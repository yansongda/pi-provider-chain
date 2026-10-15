/**
 * 全项目常量与用户文案模板（叶子模块：不 import 项目内任何模块、不碰 IO）。
 *
 * - 机器常量：键名、文件名、字面量枚举值、默认值 —— 避免同一字符串散落在多个文件里被改歪
 * - 用户文案：`MESSAGES` 里「一句话 = 一个模板」；模板只接收原始值或**已格式化**字符串
 *   （时间由调用方 `formatClock` 之后传入），因此本模块保持零依赖
 */

// ---------------------------------------------------------------------------
// 身份与键
// ---------------------------------------------------------------------------

/** 扩展名：同时作为状态键、转录条目类型与文件名前缀（有意共用同一命名空间）。 */
export const EXTENSION_NAME = "provider-chain";
/** 页脚常驻状态的键（`ctx.ui.setStatus` 的第一个参数）。 */
export const STATUS_KEY = EXTENSION_NAME;
/** 转录条目类型（`pi.appendEntry` / `registerEntryRenderer` 的 customType）。 */
export const ENTRY_TYPE = EXTENSION_NAME;
export const COMMAND_NAME = "chain";
export const COMMAND_USAGE = `/${COMMAND_NAME} [status | degrade [时长] | reset | reload]`;
/** 转录内可见条目的前缀（与命令同名，便于对照）。 */
export const ENTRY_PREFIX = `[${COMMAND_NAME}]`;
/** 启动/未启用类提示前缀。 */
export const NOTIFY_PREFIX = `[${EXTENSION_NAME}]`;
/** 抛给宿主的错误前缀。 */
export const ERROR_PREFIX = `${EXTENSION_NAME}:`;

// ---------------------------------------------------------------------------
// 路径与文件名
// ---------------------------------------------------------------------------

export const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
/** agentDir 的默认位置：`<home>/.pi/agent`。 */
export const AGENT_DIR_SEGMENTS = [".pi", "agent"] as const;
export const CONFIG_FILE_NAME = `${EXTENSION_NAME}.json`;
export const STATE_FILE_NAME = `${EXTENSION_NAME}-state.json`;
/** 原子写的临时文件后缀（前缀为状态文件路径 + pid）。 */
export const STATE_TMP_SUFFIX = ".tmp";

// ---------------------------------------------------------------------------
// 状态文件与转录条目的字面量
// ---------------------------------------------------------------------------

export const STATE_VERSION = 1;

/** 降级原因（`DegradeEntry.reason`）：命中 pattern 时写 pattern 原文；以下为内部原因。 */
export const DEGRADE_REASON = {
	QUOTA: "quota",
	RECOVERED: "recovered",
	MANUAL: "manual",
} as const;

/** 触发路径（转录条目 `trigger`）：区分「谁触发」这次降级。 */
export const DEGRADE_TRIGGER = {
	RETRY: "retry",
	SETTLE: "settle",
	MANUAL: "manual",
} as const;

export type DegradeReason = (typeof DEGRADE_REASON)[keyof typeof DEGRADE_REASON];
export type DegradeTrigger = (typeof DEGRADE_TRIGGER)[keyof typeof DEGRADE_TRIGGER];

export const NOTIFY_KIND = { INFO: "info", WARNING: "warning", ERROR: "error" } as const;
export type NotifyKind = (typeof NOTIFY_KIND)[keyof typeof NOTIFY_KIND];

export const ENTRY_KIND = { DEGRADE: "degrade", RECOVER: "recover", ERROR: "error" } as const;
export type EntryKind = (typeof ENTRY_KIND)[keyof typeof ENTRY_KIND];

/** TUI 主题色名（渲染层用）。 */
export const THEME_COLOR = {
	DIM: "dim",
	ACCENT: "accent",
	WARNING: "warning",
	SUCCESS: "success",
	CUSTOM_MESSAGE_BG: "customMessageBg",
} as const;

/** 虚拟模型可声明的输入类型（宿主契约：缺省为 text + image）。 */
export const MODEL_INPUT_KINDS = ["text", "image"] as const;
export type ModelInputKind = (typeof MODEL_INPUT_KINDS)[number];

// ---------------------------------------------------------------------------
// 默认值
// ---------------------------------------------------------------------------

export const DEFAULT_DEGRADE_PATTERNS: readonly string[] = [
	"AccountQuotaExceeded",
	"QuotaExceeded",
	"AgentPlanQuotaExceeded",
	"SetLimitExceeded",
	"InvalidSubscription",
	"subscription has expired",
	"AccountOverdueError",
	"ServiceOverdue",
	"overdue balance",
	"usage quota",
	"exceeded the quota",
	"insufficient_quota",
	"out of budget",
	"billing",
];

export const DEFAULT_RESET_PATTERN =
	"reset at\\s+(\\d{4}-\\d{2}-\\d{2})[ T](\\d{2}:\\d{2}:\\d{2})(?:\\s*([+-]\\d{2}:?\\d{2}))?";

export const DEFAULT_DEGRADE_MS = 60 * 60 * 1000;
export const MAX_DEGRADE_MS = 30 * 24 * 60 * 60 * 1000;
export const MIN_DEGRADE_MS = 60 * 1000;

/** 过期条目保留时长：超过 `until + PRUNE_AFTER_MS` 的条目在写入时被清理。 */
export const PRUNE_AFTER_MS = 24 * 60 * 60 * 1000;

/** 全部思考档位（`models[].thinkingLevels` 缺省时使用）。 */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** 转录条目里保存的错误原文上限（防止会话文件被超长错误撑大）。 */
export const MAX_ERROR_STORE_CHARS = 2000;
/** 转录条目展开时展示的错误原文上限。 */
export const MAX_ERROR_DISPLAY_CHARS = 600;
/** 手动 `/chain degrade` 写入转录条目的错误原文占位。 */
export const MANUAL_DEGRADE_NOTE = "手动 /chain degrade";

// ---------------------------------------------------------------------------
// 用户文案模板（一句话 = 一个模板）
// ---------------------------------------------------------------------------

/** 状态文件写入失败时追加到降级提示后的说明。 */
export const WRITE_FAILED_SUFFIX = "（状态文件写入失败，本次降级仅本进程生效）";

export const MESSAGES = {
	// --- 启动 / 未启用 ---
	/** 配置加载失败：扩展未启用（notify，error）。 */
	disabled: (reason: string) => `${NOTIFY_PREFIX} 未启用：${reason}`,
	commandDescription: `虚拟模型路由：${COMMAND_USAGE}`,
	commandDescriptionDisabled: "虚拟模型路由（未启用：配置加载失败）",

	// --- 运行时：降级 / 恢复 ---
	quotaLimited: (p: { provider: string; reason: string; to: string; untilText: string; writeFailed: boolean }) =>
		`⚠ ${p.provider} 额度受限（${p.reason}）→ 已切换 ${p.to}，恢复时间 ${p.untilText}${p.writeFailed ? WRITE_FAILED_SUFFIX : ""}`,
	recovered: (provider: string) => `✅ ${provider} 已恢复，后续请求回到主用`,
	/** 路由异常（已回落主用）的转录条目文案。 */
	routeError: "⚠ 路由异常（已回落主用）",
	/** 全链路不可用且主用也无法回落时的抛错文案。 */
	unavailable: (primaryRef: string) => `${ERROR_PREFIX} ${primaryRef} 与全部后备链路均不可用`,

	// --- 转录条目 ---
	entryDegrade: (p: { reason: string; to: string }) => `⚠ 额度受限（${p.reason}）→ 降级到 ${p.to}`,
	entryDegradeDim: (untilText: string) => `  ·  恢复 ${untilText}`,
	entryRecover: (provider: string) => `✅ 已恢复主用 ${provider}`,
	entryNoData: `${ENTRY_PREFIX} (no data)`,

	// --- 页脚（常驻显示当前选中模型的目标物理模型） ---
	footerActive: (target: string) => `⬇ ${target}`,
	footerDegraded: (p: { target: string; untilText: string }) => `⚠ 备用 ${p.target} · 恢复 ${p.untilText}`,

	// --- /chain status ---
	headerCurrent: (ref: string) => `当前: ${ref}`,
	headerConfig: (path: string) => `配置: ${path}`,
	headerStateFile: (path: string) => `状态文件: ${path}`,
	notSelected: "(未选择)",
	describeLink: (chainText: string) => `  链路: ${chainText}`,
	describeState: (status: string) => `  状态: ${status}`,
	describeReason: (p: { reason: string; untilText: string }) => `  原因: ${p.reason}  ·  恢复: ${p.untilText}`,
	/** 链路分隔符（`describeLink` 用）。 */
	chainSeparator: "  →  ",
	stateDegraded: (p: { level: number; ref: string }) => `降级 level=${p.level}（${p.ref}）`,
	stateExpired: "已过期（下一请求尝试主用）",
	statePrimary: "主用",
	staleHint: "提示: 状态已过期，下一请求会自动尝试主用",

	// --- /chain degrade | reset ---
	reloading: `重新加载 ${EXTENSION_NAME} 扩展与配置…`,
	noVirtualModel: "配置中没有可用的虚拟模型",
	noSpareChain: (model: string) => `${model} 未配置后备链路，无法切换`,
	manualDegraded: (p: { model: string; to: string; untilText: string }) => `已手动降级 ${p.model} → ${p.to}，至 ${p.untilText}`,
	deeperLevelKept: (p: { level: number; to: string; untilText: string }) =>
		`已存在更深的降级档位，保持 level=${p.level}（${p.to}），至 ${p.untilText}`,
	cleared: (provider: string) => `已清除 ${provider} 的降级状态，下一请求尝试主用`,
	clearFailed: (provider: string, error: string) => `清除 ${provider} 的降级状态失败：${error}`,
	unknownError: "未知错误",
	unknownSubcommand: (unknown: string) => `未知子命令：${unknown}（可用：${COMMAND_USAGE}）`,
} as const;

/** `/chain` 子命令补全项（value / label / description 均为用户可见文案）。 */
export const COMMAND_COMPLETIONS = [
	{ value: "status", label: "status", description: "显示当前选中模型、链路与降级状态" },
	{ value: "degrade 30m", label: "degrade [时长]", description: "手动降级到第 1 档备用（30m / 2h / 1d）" },
	{ value: "reset", label: "reset", description: "清除当前 provider 的降级状态，下一请求尝试主用" },
	{ value: "reload", label: "reload", description: "重新加载扩展与配置" },
] as const;
