import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_RESET_PATTERN } from "../src/constants.ts";
import {
	clampDegradeMs,
	compileDegradePatterns,
	compileResetPattern,
	formatClock,
	parseDegrade,
	parseDurationMs,
	parseResetTs,
} from "../src/degrade.ts";

const patterns = compileDegradePatterns();

test("默认 pattern 命中真实额度类错误串", () => {
	const samples = [
		"AccountQuotaExceeded: your account quota is exhausted",
		"error: insufficient_quota",
		"429 usage quota exceeded, reset at 2026-10-28 23:59:59 +08:00",
		"You are out of budget for this month",
		"InvalidSubscription: subscription has expired",
		"ServiceOverdue: overdue balance",
	];
	for (const sample of samples) {
		assert.ok(parseDegrade(patterns, sample), `应命中：${sample}`);
	}
});

test("默认 pattern 不误伤普通错误串", () => {
	for (const sample of ["cannot connect to host", "ECONNRESET", "model not found", "rebilling failed"]) {
		assert.equal(parseDegrade(patterns, sample), undefined, `不应命中：${sample}`);
	}
});

test("词边界：billing 命中独立词、不命中拼接词", () => {
	const billing = compileDegradePatterns(["billing"]);
	assert.ok(parseDegrade(billing, "Your billing is overdue"));
	assert.equal(parseDegrade(billing, "rebilling failed"), undefined);
});

test("错误码类 pattern 保持原样匹配（含下划线/驼峰）", () => {
	assert.ok(parseDegrade(patterns, "x AccountQuotaExceeded: quota"));
	assert.ok(parseDegrade(patterns, "prefix-insufficient_quota-suffix"));
});

test("compileDegradePatterns：空配置回落默认、自定义覆盖默认", () => {
	assert.deepEqual(
		compileDegradePatterns([""]).map((p) => p.source),
		compileDegradePatterns().map((p) => p.source),
	);
	const custom = compileDegradePatterns(["custom_err"]);
	assert.equal(custom.length, 1);
	assert.equal(custom[0]?.source, "custom_err");
	assert.equal(parseDegrade(custom, "AccountQuotaExceeded"), undefined);
});

test("compileDegradePatterns：非法正则字符被转义，不抛异常", () => {
	const built = compileDegradePatterns(["("]);
	assert.equal(built.length, 1);
	assert.doesNotThrow(() => parseDegrade(built, "(x)"));
});

test("parseDegrade：空文本返回 undefined", () => {
	assert.equal(parseDegrade(patterns, undefined), undefined);
	assert.equal(parseDegrade(patterns, ""), undefined);
});

test("compileResetPattern：非法正则回落默认", () => {
	assert.equal(compileResetPattern("(").source, DEFAULT_RESET_PATTERN);
	assert.equal(compileResetPattern("").source, DEFAULT_RESET_PATTERN);
	assert.equal(compileResetPattern("reset at (\\d+)").source, "reset at (\\d+)");
});

test("parseResetTs：带 +0800 时区等价 +08:00", () => {
	const now = Date.parse("2026-10-15T10:00:00+08:00");
	const compact = parseResetTs(compileResetPattern(), "reset at 2026-10-20 12:00:00 +0800", {
		now,
		maxDegradeMs: 30 * 24 * 3600_000,
	});
	const colon = parseResetTs(compileResetPattern(), "reset at 2026-10-20 12:00:00 +08:00", {
		now,
		maxDegradeMs: 30 * 24 * 3600_000,
	});
	assert.equal(compact, colon);
	assert.equal(compact, Date.parse("2026-10-20T12:00:00+08:00"));
});

test("parseResetTs：无时区与解析失败", () => {
	const now = Date.parse("2026-10-15T10:00:00+08:00");
	const ts = parseResetTs(compileResetPattern(), "reset at 2026-10-20 12:00:00", { now, maxDegradeMs: 30 * 24 * 3600_000 });
	assert.equal(ts, Date.parse("2026-10-20T12:00:00"));
	assert.equal(parseResetTs(compileResetPattern(), "no reset info here", { now, maxDegradeMs: 30 * 24 * 3600_000 }), undefined);
});

test("parseResetTs：钳制到 [now+1min, now+maxDegradeMs]", () => {
	const now = Date.parse("2026-10-15T10:00:00+08:00");
	const maxDegradeMs = 3600_000;
	const past = parseResetTs(compileResetPattern(), "reset at 2020-01-01 00:00:00", { now, maxDegradeMs });
	assert.equal(past, now + 60_000);
	const far = parseResetTs(compileResetPattern(), "reset at 2030-01-01 00:00:00", { now, maxDegradeMs });
	assert.equal(far, now + maxDegradeMs);
});

test("parseResetTs：带 g 标记的正则也可重复调用", () => {
	const re = new RegExp(DEFAULT_RESET_PATTERN, "gi");
	const now = Date.parse("2026-10-15T10:00:00+08:00");
	const text = "reset at 2026-10-20 12:00:00";
	const first = parseResetTs(re, text, { now, maxDegradeMs: 30 * 24 * 3600_000 });
	const second = parseResetTs(re, text, { now, maxDegradeMs: 30 * 24 * 3600_000 });
	assert.equal(first, second);
	assert.notEqual(first, undefined);
});

test("parseDurationMs：单位与非法输入", () => {
	assert.equal(parseDurationMs("2h"), 7_200_000);
	assert.equal(parseDurationMs("30"), 1_800_000);
	assert.equal(parseDurationMs("500ms"), 500);
	assert.equal(parseDurationMs("1d"), 86_400_000);
	assert.equal(parseDurationMs("abc"), undefined);
	assert.equal(parseDurationMs("0"), undefined);
	assert.equal(parseDurationMs(""), undefined);
	assert.equal(parseDurationMs(undefined), undefined);
});

test("clampDegradeMs：只钳上界（小值原样保留）", () => {
	assert.equal(clampDegradeMs(5_000, 3_600_000), 5_000);
	assert.equal(clampDegradeMs(3_600_000, 3_600_000), 3_600_000);
	assert.equal(clampDegradeMs(7_200_000, 3_600_000), 3_600_000);
});

test("formatClock：full 与 short 两种形态", () => {
	const ts = new Date(2026, 9, 28, 23, 5).getTime();
	assert.equal(formatClock(ts), new Date(ts).toLocaleString());
	assert.equal(formatClock(ts, "short"), "10-28 23:05");
	assert.equal(formatClock(new Date(2026, 0, 3, 4, 5).getTime(), "short"), "01-03 04:05");
});
