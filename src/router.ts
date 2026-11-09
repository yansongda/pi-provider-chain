/**
 * 降级状态机与路由决策（端口注入，无 pi 依赖）。
 *
 * 本模块是「策略」的唯一归属地：档位推进、路由决策、恢复墓碑、页脚汇总、命令输出全部在这里；
 * 副作用（状态文件、宿主注册表、UI、转录）经 `RouterPorts` 注入，因此可以脱离 pi 单测。
 *
 * 语义要点（与宿主契约对齐）：
 * - 只有额度类错误才推进档位：`parseDegrade` 命中即降级，429 瞬时限流 / 5xx / 网络错误不干预
 * - `retry` / `continuation` 且失败（或上一响应）就是当前档位 → 复用同档位，保住 prompt cache 与思考签名
 * - `retry` 的档位推进不得停在失败模型上：`next = max(当前档位, 失败模型下标 + 1)`（钳制到链路范围）
 * - `settle` 兜底路径只接管「失败者就是当前档位」的情形（调用方要剔除那条消息并续跑一次）
 * - 降级窗口过期后，第一条主用成功响应写 `level: 0` 墓碑，让「已恢复」提示只出现一次
 */

import type { LoadedConfig, LoadedModel } from "./config.ts";
import {
	DEGRADE_REASON,
	DEGRADE_TRIGGER,
	ENTRY_KIND,
	MANUAL_DEGRADE_NOTE,
	MAX_ERROR_STORE_CHARS,
	MESSAGES,
	NOTIFY_KIND,
	type DegradeTrigger,
	type NotifyKind,
} from "./constants.ts";
import { clampDegradeMs, parseDegrade, parseResetTs } from "./degrade.ts";
import { refOf, refText, type ModelRef } from "./model-ref.ts";
import { clampLevel, decideRoute, levelOfRef, type RouteReason } from "./route-policy.ts";
import { activeEntryOf, type DegradeEntry, type StateFile } from "./state.ts";
import type { RouteEntryData } from "./transcript.ts";
import {
	degradeLine,
	deeperLevelKeptLine,
	footerActive,
	footerDegraded,
	recoverNotice,
	renderStatusLines,
} from "./ui.ts";

/** 物理模型的**结构下限**：路由结果只需能被宿主识别（真实类型由装配层实例化为 pi 的 `Model`）。 */
export interface PhysicalModel {
	provider: string;
	id: string;
}

/**
 * 装配层实现的副作用端口：本模块唯一的对外依赖面。
 * `resolve` 必须返回「有凭证」的模型；`catalog` 只保证在目录里存在（用于把真实错误交回 Pi）。
 */
export interface RouterPorts<M extends PhysicalModel> {
	now(): number;
	/** 当前选中的模型（`cfg.virtualProvider` 下的虚拟模型时才显示页脚） */
	selection(): { provider: string; id: string } | undefined;
	readState(): StateFile;
	/** 写状态：`now` 由调用方传入，保证一次操作（读、写、剪枝、提示）用同一个时钟 */
	upsert(provider: string, entry: DegradeEntry, now: number): { entry: DegradeEntry; changed: boolean; writeError?: string };
	clear(provider: string, now: number): { ok: boolean; error?: string };
	resolve(ref: ModelRef): M | undefined;
	catalog(ref: ModelRef): M | undefined;
	notify(message: string, kind: NotifyKind): void;
	append(data: RouteEntryData): void;
	setStatus(text: string | undefined): void;
}

/** 宿主 `ModelRouteRequest` 的结构下限（`TLevel` 为宿主的思考档位联合类型）。 */
export interface RouteRequest<TLevel extends string> {
	reason: RouteReason;
	thinkingLevel: TLevel;
	failed?: { model?: unknown; thinkingLevel?: TLevel; message?: { errorMessage?: string } };
	previous?: { model?: unknown; thinkingLevel?: TLevel };
}

export interface RouteResult<M extends PhysicalModel, TLevel extends string> {
	model: M;
	thinkingLevel: TLevel;
}

export interface FailureInfo {
	errorText: string;
	/** 失败请求的 `provider/id`（`failed.model` 是物理模型；路由失败时宿主会省略整个 `failed`） */
	failedRef: string;
	trigger: DegradeTrigger;
}

/** 调用方已读过的状态快照：避免一次请求内重复读状态文件。 */
export interface StateSnapshot {
	state: StateFile;
	now: number;
}

export interface Router<M extends PhysicalModel, TLevel extends string> {
	route(model: LoadedModel, request: RouteRequest<TLevel>): RouteResult<M, TLevel>;
	/** 额度类错误 → 推进档位（写状态 + 提示 + 转录）；未命中、已无后备或（settle 路径）失败者不是当前档位时返回 undefined。 */
	applyFailure(model: LoadedModel, failure: FailureInfo, snapshot?: StateSnapshot): DegradeEntry | undefined;
	/** 主用成功：窗口过期则写墓碑并提示；同时用本次快照刷新页脚（不再二次读盘）。 */
	notePrimarySuccess(provider: string): void;
	refreshStatus(): void;
	/** `/chain status` 的完整输出行（头部 + 各模型）。 */
	statusLines(input: { selection?: string; unknown?: string }): string[];
	/** 手动降级到第 1 档；返回回显行与通知级别（状态已变化时为空串，反馈由降级通知承担）。 */
	manualDegrade(model: LoadedModel, durationMs?: number): { text: string; kind: NotifyKind };
	/** 清除降级状态，返回给用户的一行结果与通知级别。 */
	reset(model: LoadedModel): { text: string; kind: NotifyKind };
}

export function createRouter<M extends PhysicalModel, TLevel extends string>(
	cfg: LoadedConfig,
	ports: RouterPorts<M>,
): Router<M, TLevel> {
	/** 状态里的活跃档位（窗口过期 → 0，越界钳制）。 */
	function activeLevel(model: LoadedModel, state: StateFile, now: number): number {
		const entry = activeEntryOf(state, model.stateKey, now);
		if (!entry) return 0;
		return clampLevel(entry.level, model.chain.length);
	}

	/** 降级时长：优先解析错误里的 reset 时间，否则用默认值；统一钳制到 [1min, maxDegradeMs]。 */
	function degradeUntil(errorText: string, now: number): number {
		return (
			parseResetTs(cfg.resetRe, errorText, { now, maxDegradeMs: cfg.maxDegradeMs }) ??
			now + clampDegradeMs(cfg.defaultDegradeMs, cfg.maxDegradeMs)
		);
	}

	/**
	 * 链路内仍活跃的降级条目里**恢复最早**的那一条（并列时取链路靠前者）。
	 *
	 * 为什么按链路范围而不是本模型的 `stateKey`：`stateKey` 是 `chain[0].provider`，链路里其它成员只有在
	 * 「它也是别的虚拟模型的 `chain[0]`」时才会有条目；页脚要回答「链路上谁先恢复」，因此取全链路最早。
	 */
	function earliestRecovery(
		model: LoadedModel,
		state: StateFile,
		now: number,
	): { provider: string; until: number } | undefined {
		let best: { provider: string; until: number } | undefined;
		for (const ref of model.chain) {
			const entry = state.degraded[ref.provider];
			if (!entry || entry.until <= now) continue;
			if (!best || entry.until < best.until) best = { provider: ref.provider, until: entry.until };
		}
		return best;
	}

	/**
	 * 重算页脚：常驻显示**当前选中模型**的目标物理模型。
	 * 档位 0 → `⓪ <chain[0]>`；档位 ≥ 1 → `① <chain[level]>` 并追加「恢复方 + 该时间所属 provider」。
	 * 选中非本扩展管理的模型时清空页脚（其它模型的降级由 `/chain status` 全量展示）。
	 *
	 * `state` 可选：调用方刚读写过状态时传入同一快照，避免为页脚再读一次状态文件（仅传本次快照，不做缓存）。
	 */
	function refreshStatus(now: number = ports.now(), state?: StateFile): void {
		const selection = ports.selection();
		const model =
			selection && selection.provider === cfg.virtualProvider
				? cfg.models.find((candidate) => candidate.config.id === selection.id)
				: undefined;
		if (!model) {
			ports.setStatus(undefined);
			return;
		}
		const snapshot = state ?? ports.readState();
		const level = activeLevel(model, snapshot, now);
		const recovery = earliestRecovery(model, snapshot, now);
		ports.setStatus(
			level > 0 && recovery
				? footerDegraded({
					level,
					target: refText(model.chain[level]),
					provider: recovery.provider,
					until: recovery.until,
				})
				: footerActive(refText(model.chain[0]), level),
		);
	}

	/**
	 * 写入降级状态；仅在状态变化时做 UI 提示（幂等）。`from` 为受限方 provider（notify 与转录条目共用）。
	 *
	 * `now` 与 `baseState` 由调用方传入：写入时间、剪枝与页脚都基于同一次读快照，写入后再合成快照
	 * （以 `upsert` 返回的单调合并结果为准），因此不再为页脚重读状态文件。
	 */
	function applyDegrade(
		model: LoadedModel,
		info: { from: string; level: number; until: number; reason: string; errorMessage: string; trigger: DegradeTrigger },
		now: number,
		baseState: StateFile,
	): { entry: DegradeEntry; changed: boolean } {
		const applied = ports.upsert(
			model.stateKey,
			{ level: info.level, until: info.until, reason: info.reason, at: now },
			now,
		);
		const entry = applied.entry;
		const to = refText(model.chain[clampLevel(entry.level, model.chain.length)]);

		if (applied.changed) {
			ports.notify(
				degradeLine({
					trigger: info.trigger,
					provider: info.from,
					reason: entry.reason,
					level: entry.level,
					to,
					until: entry.until,
					writeFailed: !!applied.writeError,
				}),
				NOTIFY_KIND.WARNING,
			);
			ports.append({
				kind: ENTRY_KIND.DEGRADE,
				provider: model.stateKey,
				from: info.from,
				level: entry.level,
				to,
				until: entry.until,
				reason: entry.reason,
				trigger: info.trigger,
				errorMessage: info.errorMessage.slice(0, MAX_ERROR_STORE_CHARS),
			});
		}
		refreshStatus(now, {
			...baseState,
			degraded: { ...baseState.degraded, [model.stateKey]: entry },
		});
		return { entry, changed: applied.changed };
	}

	function applyFailure(model: LoadedModel, failure: FailureInfo, snapshot?: StateSnapshot): DegradeEntry | undefined {
		const hit = parseDegrade(cfg.patterns, failure.errorText);
		if (!hit) return undefined;

		const now = snapshot?.now ?? ports.now();
		const baseState = snapshot?.state ?? ports.readState();
		const level = activeLevel(model, baseState, now);
		const failedLevel = levelOfRef(model.chain, failure.failedRef);
		// settle 兜底要剔除「那条失败消息」并续跑，因此只接管失败者就是当前档位的情形
		if (failure.trigger === DEGRADE_TRIGGER.SETTLE && failedLevel !== level) return undefined;

		// 推进不得停在失败模型上：取「当前档位」与「失败模型下一档」的较大者（clamp 内不含失败模型时退化为 level + 1）
		const next = clampLevel(Math.max(level, failedLevel + 1), model.chain.length);
		if (next <= level) return undefined; // 已无后备可用

		return applyDegrade(
			model,
			{
				// 受限的是失败模型所属 provider：档位 ≥ 1 时它不是状态键，必须按失败模型反查
				from: model.chain[failedLevel]?.provider ?? model.stateKey,
				level: next,
				until: degradeUntil(failure.errorText, now),
				reason: hit.source,
				errorMessage: failure.errorText,
				trigger: failure.trigger,
			},
			now,
			baseState,
		).entry;
	}

	function route(model: LoadedModel, request: RouteRequest<TLevel>): RouteResult<M, TLevel> {
		const primaryRef = model.chain[0];
		/** 一次请求内每个 `provider/id` 只查一次宿主注册表（含兜底目录查询）。 */
		const resolved = new Map<string, M | undefined>();
		const catalogCache = new Map<string, M | undefined>();
		const resolveOnce = (ref: ModelRef): M | undefined => {
			const key = refText(ref);
			if (!resolved.has(key)) resolved.set(key, ports.resolve(ref));
			return resolved.get(key);
		};
		const primaryOrCatalog = (): M | undefined => {
			const resolvedModel = resolveOnce(primaryRef);
			if (resolvedModel) return resolvedModel;
			const key = refText(primaryRef);
			if (!catalogCache.has(key)) catalogCache.set(key, ports.catalog(primaryRef));
			return catalogCache.get(key);
		};

		try {
			const now = ports.now();
			const state = ports.readState();
			let level = activeLevel(model, state, now);
			const failedRef = refOf(request.failed?.model);

			// A. 额度类错误 → 推进链路（retry 快路径）
			const errorText = request.reason === "retry" ? request.failed?.message?.errorMessage : undefined;
			if (errorText) {
				const entry = applyFailure(model, { errorText, failedRef, trigger: DEGRADE_TRIGGER.RETRY }, { state, now });
				if (entry) level = clampLevel(entry.level, model.chain.length);
			}

			// B/C. 复用同档位（保 prompt cache 与思考签名）+ D. 定档
			const decision = decideRoute({
				chain: model.chain,
				level,
				reason: request.reason,
				failedRef,
				previousRef: refOf(request.previous?.model),
				isAvailable: (ref) => !!resolveOnce(ref),
			});
			if (decision) {
				const picked = resolveOnce(decision.ref);
				if (picked) {
					const thinkingLevel = decision.keepThinkingLevel
						? (request.failed?.thinkingLevel ?? request.previous?.thinkingLevel ?? request.thinkingLevel)
						: request.thinkingLevel;
					return { model: picked, thinkingLevel };
				}
			}

			// E. 都没有凭证：返回主用对象，让 Pi 报出真实错误
			const primary = primaryOrCatalog();
			if (primary) return { model: primary, thinkingLevel: request.thinkingLevel };
			throw new Error(MESSAGES.unavailable(refText(primaryRef)));
		} catch (err) {
			const primary = primaryOrCatalog();
			if (primary) {
				// 回落主用会掩盖真实异常 → 留一条转录条目（不进模型上下文）
				ports.append({
					kind: ENTRY_KIND.ERROR,
					provider: model.stateKey,
					message: err instanceof Error ? err.message : String(err),
				});
				return { model: primary, thinkingLevel: request.thinkingLevel };
			}
			throw err instanceof Error ? err : new Error(String(err));
		}
	}

	/**
	 * 主用成功响应：窗口过期则写「已恢复」墓碑并提示；无论是否写墓碑，都用本次读到的快照刷新页脚。
	 *
	 * 以状态文件自身判定恢复（`level > 0` 且窗口已过期），因此父/子进程都能提示；
	 * `level = 0` 的墓碑让后续成功响应不再重复提示，而并发下若他进程刚写入更深的活跃条目，
	 * `upsert` 的单调合并会保留盘上条目，不会清掉真实降级（此时 `changed=false`，也不发误导性的「已恢复」）。
	 */
	function notePrimarySuccess(provider: string): void {
		const now = ports.now();
		const state = ports.readState();
		const stale = state.degraded[provider];
		let snapshot = state;

		if (stale && stale.level > 0 && stale.until <= now) {
			const applied = ports.upsert(provider, { level: 0, until: now, reason: DEGRADE_REASON.RECOVERED, at: now }, now);
			if (applied.changed) {
				ports.notify(recoverNotice(provider), NOTIFY_KIND.INFO);
				ports.append({ kind: ENTRY_KIND.RECOVER, provider });
			}
			snapshot = { ...state, degraded: { ...state.degraded, [provider]: applied.entry } };
		}

		refreshStatus(now, snapshot);
	}

	function statusLines(input: { selection?: string; unknown?: string }): string[] {
		return renderStatusLines({
			virtualProvider: cfg.virtualProvider,
			models: cfg.models,
			state: ports.readState(),
			now: ports.now(),
			configPath: cfg.configPath,
			stateFile: cfg.stateFile,
			selection: input.selection,
			unknown: input.unknown,
		});
	}

	function manualDegrade(model: LoadedModel, durationMs?: number): { text: string; kind: NotifyKind } {
		const ref = `${cfg.virtualProvider}/${model.config.id}`;
		if (model.chain.length < 2) return { text: MESSAGES.noSpareChain(ref), kind: NOTIFY_KIND.WARNING };

		const now = ports.now();
		const state = ports.readState();
		const ms = clampDegradeMs(durationMs ?? cfg.defaultDegradeMs, cfg.maxDegradeMs);
		const { entry, changed } = applyDegrade(
			model,
			{
				// 手动降级只有 level 0 → 1：受限方即状态键所属 provider
				from: model.stateKey,
				level: 1,
				until: now + ms,
				reason: DEGRADE_REASON.MANUAL,
				errorMessage: MANUAL_DEGRADE_NOTE,
				trigger: DEGRADE_TRIGGER.MANUAL,
			},
			now,
			state,
		);
		// 状态真的变了 → ⚠ 通知 + 转录条目已把结果说清，命令不再重复回显
		if (changed) return { text: "", kind: NOTIFY_KIND.INFO };
		// 没变化 = 盘上已有更深的活跃档位（单调合并保留它）→ 如实回显实际生效的档位与时间
		const current = model.chain[clampLevel(entry.level, model.chain.length)];
		return {
			text: deeperLevelKeptLine({ level: entry.level, to: refText(current), until: entry.until }),
			kind: NOTIFY_KIND.INFO,
		};
	}

	function reset(model: LoadedModel): { text: string; kind: NotifyKind } {
		const now = ports.now();
		const cleared = ports.clear(model.stateKey, now);
		refreshStatus(now);
		return cleared.ok
			? { text: MESSAGES.cleared(model.stateKey), kind: NOTIFY_KIND.INFO }
			: { text: MESSAGES.clearFailed(model.stateKey, cleared.error ?? MESSAGES.unknownError), kind: NOTIFY_KIND.WARNING };
	}

	return { route, applyFailure, notePrimarySuccess, refreshStatus, statusLines, manualDegrade, reset };
}
