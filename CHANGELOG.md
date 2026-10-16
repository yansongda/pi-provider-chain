# Changelog

## 0.2.1 - 2026-10-16

页脚改为 `→` / `↓` 区分档位、恢复时间取链路内最早并点名所属 provider；补齐文档体系（docs 索引、架构文档、AGENTS.md）。

### 变更

- 页脚图标按档位区分：档位 0 用 `→`、降级用 `↓`（此前分别为 `⬇` 与 `⚠`），两者为同族细箭头；页脚不再使用 `⚠`，警示语义保留在 notify 与转录条目（`src/constants.ts`、`src/ui.ts`）
- 页脚降级文案去掉「备用」，改为 `<当前目标> · <MM-DD HH:mm> 恢复 <provider>`，明确该时间属于哪一方（`src/constants.ts`、`src/ui.ts`）
- 页脚恢复时间与 provider 改取「当前选中模型链路内仍活跃的降级条目里 `until` 最小者（并列取链路靠前者）」，不再只看本模型 `stateKey` 条目（`src/router.ts`）
- README 双语（`README.md`、`README.zh-CN.md`）新增「与 pi-subagents 配合」：子会话必须额外加载本扩展、settings 写法与本地开发注意事项；`docs/` 目录说明改为索引指向
- `examples/provider-chain.json` 同步为真实配置（9 个模型，含 `s-*` 子代理模型；`thinkingLevels` 收敛为 `max` / `high`），`examples/README.md` 补一行 pi-subagents 提示

### 工程

- 新增 `docs/README.md`（文档索引与单一权威来源约定）、`docs/architecture.md`（当前状态架构文档：分层与依赖方向、`route()` 决策顺序、降级语义不变量、状态文件/宿主/配置契约）；移除 3 份 `2026-10-15` 日期化设计记录（可从 git 历史取回）；新增 `docs/2026-10-16-footer-recovery-and-icons.md`
- 新增 `AGENTS.md`（面向 AI 编码代理的开发约束：分层铁律、降级语义不变量、状态文件与配置契约、测试与发版规范、变更检查清单），仓库结构块补 `src/command.ts`
- 测试：页脚断言同步新图标与文案，并新增「链路内多条活跃条目取最早恢复（并列取链路靠前者）」用例（`tests/ui.test.ts`、`tests/router.test.ts`、`tests/entry.test.ts`）
- `LICENSE` 版权行补邮箱

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
