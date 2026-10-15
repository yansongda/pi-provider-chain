# pi-provider-fallback

给 [Pi](https://pi.dev) 的扩展：**虚拟模型 + 额度耗尽自动降级**。

为每条配置注册一个虚拟模型（默认挂在 `yansongda` provider 下，例如 `yansongda/deepseek-v4.1-flash`），把请求路由到 `primary`；一旦命中**额度 / 订阅 / 欠费**类错误，自动推进到 `fallbacks`，并把降级状态写入共享状态文件，**跨 session、跨进程、跨父子 subagent** 生效。

## 特性

- **只对额度类错误降级**：429 瞬时限流、5xx、网络错误不干预，交回 Pi 自身重试。
- **两条触发路径**：`retry` 快路径（可重试错误）；`agent_before_settle` 兜底路径（不可重试错误，剔除失败消息后续跑一次）。
- **保缓存**：`retry` 同档位、`continuation` 沿用上一物理模型，尽量避免 prompt cache / 思考签名失效。
- **可解释**：notify 提示 + 页脚常驻状态 + 转录内可见条目（`provider-fallback`，**不进模型上下文**）。
- **自动恢复**：降级窗口按错误里的 `reset at ...` 解析，解析不到用默认时长；窗口过期后首次主用成功即提示恢复。
- **零运行时依赖**：只用 Pi 提供的 host 包（peer），不引入任何传递依赖。

## 安装

```bash
# 从 npm 安装
pi install npm:@yansongda/pi-provider-fallback@0.1.0

# 本地路径（开发用，改动无需重新安装）
pi install /Users/yansongda/000-Coding/pi-provider-fallback
pi list
```

安装后配置 `~/.pi/agent/provider-fallback.json`（或 `$PI_CODING_AGENT_DIR/provider-fallback.json`），`/reload` 或新开 session 生效。

## 配置

```json
{
  "virtualProvider": "yansongda",
  "degradePatterns": ["AccountQuotaExceeded", "insufficient_quota", "billing"],
  "resetPattern": "reset at\\s+(\\d{4}-\\d{2}-\\d{2})[ T](\\d{2}:\\d{2}:\\d{2})(?:\\s*([+-]\\d{2}:?\\d{2}))?",
  "defaultDegradeMs": 3600000,
  "maxDegradeMs": 2592000000,
  "transcriptNotice": true,
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

| 字段 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `virtualProvider` | ✅ | - | 虚拟模型挂载的 provider id（可复用已有 provider，也可以是新 id） |
| `models[].id` | ✅ | - | 虚拟模型 id，不能与 `virtualProvider` 下物理模型 id 相同 |
| `models[].name` | - | `models[].id` |  `/model` 列表里显示的名字 |
| `models[].thinkingLevels` | - | 全部档位 | 选择时可用的思考档位 |
| `models[].contextWindow` / `maxTokens` | - | 未声明 | 首个响应前展示的限值 |
| `models[].primary` | ✅ | - | 主用物理模型，`provider/id` |
| `models[].fallbacks[]` | - | `[]` | 备用物理模型，按顺序降级；非法项被忽略 |
| `degradePatterns[]` | - | 内置 14 项 | 命中即降级的关键词（忽略大小写；配置后**完全覆盖**默认值） |
| `resetPattern` | - | 内置正则 | 从错误文本解析恢复时间的正则（第 1/2 组为日期/时间，第 3 组可选时区） |
| `defaultDegradeMs` | - | `3600000`（1h） | 解析不到恢复时间时的降级时长 |
| `maxDegradeMs` | - | `2592000000`（30d） | 降级时长上限（钳制解析结果） |
| `transcriptNotice` | - | `true` | 是否在转录里追加可见条目（不影响模型上下文） |
| `stateFile` | - | `~/.pi/agent/provider-fallback-state.json` | 状态文件路径（支持 `~`） |

内置默认 `degradePatterns`：`AccountQuotaExceeded`、`QuotaExceeded`、`AgentPlanQuotaExceeded`、`SetLimitExceeded`、`InvalidSubscription`、`subscription has expired`、`AccountOverdueError`、`ServiceOverdue`、`overdue balance`、`usage quota`、`exceeded the quota`、`insufficient_quota`、`out of budget`、`billing`。

> 纯字母/词组项会自动加词边界（`\bbilling\b`），减少误判；含 `_`、数字、驼峰的项按原样匹配。

## 命令

| 命令 | 说明 |
| --- | --- |
| `/route` 或 `/route status` | 当前选中模型、配置与状态文件路径、每个虚拟模型的链路与降级状态 |
| `/route fallback [时长]` | 手动降级到第 1 档备用（`30m` / `2h` / `1d`，默认 `defaultDegradeMs`） |
| `/route reset` | 清除当前模型所属 provider 的降级状态（别名 `primary` / `clear`） |
| `/route reload` | 重新加载扩展与配置（等价 `/reload`） |

## 状态文件

默认 `~/.pi/agent/provider-fallback-state.json`：

```json
{
  "version": 1,
  "degraded": {
    "volcengine": { "level": 1, "until": 1793203199000, "code": "AccountQuotaExceeded", "at": 1792055998922 }
  }
}
```

- key 为 **primary 的 provider**（同一 provider 下所有虚拟模型共享档位）。
- 写入采用 `tmp + rename` 原子替换；并发写按「同 key 取更大 level」单调合并（父/子进程不会互相把档位打回去）。
- 每次写入会清理 `until + 24h < now` 的历史条目。
- 写入失败时降级仍在本进程生效，并通过提示告知「状态文件写入失败，本次降级仅本进程生效」。

## 工作原理

```
选中 yansongda/deepseek-v4.1-flash（虚拟模型）
        │  route(request, ctx)
        ▼
读状态文件 → level（0 = 主用，1..n = fallback，窗口过期自动回到 0）
        │
        ├─ retry 且错误文本命中 degradePatterns → 推进 level 并写状态（快路径）
        ├─ retry / continuation 且失败或上一模型就是当前档位 → 复用（保缓存）
        ├─ 否则从当前档位向后找有凭证的模型，再向前兜底
        ▼
返回物理模型 + 思考档位（assistant 消息记录的是物理模型）
```

不可重试的额度错误（如 403 订阅过期）由 `agent_before_settle` 兜底：命中后写入降级状态、剔除这条失败消息并续跑一次。

## 开发

```bash
npm install
npm test          # node --test tests/（Node ≥ 22.18 直跑 TS，无测试框架）
npm run typecheck # tsc --noEmit
npm run pack      # npm pack --dry-run，检查发布内容
```

```
extensions/provider-fallback.ts   装配层（注册虚拟模型 / 事件 / 命令 / 渲染器）
src/model-ref.ts                  provider/id 解析
src/degrade.ts                    降级判定与时间解析（纯函数）
src/state.ts                      状态文件读写（原子写 / 单调合并 / 清理）
src/config.ts                     配置加载与校验
src/routing.ts                    路由决策（纯函数）
src/ui.ts                         纯文本文案
tests/                            node --test 单测（含 stub pi 的装配集成测试）
docs/                             设计文档与执行计划
```

## 发布

1. **首次发布（人工）**：`npm login` → `npm whoami` → 确认 `@yansongda` scope → `npm publish --access public`。
2. 在 GitHub 仓库配置 `NPM_TOKEN` secret（npm Automation token）。
3. 之后随 tag 自动发布：`npm version patch && git push --tags` → `.github/workflows/release.yml` 跑 test + typecheck，`npm publish --provenance` 并创建 GitHub Release。
4. 也可以改用 npm Trusted Publishing（OIDC）替代 `NPM_TOKEN`，此时删掉 workflow 里的 `NODE_AUTH_TOKEN` 即可。

## License

MIT
