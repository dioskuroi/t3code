# 调研：t3code 登录链路与未登录可用面（票 #133）

基线：`intranet/base` @ `v0.1.12-nightly.20261123.5124`（上游 pingdotgg/t3code）。以下路径均相对仓库根；行号来自该检出。

## 0. 结论速览

t3code 存在**两条互相独立的鉴权链**：

- **链 A（本地机器链，与 Clerk 无关）**：桌面 app 生成本地随机 secret → 派生时间窗 HMAC bootstrap token → t3 server（boot service）`/oauth/token` token-exchange 换 bearer/browser 会话。UI、CLI、boot service 的全部本地功能走这条链。
- **链 B（Tern 云账号链 = Clerk）**：仅服务 t3-connect 云中继、移动端云连接、approve-agent / CLI OAuth 审批页、`t3 connect` CLI 登录。所有入口都条件化于 3 个构建期/env 值，缺省即整体不加载。

**判定：未登录状态下 t3code 能本地跑通 provider 会话 —— 能。** 本地功能与 Clerk 零耦合（证据见 §2–§5）；provider（模型厂商）会话由 provider 链另行管理，不经过 Clerk。

**深度屏蔽登录：可行（低风险）**，且有现成降级路径：构建时留空 `T3CODE_RELAY_URL` / `T3CODE_CLERK_PUBLISHABLE_KEY` / `T3CODE_CLERK_CLI_OAUTH_CLIENT_ID` 三个值即可让 Clerk 完全不挂载；彻底移除代码路径的补丁点见 §6。

## 1. 两条链的总览

### 链 A：本地 bootstrap → server 会话

1. 桌面 app 为本地 backend 生成随机 32 字节 secret：`apps/desktop/src/backend/DesktopBackendConfiguration.ts:776-790`（`SecureRandom`，经信号量串行化）。
2. secret 派生时间窗 HMAC token（12h 窗口，接受前/当前/后一窗，容 WSL 时钟偏差）：`packages/shared/src/desktopBootstrapToken.ts:12-27`。
3. server 端把该 token seed 成 bootstrap grant：`apps/server/src/auth/PairingGrantStore.ts:410-427`（`isValidDesktopBootstrapToken` 校验；`config.desktopBootstrapToken && desktopBootstrapSecret === undefined` 分支）。
4. 桌面主进程用 token 换 bearer 会话：`apps/desktop/src/backend/DesktopLocalEnvironmentAuth.ts:64-130` → `bootstrapRemoteBearerSession`（`packages/client-runtime/src/authorization/remote.ts:147-166`，POST `/oauth/token`，`grant_type=AuthTokenExchangeGrantType`，`subject_token_type=AuthEnvironmentBootstrapTokenType`）。
5. 渲染层经 preload IPC 拿 bootstrap token 换 cookie 会话：`apps/desktop/src/ipc/methods/window.ts:151-195`（`getLocalEnvironmentBootstraps`，优先用「当前窗口派生 token」）→ `apps/desktop/src/preload.ts:150-155` → `apps/web/src/environments/primary/auth.ts:175-179`（`getDesktopBootstrapCredential`）→ `exchangeBootstrapCredential`（auth.ts:232-250）。
6. 浏览器（非桌面）访问时从 URL pairing token 引导：`apps/web/src/environments/primary/auth.ts:161-176`（`peekPairingTokenFromUrl` / `takePairingTokenFromUrl`，`@t3tools/shared/remote`）。

### 链 B：Clerk（Tern 账号 / t3-connect）

- web/桌面渲染层：ClerkProvider 内 `useAuth().getToken` 取 Clerk token，喂给 relay 认证：`apps/web/src/cloud/managedAuth.tsx:37-39`（`clerk.session.getToken(resolveRelayClerkTokenOptions())`）、`:64`（`activateManagedRelayAuthentication`）、`:70-72`（`managedRelayAccountService.attach(clerk)`）。
- CLI：`t3 connect` 走 Clerk Frontend API 的 OAuth device authorization grant：`apps/server/src/cli/connect.ts:92-135`（`CliTokenManager.deviceAuthorizationLogin`）；token 存本地 secrets（`apps/server/src/cloud/CliTokenManager.ts:484-489` `secrets.set(CLOUD_CLI_OAUTH_TOKEN_SECRET, …)`），用 refresh_token grant 刷新（`:500-509`）。
- server→云中继：`apps/server/src/cloud/CloudLink.ts:851-906` 用 CLI token 以 `HttpClientRequest.bearerToken` 访问 relay；`:1263-1283` 关停时释放。
- 端点全部由 publishable key 推导：`packages/shared/src/relayAuth.ts:30-74`（`parseClerkFrontendApi`，base64 解码出 Frontend API host）。

## 2. Clerk 集成点清单（各端）

### 桌面主进程（Electron main）

| 集成点 | 位置 |
|---|---|
| Clerk bridge 创建（`createClerkBridge`，`@clerk/electron`） | `apps/desktop/src/app/DesktopClerk.ts:1`、`:77-89` |
| publishable key 构建期注入 define | `apps/desktop/vite.config.ts:24-25`（`repoEnv.T3CODE_CLERK_PUBLISHABLE_KEY`，空串缺省）；消费于 `DesktopClerk.ts:44-47,82-85` |
| Clerk token 文件存储（0700 目录 / 0600 文件，symlink 防护、legacy 迁移） | `apps/desktop/src/app/ClerkTokenStore.ts:5-9,26-59` |
| bridge 生命周期（必须在 Electron ready 前创建，注册 scheme） | `DesktopClerk.ts:124-152`（`Effect.acquireRelease`，注释「the bridge registers a scheme Electron rejects once ready」） |
| userData path 提前解析 + 单实例锁（Clerk bridge 启动序的一部分） | `DesktopClerk.ts:126-141`（`resolveUserDataPath`→`setPath`、`requestSingleInstanceLock`） |
| `clerk.configure` 启动调用 | `apps/desktop/src/app/DesktopApp.ts:392` |
| layer 装配（bridge 层为 runtime 底座） | `apps/desktop/src/main.ts:236-254`（`layerDesktopClerk` → `layerDesktopRuntime`） |
| CSP 追加 Clerk Frontend API origin（key 缺省则不加）；`challenges.cloudflare.com` 无条件在 script-src | `apps/desktop/src/electron/ElectronProtocol.ts:70-78` |
| passkeys bridge（`passkeys: true`，`@clerk/electron-passkeys`） | `DesktopClerk.ts:85`；`apps/desktop/package.json:15` |
| preload 暴露 Clerk bridge | `apps/desktop/src/preload.ts:11`（`exposeClerkBridge`） |

注意：`t3code://` deep link 路由（provider auth handoff、pairing/prompt link）在 `DesktopClerk.configure` 内实现（`DesktopClerk.ts:168-238`），但它调用的是 app 自身模块（CodexAuthCallback / DesktopWebLinks / `readPairingAppLink`），并非 Clerk 功能——移除 Clerk 时这部分逻辑要保留。

### 桌面渲染层（= apps/web 构建，`t3code://app`）

- `ElectronManagedAuthShell`：`ClerkProvider`（`@clerk/electron/react`）+ passkeys + `ManagedRelayAuthProvider`：`apps/web/src/components/clerk/ElectronManagedAuthShell.tsx:1-23`。
- **条件挂载**：`apps/web/src/main.tsx:23-26` —— 仅当 `VITE_CLERK_PUBLISHABLE_KEY && hasCloudPublicConfig()` 才动态 import Clerk shell，否则直接渲染 app（`:38-43`）。
- `hasCloudPublicConfig` 三条件：`apps/web/src/cloud/publicConfig.ts:88-93`（relay URL + Clerk key + CLI OAuth client id，均为 env/构建 define）。server 侧同源定义：`apps/server/src/cloud/publicConfig.ts:219-225`。

### Web 浏览器端

- `BrowserManagedAuthShell`：`ClerkProvider`（`@clerk/react`），注释「Lazy-load Clerk so cloudless local mode never downloads it」：`apps/web/src/components/clerk/BrowserManagedAuthShell.tsx:7-20`。
- clerk-js / @clerk/react 依赖：`apps/web/package.json:23-25`（`@clerk/clerk-js`、`@clerk/electron`、`@clerk/react`）。
- web 构建注入 `VITE_CLERK_PUBLISHABLE_KEY`：`apps/web/vite.config.ts:40`。

### t3 server（boot service / CLI 后端）

- **鉴权链路无 Clerk**：server 全部请求走 `EnvironmentAuth`（见 §3）。Clerk 相关只有两处外围：
  - 构建 define + CLI OAuth 端点配置：`apps/server/src/cloud/publicConfig.ts:41-44,120-137`（`makeCloudCliOAuthConfig` 从 publishable key 推导 `tokenEndpoint`/`deviceAuthorizationEndpoint`）；
  - `t3 connect` 的 token 管理：`apps/server/src/cloud/CliTokenManager.ts:34,440,501`。
- `apps/server/package.json` 无任何 `@clerk` 依赖（grep 全量确认）。

### 移动端（内网迁移范围外，仅记录）

- `ClerkProvider`（`@clerk/expo`，tokenCache）：`apps/mobile/src/features/cloud/CloudAuthProvider.tsx:1,28-30`；依赖 `apps/mobile/package.json:57-58`。

## 3. auth session 的存储与校验

### 本地 server 会话（链 A）

- 持久化：sqlite `AuthSessions` 表：`apps/server/src/auth/SessionStore.ts:27`（`persistence/AuthSessions.ts`）。
- **每个 HTTP 请求强制鉴权**：`apps/server/src/auth/EnvironmentAuth.ts:870-923`（`authenticateRequest`）：无 credential → `ServerAuthMissingCredentialError`（`:876-878`）；cookie 凭证要求 origin 白名单（`:877-890`，`DESKTOP_RENDERER_ORIGINS`/devUrl）；DPoP 绑定 token 需 proof（`:892-916`）。
- raw 路由同样强制：`apps/server/src/http.ts:355-373`（`authenticateRawRouteWithScope`）。
- WS upgrade：ticket 校验 + 可选 DPoP proof：`EnvironmentAuth.ts:1534-1593`（`authenticateWebSocketUpgrade`）。
- 会话态查询失败时返回 `{authenticated:false}` 而非崩：`EnvironmentAuth.ts:928-951`（`getSessionState`）。
- 浏览器会话签发：pairing/bootstrap credential 一次性消费 → cookie 会话：`EnvironmentAuth.ts:953-1030`（`createBrowserSession`，`bootstrapCredentials.consume`）。
- WS 短期 ticket、DPoP：`apps/server/src/auth/dpop.ts`、`EnvironmentAuth.ts`（`AuthWebSocketTicketResult`）。

### Clerk 会话（链 B）

- 桌面：`clerk-tokens.json`（state dir 下 `clerk/`，0600）：`ClerkTokenStore.ts:5-9`。
- web：clerk-js 自管（内存 + Clerk 域 cookie），无本地落盘。
- CLI 云 token：`ServerSecretStore`（secrets dir）：`CliTokenManager.ts:479-489`。
- mobile：`@clerk/expo` tokenCache：`CloudAuthProvider.tsx:28-30`。

## 4. boot service / t3 server 请求是否强制鉴权

**强制**，但凭证是本地派生的，与登录无关：

- server 对 HTTP/WS 一律要求 credential（§3 引用）；无匿名模式。
- 桌面启动 backend 时以 desktop 模式注入 bootstrap token：`apps/server/src/cli/server.ts:52-57`（`config.mode !== "desktop" || config.desktopBootstrapToken === undefined` 分支 + `awaitLauncherLoss`）。
- 暴露模式（local-only / network-accessible）只改绑定面，不改鉴权要求：`apps/desktop/src/app/DesktopApp.ts:266-276`（`serverExposure.configureFromSettings`）；网络暴露下浏览器仍需 pairing token 换会话（§1 第 6 步）。
- dev/web 模式的免交互路径是 `T3CODE_DEV_AUTH_TOKEN` 派生的可复用 dev 会话：`apps/server/src/auth/ReusableDevAuth.ts:14-45`（与 Clerk 无关）。

## 5. 未登录时 UI 与 CLI 的降级行为

### UI（web/桌面渲染层）

- 云配置缺失（内网 fork 构建的自然状态）：Clerk **完全不挂载**、clerk-js 不下载（`main.tsx:23-26` + `BrowserManagedAuthShell.tsx:7` 注释）；侧栏「Sign in to T3 Connect」按钮与头像直接返回 null：`apps/web/src/components/clerk/T3ConnectSidebarSignIn.tsx:12,18`；欢迎页手机步骤隐藏：`apps/web/src/components/onboarding/WelcomePage.tsx:147-152`（`welcomeOffersPhone({cloud: hasCloudPublicConfig(), …})`）；HostedEmptyState 显示本地 PairingSteps 而非 T3ConnectSteps：`apps/web/src/components/HostedEmptyState.tsx:24,46,60`；`t3 up` 云路由为 null（§5 CLI）。
- 有云配置但 Clerk 加载失败（断网）：`useClerk().status === "error"` → 登录钮变「Retry T3 Connect」，点它仅 reload 页面；本地功能不受影响：`apps/web/src/components/clerk/clerkLoadFailure.ts:3-10`、`T3ConnectSidebarSignIn.tsx:54-68`。
- 全量 `isSignedIn` 消费点仅云功能组件：`useCloudLinkController.ts:57`、`HostedEmptyState.tsx:71`、`ApproveAgentSurface.tsx:93`、`ConnectCliAuthSurface.tsx:29`、`T3ConnectSidebarSignIn.tsx:24,54`、`WelcomePage.tsx:1038`（PhoneConnectLink）、`LabsSettingsPanel.tsx:3`（注释「Clerk is only mounted when this build has T3 Connect」，`:31`）、`UseInAnotherAppDialog.tsx:2`、`T3ConnectAccountPages.tsx:42`、`SavedEnvironmentRows.tsx:57,73`。**没有任何本地聊天/终端/项目功能消费登录态。**
- 本地访问的未认证兜底是 **pairing 页**而非登录页：`apps/web/src/routes/__root.tsx:93-107`（`resolveInitialServerAuthGateState` → `requires-auth`）+ `apps/web/src/routes/pair.tsx:35-54`；`/guest` 路由供嵌入场景：`apps/web/src/guestPage.ts:2-5`、`apps/web/src/routes/guest.tsx:5-7`。

### CLI

- 全本地命令（`t3 server` / `t3 pair` / `t3 auth` / `t3 up`(lan)）：不触 Clerk。`t3 auth` 直接操作本地 EnvironmentAuth/state：`apps/server/src/cli/auth.ts:20-47`；`t3 pair` 打印本地 pairing URL + `t3code://` app link + QR：`apps/server/src/cli/pair.ts:217-228`。
- `t3 connect`：需要 Clerk device OAuth（无 TTY 时打印 verification URL + code 等审批）：`apps/server/src/cli/connect.ts:71-135`；云配置缺失时 `cloudCliOAuthConfig` 从空 key 推导 Frontend API 失败而报 ConfigError 退出：`apps/server/src/cloud/publicConfig.ts:129-137`（`clerkFrontendApiUrlFromPublishableKey` 抛错路径）+ `CliTokenManager.ts:440`。【后段为代码路径推断，未实测运行】
- `t3 up`：`connect` 路由仅在 `hasCloudPublicConfig` 时启用，否则为 null（自动降级 LAN）：`apps/server/src/cli/up.ts:82-90`。

### t3-connect / 远程 pairing / 移动端对登录的依赖

- **t3-connect（云中继）= 硬依赖登录**：web 侧需 Clerk `getToken` + `isSignedIn`（`useCloudLinkController.ts:57,255`）link 环境；CLI 侧需 device OAuth token（`CloudLink.ts:851-906,1263-1283`）；服务器到 relay 的隧道凭 link 时发的凭证。
- **远程 pairing 不依赖登录**：`t3 pair` 签发一次性 pairing token → `/pair#token=…` 或 `t3code://pair?…` QR/app link（`packages/shared/src/remote.ts:192-196`、`pair.ts:217-228`）；Tailscale HTTPS 底座也是本地能力（`pair.ts:397` `resolveTailscalePairingBase`，`ensureTailscaleServe`）。
- **移动端**：`t3code://` deep link + 扫 QR 配对可免登录连到一台机器（`apps/mobile/src/App.tsx:143`；`apps/mobile/src/features/connection/ConnectionsNewRouteScreen.tsx:151` QR→pairingUrl；`apps/mobile/src/connection/onboarding.ts:19-23`）；云环境列表则需 Clerk 登录（`ConnectionsNewRouteScreen.tsx:393-407` isSignedIn 分支）。移动端整体是云优先产品，内网迁移建议直接排除。
- **approve-agent / connect-agent 托管页**（app.t3.codes / nightly.app.t3.codes）：未登录强制弹 sign-in：`apps/web/src/components/auth/ApproveAgentSurface.tsx:93-107,142-155`；CLI OAuth 审批页同理：`apps/web/src/components/cloud/ConnectCliAuthSurface.tsx:29,52-65`。仅云端审批流使用。

## 6. 「深度屏蔽登录」可行性评估：可行（低风险）

**可行性依据**

1. 本地功能零耦合：桌面 app、boot service、CLI server/pair/auth、provider 会话均走链 A，不 import 任何 Clerk 符号（§2 server 无依赖；桌面仅 `DesktopClerk.ts` + `preload.ts:11`；web 集中在 §5 列表）。
2. 入口已条件化：Clerk 挂载与所有登录入口都以 `hasCloudPublicConfig`（3 个构建值）为开关（§2、§5 引用）——**配置级屏蔽 = 构建时留空 `T3CODE_RELAY_URL`、`T3CODE_CLERK_PUBLISHABLE_KEY`、`T3CODE_CLERK_CLI_OAUTH_CLIENT_ID`**，代价为零、行为即「无云模式」（上游注释自证：`BrowserManagedAuthShell.tsx:7`、`LabsSettingsPanel.tsx:31`）。
3. 未认证 UI 兜底是 pairing 页（§5），不需要登录墙改造。

**深度移除（删代码而非留空配置）的补丁点清单**

| # | 补丁点 | 动作 |
|---|---|---|
| 1 | `apps/web/src/main.tsx:23-26,38-43` | 删 Clerk shell 分支，恒渲染 app |
| 2 | `apps/web/src/components/clerk/*`（12 文件）及其消费方 | 整目录删除；消费方：`SettingsSidebarNav.tsx:81-89,439`、`WelcomePage.tsx`（PhoneConnectLink）、`HostedEmptyState.tsx`、`ApproveAgentSurface.tsx`、`ConnectCliAuthSurface.tsx`、`ConnectOnboardingDialog.tsx`、`UseInAnotherAppDialog.tsx`、`LabsSettingsPanel.tsx`、`SavedEnvironmentRows.tsx`、`useCloudLinkController.ts` |
| 3 | `apps/web/src/cloud/managedAuth.tsx` + `ManagedRelayAuthProvider` 链 | 与 relay 一并移除（属 ExternalTouchpoints 范围） |
| 4 | `apps/desktop/src/app/DesktopClerk.ts` + `main.ts:236-254` + `DesktopApp.ts:392` + `ElectronProtocol.ts:57,70-78` | 删 bridge；**必须保留**：userData 提前解析与单实例锁（`DesktopClerk.ts:126-141`，移入 ElectronApp 启动序）、scheme privilege 注册（已独立于 Clerk：`ElectronProtocol.ts:112-134`）、`configure` 内的 open-url/second-instance 路由（provider handoff + pairing link，`DesktopClerk.ts:168-238`，搬至 app 层） |
| 5 | `apps/desktop/src/app/ClerkTokenStore.ts`、`preload.ts:11` | 随 bridge 删除 |
| 6 | `apps/server/src/cloud/publicConfig.ts:41-44,120-137,219-225`、`cloud/CliTokenManager.ts`、`cli/connect.ts`、`cli/up.ts` 云路由、`CloudLink.ts` | t3-connect 云链整体移除（与 relay/t3-connect 票协同） |
| 7 | CSP：`ElectronProtocol.ts:78` `challenges.cloudflare.com` | 深度屏蔽时从 script-src 移除，收敛外联 |
| 8 | `apps/mobile/*` Clerk（`CloudAuthProvider.tsx` 等） | 内网范围外，建议整端排除 |

**风险与未证实项**

- 移除 bridge 后把 `setPath("userData")` / `requestSingleInstanceLock` 搬回主流程的等价性未实测（macOS 上 Clerk bridge 跳过 profile lock 的行为见 `DesktopClerk.ts:128-134` 注释）——需在打补丁后以桌面冒烟验证。
- passkeys bridge（`DesktopClerk.ts:85`、`ElectronManagedAuthShell.tsx:2`）若本地 provider 登录用到 WebAuthn 是否受影响：**未证实**（本地 provider 走 API-key/OAuth 链，初步判断无关）。
- `t3 connect` 在云配置缺失时的具体报错文案/退出码未实测运行（§5 代码路径推断）。
- 降级路线（若保留代码只做配置屏蔽）：断网时 Clerk 加载失败仅把登录钮变为「Retry T3 Connect」（`clerkLoadFailure.ts:3-10`），无崩溃路径；web 构建仍含 clerk-js 体积成本与 CSP 的 cloudflare 域，深度屏蔽可一并去除。

## 7. 明确判定（验收项）

**未登录（无任何 Clerk 会话、断外网）状态下，t3code 桌面 app / boot service / CLI 能完整本地跑通，包括 provider 会话。** 依据：本地鉴权凭证由本机 secret 派生（`desktopBootstrapToken.ts:12-27`、`DesktopBackendConfiguration.ts:776-790`），server 每请求校验的是该凭证（`EnvironmentAuth.ts:870-923`），桌面/渲染层自动完成交换（`DesktopLocalEnvironmentAuth.ts:64-130`、`auth.ts:175-250`）；全 UI/CLI 的登录态消费点仅存在于 t3-connect 云功能（§5 清单），无任何本地功能门控。
