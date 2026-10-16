import assert from "node:assert/strict";
import { test } from "node:test";
import type { LoadedConfig, LoadedModel } from "../src/config.ts";
import { DEGRADE_REASON, DEGRADE_TRIGGER, ENTRY_KIND, NOTIFY_KIND, type NotifyKind } from "../src/constants.ts";
import { compileDegradePatterns, compileResetPattern } from "../src/degrade.ts";
import { parseRef, refText, type ModelRef } from "../src/model-ref.ts";
import { createRouter, type PhysicalModel, type Router, type RouterPorts } from "../src/router.ts";
import type { DegradeEntry, StateFile } from "../src/state.ts";
import type { RouteEntryData } from "../src/transcript.ts";

/**
 * router 单测：用假端口 + 固定时钟覆盖全部策略分支。
 *
 * 假端口刻意**不**复用 `src/state.ts`（那里有自己的单测）：只实现 router 依赖的最小语义
 * ——读快照、写时按「同 provider 取更深的活跃档位」单调合并。
 */

const NOW = 1_800_000_000_000;

function chainOf(refs: readonly string[]): [ModelRef, ...ModelRef[]] {
	const parsed = refs.map((ref) => {
		const model = parseRef(ref);
		assert.ok(model, `测试用引用非法：${ref}`);
		return model;
	});
	return parsed as [ModelRef, ...ModelRef[]];
}

interface HarnessInput {
	/** `chain[]` 形式的链路（默认两档：volcengine → workbuddy） */
	chain?: readonly string[];
	/** 覆盖配置里的 models[]（多模型 / 页脚去重用） */
	models?: ReadonlyArray<{ id: string; chain: readonly string[] }>;
	/** 初始状态文件内容（provider → 档位） */
	state?: Record<string, DegradeEntry>;
	/** 有凭证的 `provider/id`；undefined = 全部有凭证 */
	available?: readonly string[];
	/** 只在目录里存在（无凭证），供「回落主用对象」路径使用 */
	catalog?: readonly string[];
	/** upsert 返回的写失败原因 */
	writeError?: string;
	/** readState 抛错（模拟端口自身故障，用于验证异常留痕） */
	readThrows?: boolean;
}

function makeHarness(input: HarnessInput = {}) {
	let now = NOW;
	const chains = input.models
		? input.models.map((model) => ({ id: model.id, refs: [...model.chain] }))
		: [{ id: "main", refs: [...(input.chain ?? ["volcengine/deepseek-v4.1-flash", "workbuddy/deepseek-v4.1-flash"])] }];
	const models: LoadedModel[] = chains.map((chain) => ({
		config: { id: chain.id },
		stateKey: parseRef(chain.refs[0]!)!.provider,
		chain: chainOf(chain.refs),
	}));

	const cfg: LoadedConfig = {
		virtualProvider: "yansongda",
		stateFile: "/tmp/does-not-matter.json",
		defaultDegradeMs: 3_600_000,
		maxDegradeMs: 2_592_000_000,
		transcriptNotice: true,
		patterns: compileDegradePatterns(),
		resetRe: compileResetPattern(),
		models,
	};

	const state: StateFile = { version: 1, degraded: { ...(input.state ?? {}) } };
	const notifications: Array<{ message: string; kind: NotifyKind }> = [];
	const entries: RouteEntryData[] = [];
	const statuses: Array<string | undefined> = [];
	const calls = { reads: 0, upserts: 0, clears: 0, resolves: 0 };

	const available = input.available ? new Set(input.available) : undefined;
	const catalogOnly = new Set(input.catalog ?? []);
	const selection: { value: { provider: string; id: string } | undefined } = {
		value: { provider: cfg.virtualProvider, id: models[0]!.config.id },
	};
	const asModel = (ref: ModelRef): PhysicalModel => ({ provider: ref.provider, id: ref.id });

	const ports: RouterPorts<PhysicalModel> = {
		now: () => now,
		// 默认选中第一个虚拟模型（与真实会话一致）；需要时用 setSelection 改
		selection: () => selection.value,
		readState: () => {
			calls.reads++;
			if (input.readThrows) throw new Error("state port down");
			return state;
		},
		upsert: (provider, entry) => {
			calls.upserts++;
			const previous = state.degraded[provider];
			const merged = previous && previous.until > now && previous.level > entry.level ? previous : entry;
			const changed =
				!previous || previous.level !== merged.level || previous.until !== merged.until || previous.reason !== merged.reason;
			state.degraded[provider] = merged;
			return input.writeError ? { entry: merged, changed, writeError: input.writeError } : { entry: merged, changed };
		},
		clear: (provider) => {
			calls.clears++;
			delete state.degraded[provider];
			return { ok: true };
		},
		resolve: (ref) => {
			calls.resolves++;
			if (available && !available.has(refText(ref))) return undefined;
			return asModel(ref);
		},
		catalog: (ref) => (catalogOnly.has(refText(ref)) ? asModel(ref) : undefined),
		notify: (message, kind) => notifications.push({ message, kind }),
		append: (data) => entries.push(data),
		setStatus: (text) => {
			statuses.push(text);
		},
	};

	return {
		cfg,
		models,
		state,
		notifications,
		entries,
		statuses,
		calls,
		router: createRouter<PhysicalModel, string>(cfg, ports) as Router<PhysicalModel, string>,
		setNow: (value: number) => {
			now = value;
		},
		setSelection: (value: { provider: string; id: string } | undefined) => {
			selection.value = value;
		},
	};
}

const quotaError = { errorMessage: "AccountQuotaExceeded: your account quota is exhausted" };

test("无降级状态：route() 返回主用物理模型与请求的思考档位", () => {
	const h = makeHarness();
	const result = h.router.route(h.models[0]!, { reason: "user", thinkingLevel: "max" });
	assert.deepEqual(result, { model: { provider: "volcengine", id: "deepseek-v4.1-flash" }, thinkingLevel: "max" });
	assert.equal(h.calls.reads, 1, "一次请求只读一次状态");
	assert.equal(h.calls.resolves, 1, "同一档位只查一次宿主注册表（memo）");
});

test("状态已降级：route() 返回备用物理模型", () => {
	const h = makeHarness({ state: { volcengine: { level: 1, until: NOW + 3_600_000, reason: "e2e", at: NOW } } });
	const result = h.router.route(h.models[0]!, { reason: "continuation", thinkingLevel: "high" });
	assert.equal(result.model.provider, "workbuddy");
	assert.equal(result.thinkingLevel, "high");
});

test("降级窗口过期 → 回到主用", () => {
	const h = makeHarness({ state: { volcengine: { level: 1, until: NOW - 1, reason: "e2e", at: NOW - 10 } } });
	assert.equal(h.router.route(h.models[0]!, { reason: "user", thinkingLevel: "low" }).model.provider, "volcengine");
});

test("retry 命中额度错误：推进档位 + 写状态 + notify/转录/页脚，端口调用顺序正确", () => {
	const h = makeHarness();
	const result = h.router.route(h.models[0]!, {
		reason: "retry",
		thinkingLevel: "max",
		failed: { model: { provider: "volcengine", id: "deepseek-v4.1-flash" }, thinkingLevel: "low", message: quotaError },
	});

	assert.equal(result.model.provider, "workbuddy");
	assert.equal(result.thinkingLevel, "max", "推进后不再复用失败档位，用请求的思考档位");
	assert.equal(h.state.degraded.volcengine?.level, 1);
	assert.equal(h.state.degraded.volcengine?.reason, "AccountQuotaExceeded");
	assert.equal(h.state.degraded.volcengine?.until, NOW + 3_600_000, "无 reset 信息 → 用默认时长");
	assert.equal(h.notifications.length, 1);
	assert.equal(h.notifications[0]?.kind, NOTIFY_KIND.WARNING);
	assert.ok(h.notifications[0]?.message.includes("workbuddy/deepseek-v4.1-flash"));
	assert.equal(h.entries.length, 1);
	const entry = h.entries[0];
	assert.equal(entry?.kind, ENTRY_KIND.DEGRADE);
	if (entry?.kind !== ENTRY_KIND.DEGRADE) return;
	assert.equal(entry.trigger, DEGRADE_TRIGGER.RETRY);
	assert.equal(entry.from, "volcengine", "受限 provider = 失败模型所属 provider");
	assert.ok(h.notifications[0]?.message.startsWith("⚠ volcengine 额度受限"), "notify 与条目同一句、同一个受限 provider");
	assert.equal(h.statuses.at(-1)?.includes("备用 workbuddy"), true, "页脚显示备用 provider");
	assert.equal(h.calls.reads, 2, "route 读一次状态 + refreshStatus 读一次（推进复用同一快照）");
});

test("retry 命中额度错误但已在链尾：复用同档位并保留失败请求的思考档位", () => {
	const h = makeHarness({
		chain: ["volcengine/deepseek-v4.1-flash", "workbuddy/deepseek-v4.1-flash"],
		state: { volcengine: { level: 1, until: NOW + 3_600_000, reason: "keep", at: NOW } },
	});
	const result = h.router.route(h.models[0]!, {
		reason: "retry",
		thinkingLevel: "max",
		failed: { model: { provider: "workbuddy", id: "deepseek-v4.1-flash" }, thinkingLevel: "low", message: quotaError },
	});

	assert.equal(result.model.provider, "workbuddy");
	assert.equal(result.thinkingLevel, "low", "已无后备 → 复用同档位并保留失败请求的思考档位");
	assert.equal(h.calls.upserts, 0, "无档位可推进时不写状态");
	assert.equal(h.notifications.length, 0);
	assert.equal(h.state.degraded.volcengine?.reason, "keep", "盘上条目不被改写");
});

test("retry 但错误未命中额度 pattern：不降级，复用同档位", () => {
	const h = makeHarness();
	const result = h.router.route(h.models[0]!, {
		reason: "retry",
		thinkingLevel: "max",
		failed: {
			model: { provider: "volcengine", id: "deepseek-v4.1-flash" },
			thinkingLevel: "low",
			message: { errorMessage: "ECONNRESET" },
		},
	});
	assert.equal(result.model.provider, "volcengine");
	assert.equal(result.thinkingLevel, "low");
	assert.equal(h.calls.upserts, 0);
	assert.equal(h.notifications.length, 0);
});

test("全链路都没有凭证：回落主用目录对象（让 Pi 报出真实错误）", () => {
	const h = makeHarness({ available: [], catalog: ["volcengine/deepseek-v4.1-flash"] });
	const result = h.router.route(h.models[0]!, { reason: "user", thinkingLevel: "low" });
	assert.equal(result.model.provider, "volcengine");
	assert.equal(h.entries.length, 0, "回落主用是正常路径，不写异常条目");
});

test("连主用都不存在：抛错并带上引用", () => {
	const h = makeHarness({ available: [] });
	assert.throws(() => h.router.route(h.models[0]!, { reason: "user", thinkingLevel: "low" }), /与全部后备链路均不可用/);
});

test("端口自身故障：回落主用并留一条 error 转录条目", () => {
	const h = makeHarness({ readThrows: true });
	const result = h.router.route(h.models[0]!, { reason: "user", thinkingLevel: "low" });
	assert.equal(result.model.provider, "volcengine");
	assert.equal(h.entries.length, 1);
	const entry = h.entries[0];
	assert.equal(entry?.kind, ENTRY_KIND.ERROR);
	if (entry?.kind !== ENTRY_KIND.ERROR) return;
	assert.ok(entry.message.includes("state port down"));
});

test("refreshStatus：常驻显示选中模型的目标；降级时给出备用目标与恢复时间", () => {
	const active = makeHarness();
	active.router.refreshStatus();
	assert.equal(active.statuses.at(-1), "⬇ volcengine/deepseek-v4.1-flash");

	const degraded = makeHarness({
		state: { volcengine: { level: 1, until: NOW + 3_600_000, reason: "q", at: NOW } },
	});
	degraded.router.refreshStatus();
	const text = degraded.statuses.at(-1) ?? "";
	assert.ok(text.startsWith("⚠ 备用 workbuddy/deepseek-v4.1-flash · 恢复 "), text);
});

test("refreshStatus：选中非本扩展模型（物理模型 / 未配置 id）时清空页脚", () => {
	const h = makeHarness({ state: { volcengine: { level: 1, until: NOW + 3_600_000, reason: "q", at: NOW } } });

	h.setSelection({ provider: "volcengine", id: "deepseek-v4.1-flash" });
	h.router.refreshStatus();
	assert.equal(h.statuses.at(-1), undefined, "选中的是物理模型 → 不接管页脚");

	h.setSelection({ provider: "yansongda", id: "not-configured" });
	h.router.refreshStatus();
	assert.equal(h.statuses.at(-1), undefined, "未配置的虚拟模型 → 不接管页脚");

	h.setSelection(undefined);
	h.router.refreshStatus();
	assert.equal(h.statuses.at(-1), undefined, "未选择 → 清空页脚");
});

test("refreshStatus：其它模型的降级不影响当前选中模型的页脚", () => {
	const h = makeHarness({
		models: [
			{ id: "a", chain: ["volcengine/a", "workbuddy/a"] },
			{ id: "b", chain: ["openrouter/b", "glm/b"] },
		],
		state: { openrouter: { level: 1, until: NOW + 3_600_000, reason: "q", at: NOW } },
	});
	h.router.refreshStatus();
	assert.equal(h.statuses.at(-1), "⬇ volcengine/a", "只反映当前选中模型（a）的档位");

	h.setSelection({ provider: "yansongda", id: "b" });
	h.router.refreshStatus();
	assert.ok((h.statuses.at(-1) ?? "").startsWith("⚠ 备用 glm/b · 恢复 "), h.statuses.at(-1));
});

test("refreshStatus：每次调用只读一次状态", () => {
	const h = makeHarness();
	h.router.refreshStatus();
	h.router.refreshStatus();
	assert.equal(h.calls.reads, 2);
});

test("notePrimarySuccess：过期降级后的首次主用成功 → 墓碑 + 提示 + 页脚清空，且不重复提示", () => {
	const h = makeHarness({ state: { volcengine: { level: 1, until: NOW - 1000, reason: "AccountQuotaExceeded", at: NOW - 1000 } } });

	h.router.notePrimarySuccess("volcengine");
	assert.equal(h.state.degraded.volcengine?.level, 0);
	assert.equal(h.state.degraded.volcengine?.reason, DEGRADE_REASON.RECOVERED);
	assert.equal(h.notifications.length, 1);
	assert.equal(h.notifications[0]?.kind, NOTIFY_KIND.INFO);
	assert.ok(h.notifications[0]?.message.includes("已恢复"));
	assert.equal(h.statuses.at(-1), "⬇ volcengine/deepseek-v4.1-flash", "页脚回到主用目标");
	assert.equal(h.entries.at(-1)?.kind, ENTRY_KIND.RECOVER);

	h.router.notePrimarySuccess("volcengine");
	assert.equal(h.notifications.length, 1, "墓碑存在时不再重复提示");
});

test("notePrimarySuccess：无状态或窗口未过期时不动作", () => {
	const none = makeHarness();
	none.router.notePrimarySuccess("volcengine");
	assert.equal(none.notifications.length, 0);

	const active = makeHarness({ state: { volcengine: { level: 1, until: NOW + 60_000, reason: "q", at: NOW } } });
	active.router.notePrimarySuccess("volcengine");
	assert.equal(active.notifications.length, 0, "窗口未过期的降级不被墓碑清掉");
	assert.equal(active.state.degraded.volcengine?.level, 1);
});

test("reviewFailure：settle 路径只接管「失败者就是当前档位」的情形", () => {
	const h = makeHarness({ chain: ["volcengine/a", "workbuddy/a", "glm/a"] });

	// 失败者不是当前档位（当前档位 0 = volcengine，失败者 workbuddy）→ 不接管
	const skipped = h.router.reviewFailure(h.models[0]!, {
		errorText: "AccountQuotaExceeded",
		failedRef: "workbuddy/a",
		trigger: DEGRADE_TRIGGER.SETTLE,
	});
	assert.equal(skipped, undefined);
	assert.equal(h.calls.upserts, 0);

	// 失败者就是当前档位 → 推进到下一档（自读状态 + refreshStatus，共 2 次）
	const readsBefore = h.calls.reads;
	const applied = h.router.reviewFailure(h.models[0]!, {
		errorText: "AccountQuotaExceeded",
		failedRef: "volcengine/a",
		trigger: DEGRADE_TRIGGER.SETTLE,
	});
	assert.equal(applied?.level, 1);
	assert.equal(h.calls.reads - readsBefore, 2, "settle 路径不重复读状态");
	const entry = h.entries.at(-1);
	assert.equal(entry?.kind, ENTRY_KIND.DEGRADE);
	if (entry?.kind !== ENTRY_KIND.DEGRADE) return;
	assert.equal(entry.trigger, DEGRADE_TRIGGER.SETTLE);
});

test("reviewFailure：未命中 pattern 时零副作用", () => {
	const h = makeHarness();
	assert.equal(
		h.router.reviewFailure(h.models[0]!, { errorText: "503 Service Unavailable", failedRef: "volcengine/x", trigger: DEGRADE_TRIGGER.RETRY }),
		undefined,
	);
	assert.equal(h.calls.upserts + h.calls.reads + h.notifications.length, 0);
});

test("状态文件写入失败：提示里带上「仅本进程生效」，但本次降级仍生效", () => {
	const h = makeHarness({ writeError: "EACCES" });
	h.router.route(h.models[0]!, {
		reason: "retry",
		thinkingLevel: "max",
		failed: { model: { provider: "volcengine", id: "deepseek-v4.1-flash" }, message: quotaError },
	});
	assert.equal(h.notifications.length, 1);
	assert.ok(h.notifications[0]?.message.includes("仅本进程生效"));
	assert.equal(h.entries.length, 1, "转录条目照常写入");
});

test("manualDegrade：写入 level=1 / reason=manual，回显留给降级通知", () => {
	const h = makeHarness();
	const line = h.router.manualDegrade(h.models[0]!, 1_800_000);
	assert.equal(line, "", "状态已变化 → 不再重复回显（⚠ 通知已说明）");
	assert.equal(h.state.degraded.volcengine?.level, 1);
	assert.equal(h.state.degraded.volcengine?.reason, DEGRADE_REASON.MANUAL);
	assert.equal(h.state.degraded.volcengine?.until, NOW + 1_800_000);
	const entry = h.entries.at(-1);
	assert.equal(entry?.kind, ENTRY_KIND.DEGRADE);
	if (entry?.kind !== ENTRY_KIND.DEGRADE) return;
	assert.equal(entry.trigger, DEGRADE_TRIGGER.MANUAL);
	assert.equal(entry.from, "volcengine", "手动降级的受限方 = 状态键所属 provider");
	assert.equal(
		h.notifications.at(-1)?.message.startsWith("⚠ 手动降级 volcengine → workbuddy/deepseek-v4.1-flash，恢复时间"),
		true,
		"notify 走手动文案，不再出现「额度受限（manual）」",
	);
});

test("manualDegrade：未配置后备链路时只返回提示，不写状态", () => {
	const h = makeHarness({ chain: ["volcengine/a"] });
	const line = h.router.manualDegrade(h.models[0]!, 1_800_000);
	assert.ok(line.includes("未配置后备链路"));
	assert.equal(h.calls.upserts, 0);
});

test("manualDegrade：盘上已有更深的活跃档位 → 保持它并如实提示", () => {
	const activeUntil = NOW + 7_200_000;
	const h = makeHarness({
		chain: ["volcengine/a", "workbuddy/a", "glm/a"],
		state: { volcengine: { level: 2, until: activeUntil, reason: "AccountQuotaExceeded", at: NOW } },
	});
	const line = h.router.manualDegrade(h.models[0]!, 1_800_000);
	assert.ok(line.includes("保持 level=2"), line);
	assert.ok(line.includes("glm/a"), line);
	assert.equal(h.state.degraded.volcengine?.level, 2);
	assert.equal(h.state.degraded.volcengine?.until, activeUntil, "不覆盖盘上更深的档位与恢复时间");
});

test("manualDegrade：盘上已有完全相同条目 → 回显实际档位（不再静默）", () => {
	const h = makeHarness();
	assert.equal(h.router.manualDegrade(h.models[0]!, 1_800_000), "", "首次执行：状态变化 → 无回显");
	const again = h.router.manualDegrade(h.models[0]!, 1_800_000);
	assert.ok(again.includes("已存在降级档位"), again);
	assert.ok(again.includes("保持 level=1"), again);
	assert.ok(again.includes("workbuddy/deepseek-v4.1-flash"), again);
	assert.equal(h.notifications.length, 1, "未变化 → 不重复发降级通知");
	assert.equal(h.entries.length, 1, "未变化 → 不重复写转录条目");
});

test("reset：清除状态 + 刷新页脚；不存在也视为成功", () => {
	const h = makeHarness({ state: { volcengine: { level: 1, until: NOW + 3_600_000, reason: "q", at: NOW } } });
	assert.ok(h.router.reset(h.models[0]!).includes("已清除 volcengine"));
	assert.equal(h.state.degraded.volcengine, undefined);
	assert.equal(h.statuses.at(-1), "⬇ volcengine/deepseek-v4.1-flash", "页脚回到主用目标");
	assert.ok(h.router.reset(h.models[0]!).includes("已清除 volcengine"));
});

test("statusLines：头部 + 各模型 + 未知子命令 + 过期提示", () => {
	const h = makeHarness({
		models: [
			{ id: "a", chain: ["volcengine/a", "workbuddy/a"] },
			{ id: "b", chain: ["openrouter/b"] },
		],
		state: {
			volcengine: { level: 1, until: NOW + 3_600_000, reason: "AccountQuotaExceeded", at: NOW },
			openrouter: { level: 1, until: NOW - 1, reason: "AccountQuotaExceeded", at: NOW - 10 },
		},
	});
	const lines = h.router.statusLines({ selection: "yansongda/a", target: h.models[1]!, unknown: "nope" });
	const text = lines.join("\n");
	assert.ok(text.includes("当前: yansongda/a"), text);
	assert.ok(text.includes("配置: "), text);
	assert.ok(text.includes("状态文件: "), text);
	assert.ok(text.includes("未知子命令：nope"), text);
	assert.ok(text.includes("  状态: 降级 level=1（workbuddy/a）"), text);
	assert.ok(text.includes("  状态: 已过期（下一请求尝试主用）"), text);
	assert.equal(lines.at(-1), "提示: 状态已过期，下一请求会自动尝试主用");
});

// ---------------------------------------------------------------------------
// S5：retry 推进不得跳过失败模型之后的可用链路
// ---------------------------------------------------------------------------

test("S5①：状态档位比失败模型更深时，回退到失败模型之后的下一档（不跳过可用后备）", () => {
	const h = makeHarness({
		chain: ["volcengine/a", "workbuddy/a", "glm/a"],
		state: { volcengine: { level: 1, until: NOW + 3_600_000, reason: "stale", at: NOW } },
	});
	const result = h.router.route(h.models[0]!, {
		reason: "retry",
		thinkingLevel: "max",
		// 失败来自 A（下标 0），而状态说当前档位是 1(B)：应落在 B，而不是跳到 C
		failed: { model: { provider: "volcengine", id: "a" }, thinkingLevel: "low", message: quotaError },
	});
	assert.equal(result.model.provider, "workbuddy");
	assert.equal(h.calls.upserts, 0, "档位未变化（盘上已是 1）→ 不写状态");
});

test("S5②：状态被清空且失败来自最后一档时，不越界（仍派发该档位）", () => {
	const h = makeHarness({ chain: ["volcengine/a", "workbuddy/a"] });
	const result = h.router.route(h.models[0]!, {
		reason: "retry",
		thinkingLevel: "max",
		failed: { model: { provider: "workbuddy", id: "a" }, thinkingLevel: "low", message: quotaError },
	});
	assert.equal(result.model.provider, "workbuddy");
	assert.equal(h.state.degraded.volcengine?.level, 1);
});

test("S5③回归：状态未降级且失败来自主用 → 推进到第 1 档", () => {
	const h = makeHarness({ chain: ["volcengine/a", "workbuddy/a", "glm/a"] });
	const result = h.router.route(h.models[0]!, {
		reason: "retry",
		thinkingLevel: "max",
		failed: { model: { provider: "volcengine", id: "a" }, thinkingLevel: "low", message: quotaError },
	});
	assert.equal(result.model.provider, "workbuddy");
	assert.equal(h.state.degraded.volcengine?.level, 1);
});

test("S5④回归：失败来自当前档位 → 推进到下一档", () => {
	const h = makeHarness({
		chain: ["volcengine/a", "workbuddy/a", "glm/a"],
		state: { volcengine: { level: 1, until: NOW + 3_600_000, reason: "q", at: NOW } },
	});
	const result = h.router.route(h.models[0]!, {
		reason: "retry",
		thinkingLevel: "max",
		failed: { model: { provider: "workbuddy", id: "a" }, thinkingLevel: "low", message: quotaError },
	});
	assert.equal(result.model.provider, "glm");
	assert.equal(h.state.degraded.volcengine?.level, 2);
	// 受限的是 workbuddy（档位 1），不是状态键 volcengine → notify 与转录条目都必须说对
	const entry = h.entries.at(-1);
	assert.equal(entry?.kind, ENTRY_KIND.DEGRADE);
	if (entry?.kind !== ENTRY_KIND.DEGRADE) return;
	assert.equal(entry.from, "workbuddy");
	assert.equal(entry.provider, "volcengine", "状态键仍是 chain[0] 的 provider");
	assert.ok(h.notifications.at(-1)?.message.startsWith("⚠ workbuddy 额度受限"));
});
