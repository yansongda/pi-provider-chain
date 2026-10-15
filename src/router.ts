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
import { defaultConfigPath } from "./config.ts";
import { clampDegradeMs, parseDegrade, parseResetTs } from "./degrade.ts";
import { refOf, refText, type ModelRef } from "./model-ref.ts";
import { clampLevel, decideRoute, levelOfRef, type RouteReason } from "./route-policy.ts";
import type { DegradeEntry, StateFile } from "./state.ts";
import type { RouteEntryData } from "./transcript.ts";
import {
	commandStatusHeader,
	degradeNotice,
	describeModel,
	deeperLevelKeptLine,
	footerActive,
	footerDegraded,
	manualDegradeLine,
	recoverNotice,
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
	upsert(provider: string, entry: DegradeEntry): { entry: DegradeEntry; changed: boolean; writeError?: string };
	clear(provider: string): { ok: boolean; error?: string };
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
	/** 额度类错误 → 推进档位；未命中、已无后备或（settle 路径）失败者不是当前档位时返回 undefined。 */
	reviewFailure(model: LoadedModel, failure: FailureInfo, snapshot?: StateSnapshot): DegradeEntry | undefined;
	notePrimarySuccess(provider: string): void;
	refreshStatus(): void;
	/** `/chain status` 的完整输出行（头部 + 各模型 + 过期提示）。 */
	statusLines(input: { selection?: string; target: LoadedModel; unknown?: string }): string[];
	/** 手动降级到第 1 档，返回给用户的一行结果。 */
	manualDegrade(model: LoadedModel, durationMs?: number): string;
	/** 清除降级状态，返回给用户的一行结果。 */
	reset(model: LoadedModel): string;
}

export function createRouter<M extends PhysicalModel, TLevel extends string>(
	cfg: LoadedConfig,
	ports: RouterPorts<M>,
): Router<M, TLevel> {
	/** 状态里的活跃档位（窗口过期 → 0，越界钳制）。 */
	function activeLevel(model: LoadedModel, state: StateFile, now: number): number {
		const entry = state.degraded[model.stateKey];
		if (!entry || entry.until <= now) return 0;
		return clampLevel(entry.level, model.chain.length);
	}

	/** 降级时长：优先解析错误里的 reset 时间，否则用默认值；统一钳制到 maxDegradeMs。 */
	function degradeUntil(errorText: string, now: number): number {
		return (
			parseResetTs(cfg.resetRe, errorText, { now, maxDegradeMs: cfg.maxDegradeMs }) ??
			now + clampDegradeMs(cfg.defaultDegradeMs, cfg.maxDegradeMs)
		);
	}

	/**
	 * 重算页脚：常驻显示**当前选中模型**的目标物理模型；该模型降级中则显示备用目标与恢复时间。
	 * 选中非本扩展管理的模型时清空页脚（其它模型的降级由 `/chain status` 全量展示）。
	 */
	function refreshStatus(now: number = ports.now()): void {
		const selection = ports.selection();
		const model =
			selection && selection.provider === cfg.virtualProvider
				? cfg.models.find((candidate) => candidate.config.id === selection.id)
				: undefined;
		if (!model) {
			ports.setStatus(undefined);
			return;
		}
		const entry = ports.readState().degraded[model.stateKey];
		const level = entry && entry.until > now ? clampLevel(entry.level, model.chain.length) : 0;
		ports.setStatus(
			entry && level > 0
				? footerDegraded({ target: refText(model.chain[level]), until: entry.until })
				: footerActive(refText(model.chain[0])),
		);
	}

	/** 写入降级状态；仅在状态变化时做 UI 提示（幂等）。 */
	function applyDegrade(
		model: LoadedModel,
		info: { level: number; until: number; reason: string; errorMessage: string; trigger: DegradeTrigger },
	): DegradeEntry {
		const applied = ports.upsert(model.stateKey, {
			level: info.level,
			until: info.until,
			reason: info.reason,
			at: ports.now(),
		});
		const entry = applied.entry;
		const to = refText(model.chain[clampLevel(entry.level, model.chain.length)]);

		if (applied.changed) {
			ports.notify(
				degradeNotice({
					provider: model.stateKey,
					reason: entry.reason,
					to,
					until: entry.until,
					writeFailed: !!applied.writeError,
				}),
				NOTIFY_KIND.WARNING,
			);
			ports.append({
				kind: ENTRY_KIND.DEGRADE,
				provider: model.stateKey,
				level: entry.level,
				to,
				until: entry.until,
				reason: entry.reason,
				trigger: info.trigger,
				errorMessage: info.errorMessage.slice(0, MAX_ERROR_STORE_CHARS),
			});
		}
		refreshStatus();
		return entry;
	}

	function reviewFailure(model: LoadedModel, failure: FailureInfo, snapshot?: StateSnapshot): DegradeEntry | undefined {
		const hit = parseDegrade(cfg.patterns, failure.errorText);
		if (!hit) return undefined;

		const now = snapshot?.now ?? ports.now();
		const level = activeLevel(model, snapshot?.state ?? ports.readState(), now);
		const failedLevel = levelOfRef(model.chain, failure.failedRef);
		// settle 兜底要剔除「那条失败消息」并续跑，因此只接管失败者就是当前档位的情形
		if (failure.trigger === DEGRADE_TRIGGER.SETTLE && failedLevel !== level) return undefined;

		// 推进不得停在失败模型上：取「当前档位」与「失败模型下一档」的较大者（clamp 内不含失败模型时退化为 level + 1）
		const next = clampLevel(Math.max(level, failedLevel + 1), model.chain.length);
		if (next <= level) return undefined; // 已无后备可用

		return applyDegrade(model, {
			level: next,
			until: degradeUntil(failure.errorText, now),
			reason: hit.source,
			errorMessage: failure.errorText,
			trigger: failure.trigger,
		});
	}

	function route(model: LoadedModel, request: RouteRequest<TLevel>): RouteResult<M, TLevel> {
		const primaryRef = model.chain[0];
		/** 一次请求内每个 `provider/id` 只查一次宿主注册表。 */
		const resolved = new Map<string, M | undefined>();
		const resolveOnce = (ref: ModelRef): M | undefined => {
			const key = refText(ref);
			if (!resolved.has(key)) resolved.set(key, ports.resolve(ref));
			return resolved.get(key);
		};
		const primaryOrCatalog = (): M | undefined => resolveOnce(primaryRef) ?? ports.catalog(primaryRef);

		try {
			const now = ports.now();
			const state = ports.readState();
			let level = activeLevel(model, state, now);
			const failedRef = refOf(request.failed?.model);

			// A. 额度类错误 → 推进链路（retry 快路径）
			const errorText = request.reason === "retry" ? request.failed?.message?.errorMessage : undefined;
			if (errorText) {
				const entry = reviewFailure(model, { errorText, failedRef, trigger: DEGRADE_TRIGGER.RETRY }, { state, now });
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
	 * 降级窗口过期后，第一条成功的主用响应 → 写「已恢复」墓碑并提示。
	 *
	 * 以状态文件自身判定恢复（`level > 0` 且窗口已过期），因此父/子进程都能提示；
	 * `level = 0` 的墓碑让后续成功响应不再重复提示，而并发下若他进程刚写入更深的活跃条目，
	 * `upsert` 的单调合并会保留盘上条目，不会清掉真实降级。
	 */
	function notePrimarySuccess(provider: string): void {
		const now = ports.now();
		const stale = ports.readState().degraded[provider];
		if (!stale || stale.level <= 0 || stale.until > now) return;

		ports.upsert(provider, { level: 0, until: now, reason: DEGRADE_REASON.RECOVERED, at: now });
		ports.notify(recoverNotice(provider), NOTIFY_KIND.INFO);
		refreshStatus(now);
		ports.append({ kind: ENTRY_KIND.RECOVER, provider });
	}

	function statusLines(input: { selection?: string; target: LoadedModel; unknown?: string }): string[] {
		const now = ports.now();
		const state = ports.readState();
		/** 仍处于窗口内的条目（已过期条目由 `describeModel` 当作 stale 展示）。 */
		const activeOf = (model: LoadedModel): DegradeEntry | undefined => {
			const entry = state.degraded[model.stateKey];
			return entry && entry.until > now ? entry : undefined;
		};
		const lines = commandStatusHeader({
			selection: input.selection,
			configPath: defaultConfigPath(),
			stateFile: cfg.stateFile,
		});
		if (input.unknown) lines.push(MESSAGES.unknownSubcommand(input.unknown), "");
		for (const model of cfg.models) {
			lines.push(
				...describeModel({
					virtualProvider: cfg.virtualProvider,
					model,
					active: activeOf(model),
					stale: state.degraded[model.stateKey],
				}),
			);
		}
		const target = state.degraded[input.target.stateKey];
		if (target && target.until <= now) lines.push("", MESSAGES.staleHint);
		return lines;
	}

	function manualDegrade(model: LoadedModel, durationMs?: number): string {
		const ref = `${cfg.virtualProvider}/${model.config.id}`;
		if (model.chain.length < 2) return MESSAGES.noSpareChain(ref);

		const ms = clampDegradeMs(durationMs ?? cfg.defaultDegradeMs, cfg.maxDegradeMs);
		const applied = applyDegrade(model, {
			level: 1,
			until: ports.now() + ms,
			reason: DEGRADE_REASON.MANUAL,
			errorMessage: MANUAL_DEGRADE_NOTE,
			trigger: DEGRADE_TRIGGER.MANUAL,
		});
		// 盘上可能已有更深的活跃档位（单调合并会保留它）→ 按实际生效的档位与时间提示
		const current = model.chain[clampLevel(applied.level, model.chain.length)];
		return applied.level > 1
			? deeperLevelKeptLine({ level: applied.level, to: refText(current), until: applied.until })
			: manualDegradeLine({ model: ref, to: refText(current), until: applied.until });
	}

	function reset(model: LoadedModel): string {
		const cleared = ports.clear(model.stateKey);
		refreshStatus();
		return cleared.ok
			? MESSAGES.cleared(model.stateKey)
			: MESSAGES.clearFailed(model.stateKey, cleared.error ?? MESSAGES.unknownError);
	}

	return { route, reviewFailure, notePrimarySuccess, refreshStatus, statusLines, manualDegrade, reset };
}
