# 技术设计：pi-provider-fallback 独立化 + 代码优化 + npm 发布

> 注：本文中的 `src/routing.ts` 已于同日（2026-10-15）更名为 `src/route-policy.ts`（纯改名，无行为变化）。
> **时间**：2026-10-15
> **作者**：DeepSeek V4.1 Flash（PI_MODEL=deepseek-v4.1-flash）+ yansongda
> **状态**：经过人工审核确认

---

## 1. 背景与问题

**现状**

`~/.pi/agent/extensions/provider-fallback.ts`（单文件 ~620 行）由 Pi 的用户扩展目录自动加载：读取配置后为每个条目注册一个虚拟模型（默认 provider = `yansongda`），把请求路由到 `primary`，命中额度/订阅/欠费类错误时自动推进到 `fallbacks`；降级状态写入共享状态文件，跨 session、跨进程、跨父子 subagent 生效。

配置 `~/.pi/agent/model-routing.json`，状态 `~/.pi/agent/model-routing-state.json`。
仓库 `yansongda/pi-provider-fallback`（原 `pi-virtual-model-fallback`）此前只有 `LICENSE` + initial commit，未承载代码。

**困境**

1. 代码只存在于用户目录：无版本控制、无测试、无发布通道，改坏了没有历史可回。
2. 命名不一致：扩展文件名 / 状态键 / entry 类型 / 命令都是 `provider-fallback`，配置与状态文件却是 `model-routing`，仓库名是 `virtual-model-fallback`。
3. 单文件把配置解析、状态 IO、降级判定、路由决策、UI 渲染、命令混在同一个闭包里，**无法单测**。
4. 状态跨进程读改写是**盲覆盖**：父进程与子 agent 并发写可能把 `level` 回退（把已降级的请求打回限额主用）；过期条目永不清理，文件随时间缓慢增长。
5. `~/.pi/agent/settings.json` 中 `subagents.defaultSubagentOnlyExtensions` 硬编码旧文件绝对路径，迁移后子 agent 会丢失路由能力。
6. npm 名 `pi-provider-fallback` 已被 `c37o` 占用（v1.0.4，同类功能），无法作为包名发布。

**目标（约束）**

- **行为零回归**：降级语义（仅额度类错误触发、retry/continuation 保留缓存与思考签名、settle 兜底续跑、reset 时间解析与钳制）完全不变。
- **零运行时依赖**：只用 Pi 提供的 host 包（peer），`npm install` 不引入传递依赖。
- **可发布**：`npm pack` 内容自洽，`pi install npm:@yansongda/pi-provider-fallback` 开箱可用；tag 推送即自动发布。
- **可回滚**：一条 `pi remove` + 两次 `mv` 即恢复旧扩展与旧配置。

---

## 2. 整体方案

**核心思路**：把扩展从用户目录搬进仓库，做成标准 **pi package**（本地路径安装）；同时把「判定 / 决策」从「IO / UI」中拆成纯函数，用 Node 原生 TS 单测兜住行为；最后用 `pi list` + `pi -p` 真机端到端验收。

**架构**

```
pi process (parent / subagent)
        │ load
        ▼
extensions/provider-fallback.ts   ← 装配层：registerVirtualModel / pi.on / registerCommand / entry renderer
        │ import（.ts 相对路径，与 pi-open-tui 惯例一致，已验证）
        ├── src/config.ts   读 ~/.pi/agent/provider-fallback.json → 校验（纯函数）
        ├── src/degrade.ts  错误文本 → 降级判定 / reset 时间 / 时长解析（纯函数）
        ├── src/routing.ts  链路 + 档位 + 可用性探针 → 目标物理模型（纯函数，探针注入）
        ├── src/state.ts    provider-fallback-state.json（原子写 + 合并 + 清理）
        └── src/ui.ts       纯文本文案（页脚、notify、命令输出；无 pi 依赖）
        ▼
~/.pi/agent/provider-fallback-state.json   ← 跨 session / 跨进程 / 父子 agent 共享
```

**文件结构（新增 / 修改 / 删除）**

```
pi-provider-fallback/
├── package.json                    新增（name/version/pi manifest/peerDeps/files/scripts/publishConfig）
├── tsconfig.json                   新增（仅类型检查；erasable syntax only）
├── .gitignore                      新增
├── README.md                       新增（中文：简介/安装/配置/命令/状态/开发/发布）
├── CHANGELOG.md                    新增（0.1.0 起）
├── LICENSE                         已有（MIT）
├── extensions/provider-fallback.ts 新增（入口装配，由单文件拆出后瘦身）
├── src/{config,degrade,routing,state,ui}.ts        新增（拆分自单文件）
├── tests/{config,degrade,routing,state,entry}.test.ts  新增（node --test，零依赖）
├── .github/workflows/{ci,release}.yml              新增（CI + tag 自动发布）
├── docs/2026-10-15-pi-provider-fallback.md         新增（本文件，入库）
├── docs/implementation/2026-10-15-pi-provider-fallback.md  新增（执行计划；过程产物，gitignore 本地保留）
├── docs/evidence/2026-10-15-pi-provider-fallback/  新增（执行证据；过程产物，gitignore 本地保留）
├── docs/learning/2026-10-15-pi-provider-fallback.md 新增（共享学习文件；过程产物，gitignore 本地保留）
└── ~/.pi/agent/extensions/provider-fallback.ts     迁移后删除（/tmp 留存备份）
```

---

## 3. 详细设计

### 3.1 命名与路径

| 项 | 值 | 说明 |
|---|---|---|
| npm 包名 | `@yansongda/pi-provider-fallback` | scoped + `publishConfig.access=public`（scoped 包必须显式 public） |
| 本地目录 / GitHub 仓库 | `/Users/yansongda/000-Coding/pi-provider-fallback`、`yansongda/pi-provider-fallback` | GitHub 侧已由用户改名；本地目录同步改；`git remote set-url` 待用户单独授权 |
| 扩展文件 | `extensions/provider-fallback.ts` | 仓库内相对路径 |
| 配置文件 | `<agentDir>/provider-fallback.json` | `agentDir = $PI_CODING_AGENT_DIR \|\| ~/.pi/agent`（现有代码已使用该变量，已验证） |
| 状态文件 | `<agentDir>/provider-fallback-state.json` | 配置内 `stateFile` 仍可覆盖 |
| 状态键 / entry 类型 / 命令 | `provider-fallback` / `provider-fallback` / `/route` | **保持不变**，避免会话历史与操作习惯断裂 |

新配置文件 = 旧 `model-routing.json` 去掉 `stateFile` 一行，其余原样：

```json
{
  "virtualProvider": "yansongda",
  "models": [
    {
      "id": "deepseek-v4.1-flash",
      "name": "DeepSeek V4.1 Flash · auto",
      "thinkingLevels": ["low", "high", "max"],
      "contextWindow": 1000000,
      "maxTokens": 384000,
      "primary": "volcengine/deepseek-v4.1-flash",
      "fallbacks": ["workbuddy/deepseek-v4.1-flash"]
    }
  ]
}
```

### 3.2 配置加载（`src/config.ts`）

- 出口：`loadConfig(path?) -> { ok: true; loaded: LoadedConfig } | { ok: false; error: string }`。
- 校验：`virtualProvider` 非空、`models[]` 非空且每项 `id` + 合法 `primary`、`degradePatterns` 过滤空项后非空、`resetPattern` 编译失败回落默认、`defaultDegradeMs/maxDegradeMs` 非法回落默认。
- 非法 `fallbacks[]` 项按现行为**静默过滤**（保持兼容），但 `primary` 非法即整体报错。
- 路径：`agentDir()` 尊重 `PI_CODING_AGENT_DIR`；`~` 展开保持在 `expandPath()`。
- 不引入 schema 依赖（保持零 runtime 依赖）。

### 3.3 降级判定（`src/degrade.ts`，纯函数）

- 保持语义：子串匹配（`escapeRegExp` + 忽略大小写）；reset 正则捕获 → `Date.parse` → 钳制到 `[now + 1min, now + maxDegradeMs]`。
- **优化**：纯字母/词组类 pattern 加词边界（`billing` → `\bbilling\b`），降低 `billing` 命中无关文案的误判；含 `_`、驼峰、数字的错误码保持原样匹配（词边界会把 `_` 视为单词字符，故 `insufficient_quota` 仍按原样处理）。
- `degradePatterns` 配置存在时**完全覆盖**默认值（现行为）。

### 3.4 路由决策（`src/routing.ts`，纯函数）

伪代码（与现实现逐条对齐）：

```
decideRoute({ chain, level, reason, failedRef, previousRef, isAvailable })
  if reason == retry        and levelOf(failedRef)    == level and isAvailable(chain[level]) → 复用同档位（保缓存）
  if reason == continuation and levelOf(previousRef)  == level and isAvailable(chain[level]) → 沿用上一物理模型
  for i = level .. end  : if isAvailable(chain[i]) → chain[i]        # 向后找可用
  for i = level-1 .. 0  : if isAvailable(chain[i]) → chain[i]        # 向前兜底
  return undefined                                                    # 入口层回落 primary / 抛错
```

- 可用性探针 `isAvailable(ref)` 由入口注入（`ctx.modelRegistry.find` + `hasConfiguredAuth`），因此纯函数可单测。
- 保留「全链路无凭证时返回 primary 让 Pi 报出真实错误」的兜底语义。

### 3.5 状态文件（`src/state.ts`）

- 保留：`mtime + size` 读缓存；`tmp + rename` 原子写；解析失败 → 空状态（不抛）。
- **优化 1（合并，防回退）**：写前重读盘，同 key 若盘上条目未过期且 `level` 更大，取更大 level（单调前进），消除父子进程互相回退。
- **优化 2（清理）**：写入时删除 `until + 24h < now` 的历史条目，防无限增长。
- **优化 3（可观测）**：写失败返回原因（仍不抛，保留“本次降级仅本进程生效”的降级路径），用户文案不变。
- 出口：`readState` / `activeEntry` / `upsertEntry`（返回 `{ entry, changed, writeError? }`）/ `clearEntry`。

### 3.6 入口装配（`extensions/provider-fallback.ts`）

- 保留全部行为：4 个虚拟模型注册、`agent_before_settle` 兜底（剔除失败消息 + `continue: true` 续跑一次）、`message_end` 恢复提示、`session_start` 页脚恢复、entry renderer、`/route status|fallback|reset`。
- **优化**：
  - `thinkingLevels: (...) as never` → 派生自 `VirtualModelDefinition["thinkingLevels"]`（已验证 `pi-coding-agent` 导出该类型，`dist/index.d.ts:28`）。
  - entry data 由 `{ kind: string; ... }` 改为判别联合类型 `RouteEntryData`。
  - 删除无意义的 `typeof pi.on === "function"` 判断。
  - 报错前缀 `model-routing:` → `provider-fallback:`；启动提示 `[provider-fallback]`。
  - 状态写失败的服务端文案保持“（状态文件写入失败，本次降级仅本进程生效）”。
- **新增**：`/route reload` → `ctx.reload()`（已验证 `ExtensionCommandContextActions.reload` 存在），改配置后无需重启进程。
- 单文件瘦身为「装配 + 少量胶水」，纯逻辑全部进入 `src/`。

### 3.7 发布准备（npm / GitHub Actions）

`package.json` 关键点（依官方 `docs/packages.md`，已验证）：

| 字段 | 值 | 说明 |
|---|---|---|
| `name` | `@yansongda/pi-provider-fallback` | scoped |
| `publishConfig` | `{ "access": "public" }` | scoped 包必须 |
| `keywords` | `["pi-package", "pi", "pi-coding-agent", "pi-extension", "model-fallback", "quota", "router"]` | `pi-package` 用于 Pi 画廊收录 |
| `pi.extensions` | `["./extensions/provider-fallback.ts"]` | 显式 manifest（不设 `exports`，避免与 Pi 发现机制冲突） |
| `peerDependencies` | `@earendil-works/pi-coding-agent`、`@earendil-works/pi-tui`，范围 `*` | host 提供；`peerDependenciesMeta.optional=true` |
| `dependencies` | 空 | 零运行时依赖 |
| `devDependencies` | `typescript`、`@types/node`、上述两个 pi 包 | 仅用于 `typecheck`，Pi 安装本地包时不会装 |
| `files` | `["extensions", "src", "README.md", "CHANGELOG.md", "LICENSE"]` | 不含 tests |
| `engines` | `{"node": ">=22.18.0"}` | `node --test` 直跑 TS 需要该版本 |

脚本（**工具链用 bun**）：`test`（`bun test`）、`typecheck`（`tsc --noEmit`）、`prepublishOnly`（test + typecheck）、`pack`（`bun pm pack --dry-run`）。

CI/CD：

- `.github/workflows/ci.yml`：push / PR → `oven-sh/setup-bun@v2` + `bun install --frozen-lockfile` + `bun run typecheck` + `bun run test`。
- `.github/workflows/release.yml`：tag `v*` → 同上 + `npm publish --access public --provenance`（`NODE_AUTH_TOKEN=${{ secrets.NPM_TOKEN }}`）+ `gh release create --generate-notes`。
- 唯一保留 npm CLI 的地方就是发布这一步：`bun publish` 目前不支持 `--provenance` 供应链证明（已实测 `bun publish --help`）。
- **首次发布必须手动**：`@yansongda` scope 归属与本地 npm 登录态需先确认（本机 `npm whoami` 当前返回 401，说明 token 可能已失效）；包存在之后才能配置 npm 侧 Trusted Publishing（OIDC）作为免 token 的替代方案。
- **CI 中不调用 `pi`**：CI 只跑单测与类型检查；真机行为验收（虚拟模型路由、降级）由本机执行，记录在 evidence。

### 3.8 兼容性与迁移

| 旧 | 新 | 处理 |
|---|---|---|
| `~/.pi/agent/extensions/provider-fallback.ts` | 仓库 `extensions/provider-fallback.ts` + `pi install <repo>` | 验证通过后删除（/tmp 备份） |
| `~/.pi/agent/model-routing.json` | `~/.pi/agent/provider-fallback.json`（去 `stateFile`） | `mv`，内容不动 |
| `~/.pi/agent/model-routing-state.json` | `~/.pi/agent/provider-fallback-state.json` | `mv`，保留当前 volcengine 降级档位 |
| settings `packages` | 追加本地包路径 | `pi install` 写入 |
| settings `subagents.defaultSubagentOnlyExtensions` | 新仓库文件绝对路径 | 手工改写 |
| `/route`、状态键、entry 类型 | 不变 | — |

**目录改名（`pi-virtual-model-fallback` → `pi-provider-fallback`）**：会在本会话执行。由于当前 pi 会话的工作目录正是旧路径，改名后立即在旧路径建**临时软链**指向新目录，保证会话内工具调用不中断；全部验收完成后删除软链，并提示用户在新目录重启会话（`git remote set-url` 需用户单独授权）。

### 3.9 性能与影响

- 每次请求：`route()` 内多一次状态文件 `stat` + 命中缓存读取，与现状相同；纯函数拆分不引入额外 IO。
- 扩展加载：多 4 个模块的 jiti 编译（有缓存），可忽略。
- 影响范围：仅本机 `~/.pi/agent` 下的配置 / 状态 / settings，加上仓库自身；无网络、无新增外部服务。

---

## 4. 推进策略

阶段划分（每阶段一个硬验证点，失败即停）：

```
阶段 1  仓库骨架（package.json / tsconfig / src 拆分 / tests / README / workflows）
        验证：node --test 全绿；npm run typecheck 无错
阶段 2  入口装配（extensions/provider-fallback.ts）+ 与旧文件逐条对照
        验证：retry / continuation / settle / 命令分支无遗漏；entry 集成测试通过
阶段 3  本地安装与迁移（pi install <repo>、settings 两处、两份文件 mv）
        验证：pi list 显示本地包；pi -p 走虚拟模型成功且物理模型 = volcengine（主用）
阶段 4  降级端到端（写入“volcengine 已降级”状态）
        验证：pi -p 实际派发 workbuddy（读会话 JSONL 的 assistant provider）
阶段 5  清理与改名（删旧扩展文件、目录改名 + 临时软链）
        验证：无双重加载；grep 无 model-routing 残留（除 /tmp 备份）
阶段 6  发布准备（bun pm pack --dry-run、workflows 语法检查）
        验证：tarball 内容符合 files 白名单；npm publish 由用户执行
```

**回滚操作（具体）**

- 正常回滚：`pi remove <repo 路径>`；`mv ~/.pi/agent/provider-fallback.json ~/.pi/agent/model-routing.json`（并写回 `"stateFile": "~/.pi/agent/model-routing-state.json"`）；`mv ~/.pi/agent/provider-fallback-state.json ~/.pi/agent/model-routing-state.json`；还原 `settings.json` 的 `packages` 与 `subagents.defaultSubagentOnlyExtensions` 两处；`/reload`。
- 紧急回滚（新扩展改坏）：`cp /tmp/pi-provider-fallback-backup-20261015/provider-fallback.ts ~/.pi/agent/extensions/provider-fallback.ts` + 上述 mv，重启 pi。
- 目录改名回滚：`mv /Users/yansongda/000-Coding/pi-provider-fallback /Users/yansongda/000-Coding/pi-virtual-model-fallback`（GitHub 侧由用户改回）。

---

## 5. 风险与对策

| 风险 | 严重度 | 对策 |
|---|---|---|
| 拆分重构引入降级漏判 / 误判 | 高 | 纯函数单测 + 真实错误串回归断言 + 阶段 3/4 真机端到端（真实降级链路） |
| `@yansongda` scope 不归本账号 / npm token 失效导致发布失败 | 中 | 发布前先 `npm whoami` + `npm publish --dry-run` 验证；失败则改用可用名（`pi-virtual-model-fallback`）作为兜底 |
| 迁移期新旧扩展同时加载（重复注册 / 重复提示） | 低 | 同 provider+id 注册为**替换**语义（已验证 docs/virtual-models.md）；阶段 3→5 之间只 `/reload` 一次 |
| 删除旧扩展文件、迁移配置文件不可逆 | 中 | 删除前 `cp` 到 `/tmp/pi-provider-fallback-backup-20261015/`；配置只 `mv` 不手改（仅去 `stateFile`） |
| 词边界优化导致真实错误不再命中 | 中 | 用真实错误串做单测断言；`degradePatterns` 配置优先级高于默认值，可即时覆盖 |
| 子 agent 路径遗漏 → 子 agent 不再降级 | 中 | 阶段 3 校验 `settings.json` 两处 + 实跑一次子 agent |
| 目录改名打断当前会话工具调用 | 中 | 改名后立即建临时软链；验收完成后删链并提示在新目录重启会话 |
| `npm ci` 在 CI 中因 peerDependencies 报错 | 低 | `peerDependenciesMeta.optional=true` + 相同包进 devDependencies（与 pi-open-tui 同做法） |
| GitHub Actions 首次发布需要 NPM_TOKEN，secret 未配置 | 低 | 首次手动发布；workflow 内文档化 secret 名称与 Trusted Publishing 替代方案 |

---

## 6. 监控与可观测性

不改上报结构，复用现有三条通道：

```jsonc
// notify 文案（不变）
"⚠ volcengine 额度受限（AccountQuotaExceeded）→ 已切换 workbuddy，恢复时间 2026-10-28 23:59:59"
// 页脚 status（不变）
"⚠ 备用 workbuddy · 10-28 23:59"
// transcript entry（不进模型上下文，data 结构不变）
{ "kind": "degrade", "provider": "volcengine", "level": 1, "to": "workbuddy/deepseek-v4.1-flash",
  "until": 1793203199000, "code": "AccountQuotaExceeded", "reason": "retry", "errorMessage": "..." }
```

- 变化仅一处：`/route status` 输出补两行人读信息 —— `配置: <path>`、`状态文件: <path>`。
- 无需新增指标：`degraded[*].code` 即降级原因分布，`until` 即恢复时间；状态文件写失败会通过 notify 文案暴露。

---

## 附录 A：默认降级判定（保持现状 + 词边界）

| 类别 | 默认 pattern（示例） |
|---|---|
| 错误码 | `AccountQuotaExceeded`、`QuotaExceeded`、`AgentPlanQuotaExceeded`、`SetLimitExceeded`、`InvalidSubscription`、`AccountOverdueError`、`ServiceOverdue` |
| 英文短语 | `subscription has expired`、`overdue balance`、`usage quota`、`exceeded the quota`、`insufficient_quota`、`out of budget`、`billing`（加词边界） |

reset 时间默认正则：`reset at\s+(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\s*([+-]\d{2}:?\d{2}))?`

## 附录 B：`/route` 命令

| 命令 | 行为 |
|---|---|
| `/route` / `/route status` | 打印当前选中模型、配置与状态文件路径、每个虚拟模型的链路与降级状态 |
| `/route fallback [时长]` | 手动降级到第 1 档，时长 `30m` / `2h` / `1d`（默认 `defaultDegradeMs`） |
| `/route reset` | 清除当前模型所属 provider 的降级状态 |
| `/route reload` | （新增）重新加载扩展与配置，等价于 `/reload` |

## 附录 C：安装与发布命令

```bash
# 本机安装（本地路径，开发期）
pi install /Users/yansongda/000-Coding/pi-provider-fallback
pi list

# 用户安装（发布后）
pi install npm:@yansongda/pi-provider-fallback@0.1.0

# 开发（bun 工具链）
bun install && bun run test && bun run typecheck && bun run pack

# 首次发布（人工执行；bun publish 无 --provenance，故用 npm CLI）
npm login && npm whoami
npm publish --access public

# 后续发布（推 tag 触发 GitHub Actions）
git tag v0.1.1 && git push origin v0.1.1
```

## 附录 D：执行期变更记录（相对本批准版本）

| 项 | 批准版本 | 实际执行 | 原因 |
| --- | --- | --- | --- |
| 包管理器 / 任务运行器 | npm + `node --test` | **bun**（`bun install` / `bun test` / `bun pm pack`） | 用户执行期追加要求「工具用 bun」 |
| 发布步骤 | npm publish | 不变（仅此一处保留 npm CLI） | `bun publish` 无 `--provenance` |
| T8/T9 顺序 | 安装 → 迁移 → 删旧文件 | **改名 → 安装 → 迁移 → 删旧文件 → 烟测** | 避免新旧扩展在同一进程中并存（重复注册/重复提示） |
| `describeModel` 入参 | 含 `level` | 去掉（内部由 `active.level` 钳制） | 避免两处传参不一致（机械性） |
| 测试运行器参数 | `node --test tests/` | 无参 `bun test` | `bun test <目录>` 会把参数当过滤器 |
| 过程性产物入库 | 未约定 | 按 execute-plan「开工准备」：`.gitignore` 忽略 `docs/implementation/`、`docs/evidence/`、`docs/learning/`、`.worktrees/`、`.pi/subagents/`；已入库的相应文件从历史中重写剔除（10 个提交，仅保留代码/测试/README/设计文档） | 用户指示：过程产物本地保留、不入库 |
