/**
 * 路由决策（纯函数模块）。
 *
 * 输入链路、当前档位、请求原因与「可用性探针」，输出应派发的物理模型；
 * 不做任何 IO，不需要 pi 的 context，因此可以单测。
 */

import { type ModelRef, refText } from "./model-ref.ts";

export type RouteReason = "user" | "continuation" | "retry" | "direct";

export interface RouteInput {
	chain: readonly ModelRef[];
	/** 当前档位（0 = 主用）；越界值会被钳制 */
	level: number;
	reason: RouteReason;
	/** `reason === "retry"` 时失败请求的 `provider/id` */
	failedRef?: string;
	/** `reason === "continuation"` 时上一个成功响应的 `provider/id` */
	previousRef?: string;
	isAvailable: (ref: ModelRef) => boolean;
}

export interface RouteDecision {
	level: number;
	ref: ModelRef;
	/** true 表示沿用失败/上一请求的思考档位（保 prompt cache 与思考签名） */
	keepThinkingLevel: boolean;
}

/** 链路中 `provider/id` 的下标；未命中返回 -1。 */
export function levelOfRef(chain: readonly ModelRef[], ref: string): number {
	if (!ref) return -1;
	return chain.findIndex((c) => refText(c) === ref);
}

/**
 * 决策顺序：
 * 1. `retry` 且失败的就是当前档位 → 复用（同一物理模型重试，保缓存）
 * 2. `continuation` 且上一个成功响应就是当前档位 → 沿用
 * 3. 从当前档位向链尾找第一个可用
 * 4. 再向前兜底找可用
 * 5. 都不可用 → undefined（由调用方回落主用 / 抛错）
 */
export function decideRoute(input: RouteInput): RouteDecision | undefined {
	const { chain, reason, failedRef, previousRef, isAvailable } = input;
	if (chain.length === 0) return undefined;

	const raw = Number.isFinite(input.level) ? Math.trunc(input.level) : 0;
	const level = Math.min(Math.max(raw, 0), chain.length - 1);
	const current = chain[level];
	if (!current) return undefined;

	if (reason === "retry") {
		if (failedRef && levelOfRef(chain, failedRef) === level && isAvailable(current)) {
			return { level, ref: current, keepThinkingLevel: true };
		}
	} else if (reason === "continuation") {
		if (previousRef && levelOfRef(chain, previousRef) === level && isAvailable(current)) {
			return { level, ref: current, keepThinkingLevel: true };
		}
	}

	for (let i = level; i < chain.length; i++) {
		const ref = chain[i];
		if (ref && isAvailable(ref)) return { level: i, ref, keepThinkingLevel: false };
	}
	for (let i = level - 1; i >= 0; i--) {
		const ref = chain[i];
		if (ref && isAvailable(ref)) return { level: i, ref, keepThinkingLevel: false };
	}
	return undefined;
}
