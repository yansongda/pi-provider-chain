/**
 * 降级状态文件（纯 IO 模块，无 pi 依赖）。
 *
 * - 读取带 `mtimeMs + size` 缓存；文件缺失/损坏一律视为空状态，不抛异常
 * - 写入为 `tmp + rename` 原子替换
 * - 合并语义：同一 key 若盘上条目仍活跃且档位更深，保留盘上条目（单调前进）
 *   —— 避免父进程与子 agent 并发写时把已推进的档位回退
 * - 每次写入清理 `until + PRUNE_AFTER_MS < now` 的历史条目
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface DegradeEntry {
	/** 生效档位：0 = 主用，1..n = fallbacks 下标 */
	level: number;
	/** 降级截止时间戳（ms） */
	until: number;
	/** 命中原因（pattern 原文、`manual`、`recovered` 等） */
	code: string;
	/** 写入时间戳（ms） */
	at: number;
}

export interface StateFile {
	version: 1;
	degraded: Record<string, DegradeEntry>;
}

/** 过期条目保留时长：超过 `until + PRUNE_AFTER_MS` 的条目在写入时被清理 */
export const PRUNE_AFTER_MS = 24 * 60 * 60 * 1000;

let stateCache: { path: string; mtimeMs: number; size: number; data: StateFile } | undefined;

export function emptyState(): StateFile {
	return { version: 1, degraded: {} };
}

function normalizeEntry(value: unknown): DegradeEntry | undefined {
	if (!value || typeof value !== "object") return undefined;
	const v = value as { level?: unknown; until?: unknown; code?: unknown; at?: unknown };
	if (typeof v.level !== "number" || !Number.isFinite(v.level)) return undefined;
	if (typeof v.until !== "number" || !Number.isFinite(v.until)) return undefined;
	return {
		level: Math.trunc(v.level),
		until: v.until,
		code: typeof v.code === "string" ? v.code : "quota",
		at: typeof v.at === "number" && Number.isFinite(v.at) ? v.at : Date.now(),
	};
}

export function readState(path: string): StateFile {
	try {
		const stat = statSync(path);
		if (stateCache && stateCache.path === path && stateCache.mtimeMs === stat.mtimeMs && stateCache.size === stat.size) {
			return stateCache.data;
		}
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<StateFile> | null;
		const raw = parsed && typeof parsed.degraded === "object" && parsed.degraded ? (parsed.degraded as Record<string, unknown>) : {};
		const degraded: Record<string, DegradeEntry> = {};
		for (const [key, value] of Object.entries(raw)) {
			const entry = normalizeEntry(value);
			if (entry) degraded[key] = entry;
		}
		const data: StateFile = { version: 1, degraded };
		stateCache = { path, mtimeMs: stat.mtimeMs, size: stat.size, data };
		return data;
	} catch {
		return emptyState();
	}
}

/** 仍处于降级窗口内的条目；已过期或结构非法返回 undefined。 */
export function activeEntry(path: string, key: string, now: number = Date.now()): DegradeEntry | undefined {
	const entry = readState(path).degraded[key];
	if (!entry || entry.until <= now) return undefined;
	return entry;
}

function sameEntry(a: DegradeEntry | undefined, b: DegradeEntry): boolean {
	return !!a && a.level === b.level && a.until === b.until && a.code === b.code;
}

function prune(state: StateFile, now: number): StateFile {
	const degraded: Record<string, DegradeEntry> = {};
	for (const [key, entry] of Object.entries(state.degraded)) {
		if (entry.until + PRUNE_AFTER_MS >= now) degraded[key] = entry;
	}
	return { version: 1, degraded };
}

function writeState(path: string, data: StateFile): { ok: true } | { ok: false; error: string } {
	const tmp = `${path}.${process.pid}.tmp`;
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
		renameSync(tmp, path);
		stateCache = undefined;
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
 * 返回值里的 `entry` 是**实际生效**的条目（可能因「单调前进」而保留盘上更深的档位）；
 * `changed` 表示相对盘上是否有变化（供 UI 去重提示）；写入失败时 `writeError` 有值且不抛异常。
 */
export function upsertEntry(
	path: string,
	key: string,
	entry: DegradeEntry,
	now: number = Date.now(),
): { entry: DegradeEntry; changed: boolean; writeError?: string } {
	const current = readState(path);
	const previous = current.degraded[key];
	const merged = previous && previous.until > now && previous.level > entry.level ? previous : entry;
	const changed = !sameEntry(previous, merged);
	const written = writeState(path, prune({ ...current, degraded: { ...current.degraded, [key]: merged } }, now));
	if (!written.ok) return { entry: merged, changed, writeError: written.error };
	return { entry: merged, changed };
}

/** 清除某个 key 的降级状态（不存在也视为成功）。 */
export function clearEntry(path: string, key: string): { ok: boolean; error?: string } {
	const state = readState(path);
	if (!(key in state.degraded)) return { ok: true };
	const degraded = { ...state.degraded };
	delete degraded[key];
	const written = writeState(path, { version: 1, degraded });
	if (!written.ok) return { ok: false, error: written.error };
	return { ok: true };
}
