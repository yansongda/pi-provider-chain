import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * 装配层集成测试：stub pi + 临时 AGENT_DIR。
 *
 * 覆盖：虚拟模型注册、无降级时走主用、状态文件里有降级时走备用、
 * retry 命中额度错误时自动推进档位并写状态、配置缺失时的降级路径、/route 命令注册。
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
	route: (request: unknown, ctx: unknown) => RouteResult | Promise<RouteResult>;
}

interface StubPi {
	registerEntryRenderer: (type: string, renderer: unknown) => void;
	registerVirtualModel: (definition: CapturedModel) => void;
	registerCommand: (name: string, options: { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }) => void;
	on: (type: string, handler: (event: unknown, ctx: unknown) => unknown) => void;
	appendEntry: (type: string, data?: unknown) => void;
}

const CONFIG = {
	virtualProvider: "yansongda",
	models: [
		{
			id: "deepseek-v4.1-flash",
			name: "DeepSeek V4.1 Flash · auto",
			thinkingLevels: ["low", "high", "max"],
			primary: "volcengine/deepseek-v4.1-flash",
			fallbacks: ["workbuddy/deepseek-v4.1-flash"],
		},
	],
};

function makeAgentDir(options: { config?: unknown; state?: unknown } = {}): string {
	const dir = mkdtempSync(join(tmpdir(), "pf-entry-"));
	if (options.config !== undefined) writeFileSync(join(dir, "provider-fallback.json"), JSON.stringify(options.config, null, 2), "utf8");
	if (options.state !== undefined) writeFileSync(join(dir, "provider-fallback-state.json"), JSON.stringify(options.state, null, 2), "utf8");
	return dir;
}

async function loadExtension(dir: string) {
	process.env.PI_CODING_AGENT_DIR = dir;
	const factory = (await import("../extensions/provider-fallback.ts")).default;
	const captured: { models: CapturedModel[]; commands: string[]; handlers: Map<string, (event: unknown, ctx: unknown) => unknown>; entries: unknown[] } = {
		models: [],
		commands: [],
		handlers: new Map(),
		entries: [],
	};
	const stub: StubPi = {
		registerEntryRenderer: () => {},
		registerVirtualModel: (definition) => captured.models.push(definition),
		registerCommand: (name) => captured.commands.push(name),
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

test("注册虚拟模型与 /route 命令（provider / id / 思考档位来自配置）", async () => {
	const captured = await loadExtension(makeAgentDir({ config: CONFIG }));
	assert.deepEqual(captured.commands, ["route"]);
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
			degraded: { volcengine: { level: 1, until: Date.now() + 3_600_000, code: "e2e", at: Date.now() } },
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

	const state = JSON.parse(readFileSync(join(dir, "provider-fallback-state.json"), "utf8")) as {
		degraded: Record<string, { level: number; code: string }>;
	};
	assert.equal(state.degraded.volcengine?.level, 1);
	assert.equal(state.degraded.volcengine?.code, "AccountQuotaExceeded");
	assert.equal(notifications.length, 1);
	assert.ok(notifications[0]!.message.includes("AccountQuotaExceeded"));
	assert.ok(notifications[0]!.message.includes("workbuddy/deepseek-v4.1-flash"));
});

test("配置缺失：不注册虚拟模型，session_start 提示未启用", async () => {
	const captured = await loadExtension(makeAgentDir());
	assert.equal(captured.models.length, 0);
	assert.deepEqual(captured.commands, ["route"]);
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
	const state = JSON.parse(readFileSync(join(dir, "provider-fallback-state.json"), "utf8")) as {
		degraded: Record<string, { level: number; code: string }>;
	};
	assert.equal(state.degraded.volcengine?.level, 1);
	assert.equal(state.degraded.volcengine?.code, "InvalidSubscription");
	assert.equal(notifications.length, 1);
	assert.ok(notifications[0]!.message.includes("workbuddy/deepseek-v4.1-flash"));
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
