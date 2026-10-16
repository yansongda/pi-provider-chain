/**
 * provider-chain — 虚拟模型 + 链路路由 + 配额耗尽自动降级。
 *
 * 读取 `<agentDir>/provider-chain.json`（`agentDir = $PI_CODING_AGENT_DIR || ~/.pi/agent`），为每条
 * `models[]` 注册一个虚拟模型（默认 provider = `yansongda`），把请求路由到 `chain[0]`，命中额度/订阅/欠费类
 * 错误时自动沿 `chain[1..]` 推进：
 * - 只有额度类错误才降级；429 瞬时限流 / 5xx / 网络错误不干预，交回 Pi 自身重试
 * - 降级状态写入共享文件（跨 session、跨进程、跨前后台 subagent 生效）
 * - 两条触发路径：reason === "retry" 快路径；agent_before_settle 兜底路径
 * - 页脚常驻：档位 0 显示 `→ <主用目标>`；降级中显示 `↓ <当前目标> · <最早恢复时间> 恢复 <provider>`
 *
 * 本文件只做「装配」：注册虚拟模型 / 事件 / 命令 / 渲染器，并把 pi 的 `ctx` 适配成 router 端口。
 * 档位推进、路由决策、恢复判定、页脚与命令输出在 `../src/router.ts`；常量与文案在 `../src/constants.ts`。
 */

import type { ExtensionAPI, ExtensionContext, VirtualModelDefinition } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { parseCommandArgs } from "../src/command.ts";
import { type LoadedModel, loadConfig } from "../src/config.ts";
import {
	COMMAND_COMPLETIONS, COMMAND_NAME, DEGRADE_TRIGGER, ENTRY_KIND, ENTRY_PREFIX, ENTRY_TYPE, MESSAGES,
	NOTIFY_KIND, STATUS_KEY, THEME_COLOR, THINKING_LEVELS, type NotifyKind,
} from "../src/constants.ts";
import { refOf, refText, type ModelRef } from "../src/model-ref.ts";
import { createRouter, type RouterPorts } from "../src/router.ts";
import { clearEntry, readState, upsertEntry } from "../src/state.ts";
import { findFailingAssistant, locateEntryIdFor, type RouteEntryData } from "../src/transcript.ts";
import { degradeLine, entryErrorDetail, entryErrorText, entryNoDataText, entryRecoverText } from "../src/ui.ts";

// --- 类型别名（宿主注册表 / 思考档位） ---
type ThinkingLevels = NonNullable<VirtualModelDefinition["thinkingLevels"]>;
type ThinkingLevel = ThinkingLevels[number];
type Registry = NonNullable<ExtensionContext["modelRegistry"]>;
/** 宿主注册表里的物理模型（即 router 的 `M`）。 */
type RegistryModel = NonNullable<ReturnType<Registry["find"]>>;

export default function (pi: ExtensionAPI) {
	const result = loadConfig();

	// --- 转录内可见条目（不进模型上下文） ---
	pi.registerEntryRenderer<RouteEntryData>(ENTRY_TYPE, (entry, options, theme) => {
		const data = entry.data;
		const box = new Box(1, 1, (text) => theme.bg(THEME_COLOR.CUSTOM_MESSAGE_BG, text));
		if (!data) {
			box.addChild(new Text(theme.fg(THEME_COLOR.DIM, entryNoDataText()), 0, 0));
			return box;
		}
		const prefix = theme.fg(THEME_COLOR.ACCENT, ENTRY_PREFIX);
		if (data.kind === ENTRY_KIND.RECOVER) {
			box.addChild(new Text(`${prefix} ${theme.fg(THEME_COLOR.SUCCESS, entryRecoverText(data.provider))}`, 0, 0));
		} else if (data.kind === ENTRY_KIND.ERROR) {
			box.addChild(new Text(`${prefix} ${theme.fg(THEME_COLOR.WARNING, entryErrorText())}`, 0, 0));
			if (options.expanded) box.addChild(new Text(theme.fg(THEME_COLOR.DIM, entryErrorDetail(data.message)), 0, 0));
		} else {
			// 旧条目没有 `from`（受限 provider）→ 回落状态键，历史会话也能渲染；文案与 notify 同一句
			const line = degradeLine({
				trigger: data.trigger,
				provider: data.from ?? data.provider,
				reason: data.reason,
				to: data.to,
				until: data.until,
			});
			box.addChild(new Text(`${prefix} ${theme.fg(THEME_COLOR.WARNING, line)}`, 0, 0));
			if (options.expanded) box.addChild(new Text(theme.fg(THEME_COLOR.DIM, entryErrorDetail(data.errorMessage)), 0, 0));
		}
		return box;
	});

	// --- 配置不可用：提示原因，不做任何路由接管 ---
	if (!result.ok) {
		const reason = result.error;
		pi.on("session_start", (_event, ctx) => {
			if (ctx.hasUI) ctx.ui.notify(MESSAGES.disabled(reason), NOTIFY_KIND.ERROR);
		});
		pi.registerCommand(COMMAND_NAME, {
			description: MESSAGES.commandDescriptionDisabled,
			handler: async (_args, ctx) => {
				if (ctx.hasUI) ctx.ui.notify(MESSAGES.disabled(reason), NOTIFY_KIND.ERROR);
			},
		});
		return;
	}

	const cfg = result.loaded;
	const models = cfg.models;
	const byId = new Map(models.map((m) => [m.config.id, m] as const));
	/** 页脚文案去重：内容未变则不重复调用 `ctx.ui.setStatus`（避免每轮响应重绘）。 */
	let lastStatus: string | undefined;

	function notifyUi(ctx: ExtensionContext, message: string, kind: NotifyKind): void {
		if (!ctx.hasUI) return;
		try {
			ctx.ui.notify(message, kind);
		} catch {
			/* 提示失败不影响路由 */
		}
	}

	/**
	 * 把 pi 的 `ctx` 适配成 router 端口 —— 本文件唯一接触宿主 IO/UI 的地方。
	 *
	 * router 自身无状态（状态都在状态文件里），因此每次调用按当前 `ctx` 现建一个即可。
	 */
	function portsFor(ctx: ExtensionContext): RouterPorts<RegistryModel> {
		const registry = ctx.modelRegistry;
		const find = (ref: ModelRef): RegistryModel | undefined => {
			try {
				return registry?.find(ref.provider, ref.id);
			} catch {
				return undefined;
			}
		};
		return {
			now: () => Date.now(),
			selection: () => {
				const selected = ctx.model;
				return selected ? { provider: selected.provider, id: selected.id } : undefined;
			},
			readState: () => readState(cfg.stateFile),
			upsert: (provider, entry) => upsertEntry(cfg.stateFile, provider, entry),
			clear: (provider) => clearEntry(cfg.stateFile, provider),
			/** 只有「模型存在且已配置凭证」才算可用；返回的模型供 route() 直接派发。 */
			resolve: (ref) => {
				const model = find(ref);
				if (!model) return undefined;
				try {
					return registry?.hasConfiguredAuth(model) ? model : undefined;
				} catch {
					return undefined;
				}
			},
			/** 兜底：目录里的主用对象（让 Pi 报出真实错误）。 */
			catalog: find,
			notify: (message, kind) => notifyUi(ctx, message, kind),
			append: (data) => {
				if (!cfg.transcriptNotice) return;
				try {
					pi.appendEntry(ENTRY_TYPE, data);
				} catch {
					/* 转录不可写不影响路由 */
				}
			},
			setStatus: (text) => {
				if (text === lastStatus) return; // 文案未变不重绘
				lastStatus = text;
				if (!ctx.hasUI) return;
				try {
					ctx.ui.setStatus(STATUS_KEY, text);
				} catch {
					/* ignore */
				}
			},
		};
	}

	const routerFor = (ctx: ExtensionContext) => createRouter<RegistryModel, ThinkingLevel>(cfg, portsFor(ctx));

	// --- 注册虚拟模型 ---
	for (const model of models) {
		pi.registerVirtualModel({
			provider: cfg.virtualProvider,
			id: model.config.id,
			name: model.config.name ?? model.config.id,
			thinkingLevels: (model.config.thinkingLevels ?? THINKING_LEVELS) as ThinkingLevels,
			// 未声明时不传该字段，保持宿主默认（text + image）
			input: model.config.input,
			contextWindow: model.config.contextWindow,
			maxTokens: model.config.maxTokens,
			route(request, ctx) {
				return routerFor(ctx).route(model, request);
			},
		});
	}

	// --- 兜底路径：不可重试的额度错误（403 订阅过期等），剔除失败消息并续跑一次 ---
	pi.on("agent_before_settle", (event, ctx) => {
		if (event.outcome !== "error") return;

		const selection = ctx.model;
		if (!selection || selection.provider !== cfg.virtualProvider) return;
		const model = byId.get(selection.id);
		if (!model || model.chain.length < 2) return;

		const context = event.context;
		const assistant = findFailingAssistant(context?.contextMessages ?? []);
		if (!assistant) return;

		// 先写降级状态：即便找不到失败消息所在的 entry（无法续跑），下一次请求也会走备用
		const entry = routerFor(ctx).reviewFailure(model, {
			errorText: String(assistant.errorMessage),
			failedRef: refOf(assistant),
			trigger: DEGRADE_TRIGGER.SETTLE,
		});
		if (!entry) return;

		const targetId = locateEntryIdFor(context?.contextEntries ?? [], assistant);
		if (!targetId) return;

		return {
			entries: [...(event.entries ?? []), { type: "context_edit", targetId, replacement: null }],
			continue: true,
		};
	});

	// --- 恢复提示 + 页脚保真（每条成功响应后按选中模型刷新） ---
	pi.on("message_end", (event, ctx) => {
		const message = event.message;
		if (!message || message.role !== "assistant") return;
		if (message.stopReason === "error" || message.stopReason === "aborted") return;
		if (!models.some((m) => m.stateKey === message.provider)) return;
		const router = routerFor(ctx);
		router.notePrimarySuccess(message.provider);
		router.refreshStatus();
	});

	// --- 模型切换：页脚常驻内容随选中模型变化 ---
	pi.on("model_select", (_event, ctx) => {
		routerFor(ctx).refreshStatus();
	});

	// --- 会话启动：把当前选中模型的目标与恢复时间显示到页脚 ---
	pi.on("session_start", (_event, ctx) => {
		routerFor(ctx).refreshStatus();
	});

	// --- /chain 命令 ---
	pi.registerCommand(COMMAND_NAME, {
		description: MESSAGES.commandDescription,
		getArgumentCompletions: (prefix: string) => {
			const text = prefix.trim().toLowerCase();
			return text ? COMMAND_COMPLETIONS.filter((item) => item.value.startsWith(text)) : [...COMMAND_COMPLETIONS];
		},
		handler: async (args, ctx) => {
			const parsed = parseCommandArgs(args);

			if (parsed.action === "reload") {
				notifyUi(ctx, MESSAGES.reloading, NOTIFY_KIND.INFO);
				await ctx.reload();
				return;
			}

			const selection = ctx.model;
			const selected =
				selection && selection.provider === cfg.virtualProvider ? byId.get(selection.id) : undefined;
			const target: LoadedModel | undefined = selected ?? models[0];
			if (!target) {
				notifyUi(ctx, MESSAGES.noVirtualModel, NOTIFY_KIND.ERROR);
				return;
			}

			const router = routerFor(ctx);
			const lines: string[] =
				parsed.action === "reset"
					? [router.reset(target)]
					: parsed.action === "degrade"
						? [router.manualDegrade(target, parsed.durationMs)]
						: router.statusLines({
								selection: selection ? `${selection.provider}/${selection.id}` : undefined,
								target,
								unknown: parsed.unknown,
							});
			// 手动降级的成功反馈由降级通知承担 → 回显可能为空，不弹空提示（status 的空行分隔不受影响）
			const text = lines.join("\n");
			if (text.trim()) notifyUi(ctx, text, NOTIFY_KIND.INFO);
		},
	});
}
