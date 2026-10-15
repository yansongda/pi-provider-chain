import assert from "node:assert/strict";
import { test } from "node:test";
import type { LoadedModel } from "../src/config.ts";
import { ENTRY_PREFIX } from "../src/constants.ts";
import { formatClock } from "../src/degrade.ts";
import type { DegradeEntry } from "../src/state.ts";
import {
	commandStatusHeader,
	degradeNotice,
	deeperLevelKeptLine,
	describeModel,
	entryDegradeLine,
	entryErrorDetail,
	entryErrorText,
	entryNoDataText,
	entryRecoverText,
	manualDegradeLine,
	recoverNotice,
	footerActive,
	footerDegraded,
} from "../src/ui.ts";

const UNTIL = new Date(2026, 9, 28, 23, 59).getTime();

const MODEL: LoadedModel = {
	config: { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash · auto" },
	stateKey: "volcengine",
	chain: [
		{ provider: "volcengine", id: "deepseek-v4.1-flash" },
		{ provider: "workbuddy", id: "deepseek-v4.1-flash" },
	],
};

const ACTIVE: DegradeEntry = { level: 1, until: UNTIL, reason: "AccountQuotaExceeded", at: UNTIL - 3_600_000 };
const STALE: DegradeEntry = { level: 1, until: UNTIL - 86_400_000, reason: "AccountQuotaExceeded", at: UNTIL - 90_000_000 };

test("degradeNotice：正常与写失败两种文案", () => {
	assert.equal(
		degradeNotice({ provider: "volcengine", reason: "AccountQuotaExceeded", to: "workbuddy/deepseek-v4.1-flash", until: UNTIL, writeFailed: false }),
		`⚠ volcengine 额度受限（AccountQuotaExceeded）→ 已切换 workbuddy/deepseek-v4.1-flash，恢复时间 ${formatClock(UNTIL)}`,
	);
	const failed = degradeNotice({ provider: "volcengine", reason: "quota", to: "workbuddy/x", until: UNTIL, writeFailed: true });
	assert.ok(failed.includes("仅本进程生效"));
});

test("footer：常驻目标模型与降级恢复时间", () => {
	assert.equal(footerActive("volcengine/deepseek-v4.1-flash"), "⬇ volcengine/deepseek-v4.1-flash");
	assert.equal(
		footerDegraded({ target: "workbuddy/deepseek-v4.1-flash", until: UNTIL }),
		`⚠ 备用 workbuddy/deepseek-v4.1-flash · 恢复 ${formatClock(UNTIL, "short")}`,
	);
});

test("entry 文案：降级行/恢复行/前缀", () => {
	assert.equal(ENTRY_PREFIX, "[chain]");
	assert.deepEqual(entryDegradeLine({ reason: "AccountQuotaExceeded", to: "workbuddy/deepseek-v4.1-flash", until: UNTIL }), {
		text: "⚠ 额度受限（AccountQuotaExceeded）→ 降级到 workbuddy/deepseek-v4.1-flash",
		dim: `  ·  恢复 ${formatClock(UNTIL)}`,
	});
	assert.equal(entryRecoverText("volcengine"), "✅ 已恢复主用 volcengine");
});

test("entry 文案：无数据 / 路由异常与错误截断", () => {
	assert.equal(entryNoDataText(), "[chain] (no data)");
	assert.equal(entryErrorText(), "⚠ 路由异常（已回落主用）");
	assert.equal(entryErrorDetail("x".repeat(700)).length, 600);
	assert.equal(entryErrorDetail("short"), "short");
});

test("manualDegradeLine / deeperLevelKeptLine：手动降级两种文案", () => {
	assert.equal(
		manualDegradeLine({ model: "yansongda/deepseek-v4.1-flash", to: "workbuddy/deepseek-v4.1-flash", until: UNTIL }),
		`已手动降级 yansongda/deepseek-v4.1-flash → workbuddy/deepseek-v4.1-flash，至 ${formatClock(UNTIL)}`,
	);
	assert.equal(
		deeperLevelKeptLine({ level: 2, to: "glm/deepseek-v4.1-flash", until: UNTIL }),
		`已存在更深的降级档位，保持 level=2（glm/deepseek-v4.1-flash），至 ${formatClock(UNTIL)}`,
	);
});

test("recoverNotice：恢复提示文案", () => {
	assert.equal(recoverNotice("volcengine"), "✅ volcengine 已恢复，后续请求回到主用");
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
		configPath: "/tmp/pf/provider-chain.json",
		stateFile: "/tmp/pf/provider-chain-state.json",
	});
	assert.deepEqual(lines, [
		"当前: yansongda/deepseek-v4.1-flash",
		"配置: /tmp/pf/provider-chain.json",
		"状态文件: /tmp/pf/provider-chain-state.json",
		"",
	]);
	assert.equal(commandStatusHeader({ configPath: "c", stateFile: "s" })[0], "当前: (未选择)");
});

test("ui 模块只做格式化：输出不含 undefined/NaN", () => {
	const text = [
		degradeNotice({ provider: "k", reason: "c", to: "t", until: UNTIL, writeFailed: false }),
		footerActive("t"),
		footerDegraded({ target: "t", until: UNTIL }),
		recoverNotice("p"),
		entryRecoverText("p"),
		entryNoDataText(),
		entryErrorText(),
		entryErrorDetail("x"),
		manualDegradeLine({ model: "m", to: "t", until: UNTIL }),
		deeperLevelKeptLine({ level: 2, to: "t", until: UNTIL }),
		...Object.values(entryDegradeLine({ reason: "c", to: "t", until: UNTIL })),
		...describeModel({ virtualProvider: "v", model: MODEL, active: ACTIVE }),
		...commandStatusHeader({ configPath: "c", stateFile: "s" }),
	].join("\n");
	assert.equal(/undefined|NaN/.test(text), false);
});
