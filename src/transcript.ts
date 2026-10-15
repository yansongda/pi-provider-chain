/**
 * 转录条目契约与会话数据遍历（纯函数模块，无 pi 依赖）。
 *
 * - `RouteEntryData`：写入会话转录（`pi.appendEntry`）的数据结构，**不进模型上下文**
 * - `findFailingAssistant` / `locateEntryIdFor`：`agent_before_settle` 兜底路径的两步纯查询
 *   （宿主事件里的消息与 entry 用结构化泛型描述，因此本模块不依赖 pi 类型）
 */

import { ENTRY_KIND, type DegradeTrigger } from "./constants.ts";

/** 转录内可见条目的数据结构（判别联合）。 */
export type RouteEntryData =
	| {
			kind: typeof ENTRY_KIND.DEGRADE;
			/** 状态键 = 链路主用 provider */
			provider: string;
			level: number;
			/** 降级到的物理模型 `provider/id` */
			to: string;
			until: number;
			/** 降级原因（pattern 原文 / `manual`） */
			reason: string;
			/** 触发路径（仅落盘留痕，不渲染） */
			trigger: DegradeTrigger;
			errorMessage: string;
	  }
	| { kind: typeof ENTRY_KIND.RECOVER; provider: string }
	| { kind: typeof ENTRY_KIND.ERROR; provider?: string; message: string };

/** 已确认「以错误结束」的 assistant 字段（调用方按结构化类型使用，不依赖 pi 的消息联合类型）。 */
export type FailingAssistant<T> = T & { stopReason: string; errorMessage: string };

/**
 * 会话消息里**最后一条** assistant 是否为「以错误结束」的失败响应。
 *
 * 只认最后一条 assistant（与宿主 `agent_before_settle` 的 settle 语义一致）：
 * 若最后一条 assistant 不是 error（例如已被剔除或正常结束），返回 undefined。
 */
export function findFailingAssistant<T extends { role?: unknown; stopReason?: unknown; errorMessage?: unknown }>(
	messages: readonly T[],
): FailingAssistant<T> | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role !== "assistant") continue;
		if (message.stopReason !== "error" || !message.errorMessage) return undefined;
		// 上面两个判断已保证字段存在且为非空字符串
		return message as FailingAssistant<T>;
	}
	return undefined;
}

/** 该消息所在的 session entry id（用于 `context_edit` 剔除消息）；定位不到返回 undefined。 */
export function locateEntryIdFor<TMessage>(
	entries: readonly { sourceEntry?: { id?: string } | undefined; messages?: readonly TMessage[] | undefined }[],
	assistant: TMessage,
): string | undefined {
	for (const entry of entries) {
		if (!(entry.messages ?? []).includes(assistant)) continue;
		const id = entry.sourceEntry?.id;
		return id || undefined;
	}
	return undefined;
}
