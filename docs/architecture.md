# 架构

> 当前状态文档：描述**现在的**结构与契约。字段语义、默认值与用户操作步骤见 README（[`README.zh-CN.md`](../README.zh-CN.md)）；开发约束、测试与发版规范见 [`AGENTS.md`](../AGENTS.md)。
> 本文引用代码位置时只写**文件名 + 函数名/导出符号**，不写行号。

## 1. 定位与运行时

| 项 | 内容 |
|---|---|
| 类型 | 给 [Pi](https://pi.dev) 的扩展（TS 源码直接加载，无构建步骤） |
| 功能 | 注册**虚拟模型**；请求路由到 `chain[0]`；命中额度/订阅/欠费类错误时沿 `chain[1..]` 降级；状态写入共享文件 |
| 宿主依赖 | 仅 peer：`@earendil-works/pi-coding-agent`、`@earendil-works/pi-tui`；**运行时零依赖** |
| 运行环境 | Node ≥ 22.18（`engines`）；开发用 Bun |
| 包入口 | `package.json` → `pi.extensions: ["./extensions/provider-chain.ts"]` |
| 发布物 | `files` 白名单：`extensions/`、`src/`、`examples/`、README、CHANGELOG、LICENSE（不含 `tests/`、`docs/`） |

## 2. 分层与依赖方向

```
extensions/provider-chain.ts   装配层：唯一 import 宿主 API / pi-tui 的地方
        │  portsFor(ctx) 把 ctx 适配成 RouterPorts 注入
        ▼
src/router.ts                  策略层：档位推进 / 路由决策 / 恢复墓碑 / 页脚 / 命令输出（无 pi 依赖）
   ├── src/route-policy.ts     纯算法：该用链路里的哪一个（可穷举测试）
   ├── src/degrade.ts          纯算法：额度类错误判定 + 恢复时间/时长解析与钳制
   ├── src/model-ref.ts        纯函数：provider/id 解析与格式化
   ├── src/state.ts            纯 IO：状态文件读/写/合并/剪枝
   ├── src/config.ts           纯函数 + 只读 IO：配置加载与校验
   ├── src/transcript.ts       纯函数：转录条目契约 + agent_before_settle 的两步查询
   └── src/ui.ts               纯函数：用户文案组装（选模板 + 汇总/截断）
            ▲
src/constants.ts               叶子模块：机器常量 + MESSAGES 文案模板（不 import 项目内任何模块、不碰 IO）
```

依赖规则：

1. **只有装配层**可以 import `@earendil-works/*`；`src/` 全部无宿主依赖，因此能脱离 Pi 直接 `tsc` 与 `node:test` 运行。
2. 副作用（状态文件、宿主注册表、UI、转录）在 `src/router.ts` 内**只通过 `RouterPorts` 接口**发生；新增副作用要先加端口。
3. `src/constants.ts` 是叶子：任何模块可依赖它，它不依赖任何模块（避免环）。用户可见文案的字面量只在这里。

## 3. 请求数据流

### 3.1 虚拟模型分发

```
用户选中 yansongda/<虚拟模型 id>
        │  宿主在每次请求前调用该虚拟模型的 route(request, ctx)
        ▼
extensions/provider-chain.ts  route() → routerFor(ctx).route(model, request)
        │  （router 无状态：档位一律现读状态文件）
        ▼
返回 { model: <物理模型>, thinkingLevel }
```

### 3.2 `route()` 的决策顺序

A→E 依次执行，前一步给出可用模型就返回：

| 段 | 条件 | 行为 |
|---|---|---|
| A | `reason === "retry"` 且带 `failed.message.errorMessage` | `reviewFailure(trigger: "retry")`：命中额度类关键词才**推进档位**（见 4） |
| B | `retry` 且失败模型 == 当前档位且可用 | 复用同档位 + 沿用失败请求的思考档位（`keepThinkingLevel`，保 prompt cache 与思考签名） |
| C | `continuation` 且上一成功响应 == 当前档位且可用 | 沿用同档位与上一思考档位 |
| D | 其余情况 | 从当前档位向链尾找第一个**有凭证**的模型；找不到再向前兜底 |
| E | 全部无凭证 | 返回主用对象（`ports.catalog`）让 Pi 报出真实错误；连主用都不在目录里才抛错（宿主以错误响应结束请求） |

要点：

- **可用 = 存在且有凭证**：`ports.resolve` 内部为 `ctx.modelRegistry.find()` + `hasConfiguredAuth()`；一次请求内每个 `provider/id` 只查一次。
- `route()` 内任何异常都会先尝试回落主用，并在能回落时追加一条 `[chain] error` 转录条目（**不进模型上下文**），避免真实异常被掩盖。
- 宿主传入的 `reason` 有四种：`user` / `continuation` / `retry` / `direct`；只有 `retry` 会触发 A 段。

### 3.3 两条降级触发路径

| 路径 | 宿主事件 | 适用 | 流程 |
|---|---|---|---|
| 快路径 | `route()` 内的 A 段 | 可重试错误（429 之外的额度类） | 命中关键词 → 写状态 → 返回备用档位模型 |
| 兜底路径 | `pi.on("agent_before_settle")` | **不可重试**错误（如 403 订阅过期） | 先写状态（保证下一次请求走备用）→ 再定位失败消息所在 entry → 两者都成功才返回 `{ entries: [剔除该条的 context_edit], continue: true }`；定位不到则**只写状态、不续跑** |

### 3.4 恢复

`pi.on("message_end")` 收到成功的 assistant 响应（非 `error` / `aborted`，且 provider 属于本扩展管理的链路）时调用 `notePrimarySuccess`：若盘上条目 `level > 0` 且窗口已过期，则写 `level: 0, reason: "recovered"` **墓碑**并提示一次恢复。

`session_start` 与 `model_select` 事件只负责刷新页脚（`refreshStatus`）。

## 4. 降级语义不变量

1. **只有额度类错误才推进档位**：判定是「错误文本按配置 pattern 做忽略大小写的子串匹配」。429 瞬时限流 / 5xx / 网络错误不干预，交回 Pi 自身重试。
2. 推进不得停在失败模型上：`next = clampLevel(max(当前档位, 失败模型下标 + 1), 链路长度)`；`next <= 当前档位` 表示已无后备，不推进。
3. `settle` 兜底只接管「失败者就是当前档位」的情形（因为它要剔除那条失败消息）。
4. 档位越界一律钳制：`clampLevel` 对非有限值按 0、越界钳到 `[0, chain.length - 1]` —— 状态文件可能被外部改写，每个读取点都用它兜底。
5. 受限方 provider 按失败模型反查（`chain[失败下标].provider`）：档位 ≥ 1 时它不是状态键，报错文案必须显示真正受限的那一方。
6. 手动 `/chain degrade` 只推进到第 1 档；状态未变化时不重复回显（反馈由降级通知承担）。

## 5. 状态文件契约

路径默认 `<agentDir>/provider-chain-state.json`（`agentDir = $PI_CODING_AGENT_DIR || ~/.pi/agent`，配置可用 `stateFile` 覆盖，支持 `~`）。

```json
{
  "version": 1,
  "degraded": {
    "<chain[0] 的 provider>": { "level": 1, "until": 1793203199000, "reason": "AccountQuotaExceeded", "at": 1792055998922 }
  }
}
```

| 规则 | 实现位置 | 说明 |
|---|---|---|
| 键 = `chain[0]` 的 provider | `config.ts` 计算 `LoadedModel.stateKey` | 同一 provider 下的多个虚拟模型**共享档位** |
| 读取容错 | `state.ts` 的 `readState` | 文件缺失/损坏/字段非法一律当作空状态，不抛异常；不做缓存（避免读到陈旧快照） |
| 原子写 | `state.ts` 的 `writeState` | 先写 `<path>.<pid>.tmp` 再 `rename`；失败清理临时文件并返回 `writeError`（用户看到「仅本进程生效」后缀） |
| 单调合并 | `state.ts` 的 `upsertEntry` | 盘上同 key 条目仍活跃（`until > now`）**且**档位更深时保留盘上条目，避免父/子进程并发写把档位回退 |
| 剪枝 | `state.ts` 的 `prune` | 每次写入清理 `until + 24h < now` 的历史条目 |
| 恢复墓碑 | `router.ts` 的 `notePrimarySuccess` | 写 `{ level: 0, until: now, reason: "recovered" }`：让「已恢复」提示只出现一次，并发下也不会清掉他进程刚写入的更深活跃条目 |
| 旧条目兼容 | `ui.ts` / 装配层渲染器 | 例：降级条目缺 `from` 时回落状态键，历史会话仍能渲染 |

已知取舍：读-改-写之间**没有文件锁**，两个进程同时写**不同** key 时理论上可丢一条记录；该 provider 的下一次请求会重新降级，可自愈。

## 6. 宿主契约

| 宿主能力 | 使用方式 | 注意 |
|---|---|---|
| 注册虚拟模型 | `pi.registerVirtualModel({ provider, id, name, thinkingLevels, input, contextWindow, maxTokens, route })` | 虚拟模型不能路由到另一个虚拟模型；`route` 抛错或返回无凭证模型 → 宿主以错误响应结束请求 |
| 档位与输入声明 | 未声明 `input` 时**不下发**该字段（保持宿主默认 text+image）；未声明 `thinkingLevels` 时装配层传入全部档位 | 归一化在 `src/config.ts` 完成 |
| 事件 | `agent_before_settle`（可返回 `{ entries, continue }`）、`message_end`、`model_select`、`session_start` | 事件里的消息与 entry 用结构化泛型描述，`src/transcript.ts` 因此不依赖 pi 类型 |
| 命令 | `pi.registerCommand("chain", { description, getArgumentCompletions, handler })`；`reload` 走 `ctx.reload()` | 子命令补全由 `COMMAND_COMPLETIONS` 提供 |
| 转录条目 | `pi.appendEntry(ENTRY_TYPE, data)` + `pi.registerEntryRenderer(ENTRY_TYPE, renderer)` | 条目**不进模型上下文**，只做可见解释 |
| UI | `ctx.ui.notify(message, kind)` / `ctx.ui.setStatus(key, text)` | 先判 `ctx.hasUI`；页脚经 `lastStatus` 去重（内容未变不重绘）；UI 调用失败不影响路由 |
| 模型注册表 | `ctx.modelRegistry.find(provider, id)` + `hasConfiguredAuth(model)` | 只有两者都通过才可派发 |

## 7. 配置契约

- 只读 `<agentDir>/provider-chain.json`（`agentDir = $PI_CODING_AGENT_DIR || ~/.pi/agent`），**不做**目录搜索或 glob。扩展加载时读一次，改配置需 `/reload`。
- 校验顺序与失败语义（`src/config.ts` 的 `loadConfig`）：

| 情况 | 结果 |
|---|---|
| 文件不存在 / JSON 解析失败 | `ok: false`，附原因 |
| `virtualProvider` 缺失或空白 | `ok: false`（`缺少 virtualProvider`） |
| `models` 非数组或为空 | `ok: false`（`models[] 为空`） |
| 条目缺 `id` 或 `chain[0]` 非法 | `ok: false`，错误里带上该条目的 JSON |
| 同一配置内 `id` 重复 | `ok: false` |

`ok: false` 时扩展**完全禁用路由**：只在 `session_start` 提示原因、`/chain` 回显原因，不注册任何虚拟模型。

- `chain[1..]` 中的非法项被**静默丢弃**（`chain[0]` 已保证合法，链路长度至少 1）。
- `degradePatterns`：非空列表**完全覆盖**内置默认；缺省/空/全空白回落默认。纯字母词组项自动加词边界以减少误判。
- 时长：`resetPattern` 解析不到恢复时间时用 `defaultDegradeMs`；所有时长统一钳制到 `[1min, maxDegradeMs]`，`maxDegradeMs` 同时也是 `defaultDegradeMs` 与手动降级的上限。
- `transcriptNotice: false` 时不追加转录条目（通知与页脚不受影响）。

## 8. 与 pi-subagents 的集成机制

用户操作步骤见 README（[与 pi-subagents 配合](../README.zh-CN.md#与-pi-subagents-配合)）；这里是机制依据：

| 子会话类型 | 宿主进程 | ambient 扩展 | 扩展注册的 provider | `registerVirtualModel()` 的虚拟模型 |
|---|---|---|---|---|
| 前台子代理 | 父进程内的 session | **从不加载** | 继承 | **不继承** |
| 后台子代理（`async: true`） | 独立 runner 进程 | 默认加载（`extensions` 一旦存在即关闭） | 由该子会话自己加载的扩展注册 | 同上 |

推论：**子代理继承到虚拟模型时，子会话必须自己加载本扩展**，否则启动即因模型解析失败而失败。加载方式：

1. settings 的 `subagents.defaultSubagentOnlyExtensions`（只给子会话**追加**，不改变 ambient 发现）；
2. agent frontmatter 的 `subagentOnlyExtensions`（同上）或 `extensions`（**存在即关闭**该子会话的 ambient 发现，`[]` 也一样）；
3. 值可以是扩展文件路径，也可以是 `npm:pi-provider-chain` 这类包源 —— 后者由 Pi 的包源解析在 `<agentDir>/tmp/extensions/npm/<hash>/` 下临时安装并复用；`PI_OFFLINE=1` 时会**静默跳过**该源；
4. 宿主扩展可用 `registerRequiredChildExtensions` 让某扩展对所有 launch 生效。

本扩展加载进子会话后：`route()` 与全部事件钩子都在子会话内生效，且状态文件与父会话**同一份**，因此降级档位跨进程共享、父子互相可见（`upsertEntry` 的单调合并保证不回退）。

## 9. 测试与 CI

| 层 | 手段 |
|---|---|
| 纯函数模块 | 边界穷举（`route-policy` / `degrade` / `command` / `model-ref` / `ui` / `transcript`） |
| 纯 IO 模块 | 临时目录 + 真实文件（`state` / `config`） |
| 策略层 | `router.test.ts` 用**端口桩 + 固定时钟**覆盖全部策略分支（桩刻意不复用 `src/state.ts`，以便独立断言单调合并语义） |
| 装配层 | `entry.test.ts` 是唯一 stub `pi` 的集成测试：虚拟模型注册、路由、状态推进、配置缺失路径、命令执行 |

运行方式与 CI 见 [`AGENTS.md`](../AGENTS.md#常用命令与-ci-对齐)；要点是同一套 `node:test` 用例同时跑在 Bun 与 Node ≥ 22.18 两条路径上，CI 各有一条 job 守护。

## 10. 发布

- 发布物由 `files` 白名单控制；`tests/`、`docs/` 不进包（`bun run pack` 可核对）。
- 推 tag `v<version>` 触发 `.github/workflows/release.yml`：先校验 tag 与 `package.json` 版本一致，再以 OIDC `--provenance` 发布到 npm。
- 版本号与 CHANGELOG 由发版流程统一处理（`.agents/skills/release/SKILL.md`），日常改动不动它们。
