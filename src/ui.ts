/**
 * 纯文本文案（无 pi 依赖）。
 *
 * 负责人读提示、页脚状态、转录条目与 `/fallback` 命令输出；不做判定、不碰 IO。
 * 所有面向用户的文案都从这里出口，入口层只负责配色与布局。
 */

import type { LoadedModel } from "./config.ts";
import { formatClock, formatClockShort } from "./degrade.ts";
import { refText } from "./model-ref.ts";
import type { DegradeEntry } from "./state.ts";

/** 转录内可见条目的前缀（与命令同名，便于对照）。 */
export const ENTRY_PREFIX = "[fallback]";

/** 降级提示（notify / 转录条目共用口径）。 */
export function degradeNotice(input: { key: string; code: string; to: string; until: number; writeFailed: boolean }): string {
	const suffix = input.writeFailed ? "（状态文件写入失败，本次降级仅本进程生效）" : "";
	return `⚠ ${input.key} 额度受限（${input.code}）→ 已切换 ${input.to}，恢复时间 ${formatClock(input.until)}${suffix}`;
}

/** 转录条目：降级行，`text` 为主文案、`dim` 为次要的恢复时间。 */
export function entryDegradeLine(input: { code: string; to: string; until: number }): { text: string; dim: string } {
	return {
		text: `⚠ 额度受限（${input.code}）→ 降级到 ${input.to}`,
		dim: `  ·  恢复 ${formatClock(input.until)}`,
	};
}

/** 转录条目：恢复行。 */
export function entryRecoverText(provider: string): string {
	return `✅ 已恢复主用 ${provider}`;
}

/**
 * 页脚常驻状态。
 * - 0 条 → undefined（清空页脚）
 * - 1 条 → `⚠ 备用 <provider> · MM-DD HH:mm`
 * - ≥2 条 → 汇总 `⚠ 备用 ×N: a, b`（各自恢复时间不同，逐个列出会超出页脚宽度）
 */
export function statusText(entries: readonly { provider: string; until: number }[]): string | undefined {
	const first = entries[0];
	if (!first) return undefined;
	if (entries.length === 1) return `⚠ 备用 ${first.provider} · ${formatClockShort(first.until)}`;
	return `⚠ 备用 ×${entries.length}: ${entries.map((entry) => entry.provider).join(", ")}`;
}

/** 恢复提示。 */
export function recoverNotice(provider: string): string {
	return `✅ ${provider} 已恢复，后续请求回到主用`;
}

/** `/fallback status` 中单个虚拟模型的描述行。 */
export function describeModel(input: {
	virtualProvider: string;
	model: LoadedModel;
	active?: DegradeEntry;
	stale?: DegradeEntry;
}): string[] {
	const { virtualProvider, model, active, stale } = input;
	const level = active ? Math.min(Math.max(active.level, 0), model.chain.length - 1) : 0;
	const currentRef = model.chain[level];
	const status = active
		? `降级 level=${active.level}（${refText(currentRef)}）`
		: stale
			? "已过期（下一请求尝试主用）"
			: "主用";

	const lines = [
		`${virtualProvider}/${model.config.id}`,
		`  链路: ${model.chain.map(refText).join("  →  ")}`,
		`  状态: ${status}`,
	];
	if (active) lines.push(`  原因: ${active.code}  ·  恢复: ${formatClock(active.until)}`);
	return lines;
}

/** `/fallback status` 头部：当前选中模型 + 配置/状态文件位置。 */
export function commandStatusHeader(input: { selection?: string; configPath: string; stateFile: string }): string[] {
	return [`当前: ${input.selection || "(未选择)"}`, `配置: ${input.configPath}`, `状态文件: ${input.stateFile}`, ""];
}
