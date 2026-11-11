# npm 分发名迁移：`pi-provider-chain` → `@yansongda/pi-provider-chain`

- 日期：2026-11-11
- 版本：`0.3.0`（新包首个版本）
- 涉及：`package.json`、`README.md` / `README.zh-CN.md`、`examples/README.md`、`AGENTS.md`、`docs/architecture.md`、`.agents/skills/release/SKILL.md`

> 本文是落盘时的决策快照，不随代码后续修改；当前事实以 README 与 `architecture.md` 为准。

## 结论

npm 不支持包改名：迁移 = **用新名字发一个新包** + 把旧包 `deprecate` 指向新名字。旧包已发布版本、tarball 与下载链接永久保留，只是不再更新。

## 决策

| 项 | 值 |
|---|---|
| 新包名 | `@yansongda/pi-provider-chain` |
| 首个版本 | `0.3.0`（0.x 下分发入口变更按 minor；不复用 `0.2.x`，避免与旧包版本序列混淆） |
| 访问级别 | `publishConfig.access: "public"`（scoped 包默认 restricted） |
| 旧包处置 | `npm deprecate pi-provider-chain@* "<迁移提示>"`；不 `npm unpublish` |
| 转录前缀 | 继续用 `[pi-provider-chain]`（与分发名解耦） |
| GitHub 仓库 | 不改名，仍为 `yansongda/pi-provider-chain` |

## 理由

- 账号已从个人账号转为 org：原用户名变成 org 名（`yansongda`），个人新账号为 `daemonyan` 且是 org owner；旧包随转换转入 org。scoped 是 org 的标准命名空间，可避免继续与第三方包撞名。
- npm 无 rename API；`unpublish` 受 72 小时 / 下载量限制，已发布历史无法搬迁，因此只能「新包 + 弃用旧包」。
- 保留 `[pi-provider-chain]` 前缀：它是转录可见标识（历史会话条目、渲染断言、`/chain` 文案都依赖它），改成 scoped 全名只会增加兼容面而无用户收益。

## 影响

- 用户侧：安装/升级命令变为 `pi install npm:@yansongda/pi-provider-chain`；pi-subagents 的 `subagents.defaultSubagentOnlyExtensions` 需同步为 `npm:@yansongda/pi-provider-chain`。已按旧名安装的用户不会自动迁移，需手动换源。
- 发布侧：新包在 npm 上不存在 → 包设置页不可用 → **Trusted Publisher 无法预先配置**，CI 的 OIDC 首发必然 404/ENEEDAUTH，必须由用户本地手动 `npm publish` 一次后再配置。
- 首个版本（`0.3.0`）不推 tag：tag 会触发 `release.yml` 对已发布版本二次 publish → 403。下一版走正常 `tag → CI` 流程，同时满足 Trusted Publisher「2 天内完成首次成功发布」的时效要求。
- 发布权限：需以 `daemonyan` 登录（org owner，2FA）发布；agent 不接触任何凭据。

## 失效条件

- npm 支持包改名或跨 scope 搬移时，本文的「新包 + deprecate」路径可作废。
- scope 归属变化（org 更名/转让）后需重走一次首次发布特例。
