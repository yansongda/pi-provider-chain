/**
 * 配置加载与校验（纯函数 + 只读 IO，无 pi 依赖）。
 *
 * 配置文件默认 `<agentDir>/provider-fallback.json`，状态文件默认
 * `<agentDir>/provider-fallback-state.json`，其中
 * `agentDir = $PI_CODING_AGENT_DIR || ~/.pi/agent`。
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	buildPatterns,
	compileResetPattern,
	DEFAULT_DEGRADE_MS,
	MAX_DEGRADE_MS,
	type Pattern,
} from "./degrade.ts";
import { type ModelRef, parseRef } from "./model-ref.ts";

export interface RoutingModelConfig {
	id: string;
	name?: string;
	thinkingLevels?: string[];
	contextWindow?: number;
	maxTokens?: number;
	primary: string;
	fallbacks?: string[];
}

export interface LoadedModel {
	config: RoutingModelConfig;
	/** 状态文件的键：primary 的 provider（同一 provider 下的虚拟模型共享档位） */
	key: string;
	/** 解析后的链路：`[primary, ...合法 fallbacks]`（至少一项） */
	chain: [ModelRef, ...ModelRef[]];
}

export interface LoadedConfig {
	virtualProvider: string;
	stateFile: string;
	defaultDegradeMs: number;
	maxDegradeMs: number;
	transcriptNotice: boolean;
	patterns: Pattern[];
	resetRe: RegExp;
	models: LoadedModel[];
}

export type LoadResult = { ok: true; loaded: LoadedConfig } | { ok: false; error: string };

/** 配置文件的原始结构（未经校验）。 */
interface RawRoutingConfig {
	virtualProvider?: unknown;
	stateFile?: unknown;
	degradePatterns?: unknown;
	resetPattern?: unknown;
	defaultDegradeMs?: unknown;
	maxDegradeMs?: unknown;
	transcriptNotice?: unknown;
	models?: unknown;
}

export function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
}

export function expandPath(p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/")) return join(homedir(), p.slice(2));
	return p;
}

export function defaultConfigPath(dir: string = agentDir()): string {
	return join(dir, "provider-fallback.json");
}

export function defaultStateFile(dir: string = agentDir()): string {
	return join(dir, "provider-fallback-state.json");
}

function positiveNumber(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

export function loadConfig(path: string = defaultConfigPath(), dir: string = agentDir()): LoadResult {
	if (!existsSync(path)) return { ok: false, error: `配置文件不存在：${path}` };

	let raw: RawRoutingConfig | null;
	try {
		raw = JSON.parse(readFileSync(path, "utf8")) as RawRoutingConfig;
	} catch (err) {
		return { ok: false, error: `配置文件解析失败：${err instanceof Error ? err.message : String(err)}` };
	}

	const virtualProvider = typeof raw?.virtualProvider === "string" ? raw.virtualProvider.trim() : "";
	if (!virtualProvider) return { ok: false, error: "缺少 virtualProvider" };
	if (!Array.isArray(raw?.models) || raw.models.length === 0) return { ok: false, error: "models[] 为空" };

	const models: LoadedModel[] = [];
	for (const entry of raw.models as RoutingModelConfig[]) {
		const id = typeof entry?.id === "string" ? entry.id.trim() : "";
		const primary = parseRef(String(entry?.primary ?? ""));
		if (!id || !primary) return { ok: false, error: `models[] 条目缺少 id 或合法 primary：${JSON.stringify(entry)}` };
		const chain: [ModelRef, ...ModelRef[]] = [primary];
		// 链长建议 ≤ 5（业界网关默认上限）：链过长会让一次故障在多个 provider 上依次付出失败代价
		for (const fb of entry?.fallbacks ?? []) {
			const ref = parseRef(String(fb));
			if (ref) chain.push(ref);
		}
		models.push({ config: { ...entry, id }, key: primary.provider, chain });
	}

	// degradePatterns 缺省 / 为空 / 全是空白 → 使用内置默认列表；非空列表完全覆盖默认值
	const patterns = buildPatterns(Array.isArray(raw.degradePatterns) ? (raw.degradePatterns as string[]) : undefined);

	const configuredStateFile =
		typeof raw.stateFile === "string" && raw.stateFile.trim() ? raw.stateFile.trim() : undefined;

	// maxDegradeMs 是硬上限：默认时长也钳制到它之下，保证「降级窗口不会超过配置的上限」
	const maxDegradeMs = positiveNumber(raw.maxDegradeMs, MAX_DEGRADE_MS);
	const defaultDegradeMs = Math.min(positiveNumber(raw.defaultDegradeMs, DEFAULT_DEGRADE_MS), maxDegradeMs);

	return {
		ok: true,
		loaded: {
			virtualProvider,
			stateFile: configuredStateFile ? expandPath(configuredStateFile) : defaultStateFile(dir),
			defaultDegradeMs,
			maxDegradeMs,
			transcriptNotice: raw.transcriptNotice !== false,
			patterns,
			resetRe: compileResetPattern(typeof raw.resetPattern === "string" ? raw.resetPattern : undefined),
			models,
		},
	};
}
