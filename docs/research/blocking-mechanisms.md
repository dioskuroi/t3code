# 调研：屏蔽机制与最小补丁面（票 #135）

基线：pingdotgg/t3code nightly `v0.1.12-nightly.20261123.5124`（commit `2808e878`），即本仓库 `intranet/base`。
所有行号均出自该基线。外网触点全量清单由票 #134 负责，本文只在需要分类处引用；其 findings 未到位，见 §6 占位。

## 0. 结论摘要

- 上游为「管理员管控」内建了一条完整的 managed policy 链：`limits.updates.mode="off"` / `feedUrl`（更新改指内网镜像）、`limits.telemetry=false`、`limits.connect=false`、`limits.previewTunnel=false`、`limits.webhookTasks=false`、`limits.browserCookieImport=false`，策略文件读不到时更新**fail-closed**（关闭）。桌面端与 server 端都读同一策略文件。
- 更新链（桌面 electron-updater + CLI pinned runtime）可**零补丁**改指内网：policy `feedUrl` 覆盖 GitHub feed；`T3CODE_RELEASE_BASE_URL` 覆盖 release 资产下载；CLI 版本索引在 policy 镜像存在时读镜像 feed 文件而非 `api.github.com`。
- 登录 / Connect 链是**构建期开关**：relay URL、Clerk key、OAuth client id 三者缺一即 `hasCloudPublicConfig=false`，登录与 Connect UI/后端自动停用；feature flag `github_app_client_id` 不设即关 GitHub App 登录。
- 遥测链可**零补丁**关闭：`T3CODE_TELEMETRY_ENABLED=false`（env，默认 true）或 policy `limits.telemetry=false`（只能关不能开）；OTel 导出默认关。
- **必须补丁**的硬编码外网点只有 3 处（triage 克隆源、模型价格表、ACP registry CDN），均为低频/用户触发、断网后优雅降级；最小补丁面估计 **3 个文件、每个 ≤10 行**（§3.3）。
- 「离线安装 pinned runtime」在现基线上有一等公民语义：`<home>/runtime/versions/<version>/t3` + `.install-complete` sentinel，sentinel 版本匹配即**完全不联网**（§5），离线方案 = 按上游自己的 sentinel 语义预置目录，不搬旧种子脚本。

## 1. 官方机制盘点

### 1.1 托管策略文件（managed policy，最强机制）

策略文件查找路径（`packages/shared/src/managedPolicyFile.ts`）：

- macOS: `/Library/Application Support/T3Code/policy.json`（:39），另有 MCX `/Library/Managed Preferences/com.t3tools.t3code.plist`（:99）
- Windows: `C:\Program Files\T3Code\policy.json`（:43），注册表 `HKLM\SOFTWARE\Policies\T3Tools\T3Code`（:100）
- Linux: `/etc/t3code/policy.json`（:45）

读取入口 `readManagedPolicy`（managedPolicyFile.ts:587）；server 端启动时读一次（`apps/server/src/policy/ManagedPolicy.ts:2-25`），桌面端读一次且**读不到即 fail-closed**：策略不可用 → `mode:"off"`、`allowNightly:false` 并提示用户（`apps/desktop/src/updates/DesktopUpdatePolicy.ts:65-77`）。

文档 schema（`packages/contracts/src/managedPolicy.ts`，`ManagedPolicyDocument` :126-134，**多余键会被拒绝**，:122-125 注释）：

| 键 | 效果 | 证据 |
|---|---|---|
| `limits.updates.mode:"off"` | 永不检查更新（MDM 场景） | managedPolicy.ts:46-48 + 注释 :50-52；桌面禁用原因 DesktopUpdates.ts:354-356 |
| `limits.updates.feedUrl` | 通用 electron-updater feed（「instead of GitHub」，managedPolicy.ts:58） | 桌面 `setFeedURL` 覆盖内置 GitHub feed：DesktopUpdates.ts:1307-1313；CLI 镜像解析 apps/server/src/policy/managedUpdates.ts:12-18 |
| `limits.updates.allowNightly:false` | 禁 nightly 通道 | managedPolicy.ts:59-60；拒绝逻辑 apps/server/src/policy/managedUpdates.ts:29-31 |
| `limits.telemetry:false` | 关产品分析（只能关不能开） | managedPolicy.ts:83-84 + 注释；server 执行点 apps/server/src/telemetry/AnalyticsService.ts:126-131 |
| `limits.connect:false` | 关 T3 Connect（远程接入） | managedPolicy.ts:79（summary :96）；执行 apps/server/src/policy/managedLimits.ts:2-12 |
| `limits.previewTunnel:false` | 关预览隧道 | managedPolicy.ts:85-87 |
| `limits.webhookTasks:false` | 关 webhook 任务 | managedPolicy.ts:82 |
| `limits.browserCookieImport:false` | 关浏览器 cookie 导入 | managedPolicy.ts:85 附近（ManagedPolicyLimits :80-90） |
| `limits.clients` | 限制可接入客户端类型 | managedPolicy.ts:94-96 |
| `settings.<dotPath>` / `providers.*` | 锁定 server 设置 / 驱动实例 | managedPolicy.ts:13-17, 26-33 |

CLI 更新在策略镜像下的完整行为：`t3 update` 目标版本从镜像 feed 文件解析（apps/server/src/cli/update.ts:372, :390-395, :110-127），归档与校验和从镜像下载（update.ts:510），且此时**要求远端发布存在**（`requirePublishedRelease`，update.ts:511）；`mode:"off"` 直接拒绝（update.ts:377-382）。

### 1.2 环境变量

| env | 作用 | 证据 |
|---|---|---|
| `T3CODE_RELEASE_BASE_URL` | release 资产下载镜像（GitHub 布局 `<base>/v<version>/<file>`，**不含**版本索引 API） | 常量 packages/shared/src/cliRelease.ts:9；默认值 :44-45；下载 URL :47-66。消费点：boot service 安装 apps/server/src/cloud/bootService.ts:821-823, :1295；CLI 更新 update.ts:510；server 自更新 apps/server/src/cloud/selfUpdate.ts:148-151；SSH 远端安装 packages/ssh/src/tunnel.ts:1142, :1150（错误提示 :552 明说该 env 选镜像）；桌面→SSH 传递 apps/desktop/src/ssh/DesktopSshEnvironment.ts:93-96。桌面/WSL 会把它注入后端：apps/desktop/src/shell/DesktopShellEnvironment.ts:127, :558；apps/desktop/src/backend/DesktopBackendConfiguration.ts（WSL 转发表） |
| `T3CODE_DISABLE_AUTO_UPDATE` | 桌面自动更新禁用 | apps/desktop/src/app/DesktopConfig.ts:60；生效 DesktopUpdates.ts:359-362, :491 |
| `T3CODE_TELEMETRY_ENABLED` | PostHog 产品分析开关（默认 **true**） | apps/server/src/telemetry/AnalyticsService.ts:74, :135-141；策略可覆盖（:126-131） |
| `T3CODE_POSTHOG_HOST` / `T3CODE_POSTHOG_KEY` | 分析后端改指（默认 `https://ingest.t3.codes` + 内置 key） | AnalyticsService.ts:68-72, :206, :231 |
| `T3CODE_FEATURE_FLAGS` | 逗号分隔 feature flag 列表 | packages/shared/src/FeatureFlags.ts:13-19, :54 |
| `T3CODE_RELAY_URL` | Connect relay 改指（须 https）；不设且无构建期值 → Connect 配置缺失即停用 | apps/server/src/cloud/publicConfig.ts:104-111; CloudLink 前置 `requireRelayUrl` apps/server/src/cloud/CloudLink.ts:301-305 |
| `T3CODE_HOSTED_APP_URL` | 批准页/hosted app 改指（可指 http loopback） | publicConfig.ts:113-126 |
| `T3CODE_CLERK_PUBLISHABLE_KEY` / `T3CODE_CLERK_CLI_OAUTH_CLIENT_ID` | 登录 IdP 改指 | publicConfig.ts:183-189 |
| `T3CODE_RELAY_CLIENT_OTLP_TRACES_URL/_DATASET/_TOKEN` | relay 追踪改指（默认关） | publicConfig.ts:88-102（`isRelayTracingEnabled` 不满足即 null） |
| `T3CODE_OTEL_SDK_DISABLED` / `OTEL_SDK_DISABLED` | 关 OTel 导出 | packages/shared/src/otelEnvironment.ts:256-267, :285 |
| `T3CODE_DESKTOP_UPDATE_REPOSITORY` | 构建期：electron-builder publish 的 GitHub 仓库改指（缺省回退 `GITHUB_REPOSITORY`） | scripts/build-desktop-artifact.ts:2734-2759 |

### 1.3 构建期开关（fork 构建流水线即可用，非源码补丁）

- 桌面更新 feed 是构建时烘进 `app-update.yml` 的：`publish` 来自 `T3CODE_DESKTOP_UPDATE_REPOSITORY`/`GITHUB_REPOSITORY`，**两者都不给且非 mock/nightly 时 `publish=null`** → 无 feed 烘入 → 运行时「no update feed is configured」自动禁更（scripts/build-desktop-artifact.ts:2734-2759, :2851-2860；运行时判定 DesktopUpdates.ts:474-477, :354-356）。
- 登录/Connect 三件套（relay URL、Clerk key、client id）同为构建期注入（`__T3CODE_BUILD_*__`，publicConfig.ts:23-29, :57-78）。三缺一 → `hasCloudPublicConfig=false`（server: publicConfig.ts:221-225；web 渲染层同样三缺一即关：apps/web/src/cloud/publicConfig.ts:45-48, :88-94）→ 登录与 Connect 面自然消失。桌面 CSP 里 Clerk origin 与 challenges.cloudflare.com 仅在设置了 key 时注入 script-src（apps/desktop/src/electron/ElectronProtocol.ts:70-78）；`DesktopClerk` 主机名来自构建期 key（apps/desktop/src/app/DesktopClerk.ts:84-89）。

### 1.4 settings（用户设置）

- 桌面 `desktop-settings.json`：`updateChannel`（`latest`/`nightly`）可选（apps/desktop/src/settings/DesktopAppSettings.ts:38-39, :106-107）。无遥测用户开关——桌面遥测同意走 `T3CODE_TELEMETRY_ENABLED`（由 shell 发现流程写入，AnalyticsService.ts:131-141）；server `settings.json` 无遥测/更新项（contracts/src/server.ts 无相关字段）。
- 结论：settings 层没有独立的外网开关，均由 policy/env 覆盖。

### 1.5 feature flags（`T3CODE_FEATURE_FLAGS`）

| flag | 默认 | 关闭方式 | 证据 |
|---|---|---|---|
| `github_app_client_id` | 未设 | **不设即关** GitHub App 登录（注释明确） | FeatureFlags.ts:18-19；消费 packages/source-control-github/src/server/GitHubAppSignIn.ts:105（缺省空 client id） |
| `tanstack_source` | off | 不设即不注册该 source-control driver | FeatureFlags.ts:17；apps/server/src/sourceControl/builtInDrivers.ts:25-40 |
| `secret_providers` | off | 不设即无 1Password 等 secret provider | FeatureFlags.ts:16；apps/server/src/ws.ts:1938 |

## 2. 触点 → 机制分类（屏蔽策略框架）

依据 §1 的机制面，对主要外网触点分类（完整触点清单待 #134，此处列机制判断所需的最小集合）：

### 2.1 纯配置（零补丁）

| 触点 | 机制 |
|---|---|
| 桌面更新（electron-updater → GitHub） | policy `updates.mode:"off"`（直接关）或 `feedUrl`（改指内网 generic feed）；或构建期 `publish=null`；或 env `T3CODE_DISABLE_AUTO_UPDATE=1`（§1.1/§1.3） |
| CLI 更新 / boot service / server 自更新（`api.github.com` 索引 + releases/download 归档） | policy `feedUrl` 镜像同时替代索引与下载（update.ts:390-395, :510）；无策略时 `T3CODE_RELEASE_BASE_URL` 只覆盖下载，索引仍走 GitHub——可改用显式 `t3 update <version>` 跳过索引（update.ts:390-391） |
| 产品分析（PostHog → ingest.t3.codes） | `T3CODE_TELEMETRY_ENABLED=false` 和/或 policy `telemetry:false`（AnalyticsService.ts:126-131） |
| OTel 导出 | 默认关；需要时 `*OTEL_SDK_DISABLED=true`（otelEnvironment.ts:256-285） |
| 登录 / Clerk / Connect relay / hosted app | 构建期三件套留空 + `T3CODE_RELAY_URL` 不设 → 全链停用（§1.3）；policy `connect:false` 再兜底 |
| GitHub App 登录 / tanstack source / secret providers | feature flag 不设（§1.5） |
| SSH 远端 t3 安装（releases/download / install.sh） | `T3CODE_RELEASE_BASE_URL` 改指内网镜像（tunnel.ts:1142-1150, :552）；离线 = 预装 |
| preview 浏览器搜索引擎模板（duckduckgo 等） | 用户可配置项，非自动出网（packages/shared/src/preview.ts:103） |

### 2.2 配置 + 小补丁（官方机制不覆盖该面）

- **模型价格表**：`UsageService` 硬编码 `raw.githubusercontent.com`/`api.github.com`（BerriAI/litellm model_prices JSON），本地缓存 TTL 24h（apps/server/src/usage/UsageService.ts:63-66, :75, :72）。断网后果：功能降级（费率显示旧数据/失败，软失败）。无官方 env。最小补丁：该两常量加 env 覆盖或改为构建期内置快照，**1 文件**。
- **ACP registry**：索引 URL 硬编码 `https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`（packages/provider-acp-registry/src/server/AcpRegistrySupport.ts:53）。代码内部本有 `registryUrl` 选项（:567, :684），但宿主装配层不透传（`layerFromHost` :546-557）。懒加载，仅用户浏览「添加 agent」时拉取，失败回退磁盘缓存（:892-899）。最小补丁：装配层透传 env（如 `T3CODE_ACP_REGISTRY_URL`），**1-2 文件**；omp 场景直接不用 registry UI 即可回避。

### 2.3 必须补丁（硬编码且无官方开关）

- **Triage（问题诊断）**：硬编码 `https://github.com/pingdotgg/t3code` 做 `git ls-remote`/`fetch --depth 1`（apps/server/src/triage/TriageService.ts:19, :133, :89-117）。用户触发、软失败（5s 超时，注释 :131-132「a dead network should not stall it」）。最小补丁：仓库 URL 常量改指内网镜像（fork 自身即内网可达），**1 文件**。
- 其余硬编码 URL（帮助链接、`RELEASES_URL` apps/desktop/src/app/DesktopStartupRecovery.ts:23、MCP 客户端拿到的 `app.t3.codes` 线程链接 apps/server/src/auth/McpOAuth.ts:612-619）**不产生网络请求**（浏览器打开/给外部的链接文本），内网无害，可不补丁。

**补丁面预估合计：3 个文件、每处 ≤10 行，全部是「常量 → env 读取」的纯加法。**

## 3. 补丁组织与 rebase 策略

1. **集中化**：新建 `packages/shared/src/intranet.ts`，集中定义 `intranetTriageRepositoryUrl`、`intranetUsageRatesUrl`、`intranetAcpRegistryUrl`（读 env，缺省指向内网镜像；布局遵循上游 URL 形状）。三个消费点各自 1 行 import + 1 行替换。这样补丁知识集中在一处，消费点 diff 退化为 import 行，rebase 冲突面最小。
2. **少即是多**：凡上游已有 policy/env 的触点一律不补丁（§2.1 清单即「禁止补丁区」），避免和高频改动的 `DesktopUpdates.ts`/`cliRelease.ts`/`bootService.ts` 产生 rebase 冲突——这三个文件恰是 nightly 迭代热区。
3. **随 nightly rebase**：
   - fork 维护 `intranet/base`（上游 nightly 快照）与 `intranet/main`（base + 补丁）两分支；补丁以线性小 commit（每文件一 commit）叠在 base 上，rebase 即 `git rebase intranet/base`。
   - 每个补丁 commit message 里写明「上游无对应机制 + 替代方案链接」，便于 reviewer 判断该补丁是否仍必要；上游若吸收（如给 UsageService 加 env），直接删补丁。
   - 构建期开关（§1.3）写进 fork 的 CI 变量而非源码，永远零冲突。
   - CI 加一个守门检查：`git diff intranet/base..intranet/main --stat` 的源码文件数 ≤ 预算（初值 5），超预算即失败，防止补丁面无序生长。
4. **未证实**：上游是否会接受 env 化 PR（把 2.2/2.3 三处推上游）未调研——若可接受，长期 fork 补丁面可降为零。

## 4. 不需要搬「旧迁移补丁」的理由（对照）

旧补丁做的事在新基线的等价物：更新屏蔽 → policy `mode:"off"`/`feedUrl`；登录屏蔽 → 构建期三件套留空；遥测屏蔽 → env/policy；GitHub 登录屏蔽 → feature flag 不设。即旧补丁面的大部分已被上游「管理员管控」机制吸收，fork 只需 §2.3 的 3 处小补丁。

## 5. 「离线安装 pinned runtime」重新设计（不搬旧脚本）

### 5.1 上游现基线的 runtime 语义（设计必须遵守）

- 目录布局：`<home>/runtime/versions/<version>/t3`（win: `t3.exe`）+ sentinel `.install-complete`（内容为版本字符串，`pinnedRuntimePaths`：apps/server/src/cloud/pinnedRuntime.ts:46-56）。`<home>` 默认 `~/.t3`（apps/server/src/auth/McpOAuth.ts:355；`T3CODE_HOME` 可改，apps/server/src/cli/app.ts:195）。
- **跳过下载的判定**：入口文件存在且 sentinel 内容等于目标版本 → `alreadyPinned`，只在 `requirePublishedRelease`（= 配了 policy 镜像）时才回源核对 SHA256SUMS，否则直接本地 `t3 --version` 校验（pinnedRuntime.ts:387-410, :1295-1300）。**sentinel 匹配 = 零网络**。
- 归档/校验和来源：`<base>/v<version>/t3-<version>-<platformKey>.tar.gz|zip` + `SHA256SUMS`（cliRelease.ts:44-66, :41-43；下载与校验 pinnedRuntime.ts:266-294, :336-353；解压 `tar -x --strip-components=1` :303-330）。平台键矩阵 cliRelease.ts:14-24（darwin-x64 不支持 Node single-executable）。
- 归档内可带 release feed 文件（`latest-mac.yml` 等，`updateFeedFileName` cliRelease.ts:107-110；镜像根目录与归档并列，注释 :107-108），桌面 policy `feedUrl` 即指向这类镜像根。

### 5.2 新方案（fork 侧，全部新代码）

1. **内网镜像即分发面**（一次建设，更新/安装/远端三链共用）：在内部文件服务上按 GitHub 布局发布 `v<version>/`：归档 + `SHA256SUMS` + 更新 feed 文件。桌面 policy `feedUrl` 与各机器 `T3CODE_RELEASE_BASE_URL` 都指它；上游对「镜像根布局」的注释（cliRelease.ts:107-108）即布局规范，无需自造协议。
2. **种子工具（新脚本 `scripts/seed-pinned-runtime.ts`，随 fork 维护）**：输入内网镜像 URL + 版本，走上游同一 URL/校验逻辑（复用 `cliReleaseAssetUrl`/`parseChecksums`）下载→校验→解压→写 sentinel→跑 `t3 --version`，产物即 `<home>/runtime/versions/<version>/`。与旧种子脚本无关；它只是把 §5.1 的 sentinel 语义在离线侧预演一遍。产物可整体 tar 分发（目录即全部状态，无注册表/DB 记录——sentinel 文件是唯一元数据）。
3. **装机流程**：内网机器解包种子目录到 `~/.t3/runtime/versions/` 后，任何后续 `t3 update <version>` / boot service 安装都会命中 `alreadyPinned`（update.ts:460-465 的 `alreadyOnDisk` 路径：提示 "Switching T3 Code" 并跳过下载）。注意：若部署了 policy 镜像，`requirePublishedRelease=true` 会回源核对 SHA256SUMS——内网镜像在线即可，完全断网的机器**不要配** policy `feedUrl`（用 `mode:"off"` 或不配 updates 键）。
4. **桌面端不需要 runtime 种子**：桌面后端直接跑自带 `apps/server/dist/bin.mjs`（apps/desktop/src/app/DesktopEnvironment.ts:210），不走 pinned runtime；runtime 种子只服务 CLI/boot-service/SSH 远端主机。SSH 远端离线 = 预装 t3（上游错误提示即此意，tunnel.ts:552）。
5. **版本一致性**：种子版本必须与桌面 app 版本同源（boot service 的 `cliVersion` 由调用方传入，bootService.ts:813, :855-856；`t3 update` 以 `packageJson.version` 为当前版本，update.ts:374，目标版本显式传入 :579；自更新用 `packageJson.version` 定位 runtime，selfUpdate.ts:84；版本比较 `compareSemverVersions`）。CI 在发布镜像时从同一 tag 产出归档与种子，避免双源漂移。

### 5.3 与旧实现的差异声明

不搬旧种子脚本；本节为按 §5.1 语义的重新设计，产物与上游 `ensurePinnedRuntimeInstalled` 完全兼容（sentinel 版本匹配即缓存命中）。

## 6. 与票 #134 的映射（占位）

#134《外网触点全量清单》分支 `research/external-touchpoints` 截至本文写作尚未 push（fetch 无此分支），本节留占位。终稿需吸收其清单并对每触点回填 §2 分类表；预期新增工作仅限：把 #134 发现的、未列入 §2 的高频（启动/定时）触点升级为补丁或配置项。已知需要 #134 确认的面：`avatars.githubusercontent.com` 等图片 CDN 的触发时机（推测为 source-control PR 头像，用户触发；**未证实**）、移动端 pairing 链路（apps/mobile 不在桌面部署范围）。
