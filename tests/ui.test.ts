import assert from "node:assert/strict";
import { test } from "node:test";
import type { LoadedModel } from "../src/config.ts";
import { DEGRADE_REASON, DEGRADE_TRIGGER, ENTRY_PREFIX } from "../src/constants.ts";
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
	footerActive,
	footerDegraded,
	levelBadge,
	recoverNotice,
} from "../src/ui.ts";

const UNTIL = new Date(2026, 9, 28, 23, 59).getTime();
const UNTIL_TEXT = "2026-10-28 23:59";

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

test("formatClock：统一 YYYY-MM-DD HH:mm，不依赖 locale", () => {
	assert.equal(formatClock(UNTIL), UNTIL_TEXT);
	assert.equal(formatClock(new Date(2026, 0, 3, 4, 5).getTime()), "2026-01-03 04:05");
	assert.equal(formatClock(Number.NaN), "NaN");
});

test("levelBadge：0–9 用圈码，≥10 直接数字，异常值回落 0", () => {
	assert.equal(levelBadge(0), "⓪");
	assert.equal(levelBadge(1), "①");
	assert.equal(levelBadge(9), "⑨");
	assert.equal(levelBadge(10), "10");
	assert.equal(levelBadge(-1), "-1");
	assert.equal(levelBadge(Number.NaN), "⓪");
	assert.equal(levelBadge(1.9), "①", "非整数取整");
});

test("degradeLine：notify 与转录条目共用同一句，writeFailed 才追加说明", () => {
	const shared = `⚠ volcengine 额度受限（AccountQuotaExceeded）→ ① workbuddy/deepseek-v4.1-flash · ${UNTIL_TEXT} 恢复`;
	assert.equal(
		degradeLine({
			provider: "volcengine",
			reason: "AccountQuotaExceeded",
			level: 1,
			to: "workbuddy/deepseek-v4.1-flash",
			until: UNTIL,
		}),
		shared,
		"不传 writeFailed = 转录条目文案",
	);
	assert.equal(
		degradeLine({
			provider: "volcengine",
			reason: "AccountQuotaExceeded",
			level: 1,
			to: "workbuddy/deepseek-v4.1-flash",
			until: UNTIL,
			writeFailed: false,
		}),
		shared,
		"显式 false 与 notify 逐字一致",
	);
	const failed = degradeLine({
		provider: "volcengine",
		reason: "quota",
		level: 1,
		to: "workbuddy/x",
		until: UNTIL,
		writeFailed: true,
	});
	assert.equal(failed, `⚠ volcengine 额度受限（quota）→ ① workbuddy/x · ${UNTIL_TEXT} 恢复；状态写入失败，仅本进程生效`);

	// 手动降级（/chain degrade）：不再套用「额度受限（manual）」，换用专用句子
	const manual = degradeLine({
		trigger: DEGRADE_TRIGGER.MANUAL,
		provider: "volcengine",
		reason: "manual",
		level: 1,
		to: "workbuddy/x",
		until: UNTIL,
	});
	assert.equal(manual, `⚠ 手动降级 volcengine → ① workbuddy/x · ${UNTIL_TEXT} 恢复`);
	assert.equal(manual.includes("额度受限"), false);
	assert.ok(
		degradeLine({
			trigger: DEGRADE_TRIGGER.MANUAL,
			provider: "volcengine",
			reason: "manual",
			level: 1,
			to: "workbuddy/x",
			until: UNTIL,
			writeFailed: true,
		}).endsWith("；状态写入失败，仅本进程生效"),
	);
});

test("footer：档位徽标 + 目标；降级追加恢复方与最早恢复时间", () => {
	assert.equal(footerActive("volcengine/deepseek-v4.1-flash"), "⓪ volcengine/deepseek-v4.1-flash");
	assert.equal(
		footerDegraded({ level: 1, target: "workbuddy/deepseek-v4.1-flash", provider: "volcengine", until: UNTIL }),
		`① workbuddy/deepseek-v4.1-flash · volcengine ${UNTIL_TEXT} 恢复`,
	);
});

test("entry 文案：来源前缀统一为 [pi-provider-chain]，恢复与路由异常回到 ⓪", () => {
	assert.equal(ENTRY_PREFIX, "[pi-provider-chain]");
	assert.ok(
		degradeLine({
			provider: "workbuddy",
			reason: "AccountQuotaExceeded",
			level: 2,
			to: "glm/x",
			until: UNTIL,
		}).startsWith("⚠ workbuddy 额度受限（AccountQuotaExceeded）→ ② glm/x"),
		"档位 ≥ 1 时条目显示的必须是受限的那个 provider",
	);
	assert.equal(recoverNotice("volcengine"), "✓ 已恢复到 ⓪ volcengine");
	assert.equal(entryErrorText("volcengine"), "⚠ 路由异常（已回到 ⓪ volcengine）");
	assert.equal(entryErrorText(), "⚠ 路由异常（已回到 ⓪）", "旧条目没有 provider 时省略它");
});

test("entry 文案：无数据 / 错误截断", () => {
	assert.equal(entryNoDataText(), "（无数据）");
	assert.equal(entryErrorDetail("x".repeat(700)).length, 600);
	assert.equal(entryErrorDetail("short"), "short");
});

test("deeperLevelKeptLine：状态未变化时的回显（徽标 + 实际生效目标）", () => {
	assert.equal(
		deeperLevelKeptLine({ level: 2, to: "glm/deepseek-v4.1-flash", until: UNTIL }),
		`⚠ 已有更深降级，保持 ② glm/deepseek-v4.1-flash · ${UNTIL_TEXT} 恢复`,
	);
	assert.equal(
		deeperLevelKeptLine({ level: 1, to: "workbuddy/deepseek-v4.1-flash", until: UNTIL }),
		`⚠ 已有更深降级，保持 ① workbuddy/deepseek-v4.1-flash · ${UNTIL_TEXT} 恢复`,
	);
});

test("recoverNotice：notify 与条目共用同一句", () => {
	assert.equal(recoverNotice("volcengine"), "✓ 已恢复到 ⓪ volcengine");
});

test("describeModel：降级中（含原因与恢复时间）", () => {
	const lines = describeModel({ virtualProvider: "yansongda", model: MODEL, active: ACTIVE });
	assert.equal(lines.length, 4);
	assert.equal(lines[0], "yansongda/deepseek-v4.1-flash");
	assert.equal(lines[1], "  链路: volcengine/deepseek-v4.1-flash → workbuddy/deepseek-v4.1-flash");
	assert.equal(lines[2], "  状态: ① workbuddy/deepseek-v4.1-flash");
	assert.equal(lines[3], `  原因: AccountQuotaExceeded · ${UNTIL_TEXT} 恢复`);
});

test("describeModel：已过期 / 档位 0", () => {
	const stale = describeModel({ virtualProvider: "yansongda", model: MODEL, stale: STALE });
	assert.equal(stale.length, 3);
	assert.equal(stale[2], "  状态: 已过期（下一请求回到 ⓪ volcengine）");

	const primary = describeModel({ virtualProvider: "yansongda", model: MODEL });
	assert.equal(primary.length, 3);
	assert.equal(primary[2], "  状态: ⓪ volcengine/deepseek-v4.1-flash");
});

test("describeModel：恢复墓碑（level 0）显示档位 ⓪，而不是「已过期」", () => {
	const recovered: DegradeEntry = { level: 0, until: STALE.until, reason: DEGRADE_REASON.RECOVERED, at: STALE.at };
	const lines = describeModel({ virtualProvider: "yansongda", model: MODEL, stale: recovered });
	assert.equal(lines[2], "  状态: ⓪ volcengine/deepseek-v4.1-flash");
});

test("describeModel：档位越界时按 clamp 后的实际档位显示徽标", () => {
	const lines = describeModel({ virtualProvider: "yansongda", model: MODEL, active: { ...ACTIVE, level: 9 } });
	assert.equal(lines[2], "  状态: ① workbuddy/deepseek-v4.1-flash");
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
	assert.equal(commandStatusHeader({ configPath: "c", stateFile: "s" })[0], "当前: （未选择）");
});

test("ui 模块只做格式化：输出不含 undefined/NaN", () => {
	const text = [
		degradeLine({ provider: "k", reason: "c", level: 2, to: "t", until: UNTIL, writeFailed: false }),
		degradeLine({ trigger: DEGRADE_TRIGGER.MANUAL, provider: "k", reason: "manual", level: 2, to: "t", until: UNTIL }),
		footerActive("t"),
		footerDegraded({ level: 2, target: "t", provider: "k", until: UNTIL }),
		recoverNotice("p"),
		entryNoDataText(),
		entryErrorText("p"),
		entryErrorText(),
		entryErrorDetail("x"),
		deeperLevelKeptLine({ level: 2, to: "t", until: UNTIL }),
		...describeModel({ virtualProvider: "v", model: MODEL, active: ACTIVE }),
		...commandStatusHeader({ configPath: "c", stateFile: "s" }),
	].join("\n");
	assert.equal(/undefined|NaN/.test(text), false);
});
