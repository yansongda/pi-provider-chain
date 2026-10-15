/**
 * provider-fallback — 虚拟模型 + 配额耗尽自动降级。
 *
 * 读取 `<agentDir>/provider-fallback.json`（`agentDir = $PI_CODING_AGENT_DIR || ~/.pi/agent`），
 * 为每条 `models[]` 注册一个虚拟模型（默认 provider = `yansongda`，例如
 * `yansongda/deepseek-v4.1-flash`），把每次请求路由到 `primary`，并在命中额度/订阅/欠费类
 * 错误时自动推进到 `fallbacks`。
 *
 * 设计要点：
 * - 只有额度类错误才降级；429 瞬时限流 / 5xx / 网络错误不干预，交回 Pi 自身重试
 * - 降级状态写入共享文件（跨 session、跨进程、跨前后台 subagent 生效）
 * - 两条触发路径：reason === "retry" 快路径；agent_before_settle 兜底路径
 * - UI：notify + 页脚常驻状态（多 provider 汇总）+ 转录内可见条目（registerEntryRenderer，不进模型上下文）
 * - 恢复判定以状态文件为准（level > 0 且窗口已过期 → 主用成功即写「已恢复」墓碑），不依赖进程内状态
 *
 * 本文件只做「装配」：配置/状态/判定/决策/文案/命令解析分别在 ../src/*.ts，可独立单测。
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	VirtualModelDefinition,
} from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { COMMAND_USAGE, parseCommandArgs } from "../src/command.ts";
import { defaultConfigPath, type LoadedModel, loadConfig } from "../src/config.ts";
import { formatClock, matchDegrade, parseResetTs } from "../src/degrade.ts";
import { type ModelRef, refOf, refText } from "../src/model-ref.ts";
import { clampLevel, decideRoute, levelOfRef } from "../src/routing.ts";
import { activeEntry, clearEntry, type DegradeEntry, readState, upsertEntry } from "../src/state.ts";
import {
	commandStatusHeader,
	degradeNotice,
	describeModel,
	ENTRY_PREFIX,
	entryDegradeLine,
	entryRecoverText,
	recoverNotice,
	statusText,
} from "../src/ui.ts";

// ---------------------------------------------------------------------------
// 常量与类型
// ---------------------------------------------------------------------------

const STATUS_KEY = "provider-fallback";
const ENTRY_TYPE = "provider-fallback";

type ThinkingLevels = NonNullable<VirtualModelDefinition["thinkingLevels"]>;

const ALL_THINKING_LEVELS: ThinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** 转录内可见条目的数据结构（不进模型上下文）。 */
type RouteEntryData =
	| {
			kind: "degrade";
			provider: string;
			level: number;
			to: string;
			until: number;
			code: string;
			reason: string;
			errorMessage: string;
		}
	| { kind: "recover"; provider: string };

// ---------------------------------------------------------------------------
// 扩展
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	const result = loadConfig();

	// --- 转录内可见条目（不进模型上下文） ---
	pi.registerEntryRenderer<RouteEntryData>(ENTRY_TYPE, (entry, options, theme) => {
		const data = entry.data;
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		if (!data) {
			box.addChild(new Text(theme.fg("dim", `${ENTRY_PREFIX} (no data)`), 0, 0));
			return box;
		}
		if (data.kind === "recover") {
			box.addChild(new Text(`${theme.fg("accent", ENTRY_PREFIX)} ${theme.fg("success", entryRecoverText(data.provider))}`, 0, 0));
		} else {
			const line = entryDegradeLine(data);
			box.addChild(new Text(`${theme.fg("accent", ENTRY_PREFIX)} ${theme.fg("warning", line.text)}${theme.fg("dim", line.dim)}`, 0, 0));
			if (options.expanded) box.addChild(new Text(theme.fg("dim", data.errorMessage.slice(0, 600)), 0, 0));
		}
		return box;
	});

	// --- 配置不可用：提示原因，不做任何路由接管 ---
	if (!result.ok) {
		const reason = result.error;
		pi.on("session_start", (_event, ctx) => {
			if (ctx.hasUI) ctx.ui.notify(`[provider-fallback] 未启用：${reason}`, "error");
		});
		pi.registerCommand("fallback", {
			description: "虚拟模型路由（未启用：配置加载失败）",
			handler: async (_args, ctx) => {
				if (ctx.hasUI) ctx.ui.notify(`[provider-fallback] 未启用：${reason}`, "error");
			},
		});
		return;
	}

	const cfg = result.loaded;
	const patterns = cfg.patterns;
	const resetRe = cfg.resetRe;
	const models = cfg.models;
	const byId = new Map(models.map((m) => [m.config.id, m] as const));

	function appendEntry(data: RouteEntryData) {
		if (!cfg.transcriptNotice) return;
		try {
			pi.appendEntry(ENTRY_TYPE, data);
		} catch {
			/* 转录不可写不影响路由 */
		}
	}

	function notifyUi(ctx: ExtensionContext, message: string, kind: "info" | "warning" | "error") {
		if (!ctx.hasUI) return;
		try {
			ctx.ui.notify(message, kind);
		} catch {
			/* ignore */
		}
	}

	function setStatus(ctx: ExtensionContext, text: string | undefined) {
		if (!ctx.hasUI) return;
		try {
			ctx.ui.setStatus(STATUS_KEY, text);
		} catch {
			/* ignore */
		}
	}

	/** 重算页脚：把状态文件里所有活跃降级汇总成一行（多 provider 不会互相覆盖，同一备用 provider 只显示一次）。 */
	function refreshStatus(ctx: ExtensionContext, now: number = Date.now()) {
		const state = readState(cfg.stateFile);
		const entries: Array<{ provider: string; until: number }> = [];
		const seen = new Set<string>();
		for (const model of models) {
			const entry = state.degraded[model.key];
			if (!entry || entry.until <= now) continue;
			const target = model.chain[clampLevel(entry.level, model.chain.length)];
			if (seen.has(target.provider)) continue;
			seen.add(target.provider);
			entries.push({ provider: target.provider, until: entry.until });
		}
		setStatus(ctx, statusText(entries));
	}

	/** 只有「模型存在且已配置凭证」才认为可用；返回的模型供 route() 直接派发。 */
	function resolvePhysical(ctx: ExtensionContext, ref: ModelRef) {
		try {
			const model = ctx.modelRegistry?.find(ref.provider, ref.id);
			if (!model) return undefined;
			if (ctx.modelRegistry.hasConfiguredAuth(model)) return model;
			return undefined;
		} catch {
			return undefined;
		}
	}

	/** 兜底回落：优先取有凭证的主用，其次取目录里的主用对象（让 Pi 报出真实错误）。 */
	function primaryOrCatalog(ctx: ExtensionContext, ref: ModelRef) {
		const physical = resolvePhysical(ctx, ref);
		if (physical) return physical;
		try {
			return ctx.modelRegistry?.find(ref.provider, ref.id);
		} catch {
			return undefined;
		}
	}

	/** 写入降级状态；仅在状态变化时做 UI 提示（幂等）。 */
	function applyDegrade(
		ctx: ExtensionContext,
		model: LoadedModel,
		info: { level: number; until: number; code: string; errorMessage: string; reason: string },
	): DegradeEntry {
		const applied = upsertEntry(cfg.stateFile, model.key, {
			level: info.level,
			until: info.until,
			code: info.code,
			at: Date.now(),
		});
		const entry = applied.entry;
		const target = model.chain[clampLevel(entry.level, model.chain.length)];
		const to = refText(target);

		if (applied.changed) {
			notifyUi(
				ctx,
				degradeNotice({ key: model.key, code: entry.code, to, until: entry.until, writeFailed: !!applied.writeError }),
				"warning",
			);
			appendEntry({
				kind: "degrade",
				provider: model.key,
				level: entry.level,
				to,
				until: entry.until,
				code: entry.code,
				reason: info.reason,
				errorMessage: info.errorMessage.slice(0, 2000),
			});
		}
		refreshStatus(ctx);
		return entry;
	}

	/**
	 * 降级窗口过期后，第一条成功的主用响应 → 写「已恢复」墓碑并提示。
	 *
	 * 以状态文件自身判定恢复（level > 0 且 until 已过期），因此父/子进程都能提示；
	 * level = 0 的墓碑让后续成功响应不再重复提示，而并发下若他进程刚写入更深的活跃条目，
	 * `upsertEntry` 的单调合并会保留盘上条目，不会清掉真实降级。
	 */
	function notePrimarySuccess(ctx: ExtensionContext, provider: string) {
		const now = Date.now();
		const stale = readState(cfg.stateFile).degraded[provider];
		if (!stale || stale.level <= 0 || stale.until > now) return;

		upsertEntry(cfg.stateFile, provider, { level: 0, until: now, code: "recovered", at: now }, now);
		notifyUi(ctx, recoverNotice(provider), "info");
		refreshStatus(ctx, now);
		appendEntry({ kind: "recover", provider });
	}

	/** 命中额度类错误时计算降级时长：优先解析错误里的 reset 时间，否则用默认值；统一钳制到 maxDegradeMs。 */
	function degradeUntil(errorText: string): number {
		const now = Date.now();
		return (
			parseResetTs(resetRe, errorText, { now, maxDegradeMs: cfg.maxDegradeMs }) ??
			now + Math.min(cfg.defaultDegradeMs, cfg.maxDegradeMs)
		);
	}

	// --- 注册虚拟模型 ---
	for (const model of models) {
		const primaryRef = model.chain[0];

		pi.registerVirtualModel({
			provider: cfg.virtualProvider,
			id: model.config.id,
			name: model.config.name ?? model.config.id,
			thinkingLevels: (model.config.thinkingLevels ?? ALL_THINKING_LEVELS) as ThinkingLevels,
			contextWindow: model.config.contextWindow,
			maxTokens: model.config.maxTokens,
			route(request, ctx) {
				try {
					const state = activeEntry(cfg.stateFile, model.key);
					let level = clampLevel(state?.level ?? 0, model.chain.length);

					// A. 额度类错误 → 推进链路（retry 快路径）
					const errorText = request.reason === "retry" ? request.failed?.message?.errorMessage : undefined;
					const hit = matchDegrade(patterns, errorText);
					if (errorText && hit) {
						const next = Math.min(level + 1, model.chain.length - 1);
						if (next > level) {
							const entry = applyDegrade(ctx, model, {
								level: next,
								until: degradeUntil(errorText),
								code: hit.source,
								errorMessage: errorText,
								reason: "retry",
							});
							level = clampLevel(entry.level, model.chain.length);
						}
					}

					// B/C. 复用同档位（保 prompt cache 与思考签名）+ D. 定档
					const decision = decideRoute({
						chain: model.chain,
						level,
						reason: request.reason,
						failedRef: refOf(request.failed?.model),
						previousRef: refOf(request.previous?.model),
						isAvailable: (ref) => !!resolvePhysical(ctx, ref),
					});
					if (decision) {
						const picked = resolvePhysical(ctx, decision.ref);
						if (picked) {
							const thinkingLevel = decision.keepThinkingLevel
								? (request.failed?.thinkingLevel ?? request.previous?.thinkingLevel ?? request.thinkingLevel)
								: request.thinkingLevel;
							return { model: picked, thinkingLevel };
						}
					}

					// E. 都没有凭证：返回主用对象，让 Pi 报出真实错误
					const primary = primaryOrCatalog(ctx, primaryRef);
					if (primary) return { model: primary, thinkingLevel: request.thinkingLevel };
					throw new Error(`provider-fallback: ${refText(primaryRef)} 与全部 fallback 均不可用`);
				} catch (err) {
					const primary = primaryOrCatalog(ctx, primaryRef);
					if (primary) return { model: primary, thinkingLevel: request.thinkingLevel };
					throw err instanceof Error ? err : new Error(String(err));
				}
			},
		});
	}

	// --- 兜底路径：不可重试的额度错误（403 订阅过期等），剔除失败消息并续跑一次 ---
	pi.on("agent_before_settle", (event, ctx) => {
		if (event.outcome !== "error") return;

		const selection = ctx.model;
		if (!selection || selection.provider !== cfg.virtualProvider) return;
		const model = byId.get(selection.id);
		if (!model) return;
		if (model.chain.length < 2) return;

		const messages = event.context?.contextMessages ?? [];
		let assistant: (typeof messages)[number] | undefined;
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i]?.role === "assistant") {
				assistant = messages[i];
				break;
			}
		}
		if (!assistant || assistant.role !== "assistant") return;
		if (assistant.stopReason !== "error" || !assistant.errorMessage) return;
		const hit = matchDegrade(patterns, assistant.errorMessage);
		if (!hit) return;

		const state = activeEntry(cfg.stateFile, model.key);
		const level = clampLevel(state?.level ?? 0, model.chain.length);
		if (levelOfRef(model.chain, refOf(assistant)) !== level) return; // 失败的不是当前档位 → 不接管
		if (level >= model.chain.length - 1) return; // 已无后备可用

		// 先写降级状态：即便找不到失败消息所在的 entry（无法续跑），下一次请求也会走备用
		applyDegrade(ctx, model, {
			level: Math.min(level + 1, model.chain.length - 1),
			until: degradeUntil(assistant.errorMessage),
			code: hit.source,
			errorMessage: assistant.errorMessage,
			reason: "settle",
		});

		const projected = (event.context?.contextEntries ?? []).find((e) => (e.messages ?? []).includes(assistant));
		const targetId = projected?.sourceEntry?.id;
		if (!targetId) return;

		return {
			entries: [...(event.entries ?? []), { type: "context_edit", targetId, replacement: null }],
			continue: true,
		};
	});

	// --- 恢复提示 ---
	pi.on("message_end", (event, ctx) => {
		const message = event.message;
		if (!message || message.role !== "assistant") return;
		if (message.stopReason === "error" || message.stopReason === "aborted") return;
		if (!models.some((m) => m.key === message.provider)) return;
		notePrimarySuccess(ctx, message.provider);
	});

	// --- 会话启动：把已生效的降级状态显示到页脚 ---
	pi.on("session_start", (_event, ctx) => {
		refreshStatus(ctx);
	});

	// --- /fallback 命令 ---
	pi.registerCommand("fallback", {
		description: `虚拟模型路由：${COMMAND_USAGE}`,
		getArgumentCompletions: (prefix: string) => {
			const items = [
				{ value: "status", label: "status", description: "显示当前选中模型、链路与降级状态" },
				{ value: "degrade 30m", label: "degrade [时长]", description: "手动降级到第 1 档备用（30m / 2h / 1d）" },
				{ value: "reset", label: "reset", description: "清除当前 provider 的降级状态，下一请求尝试主用" },
				{ value: "reload", label: "reload", description: "重新加载扩展与配置" },
			];
			const text = prefix.trim().toLowerCase();
			return text ? items.filter((item) => item.value.startsWith(text)) : items;
		},
		handler: async (args, ctx) => {
			const parsed = parseCommandArgs(args);
			const selection = ctx.model;
			const model = selection && selection.provider === cfg.virtualProvider ? byId.get(selection.id) : undefined;
			const target = model ?? models[0];

			if (parsed.action === "reload") {
				notifyUi(ctx, "重新加载 provider-fallback 扩展与配置…", "info");
				await ctx.reload();
				return;
			}

			if (!target) {
				notifyUi(ctx, "配置中没有可用的虚拟模型", "error");
				return;
			}

			const lines: string[] = [];

			if (parsed.action === "reset") {
				const cleared = clearEntry(cfg.stateFile, target.key);
				refreshStatus(ctx);
				lines.push(
					cleared.ok
						? `已清除 ${target.key} 的降级状态，下一请求尝试主用`
						: `清除 ${target.key} 的降级状态失败：${cleared.error ?? "未知错误"}`,
				);
			} else if (parsed.action === "degrade") {
				if (target.chain.length < 2) {
					lines.push(`${cfg.virtualProvider}/${target.config.id} 未配置 fallback，无法切换`);
				} else {
					const ms = Math.min(parsed.durationMs ?? cfg.defaultDegradeMs, cfg.maxDegradeMs);
					const applied = applyDegrade(ctx, target, {
						level: 1,
						until: Date.now() + ms,
						code: "manual",
						errorMessage: "手动 /fallback degrade",
						reason: "manual",
					});
					// 盘上可能已有更深的活跃档位（单调合并会保留它）→ 按实际生效的档位与时间提示
					const current = target.chain[clampLevel(applied.level, target.chain.length)];
					lines.push(
						applied.level > 1
							? `已存在更深的降级档位，保持 level=${applied.level}（${refText(current)}），至 ${formatClock(applied.until)}`
							: `已手动降级 ${cfg.virtualProvider}/${target.config.id} → ${refText(current)}，至 ${formatClock(applied.until)}`,
					);
				}
			} else {
				const state = readState(cfg.stateFile);
				lines.push(
					...commandStatusHeader({
						selection: selection ? `${selection.provider}/${selection.id}` : undefined,
						configPath: defaultConfigPath(),
						stateFile: cfg.stateFile,
					}),
				);
				if (parsed.unknown) lines.push(`未知子命令：${parsed.unknown}（可用：${COMMAND_USAGE}）`, "");
				for (const m of models) {
					lines.push(
						...describeModel({
							virtualProvider: cfg.virtualProvider,
							model: m,
							active: activeEntry(cfg.stateFile, m.key),
							stale: state.degraded[m.key],
						}),
					);
				}
				const entry = state.degraded[target.key];
				if (entry && entry.until <= Date.now()) lines.push("", "提示: 状态已过期，下一请求会自动尝试主用");
			}

			notifyUi(ctx, lines.join("\n"), "info");
		},
	});
}
