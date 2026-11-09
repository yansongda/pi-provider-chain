/**
 * 用户文案组装（纯函数模块，无 pi 依赖）。
 *
 * - 负责人读提示、页脚状态、转录条目与 `/chain` 命令输出
 * - 只做「选模板 + 汇总/截断/多行组装」：字面文案全部来自 `./constants.ts` 的 `MESSAGES`，
 *   时间统一用 `formatClock` 格式化后传给模板（模板因此不需要依赖任何工具函数）
 */

import type { LoadedModel } from "./config.ts";
import {
	DEGRADE_TRIGGER,
	LEVEL_BADGES,
	MAX_ERROR_DISPLAY_CHARS,
	MESSAGES,
	type DegradeTrigger,
} from "./constants.ts";
import { formatClock } from "./degrade.ts";
import { refText } from "./model-ref.ts";
import { clampLevel } from "./route-policy.ts";
import { activeEntryOf, type DegradeEntry, type StateFile } from "./state.ts";

/** 档位徽标：0–9 用圈码，≥10 直接数字（与 `MESSAGES` 的 `⓪` 同一套视觉语言）。 */
export function levelBadge(level: number): string {
	const n = Number.isFinite(level) ? Math.trunc(level) : 0;
	return LEVEL_BADGES[n] ?? String(n);
}

/**
 * 降级文案：notify 与转录条目**共用同一个出口**，按触发路径选模板 ——
 * `manual`（`/chain degrade`）→「手动降级」，其余 →「额度受限」（`writeFailed` 仅 notify 需要，可选）。
 */
export function degradeLine(input: {
	trigger?: DegradeTrigger;
	provider: string;
	reason: string;
	level: number;
	to: string;
	until: number;
	writeFailed?: boolean;
}): string {
	const untilText = formatClock(input.until);
	const badge = levelBadge(input.level);
	if (input.trigger === DEGRADE_TRIGGER.MANUAL) {
		return MESSAGES.manualDegradeNotice({
			provider: input.provider,
			badge,
			to: input.to,
			untilText,
			writeFailed: input.writeFailed,
		});
	}
	return MESSAGES.quotaLimited({
		provider: input.provider,
		reason: input.reason,
		badge,
		to: input.to,
		untilText,
		writeFailed: input.writeFailed,
	});
}

/** 恢复提示：notify 与转录条目共用同一句（恢复方回到档位 ⓪）。 */
export function recoverNotice(provider: string): string {
	return MESSAGES.recovered(provider);
}

/** 转录条目：无数据（条目被外部修改或写入失败）。 */
export function entryNoDataText(): string {
	return MESSAGES.entryNoData;
}

/** 转录条目：路由异常（已回到档位 ⓪）。 */
export function entryErrorText(provider?: string): string {
	return MESSAGES.routeError(provider);
}

/** 转录条目展开时展示的错误原文（截断）。 */
export function entryErrorDetail(message: string): string {
	return message.slice(0, MAX_ERROR_DISPLAY_CHARS);
}

/** `/chain degrade`：状态未变化时的回显行（盘上已有更深档位）。 */
export function deeperLevelKeptLine(input: { level: number; to: string; until: number }): string {
	return MESSAGES.deeperLevelKept({
		badge: levelBadge(input.level),
		to: input.to,
		untilText: formatClock(input.until),
	});
}

/**
 * 页脚（常驻显示当前选中模型的目标物理模型）：
 * - 档位 0 → `⓪ <chain[0]>`
 * - 档位 ≥ 1 → `① <chain[level]> · <恢复方> <YYYY-MM-DD HH:mm> 恢复`
 *
 * `provider` 是那个恢复时间所属的一方，由调用方算好（router 取链路内最早恢复的活跃条目，
 * 因此它不一定是当前档位所属 provider）。只描述**当前选中模型**（其它模型的降级信息由 `/chain status` 全量展示）。
 */
export function footerActive(target: string, level = 0): string {
	return MESSAGES.footerActive({ badge: levelBadge(level), target });
}

export function footerDegraded(input: { level: number; target: string; provider: string; until: number }): string {
	return MESSAGES.footerDegraded({
		badge: levelBadge(input.level),
		target: input.target,
		provider: input.provider,
		untilText: formatClock(input.until),
	});
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
		? MESSAGES.stateAt(levelBadge(level), refText(currentRef))
		: stale && stale.level > 0
			? MESSAGES.stateExpired(model.chain[0].provider)
			: MESSAGES.stateAt(levelBadge(0), refText(model.chain[0]));

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

/**
 * `/chain status` 的完整输出（头部 + 每个虚拟模型的链路与降级状态）。
 *
 * 纯投影：`state` / `now` / 路径都由调用方传入，router 只负责读取与转发；
 * 旧条目兼容逻辑留在 `describeModel`（`stale` 直接传盘上条目）。
 */
export function renderStatusLines(input: {
	virtualProvider: string;
	models: readonly LoadedModel[];
	state: StateFile;
	now: number;
	configPath: string;
	stateFile: string;
	selection?: string;
	/** 未识别的子命令原文（供提示） */
	unknown?: string;
}): string[] {
	const lines = commandStatusHeader({
		selection: input.selection,
		configPath: input.configPath,
		stateFile: input.stateFile,
	});
	if (input.unknown) lines.push(MESSAGES.unknownSubcommand(input.unknown), "");
	for (const model of input.models) {
		lines.push(
			...describeModel({
				virtualProvider: input.virtualProvider,
				model,
				active: activeEntryOf(input.state, model.stateKey, input.now),
				stale: input.state.degraded[model.stateKey],
			}),
		);
	}
	return lines;
}
