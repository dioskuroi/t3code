# omp 默认实例白名单

omp 是 fork 新增的一等 provider，但默认实例（`omp`，id 与 driver 同名）不在上游的「未配置实例白名单」里。从官方 app 迁移过来的 `~/.t3` 已含官方预置实例（全 disabled）→ omp 未配置、被判 disabled → composer 可选集为空、无法发送（migration bug #26）。

修法一行：`DEFAULT_ENABLED_DEFAULT_INSTANCES` 白名单（`packages/contracts/src/settings.ts`）加入 `"omp"`。该白名单是「未配置实例」的唯一启用判据，同时管三道门——client 选择门（`apps/web/src/providerInstances.ts`）、server dispatch 门（`apps/server/src/orchestration-v2/ThreadManagementService.ts`）、模型选择门（`packages/shared/src/serverSettings.ts`）。

语义：**白名单只作用于 stored settings 无条目的实例**。用户显式禁用（stored `enabled: false`）命中 `Object.hasOwn` 分支、优先于白名单，与 codex 同语义；fresh install 的 codex 兜底不受影响。

完整触发链与验收清单：[migration repo spec](https://github.com/dioskuroi/t3code-migration/blob/main/docs/spec/omp-default-instance-whitelist.md)（方向决议见 [#35](https://github.com/dioskuroi/t3code-migration/issues/35)，bug [#26](https://github.com/dioskuroi/t3code-migration/issues/26)，同批文案补丁 [#34](https://github.com/dioskuroi/t3code-migration/issues/34)）。

回归测试：`packages/contracts/src/settings.test.ts` 的 `resolveProjectProviderInstanceEnabled` 块（迁移场景：官方预置全 disabled + omp 未配置 → enabled；显式禁用 → 仍 disabled）。

## rebase

该常量区域上游流量稳定（2026-10-08 曾被 `2c1160783e` 重写为 Set 构造）。冲突形态 = initializer 相邻行；解法 = **取上游新版形（无论数组还是 Set 构造），重加 `"omp"` 一项**。若上游删除该常量或换机制：沿 spec 的三道门重定位「未配置实例默认启用」判定点，重建等效白名单。
