/**
 * 用户文案组装（纯函数模块，无 pi 依赖）。
 *
 * - 负责人读提示、页脚状态、转录条目与 `/chain` 命令输出
 * - 只做「选模板 + 汇总/截断/多行组装」：字面文案全部来自 `./constants.ts` 的 `MESSAGES`，
 *   时间统一用 `formatClock` 格式化后传给模板（模板因此不需要依赖任何工具函数）
 */

import type { LoadedModel } from "./config.ts";
import { MAX_ERROR_DISPLAY_CHARS, MESSAGES } from "./constants.ts";
import { formatClock } from "./degrade.ts";
import { refText } from "./model-ref.ts";
import { clampLevel } from "./routing.ts";
import type { DegradeEntry } from "./state.ts";

/** 降级提示（notify / 转录条目共用口径）。 */
export function degradeNotice(input: {
	provider: string;
	reason: string;
	to: string;
	until: number;
	writeFailed: boolean;
}): string {
	return MESSAGES.quotaLimited({
		provider: input.provider,
		reason: input.reason,
		to: input.to,
		untilText: formatClock(input.until),
		writeFailed: input.writeFailed,
	});
}

/** 转录条目：降级行，`text` 为主文案、`dim` 为次要的恢复时间。 */
export function entryDegradeLine(input: { reason: string; to: string; until: number }): { text: string; dim: string } {
	return {
		text: MESSAGES.entryDegrade(input),
		dim: MESSAGES.entryDegradeDim(formatClock(input.until)),
	};
}

/** 转录条目：恢复行。 */
export function entryRecoverText(provider: string): string {
	return MESSAGES.entryRecover(provider);
}

/** 转录条目：无数据（条目被外部修改或写入失败）。 */
export function entryNoDataText(): string {
	return MESSAGES.entryNoData;
}

/** 转录条目：路由异常（已回落主用）。 */
export function entryErrorText(): string {
	return MESSAGES.routeError;
}

/** 转录条目展开时展示的错误原文（截断）。 */
export function entryErrorDetail(message: string): string {
	return message.slice(0, MAX_ERROR_DISPLAY_CHARS);
}

/** `/chain degrade`：手动降级成功行。 */
export function manualDegradeLine(input: { model: string; to: string; until: number }): string {
	return MESSAGES.manualDegraded({ model: input.model, to: input.to, untilText: formatClock(input.until) });
}

/** `/chain degrade`：盘上已有更深档位时的提示行。 */
export function deeperLevelKeptLine(input: { level: number; to: string; until: number }): string {
	return MESSAGES.deeperLevelKept({ level: input.level, to: input.to, untilText: formatClock(input.until) });
}

/**
 * 页脚（常驻显示当前选中模型的目标物理模型）：
 * - 未降级 → `⬇ <目标>`
 * - 已降级 → `⚠ 备用 <目标> · 恢复 MM-DD HH:mm`
 *
 * 只描述**当前选中模型**（其它模型的降级信息由 `/chain status` 全量展示）。
 */
export function footerActive(target: string): string {
	return MESSAGES.footerActive(target);
}

export function footerDegraded(input: { target: string; until: number }): string {
	return MESSAGES.footerDegraded({ target: input.target, untilText: formatClock(input.until, "short") });
}

/** 恢复提示。 */
export function recoverNotice(provider: string): string {
	return MESSAGES.recovered(provider);
}

/** `/chain status` 中单个虚拟模型的描述行。 */
export function describeModel(input: {
	virtualProvider: string;
	model: LoadedModel;
	active?: DegradeEntry;
	stale?: DegradeEntry;
}): string[] {
	const { virtualProvider, model, active, stale } = input;
	const level = active ? clampLevel(active.level, model.chain.length) : 0;
	const currentRef = model.chain[level];
	const status = active
		? MESSAGES.stateDegraded({ level: active.level, ref: refText(currentRef) })
		: stale
			? MESSAGES.stateExpired
			: MESSAGES.statePrimary;

	const lines = [
		`${virtualProvider}/${model.config.id}`,
		MESSAGES.describeLink(model.chain.map(refText).join(MESSAGES.chainSeparator)),
		MESSAGES.describeState(status),
	];
	if (active) lines.push(MESSAGES.describeReason({ reason: active.reason, untilText: formatClock(active.until) }));
	return lines;
}

/** `/chain status` 头部：当前选中模型 + 配置/状态文件位置。 */
export function commandStatusHeader(input: { selection?: string; configPath: string; stateFile: string }): string[] {
	return [
		MESSAGES.headerCurrent(input.selection || MESSAGES.notSelected),
		MESSAGES.headerConfig(input.configPath),
		MESSAGES.headerStateFile(input.stateFile),
		"",
	];
}
