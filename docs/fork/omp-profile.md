# omp profile 隔离（`--profile t3code`）

t3code 驱动的 omp 会话统一携带 `--profile t3code`：omp 的 auth、sessions、settings、caches 全部落 `~/.omp/profiles/t3code/`，与本机其他 omp 宿主（Tern 托管的 omp、手动 CLI）完全隔离。这是 omp 的官方一等隔离机制（`omp --help`：isolated profile for auth, sessions, settings, and caches），不是 t3code 自造。

## 用途

- 会话不串：t3code 驱动的会话与其他宿主在同项目 cwd 下也不再互相可见
- 凭据/设置独立：Tern 侧重新登录、改设置不影响 t3code 侧
- 版本仍随 PATH 解析（Tern 管理的二进制或独立二进制皆可配 profile，互不冲突）

## 首次启用：凭据迁移（一次性）

新 profile 无凭据，omp 会拒绝进入 RPC 模式（adapter 映射为 `OmpRpcCredentialError`，错误信息内含下述命令）。从默认 profile 迁移凭据（按本机 omp home 调整路径）：

```sh
mkdir -p ~/.omp/profiles/t3code/agent
sqlite3 ~/.omp/agent/agent.db ".backup '$HOME/.omp/profiles/t3code/agent/agent.db'"
sqlite3 ~/.omp/agent/models.db ".backup '$HOME/.omp/profiles/t3code/agent/models.db'"
```

Tern 侧重新登录后如需跟随，重跑这两条命令即可（profile 凭据不自动同步）。

## 实现位置

- 注入点唯一：`packages/provider-omp/src/server/rpc/client.ts` 的 `makeOmpRpcClient`（所有 `omp --mode rpc` spawn——adapter 长会话、#103 textGeneration、status 探针——都经由此处）
- 常量：`packages/provider-omp/src/server/profile.ts`（`OMP_PROFILE_NAME` / `OMP_PROFILE_ARGS`）
- 凭据缺失检测：client 捕获 stderr 尾部 2KB，ready 帧前退出且 stderr 含 "No default model selected" → `OmpRpcCredentialError`

## 已知边界

- 全局 omp 插件在 profile 下需重装（项目级 AGENTS.md/skills 随 cwd，不受影响）
- 上游无 `OMP_HOME` 类整目录重定位 env；`--profile` 是其官方等价物
