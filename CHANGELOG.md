# Changelog

## 0.2.0 - 2026-10-16

降级文案收敛为单一出口（notify 与转录条目同句），手动降级反馈去重；README 双语化。

### 功能

- 降级文案统一出口 `degradeLine`：notify 与转录条目共用同一句，转录条目补上受限 provider（`src/ui.ts`、`src/constants.ts`）
- 转录条目新增 `from`（受限方 provider）：档位 ≥ 1 时记录实际受限的 provider，旧条目缺失时回落 `provider`（`src/transcript.ts`、`src/router.ts`、`extensions/provider-chain.ts`）
- 新增手动降级专用文案 `manualDegradeNotice`，`/chain degrade` 不再显示「额度受限（manual）」（`src/constants.ts`）

### 变更

- `/chain degrade` 状态已变化时不再重复回显（结果由 `⚠` 降级通知承担），未变化时回显实际生效档位（`src/router.ts`、`extensions/provider-chain.ts`）
- 「盘上已有更深档位」文案改为「已存在降级档位，保持 level=N（…），至 …」（`src/constants.ts`、`src/ui.ts`）
- README 双语化：`README.md` 改为英文（默认），中文迁入新增 `README.zh-CN.md`，顶部互相链接；安装命令不再带版本号（`README.md`、`README.zh-CN.md`、`examples/README.md`）

### 工程

- 移除 `entryDegradeLine` / `manualDegradeLine` / `degradeNotice`，统一到 `degradeLine`；同步改写测试（`tests/ui.test.ts`、`tests/router.test.ts`、`tests/entry.test.ts`）
- release skill 同步 README 双语与「发版不改 README」口径（`.agents/skills/release/SKILL.md`）

## 0.1.0 - 2026-10-16

首个版本：扩展从 `~/.pi/agent/extensions/provider-fallback.ts`（后改名 `provider-chain.ts`）迁入本仓库并模块化。
