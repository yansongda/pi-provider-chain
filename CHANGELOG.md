# Changelog

## 0.1.0 - 2026-10-15

首个版本：扩展从 `~/.pi/agent/extensions/provider-fallback.ts` 迁入本仓库并模块化。

### 功能

- 虚拟模型 + 额度耗尽自动降级：读取配置后为每条 `models[]` 注册虚拟模型，命中额度/订阅/欠费类错误时自动推进到 `fallbacks`
- 两条触发路径：`retry` 快路径 + `agent_before_settle` 兜底路径（不可重试错误会剔除失败消息并续跑一次）
- 降级状态跨 session、跨进程、跨父子 subagent 生效；恢复窗口内首次主用成功即提示恢复
- `/route status | fallback [时长] | reset | reload` 命令
- UI：notify + 页脚常驻状态 + 转录内可见条目（`provider-fallback` entry，不进模型上下文）

### 变更

- 配置文件由 `~/.pi/agent/model-routing.json` 改为 `~/.pi/agent/provider-fallback.json`
- 状态文件由 `~/.pi/agent/model-routing-state.json` 改为 `~/.pi/agent/provider-fallback-state.json`
- 状态写入改为「同 key 取更大 level」的单调合并，避免父/子进程并发写把档位回退；写入时清理超过 24h 的历史条目
- 默认降级 pattern 中纯字母/词组项启用词边界（`billing` 不再命中 `rebilling` 之类无关文案）
- 错误信息前缀由 `model-routing:` 改为 `provider-fallback:`

### 工程

- 拆分为 `src/{model-ref,degrade,state,config,routing,ui}.ts` + 薄装配入口，纯逻辑可单测
- 零运行时依赖；`node --test` 单测 + `tsc --noEmit` 类型检查
- GitHub Actions：CI（push/PR 跑 test + typecheck）与 Release（tag `v*` 发布到 npm 并创建 GitHub Release）
