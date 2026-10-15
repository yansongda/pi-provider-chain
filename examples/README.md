# 示例配置

`provider-fallback.json` 是一份**可直接使用**的完整配置示例（作者本机在用的配置），覆盖了全部可选字段。

## 使用

```bash
# 1. 复制到 agentDir（默认 ~/.pi/agent，或 $PI_CODING_AGENT_DIR 指向的目录）
cp examples/provider-fallback.json ~/.pi/agent/provider-fallback.json

# 2. 按需替换 models[] 里的 provider / 模型 id 为你的实际模型
# 3. 让配置生效：/reload 或新开一个 session
```

> 这份示例不会被 Pi 自动加载：Pi 只加载本包的 `extensions/provider-fallback.ts`，
> 配置必须位于 `<agentDir>/provider-fallback.json`（或在配置里用 `stateFile` 之外的字段覆盖，见下）。

## 字段速查

| 字段 | 必填 | 示例值 | 说明 |
| --- | --- | --- | --- |
| `virtualProvider` | ✅ | `"yansongda"` | 虚拟模型挂载的 provider id；可以是不存在的 id（此时虚拟模型始终可选），也可以是已有 provider |
| `models[].id` | ✅ | `"deepseek-v4.1-flash"` | 虚拟模型 id；不能与 `virtualProvider` 下的物理模型 id 相同；同一配置内重复会直接报错 |
| `models[].name` | - | `"DeepSeek V4.1 Flash"` | `/model` 列表显示名，缺省为 `id`（非字符串时忽略） |
| `models[].thinkingLevels` | - | `["low","high","max"]` | 可选思考档位，缺省为全部档位（非数组或过滤后为空时回落全部档位） |
| `models[].contextWindow` / `maxTokens` | - | `1000000` / `384000` | 首个响应前的展示限值，之后以实际物理模型为准（非正数时忽略） |
| `models[].primary` | ✅ | `"volcengine/deepseek-v4.1-flash"` | 主用物理模型，`provider/id` |
| `models[].fallbacks[]` | - | `["workbuddy/deepseek-v4.1-flash"]` | 备用物理模型，按序降级；非法项被静默忽略；建议链路总长 ≤ 5 |
| `degradePatterns[]` | - | 14 项内置默认 | 命中即降级的文本关键词（忽略大小写）；非空列表**完全覆盖**默认值，留空/全空白则回落默认 |
| `resetPattern` | - | 内置正则 | 从错误文本解析恢复时间；第 1/2 捕获组为日期/时间，第 3 组可选时区（`+08:00` / `+0800`） |
| `defaultDegradeMs` | - | `3600000`（1h） | 解析不到恢复时间时的降级时长；超过 `maxDegradeMs` 时被钳制 |
| `maxDegradeMs` | - | `2592000000`（30d） | 降级时长**硬上限**，同时钳制解析结果、默认时长与 `/fallback degrade <时长>` |
| `transcriptNotice` | - | `true` | 是否在转录里追加可见条目（前缀 `[fallback]`，**不进模型上下文**） |
| `stateFile` | - | 未出现（默认 `~/.pi/agent/provider-fallback-state.json`） | 跨进程共享的降级状态文件路径，支持 `~` |

完整字段语义与默认值见仓库根目录 [README.md](../README.md#配置)。

## 说明

- 示例里 `deepseek-v4-flash` 的 fallback 指向 `workbuddy/deepseek-v4.1-flash` 是**有意**的版本兜底（该 provider 没有同名模型）。
- 示例中所有 provider / 模型 id 都是作者本机配置，请按自己的环境替换；文件中不含任何密钥（密钥在 Pi 的 `auth.json` / 环境变量里）。
