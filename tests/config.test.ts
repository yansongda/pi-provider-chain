import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { agentDir, defaultConfigPath, defaultStateFile, expandPath, loadConfig } from "../src/config.ts";
import { DEFAULT_DEGRADE_MS, DEFAULT_RESET_PATTERN, MAX_DEGRADE_MS } from "../src/constants.ts";

function writeConfig(content: unknown): string {
	const path = join(mkdtempSync(join(tmpdir(), "pf-config-")), "provider-chain.json");
	writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content, null, 2), "utf8");
	return path;
}

const MINIMAL = {
	virtualProvider: "yansongda",
	models: [
		{
			id: "deepseek-v4.1-flash",
			name: "DeepSeek V4.1 Flash · auto",
			chain: ["volcengine/deepseek-v4.1-flash", "workbuddy/deepseek-v4.1-flash"],
		},
	],
};

test("合法最小配置：默认路径与链路解析", () => {
	const path = writeConfig(MINIMAL);
	const result = loadConfig(path, "/tmp/pf-agent");
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.loaded.virtualProvider, "yansongda");
	assert.equal(result.loaded.stateFile, join("/tmp/pf-agent", "provider-chain-state.json"));
	assert.deepEqual(result.loaded.models[0]?.chain, [
		{ provider: "volcengine", id: "deepseek-v4.1-flash" },
		{ provider: "workbuddy", id: "deepseek-v4.1-flash" },
	]);
	assert.equal(result.loaded.models[0]?.stateKey, "volcengine", "状态键 = chain[0] 的 provider");
	assert.equal(result.loaded.defaultDegradeMs, DEFAULT_DEGRADE_MS);
	assert.equal(result.loaded.maxDegradeMs, MAX_DEGRADE_MS);
	assert.equal(result.loaded.transcriptNotice, true);
	assert.equal(result.loaded.patterns.length > 0, true);
	assert.equal(result.loaded.resetRe.source, DEFAULT_RESET_PATTERN);
});

test("自定义 stateFile：支持 ~ 展开", () => {
	const path = writeConfig({ ...MINIMAL, stateFile: "~/custom/state.json" });
	const result = loadConfig(path, "/tmp/pf-agent");
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.loaded.stateFile, join(homedir(), "custom", "state.json"));
});

test("配置文件不存在 / 内容损坏", () => {
	const missing = join(mkdtempSync(join(tmpdir(), "pf-config-")), "nope.json");
	const missingResult = loadConfig(missing, "/tmp/pf-agent");
	assert.equal(missingResult.ok, false);
	if (!missingResult.ok) assert.ok(missingResult.error.includes("配置文件不存在"));

	const broken = loadConfig(writeConfig("{ not json"), "/tmp/pf-agent");
	assert.equal(broken.ok, false);
	if (!broken.ok) assert.ok(broken.error.includes("配置文件解析失败"));
});

test("缺少 virtualProvider / models 为空 / chain[0] 非法", () => {
	const noProvider = loadConfig(writeConfig({ models: MINIMAL.models }), "/tmp/pf-agent");
	assert.equal(noProvider.ok, false);
	if (!noProvider.ok) assert.equal(noProvider.error, "缺少 virtualProvider");

	const noModels = loadConfig(writeConfig({ virtualProvider: "yansongda", models: [] }), "/tmp/pf-agent");
	assert.equal(noModels.ok, false);
	if (!noModels.ok) assert.equal(noModels.error, "models[] 为空");

	const badPrimary = loadConfig(
		writeConfig({ virtualProvider: "yansongda", models: [{ id: "x", chain: ["noslash"] }] }),
		"/tmp/pf-agent",
	);
	assert.equal(badPrimary.ok, false);
	if (!badPrimary.ok) assert.ok(badPrimary.error.includes("models[] 条目缺少 id 或合法 chain[0]"));
});

test("chain 缺失 / 非数组 / 空数组 → 整条配置报错", () => {
	for (const chain of [undefined, "volcengine/x", [], [""], [123]]) {
		const result = loadConfig(
			writeConfig({ virtualProvider: "yansongda", models: [{ id: "x", ...(chain === undefined ? {} : { chain }) }] }),
			"/tmp/pf-agent",
		);
		assert.equal(result.ok, false, `chain=${JSON.stringify(chain)} 应报错`);
		if (!result.ok) assert.ok(result.error.includes("chain[0]"), result.error);
	}
});

test("chain[1..] 非法项被静默过滤，剩余链路仍可用", () => {
	const path = writeConfig({
		...MINIMAL,
		models: [{ ...MINIMAL.models[0], chain: ["volcengine/deepseek-v4.1-flash", "noslash", "", "workbuddy/glm-5.3"] }],
	});
	const result = loadConfig(path, "/tmp/pf-agent");
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.loaded.models[0]?.chain.length, 2);
	assert.equal(result.loaded.models[0]?.chain[1]?.provider, "workbuddy");
});

test("可选字段归一化：非法类型被丢弃、thinkingLevels 过滤非法项", () => {
	const path = writeConfig({
		...MINIMAL,
		models: [{ ...MINIMAL.models[0], name: 123, thinkingLevels: ["low", 3, " high ", ""], contextWindow: "1000000", maxTokens: 0 }],
	});
	const result = loadConfig(path, "/tmp/pf-agent");
	assert.equal(result.ok, true);
	if (!result.ok) return;
	const config = result.loaded.models[0]?.config;
	assert.equal(config?.id, "deepseek-v4.1-flash");
	assert.equal(config?.name, undefined);
	assert.deepEqual(config?.thinkingLevels, ["low", "high"]);
	assert.equal(config?.contextWindow, undefined);
	assert.equal(config?.maxTokens, undefined);
});

test("thinkingLevels 非数组 → 视为未声明（由装配层回落全部档位）", () => {
	const path = writeConfig({ ...MINIMAL, models: [{ ...MINIMAL.models[0], thinkingLevels: "low" }] });
	const result = loadConfig(path, "/tmp/pf-agent");
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.loaded.models[0]?.config.thinkingLevels, undefined);
});

test("input 归一化：只保留宿主支持的输入类型并去重，非法/空视为未声明", () => {
	const inputOf = (input: unknown) => {
		const path = writeConfig({ ...MINIMAL, models: [{ ...MINIMAL.models[0], input }] });
		const result = loadConfig(path, "/tmp/pf-agent");
		assert.equal(result.ok, true);
		return result.ok ? result.loaded.models[0]?.config.input : undefined;
	};
	assert.deepEqual(inputOf(["text", "image"]), ["text", "image"]);
	assert.deepEqual(inputOf(["image", "image", "text"]), ["image", "text"]);
	assert.deepEqual(inputOf(["text", "audio", 3]), ["text"]);
	assert.equal(inputOf([]), undefined);
	assert.equal(inputOf(["audio"]), undefined);
	assert.equal(inputOf("text"), undefined);
});

test("models[] 重复 id → 配置报错", () => {
	const path = writeConfig({ ...MINIMAL, models: [MINIMAL.models[0], { ...MINIMAL.models[0], chain: ["openrouter/other"] }] });
	const result = loadConfig(path, "/tmp/pf-agent");
	assert.equal(result.ok, false);
	if (!result.ok) assert.ok(result.error.includes("重复 id"), result.error);
});

test("非法数值与 resetPattern 回落默认", () => {
	const path = writeConfig({ ...MINIMAL, defaultDegradeMs: -1, maxDegradeMs: "big", resetPattern: "(" });
	const result = loadConfig(path, "/tmp/pf-agent");
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.loaded.defaultDegradeMs, DEFAULT_DEGRADE_MS);
	assert.equal(result.loaded.maxDegradeMs, MAX_DEGRADE_MS);
	assert.equal(result.loaded.resetRe.source, DEFAULT_RESET_PATTERN);
});

test("transcriptNotice: false 生效", () => {
	const path = writeConfig({ ...MINIMAL, transcriptNotice: false });
	const result = loadConfig(path, "/tmp/pf-agent");
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.loaded.transcriptNotice, false);
});

test("degradePatterns 覆盖默认值", () => {
	const path = writeConfig({ ...MINIMAL, degradePatterns: ["custom_quota"] });
	const result = loadConfig(path, "/tmp/pf-agent");
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.deepEqual(
		result.loaded.patterns.map((p) => p.source),
		["custom_quota"],
	);
});

test("degradePatterns 为空数组 → 回落内置默认（不再报错）", () => {
	const path = writeConfig({ ...MINIMAL, degradePatterns: [] });
	const result = loadConfig(path, "/tmp/pf-agent");
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.loaded.patterns.length > 0, true);
	assert.equal(result.loaded.patterns[0]?.source, "AccountQuotaExceeded");
});

test("defaultDegradeMs 被 maxDegradeMs 钳制（maxDegradeMs 是硬上限）", () => {
	const path = writeConfig({ ...MINIMAL, defaultDegradeMs: 7 * 24 * 3600_000, maxDegradeMs: 3600_000 });
	const result = loadConfig(path, "/tmp/pf-agent");
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.loaded.maxDegradeMs, 3600_000);
	assert.equal(result.loaded.defaultDegradeMs, 3600_000);
});

test("agentDir/defaultConfigPath/defaultStateFile 跟随 PI_CODING_AGENT_DIR", () => {
	const original = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = "/tmp/pf-agent-env";
	try {
		assert.equal(agentDir(), "/tmp/pf-agent-env");
		assert.equal(defaultConfigPath(), join("/tmp/pf-agent-env", "provider-chain.json"));
		assert.equal(defaultStateFile(), join("/tmp/pf-agent-env", "provider-chain-state.json"));
	} finally {
		if (original === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = original;
	}
	assert.equal(expandPath("~").length > 1, true);
});
