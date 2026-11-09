# 用户文案统一（档位徽标 + 单一事件句）

日期：2026-11-09
性质：历史快照（落盘后不随代码修改）

## 背景

此前同一条信息存在多套表达：

- 档位：页脚用 `→` / `↓`，`/chain status` 用 `降级 level=N（ref）`，`/chain degrade` 回显用 `保持 level=N（ref）`；
- 时间：notify / status 用 `toLocaleString()`，页脚用 `MM-DD HH:mm`，回显又是本地化完整时间；
- 前缀：`[provider-chain]`（仅未启用提示）与 `[chain]`（转录条目）；
- 恢复：notify 与转录条目两句话；过期提示在模型状态行与 status 末尾各出现一次；
- 措辞：`主用` / `回到主用` / `尝试主用` / `回落主用` 混用，`，` 与 ` · ` 混用。

另外，宿主 1.5 的内置 footer 已显示 `选中模型 • 思考档位 → 实际路由模型 • 思考档位`，扩展再用 `→` / `↓` 会与其箭头以及 token 统计的 `↑` / `↓` 视觉冲突。

## 决策

| 规则 | 取值 | 理由 |
|---|---|---|
| 档位 | `⓪①②③④⑤⑥⑦⑧⑨`；≥10 直接数字 | 一个字符表达「链路档位」，与 `/chain status` 的 `level` 概念一一对应；不再与宿主箭头混淆 |
| 时间 | `YYYY-MM-DD HH:mm` | 所有出口同一写法；不依赖 locale（`toLocaleString()` 在不同环境长度不同）；带上年可跨年阅读 |
| 前缀 | `[pi-provider-chain]` | 包名做来源标识；转录条目与「未启用」提示共用 |
| 分隔 | 元信息 ` · `；链路 ` → `；附加说明 `；` | 同一层级只用一个分隔符，避免 `，` 串接元信息 |
| 事件句 | `⚠ <受限方> <原因> → <徽标> <目标> · <时间> 恢复`；恢复 `✓ 已恢复到 ⓪ <provider>` | notify 与转录条目共用同一句（降级/恢复各一个出口） |
| 回到档位 0 | `回到 ⓪ <provider>` | 用户文案里不再出现「主用」；`⓪` 是唯一定位档位 0 的词 |
| 过期 | `已过期（下一请求回到 ⓪ <provider>）` | 只保留模型状态行这一处；删除 `staleHint` |
| 通知级别 | 降级/失败 `warning`；成功/查询 `info`；未启用/无虚拟模型 `error` | 与事件语义一致，不再让失败回显走 `info` |

### 关键取舍

- **恢复标记用 `✓` 而不是 `○✓`**：Unicode 没有单字符「圆圈勾」；`✓⃝`（组合圆）终端支持不稳。`✓`（U+2713）与 `⓪` 同属 Ambiguous 宽度，pi-tui 按 1 列计算。
- **`⓪` 后跟 provider 还是完整 `provider/id`**：
  - 「回到 ⓪」类句子跟 provider（恢复事件的上下文只有 provider；用户已确认该写法）；
  - 页脚与 `/chain status` 的主用行跟完整 `provider/id`（要区分同名模型）。
- **`/chain status` 保留 3–4 行/模型**：没有压成单行，避免长行在窄终端里换行后更难读；只删除末尾重复的 `staleHint`。
- **`stateDegraded` + `statePrimary` 合并为 `stateAt(badge, ref)`**：档位 0 与降级同一形状，越界档位显示 clamp 后的实际档位（不再出现 `level=9` 与目标不一致）。
- **恢复文案合并**：删除 `entryRecover`，`recoverNotice` 一个出口供 notify 与条目使用。

## 影响

- `src/constants.ts`：`CHAIN_PREFIX` / `LEVEL_BADGES`；模板收敛（删除 `staleHint`、`entryRecover`、`stateDegraded`、`statePrimary`）。
- `src/ui.ts`：新增 `levelBadge`；`degradeLine` / `footerActive` / `footerDegraded` / `deeperLevelKeptLine` / `describeModel` 接收档位。
- `src/router.ts`：页脚传递 `level`；`statusLines` 去掉 `target`；`manualDegrade` / `reset` 返回 `{ text, kind }`，命令层按语义选通知级别。
- `src/degrade.ts`：`formatClock(ts)` 单参数、固定格式。
- `src/config.ts`：错误原因去掉中文冒号，避免 `未启用（…）` 里再套冒号。
- `extensions/provider-chain.ts`：条目渲染统一加前缀；恢复复用 `recoverNotice`；命令输出改 `{ text, kind }`。
- 测试：`ui` / `router` / `entry` / `degrade` / `config` 断言同步；新增 `levelBadge` 边界用例。
- 文档：README 双语页脚示例与条目前缀；`docs/architecture.md` 的页脚规则与新增「用户文案规则」表。

## 兼容性

- 状态文件结构、配置字段、转录条目字段均未变；旧会话条目按新模板重新渲染（字段兼容，含旧 error 条目缺 `provider` 时回落 `已回到 ⓪`）。
- 时间格式变化会改变历史条目的显示文本，但不影响数据。
- 圈码宽度：`⓪①` 属 Ambiguous，部分终端按 2 列渲染，状态行截断可能偏差 1–2 列（不参与右对齐，影响小）。若终端表现异常，把 `LEVEL_BADGES` 换成 ASCII 数字即可（单点回退）。

## 失效条件 / 后续

- 若宿主未来新增思考档位或模型档位字符体系，需重新审视 `LEVEL_BADGES` 的视觉一致性（当前只覆盖 0–9 + 数字回落）。
- 若链长普遍超过 10，或需要跨年更醒目的时间（如 `2027-01-01` 与 `2026-12-31` 并排），再评估是否把时间改为更长格式。
- 条目展开提示（`options.keyHint`）与 `devDependencies` 升级到 1.5 未纳入本次变更，作为独立小步跟进。
