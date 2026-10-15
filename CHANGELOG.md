# Changelog

## 0.1.0 - 2026-10-15

首个版本：扩展从 `~/.pi/agent/extensions/provider-fallback.ts` 迁入本仓库并模块化。

### 功能

- 虚拟模型 + 额度耗尽自动降级：读取配置后为每条 `models[]` 注册虚拟模型，命中额度/订阅/欠费类错误时自动推进到 `fallbacks`
- 两条触发路径：`retry` 快路径 + `agent_before_settle` 兜底路径（不可重试错误会剔除失败消息并续跑一次）
- 降级状态跨 session、跨进程、跨父子 subagent 生效；恢复窗口内首次主用成功即提示恢复
- `/fallback status | degrade [时长] | reset | reload` 命令（别名：`fallback` / `primary` / `clear`，子命令带参数补全）
- UI：notify + 页脚常驻状态（多 provider 汇总）+ 转录内可见条目（前缀 `[fallback]`，不进模型上下文）

### 变更

- 配置文件由 `~/.pi/agent/model-routing.json` 改为 `~/.pi/agent/provider-fallback.json`
- 状态文件由 `~/.pi/agent/model-routing-state.json` 改为 `~/.pi/agent/provider-fallback-state.json`
- 命令由 `/route` 改为 `/fallback`（子命令首选 `degrade`，保留 `fallback` 别名），转录条目前缀同步由 `[route]` 改为 `[fallback]`
- 状态写入改为「同 key 取更大 level」的单调合并，避免父/子进程并发写把档位回退；写入时清理超过 24h 的历史条目
- 恢复提示改为基于状态文件判断（写入 `level: 0, code: "recovered"` 墓碑），父/子进程都能提示且不会重复提示
- 页脚状态改为汇总所有活跃降级（`⚠ 备用 ×N: a, b`），多 provider 不再互相覆盖
- `agent_before_settle` 定位不到失败消息 entry 时也写入降级状态（仅不续跑），下一次请求即可走备用
- `maxDegradeMs` 成为统一硬上限：同时钳制解析结果、`defaultDegradeMs` 与手动 `/fallback degrade <时长>`
- 状态文件不再做 `mtime+size` 缓存（读取即解析），消除陈旧快照；写盘前紧邻读取，缩小并发丢更新窗口
- `degradePatterns` 为空数组时明确回落内置默认（原「degradePatterns 为空」校验为不可达代码，已删除）
- 默认降级 pattern 中纯字母/词组项启用词边界（`billing` 不再命中 `rebilling` 之类无关文案）
- 错误信息前缀由 `model-routing:` 改为 `provider-fallback:`

### 工程

- 拆分为 `src/{model-ref,degrade,state,config,routing,command,ui}.ts` + 薄装配入口，纯逻辑可单测；`LoadedModel.chain` 用元组类型表达「至少一项」不变量
- 零运行时依赖；`bun test` 单测（81 用例）+ `node --test`（Node ≥ 22.18 直跑 TS）+ `tsc --noEmit` 类型检查
- `examples/` 提供可直接复制的完整配置示例与字段说明
- GitHub Actions：CI（push/PR 跑 test + typecheck）与 Release（tag `v*` 发布到 npm 并创建 GitHub Release）
