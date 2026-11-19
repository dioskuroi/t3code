# omp 凭据存储与 profile 共享面调研（#110）

母图：t3code-migration#109。方法：本机只读 sqlite 查询（生产库 `?mode=ro`）、`omp --help`、二进制 strings 定向提取、上游 `can1357/oh-my-pi` docs/源码（gh api）、`/tmp` 独立库 symlink/WAL 实验。结论日期：2026-11-19，实证对象：omp 19.0.0（`~/Library/Application Support/Tern/omp/bin/omp`）。

## 1. 凭据存储：哪个库、哪张表

**凭据只在 `agent.db`，`models.db` 不含任何凭据。**

`~/.omp/agent/agent.db`（`--profile` 下为 `~/.omp/profiles/<name>/agent/agent.db`，已实证 t3code profile 存在同结构副本）auth 相关表：

- **`auth_credentials`** — 凭据主表，登录/换 key 的写入目标。列：`id, provider, credential_type, data(JSON), disabled_cause, identity_key, created_at, updated_at`。本机默认 profile 实测行：
  - `1 | zhipu-coding-plan | api_key`（`data` JSON：`{"key":"..."}`）
  - `2 | kimi-code | oauth`（`data` JSON：`{"access":"eyJ...", ...}`；`disabled_cause` 记录了 refresh 失败：`oauth refresh failed: OAuthError: kimi-code token refresh failed: 400 invalid_grant`）
  - `3 | deepseek | api_key`（`data`：`{"key":"...","source":"login"`}）
- **`auth_credential_blocks`** — 按 `(credential_id, provider_key, block_scope)` 的限流封禁（triggers 里可见 openai-codex 的 shared/chat/spark 镜像逻辑），不是凭据本体。
- **`auth_credential_refresh_leases`** — OAuth 刷新租约：`(credential_id PK, owner, expires_at_ms, updated_at_ms)`，防止多进程并发刷新同一 OAuth 凭据。
- **`auth_credential_block_mirror_guard`** — 上述镜像 trigger 的递归保护表。
- **`auth_change_revision`** — 单行计数器，`auth_credentials`/`auth_credential_blocks` 的任何 INSERT/UPDATE/DELETE 由 trigger 自增（本机 revision=753），供其它进程/客户端感知凭据变更。
- **`auth_schema_version`** — 版本号（本机 = 8）。

`~/.omp/agent/models.db` 表仅 `model_cache / model_cache_refresh / model_cache_freshness / thinking_capability`，`model_cache` 主键 `(provider_id, materialization_policy)`，`models` 列是各 provider 的模型目录 JSON（实测含 `zhipu-coding-plan|15|...|29632` 等行）——**纯模型目录缓存，无 key/token**。`agent.db` 的 `cache` 表也只存 `extension_startup:v1:...` 之类非凭据缓存。

**登录/换 key 写哪**：`omp login` / `/login`（含 auth-broker `login`、`import`、`migrate --from-local` 的本地侧）写本 profile 的 `agent.db` → `auth_credentials`（upsert，经 `auth_change_revision` trigger 广播）。换 key 即该表 `data` 的 UPDATE。

**token 刷新归属**：默认（无 broker）**在 omp 进程内做**——二进制 strings：

> `OAuth token expired before request — please retry; AuthStorage will refresh on the next attempt.`

即按需刷新；跨进程用 `tryAcquireCredentialRefreshLease/renewCredentialRefreshLease/releaseCredentialRefreshLease`（strings 实证，落 `auth_credential_refresh_leases` 表）去重，即同机多 omp 进程靠 db 租约协调，但执行者是持锁的那个 omp 进程，**没有独立 daemon**。例外：启用 auth-broker 后刷新统一在 broker 端（见 §2，`auth-broker serve` 内建 background refresher，默认每 60 s 扫描）。

## 2. auth broker 面（`OMP_AUTH_BROKER_*` env 语义）

来源：上游 `docs/environment-variables.md`（gh api 取回，行 150–156）与 `docs/auth-broker-gateway.md`；二进制 strings 交叉印证（错误消息逐一对应）。

| env                                 | 语义                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OMP_AUTH_BROKER_URL`               | 远端 auth-broker base URL；设置即进入 broker 模式（本地 SQLite 凭据库被旁路，所有 OAuth refresh/access token 住在 broker host）。优先于 `config.yml` 的 `auth.broker.url`；**设了 URL 却拿不到 token 时 `resolveAuthBrokerConfig()` 硬报错，不回退本地 SQLite**。                                                                                        |
| `OMP_AUTH_BROKER_TOKEN`             | 除 `/v1/healthz` 外所有 broker 端点的 bearer。解析链：本 env → `auth.broker.token`（支持 `$ENV_NAME` 间接）→ `<config-dir>/auth-broker.token`（0600，`<config-dir>` = `~/.omp/`，随 profile/`PI_CONFIG_DIR`）。                                                                                                                                          |
| `OMP_AUTH_BROKER_SNAPSHOT_CACHE`    | 加密的本地 broker 快照缓存路径，默认 `~/.omp/cache/auth-broker-snapshot.enc`。快照把 refresh token 替换为 `REMOTE_REFRESH_SENTINEL`；过期 access token 由客户端 `POST /v1/credential/:id/refresh` 请 broker 代刷。                                                                                                                                       |
| `OMP_AUTH_BROKER_SNAPSHOT_TTL_MS`   | 快照新鲜度窗口，默认 3600000（1 h）；`0` 禁用快照、每次启动阻塞拉取。                                                                                                                                                                                                                                                                                    |
| `OMP_AUTH_BROKER_ACCOUNT_POOL_FILE` | **进程作用域的凭据可见性过滤**，不是凭据本体。指向 JSON：`provider → identityKey 数组 / true / false / {"accounts":[...],"apiKeys":bool}`；`"*": false` 使其成为 allow-list。启动时解析一次，非法输入 fail-closed（strings：`OMP_AUTH_BROKER_ACCOUNT_POOL_FILE must contain a JSON object` 等）。对直接客户端它不是授权边界——客户端仍持有 broker token。 |

**account pool file 能否当跨 profile 凭据共享通道？不能。** 它只是 broker 模式下的可见性过滤器，过滤的是 broker 已下发快照里的账号；没有任何凭据写入/交换语义。真正能跨 profile 共享凭据的官方面是：

1. **`omp auth export | omp auth import -`**（同机/跨机 JSON 搬运，写入目标 profile 的 `agent.db`）——`omp auth --help` 实证。
2. **auth-broker**：默认 profile 起本地 broker（`omp auth-broker serve` 直接打开 `getAgentDbPath()` 即默认 profile 的 `agent.db`），t3code profile 设 `OMP_AUTH_BROKER_URL/TOKEN` 指向它，即「默认 profile 持有正本、t3code 只读快照」。代价：broker 模式下 profile 本地 `agent.db` 凭据被旁路，OAuth 刷新集中在 broker host；且 URL 配错+token 缺失会硬错而非回退。

## 3. env 注入覆盖面

- **API key 型**：全部可走 env。上游 `docs/environment-variables.md` §1（"consumed via `getEnvApiKey()` (`packages/ai/src/stream.ts`)"）。**`zhipu-coding-plan` 是 API-key 型**：上游 catalog `packages/catalog/src/compat/rules/auth/zhipu-coding-plan.kdl` 的 login 是 `login "api-key"`（bigmodel.cn Coding Plan 面板粘贴 `<id>.<secret>` key，chat-completions validate）；本机 `auth_credentials` 行也是 `credential_type=api_key`。对应 env 为 **`ZHIPU_API_KEY`**（env docs 行 84；`omp --help` 顶层列表未列它，但 catalog `env` 项与 docs 均指向它；`ZAI_API_KEY` 是另一个 provider `zai`，勿混）。
- **OAuth/订阅型**：部分有 token env（如 `ANTHROPIC_OAUTH_TOKEN`、`XAI_OAUTH_TOKEN`、`QWEN_OAUTH_TOKEN`），但 refresh token 无法 env 注入——env 只有 access token；无 broker 时续期仍依赖 db 里的 refresh token。
- **env 注入后是否还需要 db 凭据**：按上游 `packages/ai/src/auth/cascade.ts`（gh api 取回）的优先级 **runtime → config(models.yml) → stored OAuth → login-stored api_key → config fallback → env var → stored api_key**。即：**env 只在 profile 内没有更高层凭据时生效**；一旦 db 里有 login 写入的 api_key 或 OAuth 行，db 凭据优先于 env。因此「fork 侧 `mergeProviderInstanceEnvironment` 注入 `ZHIPU_API_KEY`」要真正免 db 凭据，前提是 t3code profile 的 `agent.db` 里没有 `zhipu-coding-plan` 行（或将其 `disabled_cause`/删除）。对 api-key 型 provider，env 是完备替代（无刷新需求）；对 OAuth 型不完备。

## 4. symlink 同源可行性：WAL/-shm 命名实验

实验（`/tmp/waltest`，非生产库）：`real.db` 置 WAL 模式，目录 `a/`、`b/` 各建符号链接 `db.sqlite -> ../real.db`，两个连接分别以 `a/db.sqlite`、`b/db.sqlite` 打开并并发写。

结果：

- `-wal/-shm` 文件**随解析后的真实路径**创建：事务进行中文件集为 `real.db`, `real.db-shm`, `real.db-wal`；`a/`、`b/` 内始终只有链接本身，未出现 `a/db.sqlite-wal` / `b/db.sqlite-wal`。
- 双路径并发写不产生双 WAL；观察到的只是正常的写锁排队（`BEGIN IMMEDIATE` 冲突时后者 busy-timeout 报 `database is locked`，属锁等待非损坏）。两边 `PRAGMA integrity_check` 均 `ok`，行数一致（先前一次性 CLI 实验两路径各写一行，2 行均在，integrity ok）。

**结论：双路径（symlink 与真名）访问同一 db 不会形成双 WAL 损坏风险**——SQLite 对 journal/WAL 伴生文件的命名落在真实文件所在路径上，两个路径收敛到同一 `real.db-wal`。把 t3code profile 的 `agent.db` 做成指向默认 profile 库的 symlink，从 WAL 角度是同源安全的（仍需注意：这是两个 profile 写同一份 `auth_change_revision`/usage 数据，属数据面混写而非损坏风险；且默认侧若迁移/删除正本，profile 侧直接失效）。

## 对选型的一句话

凭据正本唯一落在默认 profile `agent.db.auth_credentials`；t3code profile 想让凭据跟随，可选面：`omp auth export|import` 显式复制（现状，#107 决定）、agent.db symlink（WAL 同源安全，但两 profile 写同一库）、auth-broker 只读快照（官方远程面，改动 env/config 面）。`OMP_AUTH_BROKER_ACCOUNT_POOL_FILE` 不承载凭据，不可作共享通道。

## 引用清单

- `sqlite3 "file:~/.omp/agent/agent.db?mode=ro" .schema / SELECT`（本文所有表结构与行内容）
- `sqlite3 "file:~/.omp/agent/models.db?mode=ro"`（model_cache 无凭据）
- `sqlite3 "file:~/.omp/profiles/t3code/agent/agent.db?mode=ro"`（profile 副本）
- `omp --help`、`omp auth --help`、`omp auth-broker --help`
- 二进制 strings：`OMP_AUTH_BROKER_*`、`tryAcquireCredentialRefreshLease`、`AuthStorage will refresh on the next attempt`、`zhipuai-coding-plan → zhipu-coding-plan`、`ZAI_API_KEY missingKeyMessage`
- 上游 https://github.com/can1357/oh-my-pi ：`docs/environment-variables.md`、`docs/auth-broker-gateway.md`、`packages/ai/src/auth/cascade.ts`、`packages/catalog/src/compat/rules/auth/zhipu-coding-plan.kdl`
- symlink/WAL 实验：`/tmp/waltest`（脚本见正文）
