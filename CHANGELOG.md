# Changelog

## 0.3.1 - 2026-11-11

文档收束：移除日期化设计记录与 docs 索引，架构文档按当前实现校正；扩展代码与运行时行为不变。

### 工程

- 删除 `docs/README.md` 索引与 4 份日期化设计记录（`docs/2026-10-16-footer-recovery-and-icons.md`、`docs/2026-11-09-unified-messages.md`、`docs/2026-11-10-runtime-hardening.md`、`docs/2026-11-11-npm-scope-migration.md`）：`docs/` 仅保留 `architecture.md`，历史内容可从 git 历史取回
- `docs/architecture.md` 按当前实现校正：补 scoped 包名与 `publishConfig.access`、按真实 `files` 白名单列出发布物；分层图补 `src/command.ts` 与装配层直用的模块；发布段落重写为 `release.yml` 的实际步骤与 OIDC Trusted Publishing 前置条件（包需已存在、workflow 不创建 GitHub Release、旧包弃用迁移）
- `AGENTS.md` 与 `README.md` / `README.zh-CN.md`：仓库结构块去掉已删除的 `docs/README.md` / `docs/YYYY-MM-DD-*.md`，文档分工改为直接指向 `docs/architecture.md`

## 0.3.0 - 2026-11-11

分发名迁移到 scoped 包 `@yansongda/pi-provider-chain`；同一窗口内一并发布此前已在 main 积累的用户文案统一（档位徽标 `⓪①`）与运行时硬化。

> 本段于发布后按真实 diff（`v0.2.1..286627c`）补正：原段落只记迁移，漏记同窗口的文案统一与运行时硬化，且「代码与运行时行为不变」「前缀保持 `[pi-provider-chain]`」与 diff 不符。

### 变更

- `package.json`：`name` → `@yansongda/pi-provider-chain`，新增 `publishConfig.access: "public"`（scoped 包默认 restricted）；旧的非 scoped 包 `pi-provider-chain` 停更
- 安装/升级命令改为 `pi install npm:@yansongda/pi-provider-chain`；`README.md` / `README.zh-CN.md` 标题与安装小节、`examples/README.md`、`AGENTS.md` 与 pi-subagents 片段同步
- 用户文案统一为档位徽标：页脚与 `/chain status` 用 `⓪①②…` 表达档位（不再出现 `level=N`，也不再用 `→` / `↓` 当档位前缀）；时间统一 `YYYY-MM-DD HH:mm`（`formatClock` 单参数、不依赖 locale）
- 转录条目与「未启用」提示前缀统一为 `[pi-provider-chain]`（此前为 `[chain]` / `[provider-chain]`）；降级与恢复的 notify 和转录条目各共用同一句
- 页脚降级文案改为 `① <目标> · <恢复方> <时间> 恢复`；过期提示只在模型状态行出现一次（删除 `staleHint`），手动降级未改变状态时不再重复回显，改为回显盘上实际生效的更深档位
- 时长一律钳制到 `[1min, maxDegradeMs]`：`maxDegradeMs` 低于 1min 时按 1min 处理；`defaultDegradeMs`、手动 `/chain degrade <时长>` 与错误文本解析出的恢复时间共用同一规则
- `stateFile` 相对路径按 `agentDir` 解析（不再按进程 cwd），父子进程/不同 cwd 共享同一份状态；`/chain status` 直接展示实际加载的配置路径

### 工程

- 状态文件读取只认 `version: 1`：缺失 `version` 或未来版本一律视为空状态；`clearEntry` 在 key 不存在时也执行剪枝
- 读盘次数收敛：一次操作（写、合并、剪枝、提示、页脚）复用同一份状态快照与同一时钟；`activeEntry(path)` 改为纯函数 `activeEntryOf(state)`
- `/chain status` 渲染下沉到 `src/ui.ts`（`renderStatusLines`），router 只读状态并转发；`reviewFailure` → `applyFailure`
- 装配层：`message_end` 用 `stateKeys` Set 判定所属链路、命令补全改为逐词前缀、通知级别由命令结果决定（手动降级成功仍由降级通知承担）
- 测试：六份测试文件 +292/−107 行，新增圈码徽标边界、`version` 校验、1min 下限、相对 `stateFile`、剪枝、`renderStatusLines` 渲染与更深档位保留等用例
- 文档：新增日期化设计记录（文案统一、运行时硬化、npm scope 迁移）；`.agents/skills/release/SKILL.md` 同步包名事实表、发布核验命令与首发特例；`docs/architecture.md`、`AGENTS.md` 同步 `npm:` 包源示例

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
