import assert from "node:assert/strict";
import { test } from "node:test";
import type { LoadedModel } from "../src/config.ts";
import { formatClock, formatClockShort } from "../src/degrade.ts";
import type { DegradeEntry } from "../src/state.ts";
import {
	commandStatusHeader,
	degradeNotice,
	describeModel,
	ENTRY_PREFIX,
	entryDegradeLine,
	entryRecoverText,
	recoverNotice,
	statusText,
} from "../src/ui.ts";

const UNTIL = new Date(2026, 9, 28, 23, 59).getTime();

const MODEL: LoadedModel = {
	config: { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash · auto", primary: "volcengine/deepseek-v4.1-flash" },
	key: "volcengine",
	chain: [
		{ provider: "volcengine", id: "deepseek-v4.1-flash" },
		{ provider: "workbuddy", id: "deepseek-v4.1-flash" },
	],
};

const ACTIVE: DegradeEntry = { level: 1, until: UNTIL, code: "AccountQuotaExceeded", at: UNTIL - 3_600_000 };
const STALE: DegradeEntry = { level: 1, until: UNTIL - 86_400_000, code: "AccountQuotaExceeded", at: UNTIL - 90_000_000 };

test("degradeNotice：正常与写失败两种文案", () => {
	assert.equal(
		degradeNotice({ key: "volcengine", code: "AccountQuotaExceeded", to: "workbuddy/deepseek-v4.1-flash", until: UNTIL, writeFailed: false }),
		`⚠ volcengine 额度受限（AccountQuotaExceeded）→ 已切换 workbuddy/deepseek-v4.1-flash，恢复时间 ${formatClock(UNTIL)}`,
	);
	const failed = degradeNotice({ key: "volcengine", code: "quota", to: "workbuddy/x", until: UNTIL, writeFailed: true });
	assert.ok(failed.includes("仅本进程生效"));
});

test("statusText：单条紧凑、多条汇总、无条目清空", () => {
	assert.equal(statusText([{ provider: "workbuddy", until: UNTIL }]), `⚠ 备用 workbuddy · ${formatClockShort(UNTIL)}`);
	assert.equal(statusText([]), undefined);
	assert.equal(
		statusText([
			{ provider: "workbuddy", until: UNTIL },
			{ provider: "openrouter", until: UNTIL + 60_000 },
		]),
		"⚠ 备用 ×2: workbuddy, openrouter",
	);
	assert.equal(recoverNotice("volcengine"), "✅ volcengine 已恢复，后续请求回到主用");
});

test("entry 文案：降级行/恢复行/前缀", () => {
	assert.equal(ENTRY_PREFIX, "[fallback]");
	assert.deepEqual(entryDegradeLine({ code: "AccountQuotaExceeded", to: "workbuddy/deepseek-v4.1-flash", until: UNTIL }), {
		text: "⚠ 额度受限（AccountQuotaExceeded）→ 降级到 workbuddy/deepseek-v4.1-flash",
		dim: `  ·  恢复 ${formatClock(UNTIL)}`,
	});
	assert.equal(entryRecoverText("volcengine"), "✅ 已恢复主用 volcengine");
});

test("describeModel：降级中（含原因与恢复时间）", () => {
	const lines = describeModel({ virtualProvider: "yansongda", model: MODEL, active: ACTIVE });
	assert.equal(lines.length, 4);
	assert.equal(lines[0], "yansongda/deepseek-v4.1-flash");
	assert.equal(lines[1], "  链路: volcengine/deepseek-v4.1-flash  →  workbuddy/deepseek-v4.1-flash");
	assert.equal(lines[2], "  状态: 降级 level=1（workbuddy/deepseek-v4.1-flash）");
	assert.equal(lines[3], `  原因: AccountQuotaExceeded  ·  恢复: ${formatClock(UNTIL)}`);
});

test("describeModel：已过期 / 主用", () => {
	const stale = describeModel({ virtualProvider: "yansongda", model: MODEL, stale: STALE });
	assert.equal(stale.length, 3);
	assert.equal(stale[2], "  状态: 已过期（下一请求尝试主用）");

	const primary = describeModel({ virtualProvider: "yansongda", model: MODEL });
	assert.equal(primary.length, 3);
	assert.equal(primary[2], "  状态: 主用");
});

test("describeModel：档位越界时链路描述不抛错", () => {
	const lines = describeModel({ virtualProvider: "yansongda", model: MODEL, active: { ...ACTIVE, level: 9 } });
	assert.equal(lines[2], "  状态: 降级 level=9（workbuddy/deepseek-v4.1-flash）");
});

test("commandStatusHeader：含配置与状态文件路径", () => {
	const lines = commandStatusHeader({
		selection: "yansongda/deepseek-v4.1-flash",
		configPath: "/tmp/pf/provider-fallback.json",
		stateFile: "/tmp/pf/provider-fallback-state.json",
	});
	assert.deepEqual(lines, [
		"当前: yansongda/deepseek-v4.1-flash",
		"配置: /tmp/pf/provider-fallback.json",
		"状态文件: /tmp/pf/provider-fallback-state.json",
		"",
	]);
	assert.equal(commandStatusHeader({ configPath: "c", stateFile: "s" })[0], "当前: (未选择)");
});

test("ui 模块只做格式化：输出不含 undefined/NaN", () => {
	const text = [
		degradeNotice({ key: "k", code: "c", to: "t", until: UNTIL, writeFailed: false }),
		statusText([{ provider: "p", until: UNTIL }]),
		recoverNotice("p"),
		entryRecoverText("p"),
		...Object.values(entryDegradeLine({ code: "c", to: "t", until: UNTIL })),
		...describeModel({ virtualProvider: "v", model: MODEL, active: ACTIVE }),
		...commandStatusHeader({ configPath: "c", stateFile: "s" }),
	].join("\n");
	assert.equal(/undefined|NaN/.test(text), false);
});
