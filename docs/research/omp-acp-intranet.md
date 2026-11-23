# 调研：omp 经 ACP 接入的内网可行性（票 #136）

- 基线：t3code fork `dioskuroi/t3code` @ v0.1.12-nightly.20261123.5124（commit `2808e878`，本 worktree）；omp 本地只读检出 `can1357/oh-my-pi` @ `57771ae`（"chore: bump version to 19.0.0"）。
- 方法：只读源码核查，两侧仓库 file:line 逐条附证据。未做运行联调（见文末「未证实」）。

## 结论（判定）

**可行，且是「纯配置」级别：t3code 干净 fork 零补丁 + omp 零 fork，仅需两侧各一组配置项。**

- t3code 侧用 ACP 的 **Local command** 形态（`source: "local"`）：不查 Registry、不下载、不触网（`AcpRegistrySupport.ts:1838-1851, 2033-2047`）；上游 nightly 已内置按可执行名识别 omp 的 flavor（askDialog 表单还原，`adapter.ts:204-206, 280-282`），ADR-0001 时代「通用 ACP adapter 不能为 omp 定制」的前提已被上游自身改变。
- omp 侧 `omp acp` 即 ACP v1 stdio server（`PROTOCOL_VERSION = 1`，`packages/utils/src/acp/protocol.ts:13`），t3code 明确协商 ACP v1 兜底（`docs/user/providers-acp.md:8-9`；实现层 `packages/provider-acp/src/server/adapter.ts:2301` 按 `protocolVersion === 2` 分支）。
- 模型接入：omp `models.yml` 自定义 provider（OpenAI 兼容 `baseUrl` + `apiKey` + 内联模型目录）指向内网网关（GLM/Kimi/DeepSeek），纯配置；模型目录经 ACP config options 透出给 t3code picker。
- omp 的外网触点全部有配置开关或仅按需触发（自更新、marketplace、web_search/fetch、skillshare 等），无一项需要 fork oh-my-pi。
- 需接受的 ACP 通用边界（非阻塞）：rollback 后 agent 会话重开并重放保留对话；thread 标题/commit message 等 app-owned 文本生成不走 ACP 实例，需另配一个走内网网关的普通 provider。

## 一、t3code 侧 ACP adapter / registry 机制

### 1.1 驱动与 adapter 分层

- provider driver 名 `acpRegistry`；`makeAcpRegistryAdapterV2` 在 `packages/provider-acp-registry/src/server/adapter.ts:189`，内部复用通用 `makeAcpAdapterV2`（`packages/provider-acp/src/server/adapter.ts:2027`）。registry 形态与 local 形态共用同一 adapter，靠 `settings.source` 区分。
- local 形态下 `registryAgentId = ""`、`startupKey = "local:<instanceId>"`（`adapter.ts:193-195`），不持有任何 registry 身份。

### 1.2 agent 注册 / 发现

- **Registry 形态**：索引取自 `https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`（`packages/provider-acp-registry/src/server/AcpRegistrySupport.ts:53`）。加载顺序为内存 ref → 磁盘缓存 → 才发起网络（`AcpRegistrySupport.ts:999-1005`）；磁盘缓存路径 `<T3 home>/caches/acp-registry/registry.json`（`:684-686`，T3 home 见 1.4）。即理论上预置缓存文件可让 registry 形态离线工作【未实测】。
- **Local command 形态（内网采用）**：`inspect` 对 `source === "local"` 只做本地可执行解析与校验，完全不调用 `loadRegistry()`（`AcpRegistrySupport.ts:1838-1851`）；`resolve` 直接返回 `spawn: { command, args: settings.commandArgs, cwd, env, shell: false }`（`:2033-2047`）。用户文档同义：local command「无需 registry 条目或下载」（`docs/user/providers-acp.md:37`）。
- Registry 安装形态才会下载到 `tools/<agent-id>/<version>/` 并做 SHA-256 校验（`docs/user/providers-acp.md:47`；`agentInstallRoot` `AcpRegistrySupport.ts:689`）——内网不用此路径。
- Registry agent 图标 CDN（`cdn.agentclientprotocol.com/.../<agentId>.svg`）只作用于 registry agentId（`packages/contracts/src/acpRegistry.ts:15-22`，local 时 agentId 不匹配 pattern 返回 null）。

### 1.3 配置面

- 实例 schema `AcpRegistrySettings`（`packages/provider-acp-registry/src/settings.ts:14-90`）：`source: "registry"|"local"`（默认 registry）、`agentId`、`commandPath`（Executable override）、`commandArgs`（UI 中逐行字面参数，`docs/user/providers-acp.md:33-36`）、`authMethodId`、`distribution`、`customModels`。
- 持久化位置：`<T3 home>/userdata/settings.json`（`apps/server/src/config.ts:151`）；T3 home 默认 `~/.t3`，可由 `t3Home` 配置改写（`apps/desktop/src/app/DesktopStatePaths.ts:20-23`）。
- 实例环境变量覆盖、agent home 等沿用通用 provider instance 机制（`docs/user/providers-acp.md:37-38, 67-68`）。

### 1.4 能力呈现边界（相对旧 ADR-0001 的变化）

ADR-0001（迁移仓 `docs/adr/0001-native-adapter-rpc-bridge.md`）当年否决 ACP 零适配器的理由是「能力呈现受通用 adapter 上限约束 + 不能为 omp 特判」。本基线的事实变化：

- **上游已内置 omp 特判 flavor**：按 local 命令 basename 识别 `omp`（`adapter.ts:204-206`），挂 `extractOmpElicitationForm`（`adapter.ts:280-282`；实现 `packages/provider-acp-registry/src/server/ompAcp.ts`）——把 omp 的 `askDialog`（`qN` + `qN__other` 自由输入伴生字段）还原为 t3code 结构化提问。fork 随上游白得，无需自研补丁。
- 模型目录：agent 经 ACP 上报的 models/config options 直接进 t3code 模型 picker（`docs/user/providers-acp.md:81-82`）；缺失项用实例 `customModels` 补（`adapter.ts:251`；`docs/user/providers-acp.md:143`）。
- 权限：registry/local agent 的审批请求按 thread 的 permission mode（Supervised / Auto-accept edits / Auto / Full access）应答（`docs/user/providers-acp.md:110-119`）；mode 切换用 agent 自己的 mode picker。omp 侧广播 `Default`/`Plan` 两个 mode（`packages/coding-agent/src/modes/acp/acp-agent.ts:2535-2544`）。注意这与 ADR-0001 想要的「四值 permission mode 精细映射」不同：ACP 路径下粒度由 omp 的 mode 决定。
- Checkpoints：文件回滚照常，但 ACP agent 会话不能 rewind，rollback 后下一 turn 新开 agent session 并发送保留对话（`docs/user/providers-acp.md:130-132`）。
- app-owned 文本生成（thread 标题、commit message、分支名、PR 描述）**不使用** registry/local ACP 实例，需另配 text-generation provider（`docs/user/providers-acp.md:134-136`）——内网中把这个 provider 也指向网关即可。
- 子代理：ACP 无 portable lineage 契约，delegation 视图为 agent 特有（`docs/user/providers-acp.md:124-126`）；omp 经 `_meta.steering` 广告 steering 支持（`acp-agent.ts:1076-1080`）。
- Native sessions：支持 session list/import（`docs/user/providers-acp.md:93-95`；omp 广告 `sessionCapabilities: list/fork/resume/close`，`acp-agent.ts:1067-1074`）。

## 二、omp 侧 `omp acp` 现状

### 2.1 子命令与协议

- 子命令 `omp acp`：`packages/coding-agent/src/commands/acp.ts:16-34`，强制 `mode: "acp"`；`--mode acp` 等价（`docs/cli-reference.md:182, 259, 270`）；dispatch 在 `packages/coding-agent/src/main.ts:2465-2496`（`1930` 处归类为 protocol mode）。
- 传输：stdio JSON-RPC，`runAcpMode`（`packages/coding-agent/src/modes/acp/acp-mode.ts:89-97`），stdout 严格隔离防污染（`acp-mode.ts:44-73`）；协议栈为 `@oh-my-pi/pi-utils/acp`（自实现 `@agentclientprotocol/sdk` 兼容面，`packages/utils/src/acp.ts:1`；`PROTOCOL_VERSION = 1`，`packages/utils/src/acp/protocol.ts:13`）。
- `initialize` 应答：`agentInfo.name = "omp"`、版本 `VERSION`；`authMethods`：`agent`（「使用 `~/.omp` 下已配置的 provider keys/OAuth」）+ 可选 `terminal`（拉起 TUI 配 key，需 client 声明 terminal 能力）（`acp-agent.ts:1038-1053`）；`authenticate` 校验 methodId 后直接返回，无网络动作（`:1090-1103`）。**预置好 models.yml 时走 `agent` 方法即可，全程离线。**
- 会话模型：每 `session/new` 建 `AgentSession`，模型列表经 config options 上报：`session.getAvailableModels()` → `currentValue` + options（`acp-agent.ts:2462-2471`），即 omp 的 models.yml 目录逐条透出给 t3code。

### 2.2 runtime 与分发

- 运行时要求 Bun ≥ 1.4.4（`README.md:100`）。
- 官方分发两路：① 安装脚本拉取 `build.stencil.so` 预编译二进制并校验 SHA-256（`README.md:47`）——编译型 Bun binary，系统无需 Bun；② `bun install -g @oh-my-pi/pi-coding-agent`（`README.md:60`）走 npm registry，需要 Bun 运行时。
- 当前版本 **19.0.0**（`packages/coding-agent/package.json:3`；HEAD commit 即版本 bump）。
- 内网安装建议（不改代码）：内部 npm 镜像源执行 `bun install -g @oh-my-pi/pi-coding-agent`，或离线分发预编译 binary（含对应版本 natives；运行时 natives 按版本放 `~/.omp/natives/` per-version copy，见 `packages/coding-agent/src/cli/auto-update.ts:15-17` 注释）【binary 自包含性未逐一验证】。另支持 Nix 包（`README.md:629`）与 Docker。

## 三、模型 API 配置（内网网关接入）

- 配置文件：`~/.omp/agent/models.yml`（或 `.yaml`；profile/`PI_CONFIG_DIR` 可改），由 `config/model-registry.ts` 加载（`docs/models.md:15-21, 5-12`）。
- OpenAI 兼容网关即一个 provider 条目：`baseUrl`、`apiKey`（值为环境变量名）、`api: openai-completions`、`headers`、`discovery`（可选，探活 `<baseUrl>/models`）、内联 `models:` 目录或 `modelOverrides`（`docs/models.md:40-90`）——GLM/Kimi/DeepSeek 各一条即可，模型目录纯配置，无需改 catalog 源码。
- 环境变量兜底同样齐全：`OPENAI_BASE_URL`（`docs/environment-variables.md:336`）、`ANTHROPIC_BASE_URL` 网关场景（`:216-227`）、LiteLLM/Bifrost/Modal 网关（`:528-530`）。
- ACP 模式启动后 `modelRegistry.refreshInBackground()` 后台做 provider discovery（`main.ts:2462`），目标就是网关 baseUrl，属内网流量。
- t3code 侧呈现：上述 ACP config options → t3code 模型 picker（见 1.4）；不透明模型 ID 用实例 `customModels` 兜底（`docs/user/providers-acp.md:81-82, 143`）。

## 四、omp 外网触点与关闭方式（全部纯配置，无需 fork）

| # | 触点 | 端点/证据 | 默认 | ACP 模式是否触发 | 关闭方式 |
|---|------|-----------|------|------------------|----------|
| 1 | 启动版本检查 | `build.stencil.so`（`cli/build-service.ts:48`）/ npm registry（`cli/update-cli.ts:740-744`）；入口 `checkForNewVersion`（`main.ts:278-293`） | `startup.checkUpdate=true`（`modes/settings.ts:1296-1302`） | 否——仅 interactive 分支调用（`main.ts:2857-2859`）；且失败被吞 | `startup.checkUpdate=false`（稳妥起见） |
| 2 | 后台自更新 | `omp update`/install 脚本 `omp.sh/install`（`update-cli.ts:2063-2064`） | `update.auto=false`（`modes/settings.ts:1331-1341`） | 否 | 默认即关 |
| 3 | marketplace 自动更新 | 插件源 git URL（`extensibility/plugins/manager.ts:50, 494-495`） | `marketplace.autoUpdate="notify"`（`modes/settings.ts:1343-1356`） | **是**——ACP 分支也 `scheduleMarketplaceAutoUpdate`（`main.ts:2491`） | `marketplace.autoUpdate=off`（必设）；未添加 marketplace 时无目录可查（`marketplace/registry.ts:5`） |
| 4 | 插件安装 | git URL / npm spec（`manager.ts:494-495`） | 用户操作才触网 | 否 | 内网不装外部插件 |
| 5 | Skillshare 技能注册表 | `skills.omp.sh`（`cli/command-help.ts:169`；`skillshare/client.ts:94`） | 按需 | 否 | 不用 `/skill` 安装命令 |
| 6 | `/record` 上传 | `live.omp.sh`（`cli/command-help.ts:46`） | 按需 | 否 | 不用 |
| 7 | grievances 推送 | 默认 `qa.omp.sh/v1/grievances`，且为手动命令 + consent gate（`cli/grievances-cli.ts:210-217`） | 不自动 | 否 | 不执行 `omp grievances push` |
| 8 | `web_search` 工具 | `tools/settings.ts:914-917`，default `true` | 会话中按需触网 | 会话内 | `web_search.enabled=false` |
| 9 | `fetch` 工具 | `tools/settings.ts:840` | 会话中按需触网 | 会话内 | `fetch.enabled=false` 或接受逐请求失败 |
| 10 | tiny/本地模型下载 | HF Hub / MLX venv（`docs/local-models.md`） | `modelRoles` 默认空记录（`config/model-settings.ts:140`）→ 默认不下载 | 否 | 不配置 tiny 角色；要用则离线预置权重 |
| 11 | `/export` HTML viewer | 模板内引用 `build.stencil.so`/`stencil.so` CDN（`export/html/index.ts:49-55`） | 按需（浏览器侧） | 否 | 不用或内网替换 |
| 12 | install-id 上行 | 本地 UUID（`docs/install-id.md`），随 Codex/Claude 兼容头、auth-gateway 头上行 | 随对应 provider | 仅访问对应 provider 时 | 内网网关侧不转发即可 |

另有 `--acp-terminal-auth`（`modes/acp/terminal-auth.ts:1-3`）：仅在需要拉 TUI 配 key 时使用，纯本地。

## 五、落地清单

### 配置清单（无补丁）

**t3code 侧**（`~/.t3/userdata/settings.json` 的 provider instance，UI 路径 Settings → Providers → Add provider → Show more → Local ACP command）：

```jsonc
// driver: "acpRegistry"
{
  "source": "local",
  "commandPath": "/opt/intranet/bin/omp",   // 或 PATH 上的 omp
  "commandArgs": ["acp"],
  "authMethodId": "agent",                  // 用 ~/.omp 既有凭据（acp-agent.ts:1040-1046）
  "customModels": []                        // omp 上报不全时再补
}
```

另需一个走网关的普通 provider 供 app-owned 文本生成（标题/commit msg，`docs/user/providers-acp.md:134-136`）。

**omp 侧**（`~/.omp/agent/models.yml` + settings）：

```yaml
providers:
  intranet-glm:
    baseUrl: http://gateway.intranet/v1
    apiKey: INTRANET_GLM_API_KEY      # 环境变量名
    api: openai-completions
    models: [ … ]                     # 内联模型目录（docs/models.md:60-90）
```

settings：`startup.checkUpdate=false`、`update.auto=false`（默认已关）、`marketplace.autoUpdate=off`（必设）、`web_search.enabled=false`、`fetch.enabled` 按需。

**分发**：内部 npm 镜像 `bun install -g @oh-my-pi/pi-coding-agent`（Bun ≥1.4.4）或离线分发预编译 binary；t3code fork 正常内部构建产物。

### 补丁清单

**无必需补丁。**两侧均为零代码改动。可选观察项（均非阻塞）：

- ACP v1（omp）与 t3code 的 v2 preview 能力差异（usage/plan/compaction 等富消息走不了 v2）——协议层协商自动降级，文档明示支持（`providers-acp.md:8-9`）。
- 若未来要 ADR-0001 式「一等 provider」体验（四值权限映射、truth 表），才回到 `packages/provider-omp` 原生 adapter 路线（`gh issue view 4 -R dioskuroi/t3code-migration`）。

## 未证实

- 未运行 `t3code + omp acp` 实机联调；结论基于两侧源码与上游用户文档。
- registry 磁盘缓存（`~/.t3/caches/acp-registry/registry.json`）离线兜底未实测（内网走 local 形态，不依赖此路径）。
- omp 预编译 binary 的完全自包含性（natives addon 加载细节）未逐版本验证（依据 `auto-update.ts:15-17` 注释推定）。
- t3code 对 local ACP command 的 ACP v1 协商为代码+文档推定（`packages/provider-acp/src/server/adapter.ts:2301` 按 v2 分支、`providers-acp.md:8-9`），未抓包验证。
