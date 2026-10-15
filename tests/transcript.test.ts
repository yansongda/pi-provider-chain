import assert from "node:assert/strict";
import { test } from "node:test";
import { DEGRADE_TRIGGER, ENTRY_KIND } from "../src/constants.ts";
import { findFailingAssistant, locateEntryIdFor, type RouteEntryData } from "../src/transcript.ts";

const FAILING = { role: "assistant", stopReason: "error", errorMessage: "AccountQuotaExceeded" };

test("findFailingAssistant：命中最后一条错误 assistant", () => {
	assert.equal(findFailingAssistant([{ role: "user" }, FAILING]), FAILING);
});

test("findFailingAssistant：跳过后面的非 assistant 消息", () => {
	assert.equal(findFailingAssistant([FAILING, { role: "toolResult" }, { role: "user" }]), FAILING);
});

test("findFailingAssistant：最后一条 assistant 正常结束 → 不接管（即使更早存在错误）", () => {
	assert.equal(findFailingAssistant([FAILING, { role: "assistant", stopReason: "endTurn" }]), undefined);
});

test("findFailingAssistant：aborted / 无 errorMessage / 空数组 → undefined", () => {
	assert.equal(findFailingAssistant([{ role: "assistant", stopReason: "aborted", errorMessage: "x" }]), undefined);
	assert.equal(findFailingAssistant([{ role: "assistant", stopReason: "error" }]), undefined);
	assert.equal(findFailingAssistant([]), undefined);
});

test("locateEntryIdFor：命中返回 sourceEntry id", () => {
	const entries = [
		{ sourceEntry: { id: "entry-1" }, messages: [FAILING] },
		{ sourceEntry: { id: "entry-2" }, messages: [] },
	];
	assert.equal(locateEntryIdFor(entries, FAILING), "entry-1");
});

test("locateEntryIdFor：无 id / 无匹配 / 无 messages → undefined", () => {
	assert.equal(locateEntryIdFor([{ sourceEntry: {}, messages: [FAILING] }], FAILING), undefined);
	assert.equal(locateEntryIdFor([{ sourceEntry: { id: "e" }, messages: [] }], FAILING), undefined);
	assert.equal(locateEntryIdFor([{ sourceEntry: { id: "e" } }], FAILING), undefined);
	assert.equal(locateEntryIdFor([], FAILING), undefined);
});

test("RouteEntryData：三种 kind 的判别联合可用", () => {
	const entries: RouteEntryData[] = [
		{
			kind: ENTRY_KIND.DEGRADE,
			provider: "volcengine",
			level: 1,
			to: "workbuddy/deepseek-v4.1-flash",
			until: 1,
			reason: "AccountQuotaExceeded",
			trigger: DEGRADE_TRIGGER.RETRY,
			errorMessage: "err",
		},
		{ kind: ENTRY_KIND.RECOVER, provider: "volcengine" },
		{ kind: ENTRY_KIND.ERROR, provider: "volcengine", message: "boom" },
	];
	assert.deepEqual(
		entries.map((entry) => entry.kind),
		["degrade", "recover", "error"],
	);
});
