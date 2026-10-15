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
 * - UI：notify + 页脚常驻状态 + 转录内可见条目（registerEntryRenderer，不进模型上下文）
 *
 * 本文件只做「装配」：配置/状态/判定/决策/文案分别在 ../src/*.ts，可独立单测。
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	VirtualModelDefinition,
} from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { defaultConfigPath, type LoadedModel, loadConfig } from "../src/config.ts";
import { formatClock, matchDegrade, parseDurationMs, parseResetTs } from "../src/degrade.ts";
import { type ModelRef, parseRef, refOf, refText } from "../src/model-ref.ts";
import { decideRoute, levelOfRef } from "../src/routing.ts";
import { activeEntry, clearEntry, type DegradeEntry, readState, upsertEntry } from "../src/state.ts";
import { commandStatusHeader, degradeNotice, describeModel, recoverNotice, statusText } from "../src/ui.ts";

// ---------------------------------------------------------------------------
// 常量与类型
// ---------------------------------------------------------------------------

const STATUS_KEY = "provider-fallback";
const ENTRY_TYPE = "provider-fallback";

type ThinkingLevels = NonNullable<VirtualModelDefinition["thinkingLevels"]>;

const ALL_THINKING_LEVELS: ThinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** 转录内可见条目的数据结构（不进模型上下文）。 */
interface RouteEntryData {
	kind: "degrade" | "recover";
	provider: string;
	level: number;
	to: string;
	until: number;
	code: string;
	reason?: string;
	errorMessage?: string;
}

// ---------------------------------------------------------------------------
// 扩展
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	const result = loadConfig();
	const notified = new Map<string, number>(); // provider key -> until（本进程内已提示过的降级）

	// --- 转录内可见条目（不进模型上下文） ---
	pi.registerEntryRenderer<RouteEntryData>(ENTRY_TYPE, (entry, options, theme) => {
		const data = entry.data;
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		if (!data) {
			box.addChild(new Text(theme.fg("dim", "[route] (no data)"), 0, 0));
			return box;
		}
		if (data.kind === "recover") {
			box.addChild(new Text(`${theme.fg("accent", "[route]")} ${theme.fg("success", `✅ 已恢复主用 ${data.provider}`)}`, 0, 0));
		} else {
			box.addChild(
				new Text(
					`${theme.fg("accent", "[route]")} ${theme.fg("warning", `⚠ 额度受限（${data.code}）→ 降级到 ${data.to}`)}` +
						theme.fg("dim", `  ·  恢复 ${formatClock(data.until)}`),
					0,
					0,
				),
			);
		}
		if (options.expanded && data.errorMessage) {
			box.addChild(new Text(theme.fg("dim", data.errorMessage.slice(0, 600)), 0, 0));
		}
		return box;
	});

	// --- 配置不可用：提示原因，不做任何路由接管 ---
	if (!result.ok) {
		const reason = result.error;
		pi.on("session_start", (_event, ctx) => {
			if (ctx.hasUI) ctx.ui.notify(`[provider-fallback] 未启用：${reason}`, "error");
		});
		pi.registerCommand("route", {
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
		const target = model.chain[entry.level] ?? model.chain[0];
		const to = target ? refText(target) : refText(model.chain[0] as ModelRef);

		if (applied.changed) {
			notifyUi(
				ctx,
				degradeNotice({ key: model.key, code: entry.code, to, until: entry.until, writeFailed: !!applied.writeError }),
				"warning",
			);
			setStatus(ctx, statusText(parseRef(to)?.provider ?? to, entry.until));
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
		notified.set(model.key, entry.until);
		return entry;
	}

	/** 降级窗口过期后，第一条成功的主用响应 → 提示已恢复。 */
	function notePrimarySuccess(ctx: ExtensionContext, provider: string) {
		if (!notified.has(provider)) return;
		if (activeEntry(cfg.stateFile, provider)) return;
		notified.delete(provider);
		notifyUi(ctx, recoverNotice(provider), "info");
		setStatus(ctx, undefined);
		appendEntry({ kind: "recover", provider, level: 0, to: provider, until: Date.now(), code: "recovered" });
	}

	/** 命中额度类错误时计算降级时长：优先解析错误里的 reset 时间，否则用默认值。 */
	function degradeUntil(errorText: string): number {
		return parseResetTs(resetRe, errorText, { now: Date.now(), maxDegradeMs: cfg.maxDegradeMs }) ?? Date.now() + cfg.defaultDegradeMs;
	}

	// --- 注册虚拟模型 ---
	for (const model of models) {
		const primaryRef = model.chain[0] as ModelRef;

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
					let level = state ? Math.min(Math.max(state.level, 0), model.chain.length - 1) : 0;

					// A. 额度类错误 → 推进链路（retry 快路径）
					const errorText = request.reason === "retry" ? request.failed?.message?.errorMessage : undefined;
					const hit = matchDegrade(patterns, errorText);
					if (hit && errorText) {
						const next = Math.min(level + 1, model.chain.length - 1);
						if (next > level) {
							const entry = applyDegrade(ctx, model, {
								level: next,
								until: degradeUntil(errorText),
								code: hit.source,
								errorMessage: errorText,
								reason: "retry",
							});
							level = Math.min(Math.max(entry.level, 0), model.chain.length - 1);
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
					const primary = resolvePhysical(ctx, primaryRef) ?? ctx.modelRegistry?.find(primaryRef.provider, primaryRef.id);
					if (primary) return { model: primary, thinkingLevel: request.thinkingLevel };
					throw new Error(`provider-fallback: ${refText(primaryRef)} 与全部 fallback 均不可用`);
				} catch (err) {
					const primary = resolvePhysical(ctx, primaryRef) ?? ctx.modelRegistry?.find(primaryRef.provider, primaryRef.id);
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
		const level = state ? Math.min(Math.max(state.level, 0), model.chain.length - 1) : 0;
		if (levelOfRef(model.chain, refOf(assistant)) !== level) return; // 失败的不是当前档位 → 不接管
		if (level >= model.chain.length - 1) return; // 已无后备可用

		const projected = (event.context?.contextEntries ?? []).find((e) => (e.messages ?? []).includes(assistant));
		const targetId = projected?.sourceEntry?.id;
		if (!targetId) return;

		applyDegrade(ctx, model, {
			level: Math.min(level + 1, model.chain.length - 1),
			until: degradeUntil(assistant.errorMessage),
			code: hit.source,
			errorMessage: assistant.errorMessage,
			reason: "settle",
		});

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
		if (!notified.has(message.provider)) return;
		if (!models.some((m) => m.key === message.provider)) return;
		notePrimarySuccess(ctx, message.provider);
	});

	// --- 会话启动：把已生效的降级状态显示到页脚 ---
	pi.on("session_start", (_event, ctx) => {
		for (const model of models) {
			const entry = activeEntry(cfg.stateFile, model.key);
			if (!entry) continue;
			notified.set(model.key, entry.until);
			const target = model.chain[Math.min(entry.level, model.chain.length - 1)];
			const provider = target ? (parseRef(refText(target))?.provider ?? model.key) : model.key;
			setStatus(ctx, statusText(provider, entry.until));
		}
	});

	// --- /route 命令 ---
	pi.registerCommand("route", {
		description: "虚拟模型路由：/route [status | fallback [时长] | reset | reload]",
		handler: async (args, ctx) => {
			const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
			const action = (parts[0] ?? "status").toLowerCase();
			const selection = ctx.model;
			const model = selection && selection.provider === cfg.virtualProvider ? byId.get(selection.id) : undefined;
			const target = model ?? models[0];

			if (action === "reload") {
				notifyUi(ctx, "重新加载 provider-fallback 扩展与配置…", "info");
				await ctx.reload();
				return;
			}

			if (!target) {
				notifyUi(ctx, "配置中没有可用的虚拟模型", "error");
				return;
			}

			const state = readState(cfg.stateFile);
			const entry = state.degraded[target.key];
			const lines: string[] = [];

			if (action === "reset" || action === "primary" || action === "clear") {
				const cleared = clearEntry(cfg.stateFile, target.key);
				notified.delete(target.key);
				setStatus(ctx, undefined);
				lines.push(
					cleared.ok
						? `已清除 ${target.key} 的降级状态，下一请求尝试主用`
						: `清除 ${target.key} 的降级状态失败：${cleared.error ?? "未知错误"}`,
				);
			} else if (action === "fallback" || action === "degrade") {
				if (target.chain.length < 2) {
					lines.push(`${cfg.virtualProvider}/${target.config.id} 未配置 fallback，无法切换`);
				} else {
					const ms = parseDurationMs(parts[1]) ?? cfg.defaultDegradeMs;
					const until = Date.now() + ms;
					const fallbackRef = target.chain[1] as ModelRef;
					applyDegrade(ctx, target, {
						level: 1,
						until,
						code: "manual",
						errorMessage: "手动 /route fallback",
						reason: "manual",
					});
					lines.push(`已手动降级 ${cfg.virtualProvider}/${target.config.id} → ${refText(fallbackRef)}，至 ${formatClock(until)}`);
				}
			} else {
				lines.push(
					...commandStatusHeader({
						selection: selection ? `${selection.provider}/${selection.id}` : undefined,
						configPath: defaultConfigPath(),
						stateFile: cfg.stateFile,
					}),
				);
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
				if (entry && entry.until <= Date.now()) lines.push("", "提示: 状态已过期，下一请求会自动尝试主用");
			}

			notifyUi(ctx, lines.join("\n"), "info");
		},
	});
}
