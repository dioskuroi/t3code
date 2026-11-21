# omp profile 隔离（`--profile t3code`）

t3code 驱动的 omp 会话统一携带 `--profile t3code`：omp 的 auth、sessions、settings、caches 全部落 `~/.omp/profiles/t3code/`，与本机其他 omp 宿主（Tern 托管的 omp、手动 CLI）完全隔离。这是 omp 的官方一等隔离机制（`omp --help`：isolated profile for auth, sessions, settings, and caches），不是 t3code 自造。

## 用途

- 会话不串：t3code 驱动的会话与其他宿主在同项目 cwd 下也不再互相可见
- 凭据/设置独立：Tern 侧重新登录、改设置不影响 t3code 侧
- 版本仍随 PATH 解析（Tern 管理的二进制或独立二进制皆可配 profile，互不冲突）

## 首次启用：bootstrap（一次性）

跟随机制（下节）只覆盖**凭据增量**；全新 profile 的 models.db 快照与插件态仍需一次性手动 bootstrap（按本机 omp home 调整路径）：

```sh
mkdir -p ~/.omp/profiles/t3code/agent
sqlite3 ~/.omp/agent/models.db ".backup '$HOME/.omp/profiles/t3code/agent/models.db'"
# 插件（mattpocock 技能等）、插件市场配置、模型配置、插件数据与原生件
cp -R ~/.omp/plugins ~/.omp/profiles/t3code/plugins
cp ~/.omp/marketplaces.json ~/.omp/profiles/t3code/marketplaces.json
cp ~/.omp/models-*.yml ~/.omp/profiles/t3code/
cp -R ~/.omp/context-mode ~/.omp/profiles/t3code/context-mode 2>/dev/null
cp ~/.omp/autoqa.db ~/.omp/profiles/t3code/ 2>/dev/null
cp -R ~/.omp/natives ~/.omp/profiles/t3code/natives 2>/dev/null
```

凭据**不在** bootstrap 清单里：首轮 spawn 时的凭据跟随会自动补齐。

## 凭据跟随（ADR-0006，自动）

Tern 侧重新登录后无需任何动作：provider-omp 在每次 spawn 时自动执行**凭据跟随**——比对默认 profile 与 t3code profile 的 `auth_change_revision`，默认侧更新才重放 `omp auth export | omp --profile t3code auth import -`。仅同步 `auth_credentials`（单向 默认→t3code）。

失败语义（fail-closed）：重放需要执行但失败（export/import 非零退出、超时、二进制缺失）→ 线程**拒绝启动**（`OmpRpcCredentialSyncError`，错误信息附上述自救命令）；凭据缺失仍走 `OmpRpcCredentialError`；Skipped（默认库不可读、无 sqlite3）不阻塞，按现有凭据继续。跟随结果经 server log `credential follow [thread]` 可查。status 探针刻意不走跟随（会话级语义，探针频率高）。

支持面：export/import 能表达的凭据类型都跟随（api_key、oauth 均可），但 OAuth 的 token 刷新由两侧 omp 进程各自进行（刷新租约不跨 profile），对 refresh rotation 严格的 provider 可能失效——本机主力 zhipu-coding-plan 为 api_key 型，不受影响。限制：revision 读取走系统 `sqlite3` CLI（macOS 内建）；Windows 无内建 sqlite3，跟随降级为 skip。

## 实现位置

- 注入点唯一：`packages/provider-omp/src/server/rpc/client.ts` 的 `makeOmpRpcClient`（所有 `omp --mode rpc` spawn——adapter 长会话、#103 textGeneration——都经由此处；status 探针不经跟随）
- 跟随实现：`packages/provider-omp/src/server/credentialFollow.ts`（revision 比较 + export/import 重放）
- 常量：`packages/provider-omp/src/server/profile.ts`（`OMP_PROFILE_NAME` / `OMP_PROFILE_ARGS`）
- 凭据缺失检测：client 捕获 stderr 尾部 2KB，ready 帧前退出且 stderr 含 "No default model selected" → `OmpRpcCredentialError`（错误信息指向跟随通知与本文档）

## 已知边界

- 全局 omp 插件在 profile 下需重装（项目级 AGENTS.md/skills 随 cwd，不受影响）
- 上游无 `OMP_HOME` 类整目录重定位 env；`--profile` 是其官方等价物
