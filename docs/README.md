# 文档索引

本目录放**当前状态**的架构文档与**日期化**的设计记录。用户可见的功能与配置以 README 为准，开发约束以仓库根 [`AGENTS.md`](../AGENTS.md) 为准。

## 单一权威来源

| 主题 | 权威处 | 更新时机 |
|---|---|---|
| 安装、配置字段与默认值、命令、状态文件说明 | [`README.md`](../README.md) / [`README.zh-CN.md`](../README.zh-CN.md) | 字段或功能变更时，双语同步 |
| 配置示例与字段速查 | [`examples/README.md`](../examples/README.md)、`examples/provider-chain.json` | 同上 |
| 与 pi-subagents 配合的用户操作步骤 | README 的「[与 pi-subagents 配合](../README.zh-CN.md#与-pi-subagents-配合)」 | 集成方式变化时 |
| 架构、分层、模块职责、状态文件/宿主/配置契约 | [`architecture.md`](architecture.md) | 结构或契约变化时 |
| 面向 AI 编码代理的开发约束、测试与发版规范、变更检查清单 | [`AGENTS.md`](../AGENTS.md) | 规范变化时 |

`architecture.md` 只写结构与契约，**不复制** README 的字段表，避免双份文案漂移。

## 文件与目录约定

| 路径 | 性质 | 说明 |
|---|---|---|
| `architecture.md` | 当前状态文档 | 架构、请求数据流、模块职责、状态文件/宿主/配置三类契约、集成机制、测试与发布 |
| `YYYY-MM-DD-<name>.md` | 日期化设计记录 | 某次变更的方案与执行记录；落盘后视为历史快照，**不再随代码修改** |

> 早期日期化记录（`2026-10-15` 三份）已从工作树移除，需要时用 `git log --diff-filter=D --oneline -- docs/` 从 git 历史取回。

## 写文档的约定

- 中文，结论先行，尽量用表格与代码块。
- 引用代码位置时写**文件名 + 函数名/导出符号**，不写行号（行号会随改动失效）。
- 设计记录写「决策 / 理由 / 影响 / 失效条件」，不写流水账。
- 用户可见文案与字段语义不在本目录维护（见上表）。
