/**
 * 降级状态文件（纯 IO 模块，无 pi 依赖）。
 *
 * - 读取即解析；文件缺失/损坏一律视为空状态，不抛异常（文件仅数百字节，不做缓存，避免读到陈旧快照）
 * - 写入为 `tmp + rename` 原子替换
 * - 合并语义：同一 key 若盘上条目仍活跃且档位更深，保留盘上条目（单调前进）
 *   —— 避免父进程与子 agent 并发写时把已推进的档位回退
 * - 每次写入清理 `until + PRUNE_AFTER_MS < now` 的历史条目
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DEGRADE_REASON, PRUNE_AFTER_MS, STATE_TMP_SUFFIX, STATE_VERSION } from "./constants.ts";

export interface DegradeEntry {
	/** 生效档位：0 = 主用，1..n = `chain[1..]` 下标 */
	level: number;
	/** 降级截止时间戳（ms） */
	until: number;
	/** 降级原因（pattern 原文、`manual`、`recovered` 等） */
	reason: string;
	/** 写入时间戳（ms） */
	at: number;
}

export interface StateFile {
	version: 1;
	degraded: Record<string, DegradeEntry>;
}

function stateWith(degraded: Record<string, DegradeEntry>): StateFile {
	return { version: STATE_VERSION, degraded };
}

export function emptyState(): StateFile {
	return stateWith({});
}

function normalizeEntry(value: unknown): DegradeEntry | undefined {
	if (!value || typeof value !== "object") return undefined;
	const v = value as { level?: unknown; until?: unknown; reason?: unknown; at?: unknown };
	if (typeof v.level !== "number" || !Number.isFinite(v.level)) return undefined;
	if (typeof v.until !== "number" || !Number.isFinite(v.until)) return undefined;
	return {
		level: Math.trunc(v.level),
		until: v.until,
		reason: typeof v.reason === "string" ? v.reason : DEGRADE_REASON.QUOTA,
		at: typeof v.at === "number" && Number.isFinite(v.at) ? v.at : Date.now(),
	};
}

export function readState(path: string): StateFile {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<StateFile> | null;
		const raw = parsed && typeof parsed.degraded === "object" && parsed.degraded ? (parsed.degraded as Record<string, unknown>) : {};
		const degraded: Record<string, DegradeEntry> = {};
		for (const [key, value] of Object.entries(raw)) {
			const entry = normalizeEntry(value);
			if (entry) degraded[key] = entry;
		}
		return stateWith(degraded);
	} catch {
		return emptyState();
	}
}

/** 仍处于降级窗口内的条目；已过期或结构非法返回 undefined。 */
export function activeEntry(path: string, provider: string, now: number = Date.now()): DegradeEntry | undefined {
	const entry = readState(path).degraded[provider];
	if (!entry || entry.until <= now) return undefined;
	return entry;
}

function sameEntry(a: DegradeEntry | undefined, b: DegradeEntry): boolean {
	return !!a && a.level === b.level && a.until === b.until && a.reason === b.reason;
}

function prune(state: StateFile, now: number): StateFile {
	const degraded: Record<string, DegradeEntry> = {};
	for (const [provider, entry] of Object.entries(state.degraded)) {
		if (entry.until + PRUNE_AFTER_MS >= now) degraded[provider] = entry;
	}
	return stateWith(degraded);
}

function writeState(path: string, data: StateFile): { ok: true } | { ok: false; error: string } {
	const tmp = `${path}.${process.pid}${STATE_TMP_SUFFIX}`;
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
		renameSync(tmp, path);
		return { ok: true };
	} catch (err) {
		try {
			if (existsSync(tmp)) unlinkSync(tmp);
		} catch {
			/* 清理失败不影响返回值 */
		}
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * 写入一条降级状态。
 *
 * 读-改-写之间没有文件锁：与其它进程**同时**写入不同 key 时，极小概率丢一条记录
 * （该 provider 下次请求会重新降级，可自愈）。这里在写盘前紧邻读取盘上快照，尽量合并
 * 其它进程刚写入的 key；同 key 仍按「更深的活跃档位优先」单调合并。
 *
 * 返回值里的 `entry` 是**实际生效**的条目（可能因「单调前进」而保留盘上更深的档位）；
 * `changed` 表示相对盘上是否有变化（供 UI 去重提示）；写入失败时 `writeError` 有值且不抛异常。
 *
 * 参数 `provider` 是状态键：当前恒为链路主用的 provider（同一 provider 下的虚拟模型共享档位）。
 */
export function upsertEntry(
	path: string,
	provider: string,
	entry: DegradeEntry,
	now: number = Date.now(),
): { entry: DegradeEntry; changed: boolean; writeError?: string } {
	const current = readState(path); // 写盘前紧邻读取，缩小并发丢更新的窗口
	const previous = current.degraded[provider];
	const merged = previous && previous.until > now && previous.level > entry.level ? previous : entry;
	const changed = !sameEntry(previous, merged);
	const written = writeState(path, prune({ ...current, degraded: { ...current.degraded, [provider]: merged } }, now));
	if (!written.ok) return { entry: merged, changed, writeError: written.error };
	return { entry: merged, changed };
}

/** 清除某个 provider 的降级状态（不存在也视为成功）；与 `upsertEntry` 一致，写入时顺带清理过期历史条目。 */
export function clearEntry(path: string, provider: string, now: number = Date.now()): { ok: boolean; error?: string } {
	const state = readState(path);
	if (!(provider in state.degraded)) return { ok: true };
	const degraded = { ...state.degraded };
	delete degraded[provider];
	const written = writeState(path, prune(stateWith(degraded), now));
	if (!written.ok) return { ok: false, error: written.error };
	return { ok: true };
}
