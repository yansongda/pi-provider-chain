/**
 * 路由决策策略（纯函数模块）。
 *
 * 输入链路、当前档位、请求原因与「可用性探针」，输出应派发的物理模型；
 * 不做任何 IO，不需要 pi 的 context，因此可以单测。
 *
 * 与 `src/router.ts` 的分工：本文件只回答「该用链路里的哪一个」（可穷举测试的纯算法）；
 * 「当前档位是多少、什么时候推进、推进后写状态/发提示/刷页脚」等编排在 `src/router.ts`。
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
 * 把档位钳制到链路范围内：非整数取整，`NaN` / `±Infinity` 按 0，越界钳到 `[0, chainLength - 1]`。
 * 状态文件可能被外部改写，链路上的每个读取点都用它兜底。
 */
export function clampLevel(level: number, chainLength: number): number {
	const raw = Number.isFinite(level) ? Math.trunc(level) : 0;
	return Math.min(Math.max(raw, 0), chainLength - 1);
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

	const level = clampLevel(input.level, chain.length);
	const current = chain[level];

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
		if (isAvailable(ref)) return { level: i, ref, keepThinkingLevel: false };
	}
	for (let i = level - 1; i >= 0; i--) {
		const ref = chain[i];
		if (isAvailable(ref)) return { level: i, ref, keepThinkingLevel: false };
	}
	return undefined;
}
