/**
 * 纯文本文案（无 pi 依赖）。
 *
 * 负责人读提示、页脚状态、`/route` 命令输出；不做判定、不碰 IO。
 */

import type { LoadedModel } from "./config.ts";
import { formatClock, formatClockShort } from "./degrade.ts";
import { refText } from "./model-ref.ts";
import type { DegradeEntry } from "./state.ts";

/** 降级提示（notify / 转录条目共用口径）。 */
export function degradeNotice(input: { key: string; code: string; to: string; until: number; writeFailed: boolean }): string {
	const suffix = input.writeFailed ? "（状态文件写入失败，本次降级仅本进程生效）" : "";
	return `⚠ ${input.key} 额度受限（${input.code}）→ 已切换 ${input.to}，恢复时间 ${formatClock(input.until)}${suffix}`;
}

/** 页脚常驻状态。 */
export function statusText(provider: string, until: number): string {
	return `⚠ 备用 ${provider} · ${formatClockShort(until)}`;
}

/** 恢复提示。 */
export function recoverNotice(provider: string): string {
	return `✅ ${provider} 已恢复，后续请求回到主用`;
}

/** `/route status` 中单个虚拟模型的描述行。 */
export function describeModel(input: {
	virtualProvider: string;
	model: LoadedModel;
	active?: DegradeEntry;
	stale?: DegradeEntry;
}): string[] {
	const { virtualProvider, model, active, stale } = input;
	const level = active ? Math.min(Math.max(active.level, 0), model.chain.length - 1) : 0;
	const currentRef = model.chain[level] ?? model.chain[0];
	const status = active
		? `降级 level=${active.level}（${currentRef ? refText(currentRef) : "-"}）`
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

/** `/route status` 头部：当前选中模型 + 配置/状态文件位置。 */
export function commandStatusHeader(input: { selection?: string; configPath: string; stateFile: string }): string[] {
	return [`当前: ${input.selection || "(未选择)"}`, `配置: ${input.configPath}`, `状态文件: ${input.stateFile}`, ""];
}
