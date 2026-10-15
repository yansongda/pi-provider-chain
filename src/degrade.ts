/**
 * 降级判定与时间解析（纯函数模块）。
 *
 * - 判定：错误文本按配置的 pattern 做「忽略大小写的子串匹配」，命中即降级
 * - 时间：从错误文本解析恢复时间（`reset at ...`），失败则用默认时长，并钳制到 [1min, maxDegradeMs]
 */

export interface Pattern {
	/** 原始 pattern 文本，命中时作为 code 展示 */
	source: string;
	re: RegExp;
}

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

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 编译降级 pattern。
 *
 * `configured` 为空（或全是空串）时使用内置默认列表，否则**完全覆盖**默认列表。
 * 纯字母/空格组成的项加词边界（`billing` → `\bbilling\b`），避免命中 `rebilling` 之类的无关文案；
 * 含 `_`、数字、驼峰的项（错误码）按原样匹配。
 */
export function buildPatterns(configured?: readonly string[]): Pattern[] {
	const provided = (configured ?? [])
		.filter((p): p is string => typeof p === "string" && p.trim().length > 0)
		.map((p) => p.trim());
	const sources = provided.length > 0 ? provided : [...DEFAULT_DEGRADE_PATTERNS];

	return sources.map((source) => {
		const escaped = escapeRegExp(source);
		const body = /^[A-Za-z ]+$/.test(source) ? `\\b${escaped}\\b` : escaped;
		return { source, re: new RegExp(body, "i") };
	});
}

/** 返回第一个命中的 pattern（顺序即优先级）；`text` 为空时返回 undefined。 */
export function matchDegrade(patterns: readonly Pattern[], text: string | undefined): Pattern | undefined {
	if (!text) return undefined;
	return patterns.find((p) => p.re.test(text));
}

/** 编译 reset 正则；非法正则或空串时回落默认。返回的正则不带 `g`/`y` 标记。 */
export function compileResetPattern(source?: string): RegExp {
	const text = typeof source === "string" ? source.trim() : "";
	if (text) {
		try {
			return new RegExp(text, "i");
		} catch {
			/* 回落默认 */
		}
	}
	return new RegExp(DEFAULT_RESET_PATTERN, "i");
}

/** 从错误文本解析恢复时间戳；解析失败返回 undefined，成功则钳制到 `[now + 1min, now + maxDegradeMs]`。 */
export function parseResetTs(
	resetRe: RegExp,
	text: string,
	opts: { now: number; maxDegradeMs: number },
): number | undefined {
	const re = resetRe.global || resetRe.sticky ? new RegExp(resetRe.source, resetRe.flags.replace(/[gy]/g, "")) : resetRe;
	const m = re.exec(text);
	if (!m) return undefined;
	// 配置的正则可能不带捕获组：按 string | undefined 处理，避免把字面量 "undefined" 拼进时间串
	const [date, time, tz] = m.slice(1) as Array<string | undefined>;
	if (!date || !time) return undefined;
	const tzRaw = tz ? tz.replace(/^([+-]\d{2})(\d{2})$/, "$1:$2") : undefined;
	const ts = Date.parse(`${date}T${time}${tzRaw ?? ""}`);
	if (!Number.isFinite(ts)) return undefined;
	return Math.min(Math.max(ts, opts.now + MIN_DEGRADE_MS), opts.now + opts.maxDegradeMs);
}

/** 解析 `30m` / `2h` / `1d` / `500ms` 之类的时长；非法返回 undefined。默认单位分钟。 */
export function parseDurationMs(text: string | undefined): number | undefined {
	const raw = (text ?? "").trim().toLowerCase();
	if (!raw) return undefined;
	const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/.exec(raw);
	if (!m) return undefined;
	const value = Number.parseFloat(m[1]);
	if (!Number.isFinite(value) || value <= 0) return undefined;
	const unit = m[2] ?? "m";
	const scale = unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
	return Math.round(value * scale);
}

export function formatClock(ts: number): string {
	try {
		return new Date(ts).toLocaleString();
	} catch {
		return String(ts);
	}
}

export function formatClockShort(ts: number): string {
	try {
		const d = new Date(ts);
		const pad = (n: number) => String(n).padStart(2, "0");
		return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
	} catch {
		return String(ts);
	}
}
