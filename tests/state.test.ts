import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { activeEntry, clearEntry, type DegradeEntry, PRUNE_AFTER_MS, readState, upsertEntry } from "../src/state.ts";

function tempStatePath(): string {
	return join(mkdtempSync(join(tmpdir(), "pf-state-")), "provider-fallback-state.json");
}

const NOW = 1_800_000_000_000;

function entry(overrides: Partial<DegradeEntry> = {}): DegradeEntry {
	return { level: 1, until: NOW + 3_600_000, code: "test", at: NOW, ...overrides };
}

test("写入后可读回", () => {
	const path = tempStatePath();
	const result = upsertEntry(path, "volcengine", entry(), NOW);
	assert.equal(result.changed, true);
	assert.equal(result.writeError, undefined);
	assert.deepEqual(readState(path).degraded.volcengine, entry());
	assert.deepEqual(readState(path).degraded.volcengine, activeEntry(path, "volcengine", NOW));
});

test("文件不存在或损坏 → 空状态，不抛异常", () => {
	const missing = tempStatePath();
	assert.deepEqual(readState(missing), { version: 1, degraded: {} });
	assert.equal(activeEntry(missing, "volcengine", NOW), undefined);

	const broken = tempStatePath();
	writeFileSync(broken, "{ not json", "utf8");
	assert.doesNotThrow(() => readState(broken));
	assert.deepEqual(readState(broken), { version: 1, degraded: {} });
});

test("activeEntry：过期条目视为未降级", () => {
	const path = tempStatePath();
	upsertEntry(path, "volcengine", entry({ until: NOW - 1 }), NOW - 3_600_000);
	assert.equal(activeEntry(path, "volcengine", NOW), undefined);
	assert.equal(readState(path).degraded.volcengine?.code, "test");
});

test("合并：盘上更深的活跃档位不被回退（changed=false）", () => {
	const path = tempStatePath();
	upsertEntry(path, "volcengine", entry({ level: 2, until: NOW + 3_600_000 }), NOW);
	const result = upsertEntry(path, "volcengine", entry({ level: 1, until: NOW + 600_000, code: "later" }), NOW);
	assert.equal(result.entry.level, 2);
	assert.equal(result.changed, false);
	assert.equal(readState(path).degraded.volcengine?.level, 2);
});

test("合并：盘上条目已过期时允许回退与覆盖", () => {
	const path = tempStatePath();
	upsertEntry(path, "volcengine", entry({ level: 2, until: NOW - 1 }), NOW - 3_600_000);
	const result = upsertEntry(path, "volcengine", entry({ level: 1, until: NOW + 600_000, code: "fresh" }), NOW);
	assert.equal(result.entry.level, 1);
	assert.equal(result.entry.code, "fresh");
	assert.equal(result.changed, true);
});

test("合并：推进到更深的档位（changed=true）", () => {
	const path = tempStatePath();
	upsertEntry(path, "volcengine", entry({ level: 1 }), NOW);
	const result = upsertEntry(path, "volcengine", entry({ level: 2 }), NOW);
	assert.equal(result.entry.level, 2);
	assert.equal(result.changed, true);
	assert.equal(readState(path).degraded.volcengine?.level, 2);
});

test("清理：超过 24h 的历史条目被删除，未过期条目保留", () => {
	const path = tempStatePath();
	upsertEntry(path, "old", entry({ until: NOW - PRUNE_AFTER_MS - 1 }), NOW);
	upsertEntry(path, "kept", entry({ until: NOW - PRUNE_AFTER_MS + 60_000 }), NOW);
	upsertEntry(path, "active", entry({ until: NOW + 3_600_000 }), NOW);
	const degraded = readState(path).degraded;
	assert.equal(degraded.old, undefined);
	assert.ok(degraded.kept);
	assert.ok(degraded.active);
});

test("写入失败：返回 writeError、不抛异常、不遗留 tmp 文件", () => {
	const dir = mkdtempSync(join(tmpdir(), "pf-state-"));
	const result = upsertEntry(dir, "volcengine", entry(), NOW); // path 是已存在目录 → rename 失败
	assert.ok(result.writeError, "应返回 writeError");
	assert.equal(result.entry.level, 1);
	assert.deepEqual(readdirSync(dir), [], "不应遗留 tmp 文件");
});

test("clearEntry：清除后 state 不含该 key，重复清除仍成功", () => {
	const path = tempStatePath();
	upsertEntry(path, "volcengine", entry(), NOW);
	upsertEntry(path, "workbuddy", entry(), NOW);
	assert.equal(clearEntry(path, "volcengine").ok, true);
	assert.deepEqual(Object.keys(readState(path).degraded), ["workbuddy"]);
	assert.equal(clearEntry(path, "volcengine").ok, true);
});

test("clearEntry：写入时顺带清理过期历史条目（与 upsertEntry 一致）", () => {
	const path = tempStatePath();
	upsertEntry(path, "active", entry(), NOW);
	// 用较早的 now 落盘一条已过期的历史条目，避免被同一次写入清掉
	upsertEntry(path, "stale", entry({ until: NOW - PRUNE_AFTER_MS - 1000 }), NOW - PRUNE_AFTER_MS - 2000);
	assert.deepEqual(Object.keys(readState(path).degraded).sort(), ["active", "stale"]);

	assert.equal(clearEntry(path, "stale", NOW).ok, true);
	assert.deepEqual(Object.keys(readState(path).degraded), ["active"]);
});

test("readState：结构非法的条目被忽略，合法条目保留", () => {
	const path = tempStatePath();
	writeFileSync(
		path,
		JSON.stringify({ version: 1, degraded: { bad1: { level: "1", until: NOW + 1, code: "x", at: 0 }, bad2: null, good: entry() } }),
		"utf8",
	);
	assert.deepEqual(Object.keys(readState(path).degraded), ["good"]);
});

test("readState：同 mtime/size 的外部改写也能读到（无陈旧缓存）", () => {
	const path = tempStatePath();
	const before = JSON.stringify({ version: 1, degraded: { volcengine: { level: 1, until: NOW + 1, code: "aa", at: 0 } } });
	const after = JSON.stringify({ version: 1, degraded: { volcengine: { level: 2, until: NOW + 1, code: "bb", at: 0 } } });
	assert.equal(before.length, after.length, "两段内容需等长才能复现 mtime+size 缓存问题");

	writeFileSync(path, before, "utf8");
	assert.equal(readState(path).degraded.volcengine?.level, 1);
	const stat = statSync(path);
	writeFileSync(path, after, "utf8");
	utimesSync(path, stat.atime, stat.mtime); // 强制 mtime 与首次读取时一致
	assert.equal(readState(path).degraded.volcengine?.level, 2);
});

test("状态文件为人类可读 JSON（缩进 2 + 末尾换行）", () => {
	const path = tempStatePath();
	upsertEntry(path, "volcengine", entry(), NOW);
	const raw = readFileSync(path, "utf8");
	assert.ok(raw.endsWith("}\n"));
	assert.ok(raw.includes('\n  "version": 1'));
});
