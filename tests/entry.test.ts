import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * 装配层集成测试：stub pi + 临时 AGENT_DIR。
 *
 * 覆盖：虚拟模型注册、无降级时走主用、状态文件里有降级时走备用、
 * retry 命中额度错误时自动推进档位并写状态、配置缺失时的降级路径、/fallback 命令注册与执行。
 */

interface RouteResult {
	model: { provider: string; id: string };
	thinkingLevel?: string;
}

interface CapturedModel {
	provider: string;
	id: string;
	name: string;
	thinkingLevels?: readonly string[];
	input?: readonly string[];
	route: (request: unknown, ctx: unknown) => RouteResult | Promise<RouteResult>;
}

interface StubPi {
	registerEntryRenderer: (type: string, renderer: unknown) => void;
	registerVirtualModel: (definition: CapturedModel) => void;
	registerCommand: (name: string, options: Omit<CapturedCommand, "name">) => void;
	on: (type: string, handler: (event: unknown, ctx: unknown) => unknown) => void;
	appendEntry: (type: string, data?: unknown) => void;
}

interface CapturedCommand {
	name: string;
	description?: string;
	getArgumentCompletions?: (prefix: string) => Array<{ value: string }> | null;
	handler: (args: string, ctx: unknown) => Promise<void>;
}

const CONFIG = {
	virtualProvider: "yansongda",
	models: [
		{
			id: "deepseek-v4.1-flash",
			name: "DeepSeek V4.1 Flash · auto",
			thinkingLevels: ["low", "high", "max"],
			chain: ["volcengine/deepseek-v4.1-flash", "workbuddy/deepseek-v4.1-flash"],
		},
	],
};

function makeAgentDir(options: { config?: unknown; state?: unknown } = {}): string {
	const dir = mkdtempSync(join(tmpdir(), "pf-entry-"));
	if (options.config !== undefined) writeFileSync(join(dir, "provider-chain.json"), JSON.stringify(options.config, null, 2), "utf8");
	if (options.state !== undefined) writeFileSync(join(dir, "provider-chain-state.json"), JSON.stringify(options.state, null, 2), "utf8");
	return dir;
}

const CONFIG2 = {
	virtualProvider: "yansongda",
	models: [
		{ id: "a", chain: ["volcengine/a", "workbuddy/a"] },
		{ id: "b", chain: ["openrouter/b", "glm/b"] },
	],
};

/** `loadExtension` 会临时改写 `PI_CODING_AGENT_DIR`；每个用例结束后恢复，避免测试间环境污染。 */
let restoreAgentDir: (() => void) | undefined;

afterEach(() => {
	restoreAgentDir?.();
	restoreAgentDir = undefined;
});

async function loadExtension(dir: string) {
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	restoreAgentDir = () => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	};
	const factory = (await import("../extensions/provider-chain.ts")).default;
	const captured: {
		models: CapturedModel[];
		commands: string[];
		commandOptions: Map<string, CapturedCommand>;
		handlers: Map<string, (event: unknown, ctx: unknown) => unknown>;
		entries: unknown[];
	} = {
		models: [],
		commands: [],
		commandOptions: new Map(),
		handlers: new Map(),
		entries: [],
	};
	const stub: StubPi = {
		registerEntryRenderer: () => {},
		registerVirtualModel: (definition) => captured.models.push(definition),
		registerCommand: (name, options) => {
			captured.commands.push(name);
			captured.commandOptions.set(name, { name, ...options });
		},
		on: (type, handler) => captured.handlers.set(type, handler),
		appendEntry: (_type, data) => captured.entries.push(data),
	};
	factory(stub as unknown as ExtensionAPI);
	return captured;
}

function makeCtx() {
	const notifications: Array<{ message: string; kind: string }> = [];
	const status: Array<string | undefined> = [];
	return {
		ctx: {
			hasUI: true,
			model: { provider: "yansongda", id: "deepseek-v4.1-flash" },
			modelRegistry: {
				find: (provider: string, id: string) => ({ provider, id }),
				hasConfiguredAuth: () => true,
			},
			ui: {
				notify: (message: string, kind: string) => notifications.push({ message, kind }),
				setStatus: (_key: string, text: string | undefined) => status.push(text),
			},
		},
		notifications,
		status,
	};
}

function readDegraded(dir: string) {
	return JSON.parse(readFileSync(join(dir, "provider-chain-state.json"), "utf8")) as {
		degraded: Record<string, { level: number; reason: string; until: number }>;
	};
}

test("注册虚拟模型与 /chain 命令（provider / id / 思考档位来自配置）", async () => {
	const captured = await loadExtension(makeAgentDir({ config: CONFIG }));
	assert.deepEqual(captured.commands, ["chain"]);
	const command = captured.commandOptions.get("chain");
	assert.ok(command?.description?.includes("degrade"), "description 应含主要子命令 degrade");
	assert.deepEqual(
		command?.getArgumentCompletions?.("res")?.map((item) => item.value),
		["reset"],
	);
	assert.equal(command?.getArgumentCompletions?.("")?.length, 4);
	assert.equal(captured.models.length, 1);
	const model = captured.models[0];
	assert.ok(model);
	assert.equal(model.provider, "yansongda");
	assert.equal(model.id, "deepseek-v4.1-flash");
	assert.equal(model.name, "DeepSeek V4.1 Flash · auto");
	assert.deepEqual(model.thinkingLevels, ["low", "high", "max"]);
	assert.ok(captured.handlers.has("agent_before_settle"));
	assert.ok(captured.handlers.has("message_end"));
	assert.ok(captured.handlers.has("session_start"));
	assert.ok(captured.handlers.has("model_select"));
});

test("无降级状态：route() 返回主用物理模型", async () => {
	const captured = await loadExtension(makeAgentDir({ config: CONFIG }));
	const { ctx } = makeCtx();
	const decision = await captured.models[0]!.route({ reason: "user", thinkingLevel: "max", messages: [] }, ctx);
	assert.deepEqual(decision, { model: { provider: "volcengine", id: "deepseek-v4.1-flash" }, thinkingLevel: "max" });
});

test("状态文件已降级：route() 返回备用物理模型", async () => {
	const dir = makeAgentDir({
		config: CONFIG,
		state: {
			version: 1,
			degraded: { volcengine: { level: 1, until: Date.now() + 3_600_000, reason: "e2e", at: Date.now() } },
		},
	});
	const captured = await loadExtension(dir);
	const { ctx } = makeCtx();
	const decision = await captured.models[0]!.route({ reason: "user", thinkingLevel: "high", messages: [] }, ctx);
	assert.equal(decision.model.provider, "workbuddy");
	assert.equal(decision.thinkingLevel, "high");
});

test("retry 命中额度错误：自动推进档位、写状态、notify 一次，并保留失败请求的思考档位", async () => {
	const dir = makeAgentDir({ config: CONFIG });
	const captured = await loadExtension(dir);
	const { ctx, notifications } = makeCtx();
	const decision = await captured.models[0]!.route(
		{
			reason: "retry",
			thinkingLevel: "max",
			messages: [],
			failed: {
				model: { provider: "volcengine", id: "deepseek-v4.1-flash" },
				thinkingLevel: "low",
				message: { stopReason: "error", errorMessage: "AccountQuotaExceeded: reset at 2030-01-01 00:00:00" },
			},
		},
		ctx,
	);
	// 推进后失败模型不再是当前档位 → 不 keep，用请求档位
	assert.equal(decision.model.provider, "workbuddy");
	assert.equal(decision.thinkingLevel, "max");

	const state = readDegraded(dir);
	assert.equal(state.degraded.volcengine?.level, 1);
	assert.equal(state.degraded.volcengine?.reason, "AccountQuotaExceeded");
	assert.equal(notifications.length, 1);
	assert.ok(notifications[0]!.message.includes("AccountQuotaExceeded"));
	assert.ok(notifications[0]!.message.includes("workbuddy/deepseek-v4.1-flash"));
});

test("models[].input：声明则透传给注册定义，未声明则不携带该字段", async () => {
	const declared = await loadExtension(
		makeAgentDir({ config: { ...CONFIG, models: [{ ...CONFIG.models[0], input: ["text"] }] } }),
	);
	assert.deepEqual(declared.models[0]?.input, ["text"]);

	const omitted = await loadExtension(makeAgentDir({ config: CONFIG }));
	assert.equal(omitted.models[0]?.input, undefined, "未声明时不传，保持宿主默认（text + image）");
});

test("配置缺失：不注册虚拟模型，session_start 提示未启用", async () => {
	const captured = await loadExtension(makeAgentDir());
	assert.equal(captured.models.length, 0);
	assert.deepEqual(captured.commands, ["chain"]);
	const { ctx, notifications } = makeCtx();
	captured.handlers.get("session_start")?.({ type: "session_start" }, ctx);
	assert.equal(notifications.length, 1);
	assert.ok(notifications[0]!.message.includes("未启用"));
	assert.equal(notifications[0]!.kind, "error");
});

test("agent_before_settle：额度错误 → 写降级状态、剔除失败消息并续跑一次", async () => {
	const dir = makeAgentDir({ config: CONFIG });
	const captured = await loadExtension(dir);
	const { ctx, notifications } = makeCtx();
	const failedAssistant = {
		role: "assistant",
		provider: "volcengine",
		model: "deepseek-v4.1-flash",
		stopReason: "error",
		errorMessage: "403 InvalidSubscription: subscription has expired, reset at 2030-01-01 00:00:00",
	};
	const result = captured.handlers.get("agent_before_settle")?.(
		{
			outcome: "error",
			entries: [],
			continue: false,
			context: {
				contextEntries: [{ sourceEntry: { id: "entry-1" }, messages: [failedAssistant] }],
				contextMessages: [failedAssistant],
			},
		},
		ctx,
	);

	assert.deepEqual(result, { entries: [{ type: "context_edit", targetId: "entry-1", replacement: null }], continue: true });
	const state = readDegraded(dir);
	assert.equal(state.degraded.volcengine?.level, 1);
	assert.equal(state.degraded.volcengine?.reason, "InvalidSubscription");
	assert.equal(notifications.length, 1);
	assert.ok(notifications[0]!.message.includes("workbuddy/deepseek-v4.1-flash"));
	assert.ok(notifications[0]!.message.startsWith("⚠ volcengine 额度受限"));
	const entry = captured.entries.at(-1) as { kind?: string; from?: string; provider?: string } | undefined;
	assert.equal(entry?.kind, "degrade");
	assert.equal(entry?.from, "volcengine", "settle 路径的受限 provider 取自失败消息");
	assert.equal(entry?.provider, "volcengine", "状态键不变");
});

test("agent_before_settle：非额度错误不接管", async () => {
	const captured = await loadExtension(makeAgentDir({ config: CONFIG }));
	const { ctx } = makeCtx();
	const result = captured.handlers.get("agent_before_settle")?.(
		{
			outcome: "error",
			entries: [],
			continue: false,
			context: {
				contextEntries: [],
				contextMessages: [
					{ role: "assistant", provider: "volcengine", id: "deepseek-v4.1-flash", stopReason: "error", errorMessage: "ECONNRESET" },
				],
			},
		},
		ctx,
	);
	assert.equal(result, undefined);
});

test("agent_before_settle：找不到失败消息所在 entry 时，仍写降级状态但不续跑", async () => {
	const dir = makeAgentDir({ config: CONFIG });
	const captured = await loadExtension(dir);
	const { ctx, notifications } = makeCtx();
	const failedAssistant = {
		role: "assistant",
		provider: "volcengine",
		model: "deepseek-v4.1-flash",
		stopReason: "error",
		errorMessage: "AccountQuotaExceeded: no reset info",
	};
	const result = captured.handlers.get("agent_before_settle")?.(
		{
			outcome: "error",
			entries: [],
			continue: false,
			context: {
				contextEntries: [{ sourceEntry: {}, messages: [failedAssistant] }], // 无 id → 无法剔除
				contextMessages: [failedAssistant],
			},
		},
		ctx,
	);

	assert.equal(result, undefined, "不应续跑");
	assert.equal(readDegraded(dir).degraded.volcengine?.level, 1, "仍应写入降级状态，让下一次请求走备用");
	assert.equal(notifications.length, 1);
});

test("message_end：过期降级后的首次主用成功 → 提示恢复、写墓碑、不重复提示", async () => {
	const dir = makeAgentDir({
		config: CONFIG,
		state: {
			version: 1,
			degraded: { volcengine: { level: 1, until: Date.now() - 1000, reason: "AccountQuotaExceeded", at: Date.now() - 3_600_000 } },
		},
	});
	const captured = await loadExtension(dir);
	const { ctx, notifications, status } = makeCtx();
	const messageEnd = captured.handlers.get("message_end");
	const success = { role: "assistant", provider: "volcengine", model: "deepseek-v4.1-flash", stopReason: "endTurn" };

	messageEnd?.({ message: success }, ctx);
	assert.equal(notifications.length, 1);
	assert.ok(notifications[0]!.message.includes("已恢复"));
	assert.equal(readDegraded(dir).degraded.volcengine?.level, 0, "应写入 level=0 墓碑");
	assert.equal(readDegraded(dir).degraded.volcengine?.reason, "recovered");
	assert.equal(status.at(-1), "⬇ volcengine/deepseek-v4.1-flash", "页脚回到主用目标");

	messageEnd?.({ message: success }, ctx);
	assert.equal(notifications.length, 1, "墓碑存在时不应重复提示");
});

test("message_end：非主用 provider 的成功响应不触发恢复逻辑", async () => {
	const captured = await loadExtension(makeAgentDir({ config: CONFIG }));
	const { ctx, notifications } = makeCtx();
	captured.handlers.get("message_end")?.({ message: { role: "assistant", provider: "workbuddy", stopReason: "endTurn" } }, ctx);
	assert.equal(notifications.length, 0);
});

test("/chain degrade 与 reset：手动降级写状态，reset 清除并刷新页脚", async () => {
	const dir = makeAgentDir({ config: CONFIG });
	const captured = await loadExtension(dir);
	const { ctx, notifications, status } = makeCtx();
	const command = captured.commandOptions.get("chain");
	assert.ok(command);

	await command.handler("degrade 30m", ctx);
	assert.equal(notifications.length, 1, "一次手动降级只提示一条：状态已变化 → 命令不再重复回显");
	assert.ok(
		notifications.at(-1)?.message.startsWith("⚠ 手动降级 volcengine →"),
		"降级 notify 走手动文案，不再是「额度受限（manual）」",
	);
	const state = readDegraded(dir);
	assert.equal(state.degraded.volcengine?.level, 1);
	assert.equal(state.degraded.volcengine?.reason, "manual");
	assert.ok(status.at(-1)?.includes("workbuddy"), "页脚应显示备用 provider");

	await command.handler("reset", ctx);
	assert.equal(readDegraded(dir).degraded.volcengine, undefined);
	assert.ok(notifications.at(-1)?.message.includes("已清除"));
	assert.equal(status.at(-1), "⬇ volcengine/deepseek-v4.1-flash", "reset 后页脚回到主用目标");
});

test("/chain degrade：盘上已有更深档位时，提示实际生效的档位与恢复时间", async () => {
	const config = {
		virtualProvider: "yansongda",
		models: [
			{
				id: "deepseek-v4.1-flash",
				chain: ["volcengine/deepseek-v4.1-flash", "workbuddy/deepseek-v4.1-flash", "glm/deepseek-v4.1-flash"],
			},
		],
	};
	const activeUntil = Date.now() + 7_200_000;
	const dir = makeAgentDir({
		config,
		state: { version: 1, degraded: { volcengine: { level: 2, until: activeUntil, reason: "AccountQuotaExceeded", at: Date.now() } } },
	});
	const captured = await loadExtension(dir);
	const { ctx, notifications } = makeCtx();
	const command = captured.commandOptions.get("chain");
	assert.ok(command);

	await command.handler("degrade 30m", ctx);

	const output = notifications.at(-1)!.message;
	assert.ok(output.includes("保持 level=2"), output);
	assert.ok(output.includes("glm/deepseek-v4.1-flash"), output);
	assert.equal(output.includes("workbuddy/deepseek-v4.1-flash"), false, "不应提示未生效的第 1 档");
	const state = readDegraded(dir).degraded.volcengine;
	assert.equal(state?.level, 2, "不应把档位打回 1");
	assert.equal(state?.until, activeUntil, "不应改写恢复时间");
});

test("/chain status：未知子命令给出提示，已知 status 输出链路", async () => {
	const captured = await loadExtension(makeAgentDir({ config: CONFIG }));
	const { ctx, notifications } = makeCtx();
	const command = captured.commandOptions.get("chain");
	assert.ok(command);

	await command.handler("nope", ctx);
	assert.ok(notifications.at(-1)?.message.includes("未知子命令：nope"));

	await command.handler("status", ctx);
	const output = notifications.at(-1)!.message;
	assert.ok(output.includes("yansongda/deepseek-v4.1-flash"));
	assert.ok(output.includes("volcengine/deepseek-v4.1-flash  →  workbuddy/deepseek-v4.1-flash"));
});

test("session_start：页脚只反映当前选中模型的降级（不再汇总其它 provider）", async () => {
	const dir = makeAgentDir({
		config: CONFIG2,
		state: {
			version: 1,
			degraded: {
				volcengine: { level: 1, until: Date.now() + 3_600_000, reason: "q", at: Date.now() },
				openrouter: { level: 1, until: Date.now() + 3_600_000, reason: "q", at: Date.now() },
			},
		},
	});
	const captured = await loadExtension(dir);
	const { ctx, status } = makeCtx();
	ctx.model = { provider: "yansongda", id: "a" };
	captured.handlers.get("session_start")?.({ type: "session_start" }, ctx);
	assert.ok(status.at(-1)?.startsWith("⚠ 备用 workbuddy/a · 恢复 "), status.at(-1));

	// 切到模型 b：页脚跟随选中模型，显示 b 所在链路的备用目标
	ctx.model = { provider: "yansongda", id: "b" };
	captured.handlers.get("model_select")?.({ type: "model_select" }, ctx);
	assert.ok(status.at(-1)?.startsWith("⚠ 备用 glm/b · 恢复 "), status.at(-1));
});

test("页脚去重：同一文案不重复调用 setStatus", async () => {
	const dir = makeAgentDir({ config: CONFIG });
	const captured = await loadExtension(dir);
	const { ctx, status } = makeCtx();

	captured.handlers.get("session_start")?.({ type: "session_start" }, ctx);
	assert.equal(status.at(-1), "⬇ volcengine/deepseek-v4.1-flash");
	const count = status.length;

	captured.handlers.get("model_select")?.({ type: "model_select" }, ctx);
	captured.handlers.get("message_end")?.(
		{ message: { role: "assistant", provider: "volcengine", model: "deepseek-v4.1-flash", stopReason: "endTurn" } },
		ctx,
	);
	assert.equal(status.length, count, "文案未变不重复写页脚");
});

test("message_end：成功响应后刷新页脚（选中模型降级中 → 备用与恢复时间）", async () => {
	const dir = makeAgentDir({
		config: CONFIG,
		state: { version: 1, degraded: { volcengine: { level: 1, until: Date.now() + 3_600_000, reason: "q", at: Date.now() } } },
	});
	const captured = await loadExtension(dir);
	const { ctx, status } = makeCtx();

	captured.handlers.get("message_end")?.(
		{ message: { role: "assistant", provider: "workbuddy", stopReason: "endTurn" } },
		ctx,
	);
	assert.equal(status.length, 0, "非本扩展模型 provider 的成功响应不触发页脚刷新");

	captured.handlers.get("message_end")?.(
		{ message: { role: "assistant", provider: "volcengine", model: "deepseek-v4.1-flash", stopReason: "endTurn" } },
		ctx,
	);
	assert.ok(status.at(-1)?.startsWith("⚠ 备用 workbuddy/deepseek-v4.1-flash · 恢复 "), status.at(-1));
});
