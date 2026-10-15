# 技术设计：src 命名规整 + 常量/文案收敛 + 抽出 router（装配层瘦身）

> **时间**：2026-10-15
> **作者**：Claude + yansongda
> **状态**：经过人工审核确认

---

## 1. 背景与问题

**现状**

`src/` 7 文件 673 行、`extensions/provider-fallback.ts` 456 行；纯函数 / IO / 装配三分，87 个测试全绿、`tsc --noEmit` 干净、零运行时依赖。整体分层可靠，但存在 4 类遗留问题。

**困境**

1. **核心决策 glue 不可单测**：`extensions/provider-fallback.ts:254-304` 的 `route()` 内「额度判定 → 推进档位 → 决策 → 回落」约 50 行直接闭包捕获 `cfg`/`pi`/`ctx`；`applyDegrade`(180-214)、`notePrimarySuccess`(223-232)、`refreshStatus`(141-154) 同样无注入点。整系统最易改坏的路径只能用 `tests/entry.test.ts`（419 行，全仓最大）走 stub-pi 集成测试覆盖。
2. **魔法字符串散落 6 个文件**：`"provider-fallback"`（状态键 / entry 类型 / 文件名 / 错误前缀共 4 处语义）、`"quota"`/`"recovered"`/`"manual"`/`"retry"`/`"settle"`、`"info"|"warning"|"error"`、`"dim"`、`provider-fallback.json` / `-state.json` / `.tmp` / `PI_CODING_AGENT_DIR`、7 项默认常量（`DEFAULT_/MAX_/MIN_DEGRADE_MS` 在 `degrade.ts:34-36`，`PRUNE_AFTER_MS` 在 `state.ts:31`）。
3. **命名与语义不齐**：`buildPatterns` / `matchDegrade` / `formatClockShort` 与 `compileResetPattern` / `formatClock` 不成对；`DegradeEntry.code` 字段名叫 code 但承载「降级原因」；`state.ts` 三个导出函数的第二参数名为 `key` 但语义恒为 provider。
4. **三处小偏差**：`degradeUntil`/`applyDegrade` 内部 `Date.now()`（`ext:189,235`）破坏时间注入一致性；同一请求内 `modelRegistry` 被查 2–4 次（`ext:283/288/296/300`）；`route()` 外层 catch-all（`ext:299-303`）静默吞掉编程错误且无诊断出口。

**目标（约束）**

- **对外可见输出逐字不变**：notify 文案、页脚、`/fallback status` 行——由现有逐字断言测试冻结（这是行为回归判据）。
- **无兼容负担**（已核实 `npm view @yansongda/pi-provider-fallback` 返回 404，从未发布）：字段名与数据结构可直接改——不做双读别名、不做旧条目归一化、不写迁移说明。
- **零新增运行时依赖**；不引入配置格式 breaking change（`models[].input` 为纯新增）。
- 装配层 **≤ 250 行**；`src/` 每模块单一职责；凡「策略」均可脱离 pi 单测。
- 逐阶段独立 commit，任一阶段 `git revert` 即回退。

---

## 2. 整体方案

**核心思路**：把「**策略**」从装配层搬到 `src/router.ts`，通过 **ports（端口）注入副作用**；把「**字面量**」收敛到零依赖的 `src/constants.ts`；把「**转录条目契约与会话遍历**」独立为纯函数模块 `src/transcript.ts`。

**架构**

```
                        ┌────────────────────────────────────────────────┐
                        │ extensions/provider-fallback.ts  (~460 → ~210) │
                        │ 只做：registerVirtualModel/on/registerCommand/  │
                        │ registerEntryRenderer + ctx→ports 适配 + theme │
                        └───┬──────────────┬──────────────────┬──────────┘
                            │              │                  │
              ┌─────────────▼──┐    ┌──────▼─────┐     ┌──────▼──────┐
              │ router.ts ★新  │    │ ui.ts      │     │ command.ts  │
              │ 状态机 + 决策  │───▶│ 文案组装    │     └──────┬──────┘
              │ ports 注入     │    └──────┬─────┘            │
              └──┬────┬────┬───┘           │                  │
                 │    │    │               │                  │
                 ▼    ▼    ▼               ▼                  │
        ┌──────────┐┌────────┐┌───────────────┐┌────────┐      │
        │ state.ts ││routing ││ transcript ★新 ││degrade │      │
        │ (fs IO)  ││ (纯)   ││ (纯·条目契约)  ││ (纯)   │      │
        └──────────┘└────────┘└───────────────┘└───┬────┘      │
              ▲          ▲                         │           │
              │          │        ┌────────────────┴───────────┴──┐
        ┌─────┴──────────┴────────┤ constants.ts ★新（叶子·零依赖）│
        │ config.ts（只读 IO）    │ 机器常量 + 用户文案模板          │
        └─────────────────────────┴────────────────────────────────┘
         model-ref.ts（不变·叶子）
```

**文件结构**

```
extensions/provider-fallback.ts   修改：瘦身到 ~210 行（只剩装配 + 适配）
src/constants.ts                  新增：机器常量 + 用户文案模板（叶子，零依赖）
src/router.ts                     新增：状态机与决策（ports 注入）
src/transcript.ts                 新增：转录条目契约 + 会话遍历（纯函数）
src/degrade.ts                    修改：compileDegradePatterns / parseDegrade / formatClock(ts,style)
                                          / clampDegradeMs；默认常量迁往 constants.ts
src/state.ts                      修改：DegradeEntry.reason；key→provider；只读 reason
src/config.ts                     修改：常量引用 + clampDegradeMs + models[].input 归一化
src/routing.ts                    修改：无签名变化（仅复用分支注释）
src/ui.ts                         修改：消费 constants 文案模板，保留组装逻辑
src/command.ts                    修改：COMMAND_USAGE 引用 constants
tests/router.test.ts              新增（端口假实现 + 固定时钟）
tests/transcript.test.ts          新增（会话遍历 + 条目契约）
tests/entry.test.ts               修改：瘦身至 ~220 行（用例迁移，非删除）
tests/{config,degrade,state,ui,command,model-ref,routing}.test.ts  修改：改名与断言同步
README.md / examples/README.md / examples/provider-fallback.json   修改：`reason` 字段、`input` 示例
CHANGELOG.md                      修改：0.1.0 内文 `code`→`reason` + 补 `input`（不新增版本条目）
docs/2026-10-15-src-refactor-naming-constants-router.md             新增（本文档，入库）
docs/implementation/2026-10-15-src-refactor-naming-constants-router.md  新增（执行计划，gitignore）
```

**本轮决议（原分析建议的处置）**

| 建议 | 处置 |
|---|---|
| S1 抽 `src/router.ts` | ✅ 采纳（3.5） |
| S2 状态键配置化 | ⛔ 保持 provider 维度（用户指示）；仅内部字段改名 `LoadedModel.key` → `stateKey` |
| S3 时间注入补齐 | ✅ `ports.now()`（3.5） |
| S4 探针 memo | ✅ 不改 `routing.ts` 签名（3.5） |
| S5 retry 推进档位冲突 | ✅ 公式化修正（3.6，行为变化） |
| S6 异常可观测 | ✅ 新增 `kind:"error"` 转录条目（3.5） |
| P3-g 钳制三副本 | ✅ `clampDegradeMs()`（3.7） |
| P3-h 虚拟/物理同名检测 | ⛔ 技术不可行（附录 A 证据） |
| P3-i① `input` 透传 | ✅（3.7） |
| P3-i② `request.state` 读缓存 | ⛔ 明确不做（跨进程真值仍是文件） |
| P3-j 边界瑕疵 | ✅ 常量迁移 + DTO 字面量收窄 + ui 职责说明 |

---

## 3. 详细设计

### 3.1 命名规整

| 现名 | 新名 | 影响点 |
|---|---|---|
| `buildPatterns` | `compileDegradePatterns` | `degrade.ts`、`config.ts`、`tests/degrade.test.ts` |
| `matchDegrade` | `parseDegrade` | `degrade.ts`、`ext`、`tests/degrade.test.ts` |
| `formatClock` + `formatClockShort` | `formatClock(ts, style: "full" \| "short" = "full")` | `degrade.ts`、`ui.ts`、`ext`、`tests/degrade.test.ts`、`tests/ui.test.ts` |
| `DegradeEntry.code` | `DegradeEntry.reason` | `state.ts`、`ui.ts`、`ext`、4 个测试文件、README、CHANGELOG |
| `state.ts` 三函数的第二参数 `key` | `provider` | `state.ts`（位置参数，调用点语义不变） |
| `ui.degradeNotice({key})` | `{provider}` | `ui.ts`、`ext`、`tests/ui.test.ts` |
| `LoadedModel.key` | `LoadedModel.stateKey` | `config.ts`、`ext`、`tests/ui.test.ts`（注释写明「= primary.provider，同 provider 共享档位」） |

### 3.2 常量与文案收敛：`src/constants.ts`

`constants.ts` 是**叶子模块**（不 import 任何项目内模块、不碰 IO），导出两类内容：

| 分组 | 内容 |
|---|---|
| 身份/键 | `EXTENSION_NAME`、`STATUS_KEY`、`ENTRY_TYPE`、`COMMAND_NAME`、`COMMAND_USAGE`、`ENTRY_PREFIX`、`NOTIFY_PREFIX`、`ERROR_PREFIX` |
| 路径 | `AGENT_DIR_ENV`、`AGENT_DIR_SEGMENTS`、`CONFIG_FILE_NAME`、`STATE_FILE_NAME`、`STATE_TMP_SUFFIX` |
| 状态字面量 | `STATE_VERSION`、`DEGRADE_REASON`、`DEGRADE_TRIGGER`、`NOTIFY_KIND`、`ENTRY_KIND`、`THEME_COLOR`、`MODEL_INPUT_KINDS` |
| 默认值 | `DEFAULT_DEGRADE_PATTERNS`、`DEFAULT_RESET_PATTERN`、`DEFAULT_DEGRADE_MS`、`MAX_DEGRADE_MS`、`MIN_DEGRADE_MS`、`PRUNE_AFTER_MS`、`THINKING_LEVELS`、`MAX_ERROR_STORE_CHARS`、`MAX_ERROR_DISPLAY_CHARS` |
| 用户文案模板 | `MESSAGES`：每个函数 = **一整句**，只接收原始值或已格式化字符串（时间由 `ui.ts` 调用 `formatClock` 后传入），因此本模块保持零依赖 |

**文案边界**：模板负责字符串拼装，`ui.ts` 只负责「选模板 + 汇总/截断/多行组装」。

**文案出口规则（执行期细化）**：字面文案**全部**在 `constants.ts`（`MESSAGES` / `COMMAND_COMPLETIONS` / `*_SUFFIX`）；
需要**时间格式化或汇总**的文案在 `ui.ts` 组装（`degradeNotice` / `entryDegradeLine` / `statusText` / `describeModel` /
`commandStatusHeader` / `manualDegradeLine` / `deeperLevelKeptLine` / `entry*Text`）；
**无参数的静态整句**允许 `router.ts` / 装配层直接使用 `MESSAGES.xxx`（避免十多个一行透传包装）。

### 3.3 状态文件：`code` → `reason`（直接改，无兼容）

```jsonc
{ "version": 1, "degraded": { "volcengine": { "level": 1, "until": 1793203199000, "reason": "AccountQuotaExceeded", "at": 1792067541818 } } }
```

- 读写都只认 `reason`；`reason` 缺失（外部手改文件）回落 `DEGRADE_REASON.QUOTA`。
- 本机残留旧字段被忽略：`level`/`until` 照常生效，仅 `/fallback status` 的原因显示回落 `quota`（该条目 2026-10-28 自然过期）。可选：真机验证阶段顺手改写（需授权）。

### 3.4 转录条目 DTO：直接采用新形状

```
{ kind:"degrade", provider, level, to, until, reason, trigger, errorMessage }   // reason=降级原因, trigger=retry|settle|manual
{ kind:"recover", provider }
{ kind:"error",  provider?, message }                                          // 新增：路由异常但已回落主用
```

- 消歧：原因 `code` → `reason`，原触发路径 `reason` → `trigger`（两者均为收窄字面量联合，原 `reason` 为 `string`）。
- 不做历史条目兼容；`trigger` 不渲染（仅落盘供事后分析），展示面与现状逐字一致。
- `src/transcript.ts` 提供 DTO 类型 + 两个纯函数：`findFailingAssistant(messages)`、`locateEntryIdFor(entries, assistant)`（泛型约束，不 import pi）。

### 3.5 `src/router.ts`：状态机 + 决策

**接口形态（伪接口，实现细节留执行阶段）**

```
RouterPorts<M>                       // 装配层实现：唯一接触 pi/ctx/fs 的地方
  now(): number                      //   S3：时间全量注入
  readState(): StateFile
  upsert(provider, entry): { entry, changed, writeError? }
  clear(provider): { ok, error? }
  resolve(ref): M | undefined         //   有凭证的物理模型（按请求 memo → S4）
  catalog(ref): M | undefined         //   兜底：目录对象（让 Pi 报真实错误）
  notify(text, kind)
  append(data: RouteEntryData)        //   受 transcriptNotice 约束
  setStatus(text | undefined)

createRouter<M, TLevel>(cfg, ports) → Router<M, TLevel>
  route(model, request): { model: M, thinkingLevel: TLevel }
  reviewFailure(model, { errorText, failedRef, trigger }, snapshot?): DegradeEntry | undefined   // ★ retry/settle 共用；snapshot 避免重复读状态
  notePrimarySuccess(provider): void
  refreshStatus(): void
  statusLines({ selection, target, unknown? }): string[]        // 直接返回给用户的行
  manualDegrade(model, durationMs?): string                      // 直接返回给用户的一行
  reset(model): string                                           // 直接返回给用户的一行
```

**`route()` 决策链（语义与现状一致）**

```
route():
  level ← 状态文件档位（窗口过期 → 0，越界钳制）             # ②
  if reason == retry: level ← reviewFailure(failedText, failedRef, "retry")   # ③ 推进
  memo ← {}                                                # S4：一次请求内 resolve 只打一次宿主
  d ← decideRoute(chain, level, reason, failedRef, previousRef, isAvailable=memo)
  return d ? memo.resolve(d.ref) : primaryOrCatalog(primary)  # ⑦ 回落主用让 Pi 报真实错误
  catch err: append({ kind:"error", … })                    # S6
```

**`reviewFailure` 统一两条触发路径**（消除 retry 快路径与 settle 路径的重复实现）：`parseDegrade` 未命中 → 零副作用返回；命中 → 计算 `next`（3.6）→ `clampDegradeMs(parseResetTs(...) ?? now + defaultDegradeMs)` → `ports.upsert` → `changed` 时 notify + `append(kind:"degrade")` → `refreshStatus`。

**读次数**：`refreshStatus` 复用同一份状态快照；单请求降级路径的状态文件读次数由 4 降到 ≤ 3。

### 3.6 retry 档位推进公式修正（行为变化，仅罕见路径）

**问题**：`next = min(level + 1, len-1)` 只参考当前状态档位、不参考失败者所在档位，与「复用同档位」分支联合后产生两处偏差：

| 场景（chain=[A,B,C]） | 现状 | 期望 |
|---|---|---|
| 状态 level=1(B)，本次失败来自 A（两次尝试之间状态被 reset/过期） | level→2 跳到 C，跳过 B | level→1 用 B |
| 状态 level=0，失败来自 B（链尾 len=2） | 推进到 1(B) 后复用刚失败的 B，白跑一次 | 无更优选项，仍 B（可接受） |

**修正（单一公式）**

```
failedLevel ← levelOfRef(chain, failedRef)          # 未命中 → -1
next        ← clampLevel(max(level, failedLevel + 1), chain.length)   # next > level 才落盘
```

推进后必有 `level > failedLevel`，于是 `routing.ts` 的「失败者=当前档位 → 复用」分支**在推进场景下不可能命中**，无需引入 `skipReuse` 参数；链尾无后备时（`next <= level`）复用分支仍按现状保留（保 prompt cache）。

### 3.7 其余项

| 项 | 做法 |
|---|---|
| P3-g 钳制三副本 | `degrade.ts` 新增 `clampDegradeMs(ms, maxDegradeMs)`（**仅上限**，与 README「硬上限」语义一致，不引入新下限）；`config.ts`、`degradeUntil`、`manualDegrade` 三处统一调用 |
| P3-i① `input` 透传 | `config.ts` 归一化 `models[].input`（`MODEL_INPUT_KINDS` 白名单、去重、空则 undefined；本地类型 `ModelInputKind` 保持 config 无 pi 依赖）；`registerVirtualModel` 透传；未声明 → 不传（宿主默认 text+image） |
| S6 异常条目 | 新增 `kind:"error"` 条目（`⚠ 路由异常（已回落主用）` + expanded 显示 message），**行为仍为回落主用**，不改降级判定 |

### 3.8 兼容性与影响

| 变更 | 可见性 | 处置 |
|---|---|---|
| 状态文件 `code` → `reason` | 磁盘 | 直接改；本机残留旧字段仅影响原因显示 |
| 转录条目 `reason`/`trigger` | 会话 JSONL 历史 | 直接改；历史条目不处理（本机全量会话仅 1 条该类型条目） |
| 新增 `kind:"error"` 条目 | 新增可见行 | 仅在意外异常时出现；`transcriptNotice=false` 时不写 |
| notify / 页脚 / `/fallback status` 文案 | 用户可见 | **逐字不变** |
| retry 推进公式 | 行为 | 仅影响「失败者 ≠ 当前档位」的罕见路径；4 个用例固定 |
| `models[].input` | 配置 | 纯新增，缺省行为不变 |
| 版本 | 工程 | 不新增 CHANGELOG 条目、不升 `package.json` version（0.1.0 内文直接修订） |

### 3.9 性能与影响

| 指标 | 改造前 | 改造后 |
|---|---|---|
| 单请求状态文件读次数（降级路径） | 4（activeEntry + upsert 内读 + refreshStatus + 慢路径重复） | 2（route 读一次 + refreshStatus 复用同一快照） |
| 单请求 `modelRegistry.find` 次数 | 2–4（+N 探针） | 每候选 1 次（memo 命中） |
| 装配层行数 | 456 | 243 |
| 测试分布 | entry.test 419 行（最大） | entry.test 430 行（装配契约，13 用例）+ router.test 460 行（策略，25 用例）+ transcript.test 60 行 |

---

## 4. 推进策略

```
阶段 1  命名/常量（纯机械，行为零变化）
        constants.ts 建立 + 3.1 全部改名 + 3.2 常量迁移 + clampDegradeMs + formatClock 合并
        + state 参数名与 reason 字段（无兼容分支）+ 全部测试同步
        验证：typecheck 无错；测试全绿（含逐字文案断言）；grep 旧名零残留

阶段 2  结构搬迁（行为零变化）
        transcript.ts + router.ts（ports）+ extension 适配瘦身
        + S3 时间注入 + S4 memo + S6 异常条目 + entry.test 瘦身（用例迁移而非删除）
        验证：全绿；extension ≤ 250 行；router.test/transcript.test 覆盖全部策略分支

阶段 3  行为修正 + 能力新增
        S5 推进公式（4 用例）+ input 透传 + README/examples/CHANGELOG
        验证：全绿；README 字段表与 config 归一化逐项一致

阶段 4  真机验收（本机执行）
        可选改写本机状态文件（需授权）→ pi -p 走虚拟模型 → 读会话 JSONL 物理 provider
        → /fallback status → /fallback degrade 30m（写 reason=manual）→ reset 后页脚清空
        验证：状态文件写出 reason（无 code 残留）；UI 三通道文案逐字正确
```

**正常回滚**：逐阶段独立 commit，`git revert <commit>`；状态文件与配置无需回滚（无兼容层，回退代码即回退语义）。
**紧急回滚**：`git revert` 阶段 2/3 的 commit 即回到「旧命名 + 大文件」的可用状态。

---

## 5. 风险与对策

| 风险 | 严重度 | 对策 |
|---|---|---|
| 文案被无意改变（模板化最常见踩坑） | 中 | `tests/ui.test.ts` + `tests/entry.test.ts` 逐字断言作为冻结基线；阶段 1 只做搬迁不改字符串 |
| router 抽取漏掉副作用顺序（notify→append→status） | 中 | 先写 `router.test.ts`（端口调用**序列**断言）再搬迁；entry.test 双保险 |
| entry.test 瘦身误删覆盖 | 低 | 用例迁移映射表写进 plan；每个移除断言须在 router/transcript.test 有等价用例（F1 逐条核对） |
| S5 公式改动影响保缓存语义 | 中 | 推进场景 `keepThinkingLevel=false` 语义不变；4 新用例 + 现有 retry 用例；单独 commit 便于 revert |
| 本机状态文件残留 `code` → 原因显示回落 `quota` | 低 | 不影响 level/until 与降级行为；可选一步改写（需授权） |
| `input` 透传触发宿主行为差异 | 低 | 缺省不传（宿主默认 text+image），仅显式声明时透传 |
| 常量收敛过度 → 文案碎片化 | 低 | 硬规则「一句话 = 一个模板」，只接收原始值 |

---

## 6. 监控与可观测性

复用现有三通道，不新增上报结构：

```jsonc
// 状态文件（唯一形状，无兼容分支）
{ "version": 1, "degraded": { "volcengine": { "level": 1, "until": 1793203199000, "reason": "AccountQuotaExceeded", "at": 1792067541818 } } }
// 转录条目：降级（trigger 消歧，不渲染）
{ "kind": "degrade", "provider": "volcengine", "level": 1, "to": "workbuddy/deepseek-v4.1-flash",
  "until": 1793203199000, "reason": "AccountQuotaExceeded", "trigger": "retry", "errorMessage": "..." }
// 转录条目：路由异常（新增）
{ "kind": "error", "provider": "volcengine", "message": "TypeError: ..." }
```

- 关键指标不变：`degraded[*].reason` = 降级原因分布、`until` = 恢复时间、状态写失败经 notify 文案暴露。
- 新增可观察点：`/fallback status` 与页脚行为逐字不变（回归判据）。

---

## 附录 A：契约标注

**已验证（读过源码）**

| 契约 | 证据 |
|---|---|
| `ModelRouteRequest.failed.model` 是**物理模型**；仅当「失败本身是路由失败」时宿主省略整个 `failed` | `dist/core/model-runtime.js:741-748`（`getPhysicalModel(failed.provider, failed.model)` + `failedModel &&` 短路） |
| `VirtualModelDefinition.input?: ("text"\|"image")[]`，缺省 text+images | `dist/core/virtual-models.d.ts:66-77` |
| `ModelRouteRequest.reason` 四值、`previous`/`failed`/`state` 字段 | `dist/core/virtual-models.d.ts:26-56` |
| `AgentBeforeSettleEvent` = `{ entries, continue, context:{contextEntries,contextMessages,…}, outcome }`；宿主对 `continue` 做 `canContinue` 校验 | `dist/core/extensions/types.d.ts:786-799`；`agent-session.js:1542-1555` |
| 同名物理模型在虚拟模型注册后被过滤，注册前无 `ctx` 可探测 → P3-h 不可行 | `dist/core/virtual-models.js:106-112` |
| `EntryRenderer(entry, {expanded}, theme)`；`options.expanded` | `dist/core/extensions/types.d.ts:1160-1166` |
| 扩展 API 无 logger（异常只能经 notify/appendEntry 暴露） | `dist/core/extensions/types.d.ts:1185-1254` |

**推断（未实测）**

| 推断 | 影响 | 验证方式 |
|---|---|---|
| 宿主对未声明 `input` 的占位符细节 | `input` 透传收益 | 注释推断；若不符预期 → 回退为不透传（`0*` 软依赖） |
| `refreshStatus` 复用快照后读次数 4 → ≤3 | 性能 | `router.test.ts` 用假 ports 计数断言 |

---

## 附录 B：本机验证清单（阶段 4）

```bash
bun run typecheck && bun run test && bun run pack   # 工程验收
grep -rn "matchDegrade\|buildPatterns\|formatClockShort" src extensions tests   # 旧名零残留

# 真机（需授权执行）
pi -p "reply OK"                                  # 走虚拟模型 → 读会话 JSONL 的 assistant provider
/fallback status                                   # 链路 / 档位 / 原因 / 恢复时间
/fallback degrade 30m                              # 写 reason=manual、页脚显示备用
/fallback reset                                    # 清除后页脚清空
```

---

## 附录 D：执行期变更记录（相对批准版本）

| 项 | 批准版本 | 实际执行 | 原因 |
| --- | --- | --- | --- |
| 文案出口 | 全部在 `ui.ts` 组装 | 字面文案全部在 `constants.ts`；需格式化/汇总的在 `ui.ts`；无参静态整句允许直接 `MESSAGES.xxx` | 避免十多个一行透传包装，字面量仍集中在 `constants.ts`（见 3.2 细化） |
| 命令路径返回 | `manualDegrade` / `statusLines` / `reset` 返回数据结构，由装配层格式化 | 直接返回用户可见行（`string` / `string[]`） | 命令 handler 只剩 ctx 适配；文案仍只来自 `constants.ts` + `ui.ts` |
| `reviewFailure` 签名 | 无快照参数 | 增加可选 `snapshot?: { state, now }` | 消除 retry 路径重复读状态（3 → 2 次） |
| `entry.test.ts` 行数 | ~220 | 430（13 个装配契约用例基本保留） | 迁移映射表本身要求保留 10 个装配用例，「220 行」与映射表自相矛盾；以覆盖优先 |
| `describeModel` 入参 | 不变 | 不变（`active` / `stale`） | — |
