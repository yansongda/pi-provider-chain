# AGENTS.md — 仓库开发指令（面向 AI 编码代理）

> 本文件为 AI 编码代理提供开发约束与架构背景，修改本仓库代码前必读。
> 使用方式（安装、配置字段、命令、状态文件）一律看 README：`README.md`（英文，默认）/ `README.zh-CN.md`（中文）。
> 发版流程见 `.agents/skills/release/SKILL.md`。

## 项目概述

给 [Pi](https://pi.dev) 的扩展：为每条配置注册一个**虚拟模型**，把请求路由到 `chain[0]`，命中**额度 / 订阅 / 欠费**类错误时自动沿 `chain[1..]` 降级，状态写入共享状态文件（跨 session / 跨进程 / 跨父子 subagent 生效）。

- 运行环境：Node ≥ 22.18（`engines`），开发用 Bun；ESM + TypeScript strict。
- **零运行时依赖**：`dependencies` 必须保持为空，只用宿主提供的 peer（`@earendil-works/pi-coding-agent`、`@earendil-works/pi-tui`）。
- 发布物由 `files` 白名单决定（`extensions` / `src` / `examples` / README / CHANGELOG / LICENSE）；`pi.extensions` 只声明 `./extensions/provider-chain.ts`。

## 仓库结构

```
extensions/provider-chain.ts  装配层：注册虚拟模型 / 事件 / 命令 / 条目渲染器；portsFor(ctx) 是唯一接触宿主 IO/UI 的地方
src/constants.ts              叶子模块：机器常量 + MESSAGES 文案模板（不 import 项目内其他模块、不碰 IO）
src/model-ref.ts              provider/id 解析与格式化（纯函数）
src/degrade.ts                降级判定（pattern 子串匹配）+ 恢复时间/时长解析与钳制（纯函数）
src/route-policy.ts           路由算法：该用链路里的哪一个（纯函数，可穷举测试）
src/router.ts                 策略唯一归属地：档位推进 / 路由决策 / 恢复墓碑 / 页脚 / 命令输出（端口注入，无 pi 依赖）
src/state.ts                  状态文件读写：tmp+rename 原子写、单调合并、剪枝（纯 IO）
src/config.ts                 配置加载与校验（纯函数 + 只读 IO）
src/transcript.ts             转录条目契约 + agent_before_settle 兜底路径的两步纯查询
src/ui.ts                     用户文案组装（选模板 + 汇总/截断），字面文案全部来自 constants.ts
tests/*.test.ts               node:test 单测；entry.test.ts 是唯一 stub pi 的装配级集成测试
examples/                     可直接用的配置示例 + 字段速查（字段语义权威处之一）
docs/YYYY-MM-DD-*.md          技术设计文档（历史决策与背景）
.agents/skills/release/       发版 skill（版本建议、diff 清单、tag 与 npm 发布核验）
```

## 架构与不变量（改代码前必读）

### 分层铁律

- `extensions/provider-chain.ts` **只做装配**：`registerVirtualModel` / `pi.on(...)` / `registerCommand` / `registerEntryRenderer` + `portsFor(ctx)` 适配。策略、判定、文案组装都不许写进这里。
- `src/router.ts` 是**策略的唯一归属地**；副作用（状态文件、宿主注册表、UI、转录）一律经 `RouterPorts` 注入，因此必须能脱离 pi 单测。新增副作用请先加端口，不要在 router 内直接引入宿主类型。
- `src/route-policy.ts` 只回答「该用链路里的哪一个」；「当前档位是多少、何时推进、推进后写状态/提示/刷页脚」属于 `router.ts`。**不要把两者混回一个文件。**
- 用户可见文案的字面量只在 `src/constants.ts` 的 `MESSAGES`；`src/ui.ts` 只做「选模板 + 组装」（时间先 `formatClock` 再传模板，模板本身零依赖）。新增/修改文案不许在 router 或入口层内联字符串。

### 降级语义不变量

- **只有额度类错误才推进档位**：429 瞬时限流 / 5xx / 网络错误不干预，交回 Pi 自身重试。放宽这个条件属破坏性变更，必须先说明理由并同步测试。
- 两条触发路径：`route()` 内的 `retry` 快路径（`reviewFailure`）；`agent_before_settle` 兜底路径（不可重试错误）。兜底路径**必须**先写状态，再定位失败消息所在 entry 并返回 `entries` + `continue: true`；定位不到时保持「只写状态、不续跑」。
- 推进不得停在失败模型上：`next = clampLevel(max(当前档位, 失败模型下标 + 1), 链路长度)`；`settle` 兜底只接管「失败者就是当前档位」的情形（因为它要剔除那条失败消息）。
- 保缓存：`retry` / `continuation` 且失败（或上一响应）就是当前档位时，复用同档位与思考档位，不得无故切模型。
- 恢复：窗口过期后**第一条主用成功响应**写 `level: 0` 墓碑（`notePrimarySuccess`），让「已恢复」提示只出现一次；并发下单调合并会保留他进程刚写入的更深活跃条目。
- 派发前必须确认凭证：`ports.resolve` 只返回「存在且有凭证」的物理模型；全部不可用时回落主用对象（`catalog`），把真实错误交回 Pi 报出。

### 状态文件契约（跨进程共享，慎改）

- 结构 `{"version": 1, "degraded": { <provider>: { level, until, reason, at } }}`；键是 `chain[0]` 的 provider（同一 provider 下所有虚拟模型共享档位）。
- 写入：`tmp + rename` 原子替换；同 key 单调合并（盘上更深的活跃条目保留，绝不回退）；每次写入清理 `until + 24h` 的历史条目。
- 读取：文件缺失或损坏一律视为空状态，不抛异常（不做缓存，避免读到陈旧快照）。
- 兼容性：`/chain status` 与条目渲染必须能渲染**旧条目**（例如降级条目缺 `from` 时回落状态键）。改字段名等于破坏历史会话渲染，属破坏性变更。

### 宿主契约要点

- `route()` 抛错、或所有档位都无凭证时，宿主以错误响应结束请求；`route()` 内任何异常都必须先尝试回落主用，并在能回落时留一条 `[chain] error` 转录条目，避免真实异常被掩盖。
- `pi.appendEntry` 写入的条目**不进模型上下文**（通知/页脚同理）；不要试图用它影响模型输入。
- 页脚 `ctx.ui.setStatus` 必须先经 `lastStatus` 去重（否则每轮响应都重绘）；无 UI（`ctx.hasUI === false`）时静默跳过，且 UI 调用失败不得影响路由。

### 配置契约

- 配置只从 `<agentDir>/provider-chain.json` 读（`agentDir = $PI_CODING_AGENT_DIR || ~/.pi/agent`），不做任何 glob/搜索；状态文件默认 `<agentDir>/provider-chain-state.json`。
- `chain[0]` 非法 → 报错并整体禁用（只在 `session_start` 与 `/chain` 提示原因，不接管任何路由）；后续非法项静默忽略。
- `degradePatterns` 非空列表**完全覆盖**内置默认，留空/全空白回落默认；`resetPattern` 解析不到时间时用 `defaultDegradeMs`，一律钳制到 `[1min, maxDegradeMs]`。

## 常用命令（与 CI 对齐）

```bash
bun install        # devDeps / peers
bun run test       # bun test（跑 tests/ 下全部 node:test 用例）
bun run typecheck  # tsc --noEmit
bun run test:node  # node --test "tests/**/*.test.ts"（Node ≥ 22.18 直跑 TS，无测试框架）
bun run pack       # bun pm pack --dry-run，检查发布物白名单
```

CI（`.github/workflows/ci.yml`）：`bun install --frozen-lockfile` → `typecheck` → `test`；另有独立 job 用 Node 24 跑 `test:node`，守护「直跑 TS」的承诺。**两条路径都必须绿**：新增用例不要引入 bun 专有 API 或测试框架。

## 开发规范

- 模块系统：ESM；导入本地模块**必须带 `.ts` 后缀**（`allowImportingTsExtensions`）；纯类型导入用 `import type`（`verbatimModuleSyntax`）。
- `erasableSyntaxOnly`：禁止 `enum` / `namespace` / 参数属性等不可擦除语法；常量用 `as const` 对象 + 字面量联合。
- `strict` 全开：禁止 `any` / `@ts-ignore`；用判别联合而不是可选字段堆叠（`RouteEntryData` 是范例）。
- 缩进用 tab；注释与文案用中文；注释即文档——模块顶部块注释声明职责与边界，函数注释写清契约与「为什么」。
- 小步变更：一次改动聚焦一个问题；不做与任务无关的格式化或重命名。
- 不新增运行时依赖（`dependencies` 保持为空）；宿主 peer 只在必要时使用，且不得引入传递依赖。
- 新增用户可见文案时改 `src/constants.ts`，并检查既有测试断言是否跟随。

## 测试规范

- 运行器：`node:test` + `node:assert/strict`；用例文件与 `src/*.ts` 同名镜像。
- 覆盖策略：纯函数按边界穷举（`route-policy` / `degrade` / `command`）；IO 模块用临时目录（`state` / `config`）；`router.test.ts` 用**端口桩 + 固定时钟**覆盖全部策略分支（桩刻意不复用 `src/state.ts`）；`entry.test.ts` 是唯一 stub pi 的装配级集成测试（虚拟模型注册、事件装配、命令执行）。
- 新增函数或修复缺陷必须补用例；改文案时同步受影响的断言（`ui` / `router` / `entry`）。
- 不引入 mock 框架，手写桩对象即可；用例名用中文描述行为（既有风格）。

## 与 pi-subagents 协作注意

本机默认模型是虚拟模型（`yansongda/*`）。前台子代理**继承父会话扩展注册的 provider，但不继承 `pi.registerVirtualModel()` 注册的虚拟模型**，因此子会话必须加载 `extensions/provider-chain.ts`，否则子代理启动即模型解析失败（报错会说 `It inherits the providers they registered, but not virtual models registered with pi.registerVirtualModel().`）。

- 写在 settings 里的值按 Pi 的包源解析：`subagents.defaultSubagentOnlyExtensions: ["npm:pi-provider-chain"]` 会在首次子代理启动时自动装到 `<agentDir>/tmp/extensions/npm/<hash>/` 并复用（不用记路径）；也可以写扩展文件路径。
- **本机现状**：settings 指向本仓库的 `extensions/provider-chain.ts`（本地开发时父子跑同一份工作树）。如果改成 `npm:pi-provider-chain`，子会话加载的是 npm 上的**已发布副本**，开发期会出现父子版本漂移，改完代码需先发版才对子代理生效。
- 该键只给子会话**追加**加载，**不关闭** ambient 扩展发现；`subagents.defaultExtensions` 一旦存在就会关闭，别用。
- 离线时注意：`npm:` 形式首次安装需要联网，`PI_OFFLINE=1` 会**静默跳过**该源（子会话拿不到扩展却报模型解析失败），调试时优先用路径形式。
- 备选：agent frontmatter 的 `subagentOnlyExtensions:`（追加）或 `extensions:`（**出现即关闭**该子会话的 ambient 扩展发现，包括 `[]`）；`async: true` 的后台子代理默认加载 ambient 扩展，通常无需配置。
- `capabilityCeiling.denyExtensions` 会压掉以上全部配置。
- 派发子代理前若怀疑扩展没加载：发起一个继承虚拟模型的子代理；或让 agent 调用 `subagent({ action: "get", agent: "<名称>" })` 看该 agent 生效的 `Subagent-only extensions`；`/subagents-doctor` 看诊断。
- 用户侧措辞以 README 的[与 pi-subagents 配合](README.zh-CN.md#与-pi-subagents-配合)为准，本文件不重复维护该段文案。

## 文档与发版

- README 双语必须同步：`README.md`（英文，默认）/ `README.zh-CN.md`（中文），顶部互相链接。**发版不改 README**，README 只按功能变更维护且不带版本号。
- 配置字段语义的权威处是 README 字段表 + `examples/README.md` 字段速查 + `examples/provider-chain.json` 示例值；改字段、默认值或用户可见文案时三处同步。
- 新的设计决策写进 `docs/YYYY-MM-DD-<plan-name>.md`（技术设计文档），不要把长背景堆进 `AGENTS.md` 或 README。
- CHANGELOG 与版本号由发版流程统一处理（`.agents/skills/release/SKILL.md`，按真实代码 diff 生成改动清单）；**日常改动不要手改 `package.json` 版本号或 CHANGELOG**。
- 发布：tag `v<version>` 触发 `.github/workflows/release.yml`，先校验 tag 与 `package.json` 版本一致，再用 OIDC 发布到 npm。PR 合并永远由人工完成。

## 变更检查清单

改 `src/` 或 `extensions/` 后逐项自查：

1. 策略是否仍留在 `src/router.ts`（入口层没有新增判定 / 文案 / IO）？
2. 文案是否只走 `MESSAGES` 且保持单一出口（notify 与转录条目同句）？旧会话条目的渲染兼容是否保住？
3. 状态文件是否仍满足：原子写、单调合并、不回退、与 `version: 1` 及旧字段兼容？
4. 降级触发条件是否被放宽（429 / 5xx / 网络错误必须仍不干预）？保缓存路径是否被破坏？
5. `ports.resolve` 是否仍要求凭证？全部不可用时是否仍回落主用、让 Pi 报出真实错误？
6. 是否同步了 `README.md` / `README.zh-CN.md` / `examples/README.md`（字段、默认值、文案）？
7. `bun run typecheck` + `bun run test` + `bun run test:node` 是否全绿？
