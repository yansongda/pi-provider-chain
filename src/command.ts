/**
 * `/fallback` 命令参数解析（纯函数模块，无 IO、无 pi 依赖）。
 *
 * - action 归一化：`degrade` / `fallback` → degrade，`reset` / `primary` / `clear` → reset
 * - 空参数或未识别的首个子命令 → status（未识别时带原文，供命令层追加提示）
 * - 时长文本交给 `parseDurationMs` 解析，非法时长返回 undefined（由命令层回落默认值）
 */

import { parseDurationMs } from "./degrade.ts";


export type CommandAction = "status" | "degrade" | "reset" | "reload";

export interface ParsedCommand {
	action: CommandAction;
	/** `degrade` 的时长（ms）；未提供或非法时为 undefined */
	durationMs?: number;
	/** 未识别的首个子命令原文（供提示） */
	unknown?: string;
}

export function parseCommandArgs(args?: string): ParsedCommand {
	const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
	const head = (parts[0] ?? "status").toLowerCase();

	switch (head) {
		case "status":
			return { action: "status" };
		case "degrade":
		case "fallback":
			return { action: "degrade", durationMs: parseDurationMs(parts[1]) };
		case "reset":
		case "primary":
		case "clear":
			return { action: "reset" };
		case "reload":
			return { action: "reload" };
		default:
			return { action: "status", unknown: parts[0] };
	}
}
