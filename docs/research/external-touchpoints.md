# t3code v0.1.12-nightly 外网触点全量清单（票 #134）

基线：pingdotgg/t3code @ 2808e878（v0.1.12-nightly.20261123）。仅列运行时出网触点；纯文档/链接文案（install 提示文本、应用商店链接、i18n 文案）不构成出网，归入「仅提示文本」。后果分级：致命 = 核心流程不可用；功能降级 = 某功能不可用但产品可用；仅报错 = 日志/提示。触发时机：启动 / 定时 / 用户操作 / 按需（懒触发+缓存）。

## 1. Release feed 与自更新

| 触点 | 位置 | 触发时机 | 断网后果 | 可配置性 |
|---|---|---|---|---|
| `api.github.com/repos/pingdotgg/t3code/releases`（CLI `t3 update` 索引） | packages/shared/src/cliRelease.ts:136；调用 apps/server/src/cli/update.ts:82 | 用户操作 | 仅报错 | 否（仓库硬编码 `pingdotgg/t3code`，cliRelease.ts:8） |
| `github.com/.../releases/download/v<ver>/...`（CLI pinned runtime 安装包 + SHA256SUMS） | packages/shared/src/cliRelease.ts:39（默认 base URL）、:56-71 | 按需（SSH runner 首次装 CLI、pinned runtime） | 功能降级（远程环境起不来，本地不受影响） | ✅ `T3CODE_RELEASE_BASE_URL`（cliRelease.ts:11；SSH tunnel 注入 packages/ssh/src/tunnel.ts:496,1150；desktop 透传 apps/desktop/src/shell/DesktopShellEnvironment.ts:127） |
| `api.github.com` + `objects.githubusercontent.com`（desktop 自动更新 feed，app-update.yml 内 GitHub provider；`latest.yml`/blockmap） | apps/desktop/src/electron/ElectronUpdater.ts:105-171；调度 apps/desktop/src/updates/DesktopUpdates.ts:1053-1065 | 启动（延迟）+ 定时（4 小时，DesktopUpdates.ts:65）+ 用户操作 | 仅报错（更新不可用） | ✅ 管理策略 `feedUrl` 覆盖为 generic feed（DesktopUpdates.ts:1307-1313）；❌ env `T3CODE_DISABLE_AUTO_UPDATE` 关闭（apps/desktop/src/app/DesktopConfig.ts:60） |
| `registry.npmjs.org/t3/<spec>`（server 云链路 npm 版本查询） | apps/server/src/cloud/npmRelease.ts:66 | 按需（15s 超时，1 分钟缓存） | 功能降级（云链路安装提示退化） | 否 |
| `registry.npmjs.org`（各 provider CLI 安装/更新走 npm） | apps/server/src/provider/CodexInstallation.ts:39；ClaudeMaintenance.ts:21（mise/npm 路径） | 按需（provider 安装/更新） | 功能降级（可改用本地已装 CLI） | 否（受 npm 自身 env 影响） |
| `t3.codes/install.sh|install.ps1`（提示文本，非 fetch） | apps/server/src/cli/install.ts:57-58；apps/server/src/cloud/servicePreflight.ts:54；packages/ssh/src/tunnel.ts:552 | 仅输出 | 无 | — |

## 2. T3 Connect / relay / 远程控制面

| 触点 | 位置 | 触发时机 | 断网后果 | 可配置性 |
|---|---|---|---|---|
| Relay（WSS/HTTPS，URL 来自 build 常量或 env；产品正式域名随构建注入） | apps/server/src/cloud/publicConfig.ts:109-116（`T3CODE_RELAY_URL`，`__T3CODE_BUILD_RELAY_URL__`）；apps/server/vite.config.ts:155 | 云链路启用后常驻 WS | 致命（对 t3-connect 远程功能）：无法远程接入；本地使用不受影响 | ✅ env `T3CODE_RELAY_URL` 可指向内网 relay |
| Clerk frontend API（由 publishable key 推导，`https://<frontendApi>`） | packages/shared/src/relayAuth.ts:63,76-81；key 来自 `T3CODE_CLERK_PUBLISHABLE_KEY`（vite.config.ts:157） | 登录/token 刷新（CliTokenManager 定时轮换） | 致命（对云账号链路）：CLI login/device 授权不可用；relay JWT 失效后远程断 | ✅ 内网 Clerk 或禁用云链路 |
| Clerk OAuth token/device endpoints `<clerkFrontendApi>/oauth/token`、`/oauth/device_authorization` | apps/server/src/cloud/publicConfig.ts:206-207；apps/server/src/cloud/CliTokenManager.ts:321,404（RFC 8628 device 轮询） | 用户操作（`t3 connect` 授权）/ 定时（token 刷新轮询） | 功能降级→致命（对云链路） | 同上 |
| Hosted app 审批页 `app.t3.codes` / nightly `nightly.app.t3.codes`（agent 登录批准跳转 + 深链回调 origin 白名单） | packages/shared/src/connectAuth.ts:10；apps/server/src/cloud/publicConfig.ts:118-127；packages/shared/src/providerAuthReturnUrl.ts:10 | 用户操作（授权审批） | 功能降级（审批可走 loopback fallback） | ✅ `T3CODE_HOSTED_APP_URL`（publicConfig.ts:129-136） |
| Cloudflared relay client（下载 `github.com/cloudflare/cloudflared/releases/download/2026.10.4/...`） | packages/shared/src/relayClient.ts:107-133,468 | 按需（首次建云隧道，10 分钟超时） | 致命（对 t3-connect 隧道模式） | ✅ `T3CODE_CLOUDFLARED_PATH` 指向本地二进制（relayClient.ts:34）；隧道本身连 Cloudflare 边缘，内网必断 |
| 隧道出网（Cloudflare edge + relay 边缘节点） | apps/server/src/cloud/managedTunnelStartup.ts、ConnectReachability.ts | 云链路启用期间 | 致命（对远程接入） | ❌ 协议固有；应改用内网 relay/SSH |
| `https://<host>/.well-known/t3/environment`（对端可达性探测，host 为用户配置的远端） | apps/server/src/cloud/ConnectReachability.ts:306 | 用户操作（连接前） | 仅报错（对内网远端可达则无感） | host 用户配置 |

## 3. GitHub 集成（source control / PR）

| 触点 | 位置 | 触发时机 | 断网后果 | 可配置性 |
|---|---|---|---|---|
| `api.github.com` REST + `/graphql`（默认；per-instance 可覆盖） | packages/source-control-github/src/server/GitHubRequestPolicy.ts:116 | 用户操作（PR/issue 查看、star 等）+ 事件订阅 | 功能降级（GitHub PR 功能不可用；内网 GHE 用户改 baseURL 即可） | ✅ GHE instance 级配置（代码含 ghe.com/internal 分支逻辑） |
| `github.com` / `raw.githubusercontent.com` / `media.githubusercontent.com` / `objects.githubusercontent.com` / `private-user-images.githubusercontent.com`（PR 媒体拉取，凭据仅对 raw/media 生效） | packages/source-control-github/src/shared/gitHubMedia.ts:6-13 | 用户操作（渲染 PR 图片/附件） | 仅报错（图片裂图） | 否 |
| `user/starred/<repo>`（web 内 star） | packages/source-control-github/src/server/driver.ts:62-64 | 用户操作 | 仅报错 | 否 |
| GH webhook 入站（relay 送达或直达，属入站非出网） | apps/server/src/scheduledTasks/webhookRoute.ts:49 | 外部事件 | 功能降级（事件靠轮询兜底） | — |
| GraphQL webhook 订阅（`gitHubPullRequestEvents`，失败静默转轮询） | packages/source-control-github/src/server/gitHubPullRequestEvents.ts:23,65 | 定时/订阅 | 仅报错 | 否 |
| `api.github.com/repos/BerriAI/litellm/...model_prices...json`（模型价格表） | apps/server/src/usage/UsageService.ts:73-77 | 定时（24h TTL，:302） | 仅报错（成本估算缺失） | 否 |

## 4. 遥测 / 可观测性

| 触点 | 位置 | 触发时机 | 断网后果 | 可配置性 |
|---|---|---|---|---|
| PostHog `https://ingest.t3.codes`（key 硬编码默认） | apps/server/src/telemetry/AnalyticsService.ts:70-74 | 事件批量 flush（批量 20，重试上限 5 分钟退避） | 仅报错（本地缓冲） | ✅ `T3CODE_POSTHOG_HOST`、`T3CODE_POSTHOG_KEY`、`T3CODE_TELEMETRY_ENABLED=false` |
| OTLP traces/metrics/logs（server） | apps/server/src/cli/config.ts:113-125 | 配置了 URL 才导出 | 仅报错 | ✅ `T3CODE_OTLP_TRACES_URL/_METRICS_URL/_LOGS_URL`（默认不配置不出网） |
| Relay 客户端 OTLP tracing（Axiom 等） | apps/server/src/cloud/publicConfig.ts:44-52,89-104；env `T3CODE_RELAY_CLIENT_OTLP_TRACES_URL/_DATASET/_TOKEN`（vite.config.ts:163-171） | relay tracing 开启时 | 仅报错 | ✅ 不配置即关闭（默认关闭） |
| 无 Sentry：仓库运行时代码无 Sentry SDK（grep 仅命中无关文件）；崩溃走桌面端本地日志 | 全库 grep | — | — | — |

## 5. 内置模型 provider / agent runtime 出网

| 触点 | 位置 | 触发时机 | 断网后果 | 可配置性 |
|---|---|---|---|---|
| OpenAI Codex ChatGPT OAuth：`auth.openai.com/.well-known/openid-configuration`、`/oauth/*`；resource `api.openai.com/v1` | apps/server/src/provider/CodexChatGptAuth.ts:39-41,206 | 登录 + 定时 token 刷新 | 致命（对 Codex ChatGPT 登录） | ❌ issuer 校验硬编码（:206） |
| `api.openai.com/v1/models`、`/v1`（token-sharing provider） | apps/server/src/provider/CodexChatGptModels.ts:39；CodexManagedRuntime.ts:26 | 按需/会话 | 致命（对该 provider 推理） | ❌（走内网代理需改此文件） |
| Codex CLI 安装/更新：`registry.npmjs.org/@openai/codex/latest`、`github.com/openai/codex/releases/download/...`、频道 `releases.openai.com/codex/channels/latest` | apps/server/src/provider/CodexInstallation.ts:39-117；Drivers/CodexDriver.ts:106-118 | 按需（安装）/定时（最新版检查） | 功能降级（已装 CLI 继续可用） | 部分（可用系统 PATH 已装 CLI） |
| Claude：`downloads.claude.ai/claude-code-releases`（native 安装/更新）；`api.anthropic.com`（usage/oauth：claudeResetCredits.ts:15、cliproxyApi.ts:317） | apps/server/src/provider/Drivers/ClaudeMaintenance.ts:21；apps/server/src/usage/claudeResetCredits.ts:15 | 按需/定时 | 功能降级/仅报错 | 部分 |
| Antigravity（Google）：`accounts.google.com` OAuth、`oauth2.googleapis.com/token`、`www.googleapis.com/oauth2/v2/userinfo`、`cloudcode-pa.googleapis.com`、`daily-cloudcode-pa.googleapis.com`、`antigravity.google/oauth-callback`、CLI 清单 `antigravity-cli-auto-updater-...run.app`、二进制 `storage.googleapis.com/antigravity-public` | apps/server/src/provider/antigravityAuthSupport.ts:576,592；antigravityUsageLimits.ts:24-25,386-414；antigravityCallback.ts:56；antigravityCliRelease.ts:4,43 | 登录 + 定时配额 | 致命（对该 provider） | ❌ |
| Grok/xAI：`auth.x.ai`、`accounts.x.ai/sign-in`（凭据 key）、`api.x.ai/v1/stt`（语音）、用量 `cli-chat-proxy.grok.com/v1/billing` | packages/provider-grok/src/server/usageLimits.ts:27,157；apps/server/src/speech/CloudSpeech.ts:32 | 会话/登录/定时 | 致命（对 grok provider 推理） | ❌ |
| Cursor：`api.cursor.com`（默认，provider-cursor CursorSdkCatalog.ts:111）、`api2.cursor.sh`（apiKey endpoint，apiKey.ts:7）、Origin CLI 走 `api.cursor.com/v1/origin`、下载 `downloads.cursor.com`（提示文本） | packages/provider-cursor/src/server/*；packages/source-control-cursor-origin/src/server/OriginCli.ts:31 | 会话/定时用量 | 致命（对 cursor provider） | ✅ endpoint 可配置（Config 默认值） |
| OpenCode Zen：`opencode.ai/zen/go/v1/usage`、console 校验 `opencode.ai/console` | packages/provider-opencode/src/server/usageLimits.ts:75,139 | 定时用量 | 仅报错 | 否 |
| fx：`releases.fx.sh/latest.txt`（版本检查） | packages/provider-fx/src/server/maintenance.ts:19 | 定时 | 仅报错 | 否 |
| Muse：`api.meta.ai/muse` | packages/provider-muse（grep 命中） | 会话 | 致命（对该 provider） | ❌ |
| ACP registry：`cdn.agentclientprotocol.com/registry/v1/latest/registry.json`（agent 目录）+ icon SVG | packages/provider-acp-registry/src/server/AcpRegistrySupport.ts:53,684,892-899；icons packages/contracts/src/acpRegistry.ts:13,17 | 按需（磁盘缓存缺失时，driver.ts:824） | 功能降级（ACP registry 目录不可见；**已装 agent 的 ACP 会话不受影响**——omp 接入关键） | ✅ `registryUrl` 入参可覆盖（:684） |
| 模型清单 `raw.githubusercontent.com/pingdotgg/t3code/.../model-manifest.json`（捆绑副本兜底） | apps/server/src/provider/ModelManifest.ts:27-43 | 定时（1h TTL，失败退避 5min） | 仅报错（用内置 model-manifest.json） | 否 |
| 云端语音转写：`api.openai.com/v1/audio/transcriptions`、`api.x.ai/v1/stt`、`openrouter.ai/api/v1/...`、模型列表查询、本地模型 `huggingface.co/<model>/resolve/...` | apps/server/src/speech/CloudSpeech.ts:31-36；SpeechModelStore.ts:300 | 用户操作（语音输入） | 功能降级（该功能不可用） | 部分（provider 选择；huggingface 硬编码） |
| provider 会话推理出网（各 model API） | 各 provider driver | 用户会话 | 致命（对所有云端模型）；本地 ACP agent（omp）不受影响 | 各 provider 配置 |

## 6. CDN / 字体 / 图片 / 杂项

| 触点 | 位置 | 触发时机 | 断网后果 | 可配置性 |
|---|---|---|---|---|
| favicon 服务 `www.google.com/s2/favicons` | packages/shared/src/favicon.ts:81 | 按需（UI 渲染） | 仅报错 | 否 |
| search engine 模板（duckduckgo/google/bing/brave/kagi/ecosia，浏览器预览打开） | packages/shared/src/preview.ts:103-108 | 用户操作 | 仅报错（用户行为） | — |
| headless chrome for testing：`storage.googleapis.com/chrome-for-testing-public/...`（预览浏览器自动装） | apps/server/src/preview/PreviewBrowser.ts:25,88 | 按需（首次） | 功能降级（预览渲染不可用；可预装 Chrome） | 部分 |
| Expo 设备桥：`api.expo.dev/graphql`、`api.expo.dev`（hub origin） | apps/server/src/device/ExpoApi.ts:26；EasDeviceHost.ts:846 | 用户操作（移动设备管理） | 功能降级 | ✅ `EXPO_TOKEN` 相关；URL 硬编码 |
| web 端编辑器/扩展市场 `open-vsx.org` | grep apps/web | 按需 | 仅报错 | 否 |

## 7. 深链 / 移动端 pairing

| 触点 | 位置 | 触发时机 | 断网后果 | 可配置性 |
|---|---|---|---|---|
| `t3code://` 协议（desktop `setAsDefaultProtocolClient`；mobile App.tsx:143） | apps/desktop/src/electron/ElectronApp.ts:202-208 | OS 事件 | 无（本地） | — |
| pairing deep link 解析（`readPairingAppLink`）→ 指向 hosted app `app.t3.codes`/自建 relay | apps/desktop/src/app/DesktopClerk.ts:219；packages/shared/src/remote | 用户操作 | 功能降级（改用内网 relay URL pairing） | ✅ `T3CODE_HOSTED_APP_URL`/`T3CODE_RELAY_URL` |
| mobile：relay URL 来自 cloud public config（`resolveCloudPublicConfig().relay.url`，fallback `http://relay.invalid`） | apps/mobile/src/lib/runtime.ts:19 | 启动 | 致命（连不上 server 时）；直连内网 server 可用 | ✅ 构建期 `EXPO_PUBLIC_*`（app.config.ts） |
| mobile OTA 更新 `u.expo.dev/...`、OTLP `api.axiom.co/v1/traces`（默认）、Clerk `clerk.t3.codes` | apps/mobile/app.config.ts:250,488,86-102 | 启动/定时 | 仅报错/功能降级 | ✅ `EXPO_PUBLIC_OTLP_TRACES_URL`；OTA 可禁 |
| showcase 演示环境（`*.t3.sh`、`*.ts.net`） | apps/mobile/src/features/showcase/showcaseEnvironmentRows.ts:7-45 | 用户操作（演示） | 仅报错 | — |

## 8. 其他 server 出网点

| 触点 | 位置 | 触发时机 | 断网后果 | 可配置性 |
|---|---|---|---|---|
| Triage/playbook 抓取（提示词让 agent fetch `raw.githubusercontent.com/pingdotgg/t3code/.../PLAYBOOK.md`） | apps/server/src/triage/triagePrompt.ts:37 | 用户操作（triage 命令） | 功能降级（agent fetch 失败） | 否 |
| Linear API `api.linear.app/graphql` | packages/issue-tracker-linear/src/server/LinearApi.ts:57 | 用户操作 | 功能降级 | ✅ instance URL 可配 |
| Tailscale：`login.tailscale.com/admin/dns`（提示文本）、controlplane（本机 tailscaled 出网，非本产品进程） | packages/tailscale/src/tailscale.ts:462；apps/server/src/cli/pair.ts:124 | 用户操作（serve/pair） | 功能降级 | — |
| marketing（apps/marketing）构建期/SSR 抓 `api.github.com`（releases/stats） | apps/marketing/src/lib/releases.ts:6-8；stats.ts:5 | 部署构建期，非客户端运行时 | 无（内网不需部署该站） | — |
| agent 抓取任意用户指定 URL（fetch/web 工具） | server 通用 HTTP 出站 apps/server/src/outboundHttp.ts | 用户会话 | 功能降级 | 由模型/用户控制 |

## 结论（迁移要点）

1. **对 omp/ACP 内网场景致命且必须处理的**：① 模型 provider 云端 API（不用云端 provider 即无影响）；② Clerk/relay/hosted app（完全绕过：不启用云链路即可，`T3CODE_RELAY_URL`/`T3CODE_HOSTED_APP_URL` 均有 env 出口）；③ cloudflared 下载与 Cloudflare 边缘（`T3CODE_CLOUDFLARED_PATH` 或禁用 t3-connect，改 SSH/内网 relay）；④ ACP registry（硬编码 CDN，driver 支持 `registryUrl` 覆盖——但无 env 开关，需补丁或放任缓存降级）。
2. **自动降级、内网可忽略**：PostHog、OTLP（默认关）、model-manifest（捆绑副本）、litellm 价格表、desktop 更新（可 `T3CODE_DISABLE_AUTO_UPDATE`+`feedUrl`）、provider 版本检查、favicons。
3. **已有 env 出口清单**：`T3CODE_RELEASE_BASE_URL`、`T3CODE_RELAY_URL`、`T3CODE_HOSTED_APP_URL`、`T3CODE_DISABLE_AUTO_UPDATE`、`T3CODE_POSTHOG_HOST/KEY`、`T3CODE_TELEMETRY_ENABLED`、`T3CODE_OTLP_*_URL`、`T3CODE_RELAY_CLIENT_OTLP_TRACES_*`、`T3CODE_CLOUDFLARED_PATH`、`T3CODE_DISABLE_AUTO_UPDATE`；构建期 `T3CODE_CLERK_PUBLISHABLE_KEY`、`T3CODE_CLERK_CLI_OAUTH_CLIENT_ID`（apps/server/vite.config.ts:153-171）。
4. **无 env 出口、内网需补丁的点**：ACP registry CDN（AcpRegistrySupport.ts:53）、Codex ChatGPT issuer 白名单（CodexChatGptAuth.ts:206）、各 provider API 硬编码 base URL（grok/cursor 部分 endpoint 可配）、`pingdotgg/t3code` 仓库名常量（cliRelease.ts:8、desktopUpdate.logic.ts:15、DesktopStartupRecovery.ts:23、mobile remoteRegistration）、favicon 服务（favicon.ts:81）、huggingface 语音模型（SpeechModelStore.ts:300）。
5. desktop `session.webRequest.onBeforeSendHeaders` 拦截点仅做 header 清洗/改写（apps/desktop/src/window/RemoteRequestHeaders.ts:116-127、preview/BrowserSession.ts:683），**无全局域名封锁层**——内网版需自加 deny 策略或依赖断网自然失败。

未证实：mobile 端 Clerk `clerk.t3.codes` 具体请求路径（app.config.ts:86-102 仅见 relyingParty 配置）；`latest.app.t3.codes` 的消费方（grep 仅 1 处命中，未追）。