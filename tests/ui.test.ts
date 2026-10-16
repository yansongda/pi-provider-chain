import assert from "node:assert/strict";
import { test } from "node:test";
import type { LoadedModel } from "../src/config.ts";
import { DEGRADE_TRIGGER, ENTRY_PREFIX } from "../src/constants.ts";
import { formatClock } from "../src/degrade.ts";
import type { DegradeEntry } from "../src/state.ts";
import {
	commandStatusHeader,
	degradeLine,
	deeperLevelKeptLine,
	describeModel,
	entryErrorDetail,
	entryErrorText,
	entryNoDataText,
	entryRecoverText,
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

test("degradeLine：notify 与转录条目共用同一句，writeFailed 才追加说明", () => {
	const shared = `⚠ volcengine 额度受限（AccountQuotaExceeded）→ 已切换 workbuddy/deepseek-v4.1-flash，恢复时间 ${formatClock(UNTIL)}`;
	assert.equal(
		degradeLine({ provider: "volcengine", reason: "AccountQuotaExceeded", to: "workbuddy/deepseek-v4.1-flash", until: UNTIL }),
		shared,
		"不传 writeFailed = 转录条目文案",
	);
	assert.equal(
		degradeLine({ provider: "volcengine", reason: "AccountQuotaExceeded", to: "workbuddy/deepseek-v4.1-flash", until: UNTIL, writeFailed: false }),
		shared,
		"显式 false 与 notify 逐字一致",
	);
	const failed = degradeLine({ provider: "volcengine", reason: "quota", to: "workbuddy/x", until: UNTIL, writeFailed: true });
	assert.ok(failed.includes("仅本进程生效"));

	// 手动降级（/chain degrade）：不再套用「额度受限（manual）」，换用专用句子
	const manual = degradeLine({ trigger: DEGRADE_TRIGGER.MANUAL, provider: "volcengine", reason: "manual", to: "workbuddy/x", until: UNTIL });
	assert.equal(manual, `⚠ 手动降级 volcengine → workbuddy/x，恢复时间 ${formatClock(UNTIL)}`);
	assert.equal(manual.includes("额度受限"), false);
	assert.ok(
		degradeLine({ trigger: DEGRADE_TRIGGER.MANUAL, provider: "volcengine", reason: "manual", to: "workbuddy/x", until: UNTIL, writeFailed: true }).includes(
			"仅本进程生效",
		),
	);
});

test("footer：常驻目标模型与降级恢复时间", () => {
	assert.equal(footerActive("volcengine/deepseek-v4.1-flash"), "⬇ volcengine/deepseek-v4.1-flash");
	assert.equal(
		footerDegraded({ target: "workbuddy/deepseek-v4.1-flash", until: UNTIL }),
		`⚠ 备用 workbuddy/deepseek-v4.1-flash · 恢复 ${formatClock(UNTIL, "short")}`,
	);
});

test("entry 文案：受限 provider 打头，恢复行与前缀不变", () => {
	assert.equal(ENTRY_PREFIX, "[chain]");
	assert.ok(
		degradeLine({ provider: "workbuddy", reason: "AccountQuotaExceeded", to: "glm/x", until: UNTIL }).startsWith(
			"⚠ workbuddy 额度受限（AccountQuotaExceeded）",
		),
		"档位 ≥ 1 时条目显示的必须是受限的那个 provider",
	);
	assert.equal(entryRecoverText("volcengine"), "✅ 已恢复主用 volcengine");
});

test("entry 文案：无数据 / 路由异常与错误截断", () => {
	assert.equal(entryNoDataText(), "[chain] (no data)");
	assert.equal(entryErrorText(), "⚠ 路由异常（已回落主用）");
	assert.equal(entryErrorDetail("x".repeat(700)).length, 600);
	assert.equal(entryErrorDetail("short"), "short");
});

test("deeperLevelKeptLine：状态未变化的回显（一条覆盖 level ≥ 1）", () => {
	assert.equal(
		deeperLevelKeptLine({ level: 2, to: "glm/deepseek-v4.1-flash", until: UNTIL }),
		`已存在降级档位，保持 level=2（glm/deepseek-v4.1-flash），至 ${formatClock(UNTIL)}`,
	);
	assert.equal(
		deeperLevelKeptLine({ level: 1, to: "workbuddy/deepseek-v4.1-flash", until: UNTIL }),
		`已存在降级档位，保持 level=1（workbuddy/deepseek-v4.1-flash），至 ${formatClock(UNTIL)}`,
		"盘上已有完全相同条目时也走这条（不再有「更深的」措辞）",
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
		degradeLine({ provider: "k", reason: "c", to: "t", until: UNTIL, writeFailed: false }),
		degradeLine({ trigger: DEGRADE_TRIGGER.MANUAL, provider: "k", reason: "manual", to: "t", until: UNTIL }),
		footerActive("t"),
		footerDegraded({ target: "t", until: UNTIL }),
		recoverNotice("p"),
		entryRecoverText("p"),
		entryNoDataText(),
		entryErrorText(),
		entryErrorDetail("x"),
		deeperLevelKeptLine({ level: 2, to: "t", until: UNTIL }),
		degradeLine({ provider: "k", reason: "c", to: "t", until: UNTIL }),
		...describeModel({ virtualProvider: "v", model: MODEL, active: ACTIVE }),
		...commandStatusHeader({ configPath: "c", stateFile: "s" }),
	].join("\n");
	assert.equal(/undefined|NaN/.test(text), false);
});
