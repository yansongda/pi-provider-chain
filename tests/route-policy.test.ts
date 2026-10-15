import assert from "node:assert/strict";
import { test } from "node:test";
import { type ModelRef, refText } from "../src/model-ref.ts";
import { clampLevel, decideRoute, levelOfRef, type RouteInput } from "../src/route-policy.ts";

const PRIMARY: ModelRef = { provider: "volcengine", id: "deepseek-v4.1-flash" };
const FALLBACK1: ModelRef = { provider: "workbuddy", id: "deepseek-v4.1-flash" };
const FALLBACK2: ModelRef = { provider: "openrouter", id: "deepseek-v4.1-flash" };
const CHAIN = [PRIMARY, FALLBACK1, FALLBACK2];

function input(overrides: Partial<RouteInput> = {}): RouteInput {
	return { chain: CHAIN, level: 0, reason: "user", isAvailable: () => true, ...overrides };
}

test("levelOfRef：命中返回下标，未命中返回 -1", () => {
	assert.equal(levelOfRef(CHAIN, refText(FALLBACK1)), 1);
	assert.equal(levelOfRef(CHAIN, "nope/nope"), -1);
	assert.equal(levelOfRef(CHAIN, ""), -1);
});

test("无降级 + 主用可用 → 主用", () => {
	const decision = decideRoute(input());
	assert.deepEqual(decision, { level: 0, ref: PRIMARY, keepThinkingLevel: false });
});

test("retry 且失败的是当前档位 → 复用并保留思考档位", () => {
	const decision = decideRoute(input({ reason: "retry", failedRef: refText(PRIMARY) }));
	assert.deepEqual(decision, { level: 0, ref: PRIMARY, keepThinkingLevel: true });
});

test("retry 但失败的不是当前档位（档位刚被推进） → 不复用，走新档位", () => {
	const decision = decideRoute(input({ reason: "retry", failedRef: refText(PRIMARY), level: 1 }));
	assert.deepEqual(decision, { level: 1, ref: FALLBACK1, keepThinkingLevel: false });
});

test("continuation 且上一响应当前档位 → 沿用", () => {
	const decision = decideRoute(input({ reason: "continuation", previousRef: refText(PRIMARY) }));
	assert.deepEqual(decision, { level: 0, ref: PRIMARY, keepThinkingLevel: true });
});

test("continuation 但上一响应不是当前档位 → 走当前档位", () => {
	const decision = decideRoute(input({ reason: "continuation", previousRef: refText(FALLBACK1), level: 0 }));
	assert.deepEqual(decision, { level: 0, ref: PRIMARY, keepThinkingLevel: false });
});

test("降级后主用不可用 → 选 fallback", () => {
	const decision = decideRoute(input({ level: 1, isAvailable: (ref) => ref.provider !== "openrouter" }));
	assert.deepEqual(decision, { level: 1, ref: FALLBACK1, keepThinkingLevel: false });
});

test("当前档位不可用 → 继续向链尾找", () => {
	const decision = decideRoute(input({ level: 1, isAvailable: (ref) => ref.provider === "openrouter" }));
	assert.deepEqual(decision, { level: 2, ref: FALLBACK2, keepThinkingLevel: false });
});

test("链尾也不可用 → 向前兜底主用", () => {
	const decision = decideRoute(input({ level: 2, isAvailable: (ref) => ref.provider === "volcengine" }));
	assert.deepEqual(decision, { level: 0, ref: PRIMARY, keepThinkingLevel: false });
});

test("全链路都不可用 → undefined（不抛错）", () => {
	assert.equal(decideRoute(input({ isAvailable: () => false })), undefined);
});

test("档位越界（状态残留）被钳制，不抛错", () => {
	assert.deepEqual(decideRoute(input({ level: 99 }))?.ref, FALLBACK2);
	assert.deepEqual(decideRoute(input({ level: -5 }))?.ref, PRIMARY);
	assert.deepEqual(decideRoute(input({ level: Number.NaN }))?.ref, PRIMARY);
});

test("clampLevel：非整数取整、非法值按 0、越界钳制", () => {
	assert.equal(clampLevel(1.9, CHAIN.length), 1);
	assert.equal(clampLevel(-5, CHAIN.length), 0);
	assert.equal(clampLevel(99, CHAIN.length), 2);
	assert.equal(clampLevel(Number.NaN, CHAIN.length), 0);
	assert.equal(clampLevel(Number.POSITIVE_INFINITY, CHAIN.length), 0);
	assert.equal(clampLevel(0, 1), 0);
});

test("空链路 → undefined", () => {
	assert.equal(decideRoute(input({ chain: [] })), undefined);
});

test("单元素链路：全不可用时仍返回 undefined（由调用方决定回落/报错）", () => {
	assert.equal(decideRoute(input({ chain: [PRIMARY], isAvailable: () => false })), undefined);
});
