# 2026-11-10 运行时硬化与精简

> 本次变更的设计记录与执行清单。落盘后视为历史快照，不再随代码修改；当前状态见 [`architecture.md`](architecture.md)。

## 背景

一次代码审读（架构 + 精简）发现以下问题，全部为内部实现或边界语义，不涉及路由/降级的主干不变量：

1. 策略层 `router.statusLines` 在渲染时调用 `defaultConfigPath()`，读 `$PI_CODING_AGENT_DIR` + `homedir()`；与实际 `loadConfig(path)` 的路径可能不一致。
2. 「降级窗口是否活跃」在 `state.activeEntry`、`router.activeLevel`、`statusLines` 内有三分实现；其中 `activeEntry` 生产代码零调用（只有测试用），且签名是「按路径重新读盘」，无法复用已读快照。
3. `stateFile` 相对路径被 `node:fs` 按进程 cwd 解析：父子 agent / 不同 cwd 的 runner 会各写一份状态，"跨进程共享"悄悄失效。
4. `docs/architecture.md` 声称时长统一钳制到 `[1min, maxDegradeMs]`，代码只钳上界（`defaultDegradeMs` / 手动时长可低于 1min）。
5. 降级 retry 一次请求读状态 3 次（route 快照 + `upsertEntry` 内部合并 + 页脚重算）；恢复响应读 4 次（`notePrimarySuccess` + `upsert` + 内部页脚 + 装配层再刷一次）。
6. 同一操作内 `ports.now()` 被读多次（`at` / `until` / `upsertEntry` 的合并与剪枝各取一次时钟）。
7. `readState` 不校验 `version`：未来/缺失版本的 JSON 会被按 v1 语义读写；`clearEntry` 在 key 不存在时提前返回，跳过剪枝。
8. 零散冗余：`reviewFailure` 名字像只读（实际写状态 + 通知 + 转录）；`/chain status` 的组装留在 router；`message_end` 每轮线性扫描 `models`；补全只按整串 `startsWith`；`ports.catalog` 在一个请求内可能被查两次。

## 决策

| # | 决策 | 理由 |
|---|---|---|
| 1 | `clampDegradeMs` 统一钳制到 `[1min, maxDegradeMs]`；`maxDegradeMs` 低于 1min 时按 1min 处理，并在 `loadConfig` 中把 `maxDegradeMs` 抬到下限 | 下限与上限需要单一实现，避免「默认时长可低于 1min」；上限低于下限时以下限为准，避免窗口被压到几秒导致频繁重新降级 |
| 2 | `parseResetTs` 复用 `clampDegradeMs`（偏移量钳制后加回 `now`） | 解析恢复时间与默认/手动时长走同一套边界 |
| 3 | `readState` 只认 `version: 1`；缺失/未来版本 → 空状态 | 不按猜测的语义读写；未来版本迁移必须显式设计 |
| 4 | `stateFile` 相对路径按 `agentDir` 解析（`expandPath(p, baseDir)`），`~` 仍展开 | 保证父子进程/不同 cwd 共享同一份状态 |
| 5 | `LoadedConfig.configPath` 记录实际加载路径；`/chain status` 直接展示 | 去掉策略层的环境变量读取，输出可确定 |
| 6 | `refreshStatus(now, state?)` 接受本次已读/已写快照；`applyDegrade` 用 `upsert` 返回的单调合并结果合成快照；`notePrimarySuccess` 用同一快照同时完成恢复判定与页脚刷新 | 只传「本次操作的快照」，不引入跨请求缓存；装配层不再二次读状态/二次刷新 |
| 7 | `RouterPorts.upsert/clear` 增加 `now`，`applyDegrade` / `manualDegrade` / `reset` 显式传时钟 | 一次操作（写、合并、剪枝、提示）用同一个 `now`，测试可用固定时钟断言 |
| 8 | `state.activeEntryOf(state, provider, now)` 纯函数；`activeEntry(path…)` 删除；`activeLevel` / `renderStatusLines` 复用同一判定 | 判定单点，避免为页脚/状态行重复读盘 |
| 9 | `router.reviewFailure` → `applyFailure` | 名字与副作用（写状态 + 通知 + 转录）一致 |
| 10 | `/chain status` 的组装迁到 `ui.renderStatusLines`（纯投影），router 只读状态并转发 | 策略层保持「编排」职责；文案/格式继续只在 `ui.ts` + `constants.ts` |
| 11 | `clearEntry` 在 key 不存在时也剪枝；只有「无 key 且无可剪枝条目」才跳过写盘 | 与 `upsertEntry` 的剪枝语义一致，同时避免无意义的文件创建 |
| 12 | 微优化：`message_end` 用 `stateKeys` Set；`route()` 内 catalog 查询 memo；子命令补全改为逐词前缀 | 去掉轮询/重复查询；`degrade 3` 这类参数前缀也能补全（`degrade 30m`） |

## 影响

### 用户可见

- 低于 1min 的 `defaultDegradeMs`、手动 `/chain degrade <时长>` 现在被抬到 1min；`maxDegradeMs < 1min` 按 1min 处理。
- `stateFile` 的相对路径按 `agentDir` 解析（不再跟随进程 cwd）。
- 状态文件 `version` 不是 `1` 时视为空状态（下次运行会写回 `version: 1`）。
- `/chain status` 的「配置:」展示实际加载路径；`/chain degrade` 参数补全支持逐词前缀。

### 内部

- 降级 retry 的真实读取次数：3 → 2（route 快照 + `upsertEntry` 内部合并；页脚复用合成快照）。
- 成功响应：恢复路径 4 → 2（`notePrimarySuccess` 读取 + `upsertEntry` 内部合并；页脚零额外读），普通路径 2 → 1（恢复判定与页脚刷新共用一次读取）。
- `router.ts` 不再 import `config.defaultConfigPath`，也不直接组装 status 行。
- `notePrimarySuccess` 在「并发下盘上保留更深活跃条目」时不再发「已恢复」提示（`upsert.changed === false`）。
- `readState` 的 `normalizeEntry` 仍以 `Date.now()` 作为缺失 `at` 的兜底：它只影响结构非法/旧条目的元数据，不参与档位与页脚判定，因此未注入时钟。

## 失效条件

- 若要支持状态文件版本迁移（`version > 1`），必须重新定义读取/写入语义；当前的「版本不符 = 空状态」会丢弃旧状态（只影响提示与档位，下一次请求会重新判定）。
- 若未来允许低于 1min 的降级窗口，应通过显式参数/测试钩子实现，而不是放宽全局 `clampDegradeMs`。
- `stateFile` 改为相对 `agentDir` 后，依赖 cwd 相对路径的旧配置会改变落盘位置（该用法未在 README 承诺）。
