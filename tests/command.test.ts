import assert from "node:assert/strict";
import { test } from "node:test";
import { COMMAND_USAGE } from "../src/constants.ts";
import { parseCommandArgs } from "../src/command.ts";

test("parseCommandArgs：默认与显式 status", () => {
	assert.deepEqual(parseCommandArgs(), { action: "status" });
	assert.deepEqual(parseCommandArgs("  "), { action: "status" });
	assert.deepEqual(parseCommandArgs("status"), { action: "status" });
	assert.deepEqual(parseCommandArgs("STATUS"), { action: "status" });
});

test("parseCommandArgs：degrade 与其别名、时长解析", () => {
	assert.deepEqual(parseCommandArgs("degrade"), { action: "degrade", durationMs: undefined });
	assert.deepEqual(parseCommandArgs("fallback 30m"), { action: "status", unknown: "fallback" }, "fallback 不再是子命令");
	assert.deepEqual(parseCommandArgs("degrade 2h"), { action: "degrade", durationMs: 7_200_000 });
	assert.deepEqual(parseCommandArgs("degrade abc"), { action: "degrade", durationMs: undefined });
});

test("parseCommandArgs：reset 别名与 reload", () => {
	for (const alias of ["reset", "primary", "clear"]) {
		assert.deepEqual(parseCommandArgs(alias), { action: "reset" }, alias);
	}
	assert.deepEqual(parseCommandArgs("reload"), { action: "reload" });
});

test("parseCommandArgs：未知子命令回落到 status 并带原文", () => {
	assert.deepEqual(parseCommandArgs("30m"), { action: "status", unknown: "30m" });
	assert.equal(COMMAND_USAGE.includes("degrade"), true);
});
