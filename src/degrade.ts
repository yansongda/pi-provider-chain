/**
 * 降级判定与时间解析（纯函数模块）。
 *
 * - 判定：错误文本按配置的 pattern 做「忽略大小写的子串匹配」，命中即降级
 * - 时间：从错误文本解析恢复时间（`reset at ...`），失败则用默认时长，并统一钳制到 [1min, maxDegradeMs]
 */

import {
	DEFAULT_DEGRADE_PATTERNS,
	DEFAULT_RESET_PATTERN,
	MIN_DEGRADE_MS,
} from "./constants.ts";

export interface Pattern {
	/** 原始 pattern 文本，命中时作为 reason 展示 */
	source: string;
	re: RegExp;
}

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
export function compileDegradePatterns(configured?: readonly string[]): Pattern[] {
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
export function parseDegrade(patterns: readonly Pattern[], text: string | undefined): Pattern | undefined {
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

/** 从错误文本解析恢复时间戳；解析失败返回 undefined，成功则统一钳制到 `[now + 1min, now + maxDegradeMs]`。 */
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
	// 与 `clampDegradeMs` 共用同一条钳制规则，避免「低于 1min」与「超过 max」两处各写一遍
	return opts.now + clampDegradeMs(ts - opts.now, opts.maxDegradeMs);
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

/**
 * 降级时长的**统一钳制**：下限 `MIN_DEGRADE_MS`（1min），上限 `maxDegradeMs`。
 *
 * - 上限低于下限时**按下限**处理（避免一份把窗口压到几秒的配置让每次请求都重试降级）；
 * - `defaultDegradeMs` / 手动时长 / 解析出的恢复时间都走这里，保证同一套边界语义。
 */
export function clampDegradeMs(ms: number, maxDegradeMs: number): number {
	const upper = Math.max(maxDegradeMs, MIN_DEGRADE_MS);
	return Math.min(Math.max(ms, MIN_DEGRADE_MS), upper);
}

/**
 * 时间格式化：统一 `YYYY-MM-DD HH:mm`（本地时区，24 小时制）。
 *
 * 不依赖 locale（`toLocaleString()` 在不同环境长度不同），也不区分 full/short ——
 * 页脚、notify、转录条目、`/chain status` 共用同一种时间写法。
 */
export function formatClock(ts: number): string {
	const d = new Date(ts);
	if (Number.isNaN(d.getTime())) return String(ts);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
