# 技术设计：配置合并为 chain + 全局改名 pi-provider-chain + 页脚常驻当前模型

> **时间**：2026-10-15
> **作者**：Claude + yansongda
> **状态**：经过人工审核确认

---

## 1. 背景与问题

**现状**

- 配置里每条虚拟模型写 `primary`（单值）+ `fallbacks`（数组），语义上就是「一条有序链路」，拆两个字段只是增加书写与迁移负担。
- 页脚（`ctx.ui.setStatus`）只在**有活跃降级**时出现，且是「按 provider 聚合」（`⚠ 备用 ×N: a, b`）；正常状态完全空白，用户看不到当前请求会派发到哪个物理模型；切换模型（`model_select`）时也不刷新。
- 命名层面：包名/仓库/扩展文件/配置与状态文件仍叫 `provider-fallback`，而功能本质是「按 chain 路由 + 额度耗尽降级」；非 scope 的 `pi-provider-fallback` 已被占用（`npm view` → 1.0.4），且 `@yansongda` scope 未注册、与账号冲突。

**困境**

1. 链路写两处，顺序关系只能靠文档理解；调整顺序要动两个字段。
2. 页脚不显示「当前目标模型」，降级时又不显示「何时恢复」。
3. 命名与功能不匹配，且 npm 名称受限 —— 包未发布，现在是改名成本最低的时刻。

**目标（约束）**

- 一条链路一个字段：`chain: string[]`，**首元素即主用**。
- 全局改名：npm 包名（非 scope `pi-provider-chain`）、仓库/目录、扩展入口文件、配置/状态文件、命令、转录前缀、常量、文案统一为 **chain**。
- 页脚**常驻**显示当前目标物理模型；主用不可用时追加该目标模型的**恢复时间**。
- 无兼容负担（包未发布）：schema 与命名直接改，不做双读/别名兼容（仅移除 `degrade` 的 `fallback` 子命令别名）。
- 降级/恢复语义、状态文件结构、`/chain status` 的全量输出保持不变。

---

## 2. 整体方案

**核心思路**：一次把「词汇」与「配置形状」收敛到 chain 语义（`chain[]` + 统一命名），再把页脚从「全模型聚合」改成「按选中模型」并补齐刷新时机（`model_select` / `message_end`）。

**命名总表（改名唯一依据）**

| 项 | 旧 | 新 |
|---|---|---|
| npm 包名 | `@yansongda/pi-provider-fallback`（未发布） | **`pi-provider-chain`**（非 scope；`npm view` → 404 可用） |
| 仓库 / 本地目录 | `pi-provider-fallback` | **`pi-provider-chain`** |
| 扩展入口 | `extensions/provider-fallback.ts` | **`extensions/provider-chain.ts`** |
| `EXTENSION_NAME` | `provider-fallback` | **`provider-chain`**（派生 `STATUS_KEY` / `ENTRY_TYPE` / `CONFIG_FILE_NAME` / `STATE_FILE_NAME` / `NOTIFY_PREFIX` / `ERROR_PREFIX`） |
| 配置文件 | `<agentDir>/provider-fallback.json` | **`provider-chain.json`** |
| 状态文件 | `<agentDir>/provider-fallback-state.json` | **`provider-chain-state.json`** |
| 命令 | `/fallback` | **`/chain`**（子命令不变：`status` / `degrade [时长]` / `reset` / `reload`） |
| 用法串 | `/fallback [status \| degrade [时长] \| reset \| reload]` | `/chain [...]` |
| 转录条目前缀 | `[fallback]` | `[chain]` |
| notify / 错误前缀 | `[provider-fallback]` / `provider-fallback:` | `[provider-chain]` / `provider-chain:` |
| 示例配置 | `examples/provider-fallback.json` | **`examples/provider-chain.json`** |
| 包关键词 | `model-fallback`, `provider-fallback` | `virtual-model`, `provider-chain`, `model-chain`, `quota`, `router` |
| 代码内 `fallback` 词 | `MESSAGES.noFallback`、`与全部 fallback 均不可用` | `MESSAGES.noSpareChain`、`与全部后备链路均不可用` |
| 手动降级转录占位 | `手动 /fallback degrade` | `手动 /chain degrade` |
| `degrade` 子命令别名 | `fallback` | **移除**（避免与新命名混淆；`reset` 的 `primary`/`clear` 别名保留） |

**文件结构**

```
extensions/provider-chain.ts                 改名（git mv）+ model_select 处理器 + ports.selection()
src/constants.ts                             改名常量 + 页脚/未配置后备文案
src/config.ts                                chain[] 校验与解析；LoadedModel.config 收窄
src/router.ts                                refreshStatus → selection-aware；RouterPorts 增 selection()
src/ui.ts                                    statusText → footerActive / footerDegraded
src/command.ts                               移除 fallback 子命令别名
tests/{config,ui,router,entry,command}.test.ts  同步 schema、页脚、命令名、临时文件名
examples/provider-chain.json                 改名 + chain[] + input 示例
README.md / examples/README.md / CHANGELOG.md   同步命名、schema、页脚说明、安装命令
package.json / bun.lock                      name / pi.extensions / URLs / keywords；lockfile 刷新
~/.pi/agent/*（仓库外）                       配置迁移、旧状态文件删除、settings.json 路径更新
```

---

## 3. 详细设计

### 3.1 配置 schema

```jsonc
{
  "virtualProvider": "yansongda",
  "models": [
    {
      "id": "deepseek-v4.1-flash",
      "name": "DeepSeek V4.1 Flash",
      "thinkingLevels": ["low", "high", "max"],
      "input": ["text", "image"],
      "contextWindow": 1000000,
      "maxTokens": 384000,
      "chain": ["volcengine/deepseek-v4.1-flash", "workbuddy/deepseek-v4.1-flash"]
      //      ↑ chain[0] = 主用（原 primary）      ↑ 之后按顺序降级（原 fallbacks）
    }
  ]
}
```

| 字段 | 变化 | 语义 |
|---|---|---|
| `models[].primary` / `models[].fallbacks` | **删除** | 语义并入 `chain[0]` / `chain[1..]` |
| `models[].chain` | **新增（必填）** | 非空数组；`chain[0]` 必须能解析为 `provider/id`，否则整条配置报错（文案 `models[] 条目缺少 id 或合法 chain[0]：…`）；`chain[1..]` 非法项**静默过滤**（沿用现行为） |

- `LoadedModel`：`chain: [ModelRef, ...ModelRef[]]`（已解析）不变；`config` 收窄为 `Omit<RoutingModelConfig, "chain">`，避免原始字符串链路与解析结果混淆。
- 「链长建议 ≤ 5」由代码注释移入 README 字段说明。

### 3.2 页脚：selection-aware 常驻

```
refreshStatus():
  sel   ← ports.selection()                              # ctx.model
  model ← sel?.provider === cfg.virtualProvider ? byId(sel.id) : undefined
  if (!model) { setStatus(undefined); return }           # 非本扩展管理的模型 → 清空
  level ← 状态文件里 model.stateKey 的活跃档位（过期 → 0，越界钳制）
  setStatus(level > 0
    ? footerDegraded({ target: refText(chain[level]), untilText: formatClock(until, "short") })
    : footerActive(refText(chain[0])))
```

| 状态 | 文案 | 示例 |
|---|---|---|
| 正常 | `⬇ <目标物理模型>` | `⬇ volcengine/deepseek-v4.1-flash` |
| 降级 | `⚠ 备用 <目标物理模型> · 恢复 MM-DD HH:mm` | `⚠ 备用 workbuddy/deepseek-v4.1-flash · 恢复 10-28 23:59` |

刷新时机：

| 事件 | 现状 | 改动后 |
|---|---|---|
| `session_start` | 刷新（聚合） | 刷新（按选中模型）；resume 时 `ctx.model` 是否就绪**未实测** → 由 `message_end` 兜底 |
| `model_select` | 未注册 | **新增**（已核实 `setModel` 先写 `agent.state.model` 再 emit） |
| `message_end` | provider 命中 → `notePrimarySuccess` | 同处**追加** `refreshStatus()` |
| 降级 / 恢复 / reset / 手动降级 | 刷新 | 内容改为按选中模型 |

- **有意变更**：页脚不再汇总其它模型/provider 的降级；全量信息仍在 `/chain status`。
- **去重**：扩展侧记录上次文案，相同则不调用 `ctx.ui.setStatus`（避免每轮响应重绘）。
- 已知偏差（本次不修，写入文档）：页脚显示「计划目标」`chain[level]`；若该目标无凭证，`route()` 会回落到其它链路，页脚与实际派发可能短暂不一致。

### 3.3 仓库外改动（已获授权，逐项备份）

| # | 动作 | 说明 |
|---|---|---|
| 1 | `~/.pi/agent/provider-fallback.json` → `provider-chain.json`，5 个模型 `primary`+`fallbacks` → `chain[]` | 备份到 `/tmp/provider-chain-migration-<ts>/`；等价文本替换（每模型 2 行 → 1 行）保留其它格式；改完 `json.load` 校验 + diff 复核 |
| 2 | 旧状态文件 `provider-fallback-state.json` | **删除**（同时备份）：旧条目字段为 `code`（新代码不读）；配额若仍耗尽首次请求会重新降级（自愈） |
| 3 | 本地目录 `pi-provider-fallback` → `pi-provider-chain` + `git remote set-url` | 改名后立即在旧路径建临时软链（保当前会话可用），收尾删链并提示在新目录重启；remote 指向 `git@github.com:yansongda/pi-provider-chain.git` |
| 4 | `~/.pi/agent/settings.json` 的 `packages[]` 与 `subagents.defaultSubagentOnlyExtensions[]` | 与 3 成对执行（否则 Pi 找不到包） |
| 5 | GitHub 仓库改名 | **需用户在 GitHub 操作**；完成前 remote 指向新名会导致 push 404（本次不 push） |
| 6 | `bun install` 刷新 `bun.lock` 包名 | 无新依赖；`git diff bun.lock` 应仅 name 相关行 |

### 3.4 兼容性与影响

| 变更 | 可见性 | 处置 |
|---|---|---|
| 配置字段与文件名 | 用户配置 | breaking（未发布）；本机配置一次性迁移（3.3-1） |
| 命令 `/fallback` → `/chain`、前缀 `[fallback]` → `[chain]` | 用户可见 | 本机会话旧 `customType` 条目 **0 条**（已验证）→ 无历史渲染问题 |
| 页脚聚合 → 按选中模型 + 常驻 | 用户可见 | 有意变更；`/chain status` 不受影响 |
| 状态文件改名 | 本机 | 删除旧文件从空状态开始（3.3-2） |
| 降级/恢复语义、状态文件结构、`models[].name/thinkingLevels/input/contextWindow/maxTokens` | — | **不变** |
| 历史设计文档（`docs/2026-10-15-pi-provider-fallback.md`、`2026-10-15-src-refactor-*.md`） | 仓库内 | **保留内容与原文件名**（历史记录真实性），在 CHANGELOG 与本设计文档记录改名 |

### 3.5 性能与影响

| 指标 | 现状 | 改动后 |
|---|---|---|
| 页脚刷新状态文件读次数 | 1（遍历全模型） | 1（只算选中模型） |
| 新增刷新点 | — | `model_select` 1 次/切换、`message_end` 1 次/响应（文案未变则不重绘） |

---

## 4. 推进策略

```
阶段 1  仓库内改名 + schema 合并（不改行为）
        验证：typecheck + 全部测试；grep 确认仓库内（除历史文档）provider-fallback / primary / fallbacks 零残留
阶段 2  页脚常驻（ui/router/constants + model_select/message_end + 去重）
        验证：router.test 覆盖 4 种 selection；entry.test 覆盖 model_select；ui.test 新文案
阶段 3  本机迁移（已授权）：配置改名+改 schema、删旧状态文件、目录改名+软链+remote+settings
        验证：loadConfig 只读脚本打印 5 条链路；pi list 能识别新路径
阶段 4  真机验收：pi -p 走虚拟模型（读会话 JSONL 的物理 provider）；页脚与 /chain 命令由用户交互确认
```

**回滚**：阶段 1/2 逐阶段 `git revert`；阶段 3 用 `/tmp` 备份还原配置 + 目录改回 + remote 改回（代码与本机必须成对回滚）。

---

## 5. 风险与对策

| 风险 | 严重度 | 对策 |
|---|---|---|
| 改名漏改 → 扩展找不到配置/命令失效 | 中 | 按命名总表逐项 grep 核对；测试断言 `CONFIG_FILE_NAME`/命令名/前缀 |
| 本机配置迁移出错导致扩展停用 | 中 | 先备份、等价替换、`json.load` 校验、loadConfig 只读校验；代码与本机迁移同批完成 |
| 目录改名打断当前会话 | 中 | 改名后立即建临时软链；收尾提示在新目录重启会话 |
| GitHub 仓库未同步改名 → remote 指向不存在的仓库 | 低 | 已明确告知需用户在 GitHub 改名；本次不 push |
| 页脚不再显示其它模型的降级 | 低 | `/chain status` 保留全量；如需全局提示可加第二状态键（本次不做） |
| 页脚显示「计划目标」与实际派发不一致（目标无凭证时） | 低 | 记为已知偏差 |

---

## 6. 监控与可观测性

- 页脚（`constants.ts` 两条新模板）：`⬇ volcengine/deepseek-v4.1-flash`、`⚠ 备用 workbuddy/deepseek-v4.1-flash · 恢复 10-28 23:59`
- 状态文件结构、notify、转录条目、`/chain status` 输出结构均不变；变化仅为命名（前缀 `[chain]`、错误前缀 `provider-chain:`、配置/状态文件名）。

---

## 附录 A：契约标注（已验证 / 推断）

**已验证（读过源码）**

| 契约 | 证据 |
|---|---|
| `model_select` = `{ type, model, previousModel, source }`；`source: "set" \| "cycle" \| "restore"` | `dist/core/extensions/types.d.ts:883-890` |
| `setModel` 先写 `agent.state.model` 再 emit → 处理器内 `ctx.model` 即新模型 | `dist/core/agent-session.js:1983-1994` |
| 本 build 只 emit `set`/`cycle`（`"restore"` 仅存在于类型） | `_emitModelSelect` 三个调用点 |
| `pi-provider-chain` 在 npm 可用；`pi-provider-fallback` 已被占用（1.0.4） | `npm view` |
| 本机会话无旧 `customType: "provider-fallback"` 条目 | `grep -ho` 计数 = 0 |
| `npm whoami` 未登录 → 发布需用户 `npm login` | `npm whoami` → ENEEDAUTH |

**推断（未实测）**：`resume` 时 `session_start` 处理器内 `ctx.model` 可能尚未就绪（由 `message_end` 兜底）；页脚文案过长时宿主可能截断。

---

## 附录 B：执行期变更记录（相对批准版本）

| 项 | 批准版本 | 实际执行 | 原因 |
| --- | --- | --- | --- |
| npm 包名 | `@yansongda/pi-provider-fallback`（初版设计） | `pi-provider-chain`（非 scope） | 用户指示：`@yansongda` scope 未注册且与账号冲突 |
| `publishConfig.access` | scoped 必需 | 移除 | 非 scope 包默认可发布 |
| 发布命令 | `npm publish --access public --provenance` | `npm publish --provenance` | 同上 |
| `src/routing.ts` | 保持原名 | 更名为 **`src/route-policy.ts`**（测试同改名） | 用户指示：与 `src/router.ts` 只差一个字母易混；纯改名，行为零变化 |
