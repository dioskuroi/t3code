# 调研：nightly 基线核验（中文支持与结构速览）

基线：fork `dioskuroi/t3code` tag `v0.1.12-nightly.20261123.5124`（上游 commit `2808e878`）。所有路径相对仓库根。

## 1. 中文（zh）支持现状

### 1.1 覆盖范围：全 UI 面，CLI/server 无 i18n

上游使用 [General Translation (gt)](https://generaltranslation.com) 体系，locale 目录为 `zh`（非 zh-Hans/zh-CN，通过 `resolveLocale` 做语言匹配回退，见 `packages/client-runtime/src/locales`，由各 app 的 `src/i18n/locales.ts` 调用）。

| 面 | locale 文件 | en 键数 | zh 键数 | zh 缺失 |
|---|---|---|---|---|
| web (`apps/web`) | `apps/web/src/i18n/translations/zh.json` | 10,182 | 10,182 | 0 |
| mobile (`apps/mobile`) | `apps/mobile/src/i18n/translations/zh.json` | 5,058 | 5,058 | 0 |
| desktop 原生壳 (`apps/desktop`) | `apps/desktop/src/i18n/translations/zh.json` | 125 | 125 | 0 |
| marketing (`apps/marketing`) | `apps/marketing/src/i18n/zh.ts` | —（结构化 TS） | — | 完整移植 `en.ts` 结构 |
| CLI/server (`apps/server`) | 无任何 i18n | — | — | CLI 输出纯英文硬编码（如 `apps/server/src/binCli.ts:49`） |

键数核验：用脚本对三个 `translations/en.json` 与 `zh.json` 逐键对比，**zh 缺失键数为 0**（web/mobile/desktop 均完全覆盖）。locale 清单见 `apps/web/gt.config.json`（`locales: ["de","es","fr","ja","ko","pt-BR","ru","sv","zh"]`）与 `apps/desktop/gt.config.json`（同清单）。desktop 只翻译原生壳层（125 条：启动失败、更新器等），主 UI 由内嵌 web 承载，故其界面中文实际来自 web 的 catalog。

**结论：中文覆盖 = web + mobile 全量 UI + desktop 原生壳 + marketing 站；CLI/server 无中文（内网迁移下 CLI 文案保持英文，不影响使用）。**

### 1.2 成熟度：机器翻译（gt 流水线），键级完整

- 生成链路：`apps/web/package.json:11,14` 有 `"i18n:generate": "gt generate"` 与 `"i18n:translate": "gt translate"` —— `gt translate` 是 General Translation 的 AI 翻译服务，即 **zh 内容为机器翻译**，未见人工校对痕迹（仓库无 review 标记文件）。未证实：是否有外包人工复核流程。
- CI 守护：`scripts/i18n-check.ts`（`package.json:22` `i18n:check`）校验 en.json 与源码一致、且各 locale 键集合与 en 一致；`scripts/i18n-untranslated.ts`（`package.json:35`）用 lint 规则 `t3code/no-untranslated-copy` 统计未接入 i18n 的硬编码文案（覆盖 `apps/web/src`、`apps/mobile/src`、`packages/client-runtime/src`）。
- 抽样质量：zh.json 译文自然（如 `"4bcfa3b976a421cf": "侧聊"`、`"0001ae5846061bb6": "{machine} 上的会话"`，`apps/web/src/i18n/translations/zh.json:2-4`），ICU 变量保留正确。

**结论：键级完整但为机翻质量；对内网 fork 而言 zh catalog 是静态 JSON 资产，随构建打包，无运行时外网请求（gt 仅在构建期使用）。**

### 1.3 语言设置入口

- web：设置面板 Display → Language 下拉，`apps/web/src/components/settings/SettingsPanels.tsx:1123-1149`（`setting("language")`，描述「System default follows your browser or OS language」）；设置项定义 `packages/contracts/src/settings.ts:595`（`language` 默认 `"en"`）。catalog 加载与 locale 解析：`apps/web/src/i18n/locales.ts`、`I18nProvider.tsx`、`initializeI18n.ts`。
- desktop 原生壳：`apps/desktop/src/i18n/messages.ts` —— catalog 表 `CATALOGS`（含 `zh`，:16-27），`SUPPORTED_LOCALES`（:24），激活函数 `applyLanguage`（:67，读取保存的 `language` client setting，`"system"` 跟随 OS）。desktop 侧未见独立语言设置 UI 面板（`grep language apps/desktop/src --include=*.tsx` 无命中）；设置存在 client settings 里，与 web 共用同一 setting 键。
- mobile：`apps/mobile/src/i18n/`（同 gt 结构，`locales.ts`/`I18nProvider.tsx`）。

### 1.4 增量维护机制

1. 源码文案用 `gt()` / `<T>` 标记（gt 体系），`gt generate` 扫描源码产出 `en.json`（`gt.config.json` 的 `src` 定义扫描范围：`apps/web` 还覆盖 `packages/client-runtime/src` 与 `packages/shared/src`）。
2. `gt translate` 对新增键生成各 locale JSON（需 GT 云凭证——**外网依赖，仅构建期**）。
3. `pnpm i18n:check` 在 CI 保证 catalog 不漂移（不需要网络，`scripts/i18n-check.ts:6-7` 注释明确「Needs no GT credentials or network」）。
4. 内网 fork 影响：新增文案若要出中文，需离线手工补 zh.json 对应键（键为文案 hash，如 `4bcfa3b976a421cf`），`i18n:check` 只校验键集合一致，不校验译文质量；缺失键回退英文。

## 2. 结构速览（pnpm monorepo，相对旧 v0.1.7 的导览）

> 说明：本 worktree 无 v0.1.7 历史可 diff（fork 只有 nightly tag），以下为 nightly 现状导览；「相对旧版」差异未证实，其余调研票可按本节路径自行核对。

### 2.1 apps 布局与构建入口

```
apps/
  server    @t3tools/t3 "t3"  CLI + 本地服务（bin: t3 -> dist/bin.mjs，apps/server/package.json:10-12）
  web       @t3tools/web      前端 UI（TanStack Router + Vite，build = "vp build"）
  desktop   @t3tools/desktop  Electron 壳（electron-builder 26，内嵌 web/server）
  mobile    @t3tools/mobile   移动端
  marketing @t3tools/marketing 官网（Astro）
packages/   见 2.3 provider 体系；另有 client-runtime、contracts、shared、ssh、tailscale 等
```

构建入口（根 `package.json` scripts）：
- dev：`pnpm dev`（`scripts/dev-runner.ts`，可 `dev:server` / `dev:web` / `dev:desktop`）。
- server 打包：`apps/server/package.json` → `build:bundle`（`vp pack`）、`build:exe`（`node scripts/cli.ts build-exe`，单文件可执行）。
- desktop：electron-builder（`apps/desktop/package.json:41`），无内联 `build` script（由 workspace `vp` 编排）。
- 包管理器为 pnpm + `vp`（vite-plus 封装），workspace 定义 `pnpm-workspace.yaml`。

### 2.2 登录 / 认证面

- **桌面/web 本地使用不强制登录**；认证集中在：
  - server 侧：`apps/server/src/auth/`（EnvironmentAuth、PairingGrantStore、SessionStore、DPoP、McpOAuth、RpcAuthorization）——本地环境/配对/MCP OAuth。
  - web 侧：`apps/web/src/components/auth/`（`BrowserManagedAuthShell.tsx`、`ElectronManagedAuthShell.tsx` 等）。
  - **T3 Connect 云账号 = Clerk**：`apps/web/src/cloud/managedAuth.tsx:1`（`useClerk` from `@clerk/react`）；Clerk 组件目录 `apps/web/src/components/clerk/`（`T3ConnectSidebarSignIn.tsx`、`T3ConnectUserProfilePage.tsx` 等）。云开关由构建期 public config 门控：`apps/server/src/binCli.ts:49`「T3 Connect commands are unavailable: this build is missing T3 Connect public configuration」（`hasCloudPublicConfig`，`makeCli({cloudEnabled})` :68）。
- CLI 命令面：`apps/server/src/binCli.ts:78-105` 子命令（`start/serve/pair/auth/environment/up/status/update/...`）；`connect` 在无 public config 构建中是显式报错的占位（:52-70）。

### 2.3 provider / adapter 体系

内置 driver 注册表：`apps/server/src/provider/builtInDrivers.ts:34-46` —— `BUILT_IN_DRIVERS` = **Codex、Claude、Cursor、Grok、Fx、OpenCode、Antigravity、Kiro、Pi、Muse、AcpRegistry**（11 个）。usage 聚合子集 `BUILT_IN_USAGE_DRIVERS`（:61-74，8 个）。

- 独立协议包：`packages/provider-pi|cursor|grok|kiro|muse|opencode|fx`（各含 `client.ts` label 与 `server/` driver/worker；例：Cursor 有独立 SDK worker，`apps/server/src/binMain.ts:30-36` `__cursor-sdk-worker`）。
- **ACP 体系（omp 接入面，关键）**：
  - `packages/provider-acp`：ACP 协议 runtime（adapter v2、runtimeModel）。
  - `packages/effect-acp`：ACP 协议 Effect 实现。
  - `packages/provider-acp-registry`：ACP Registry driver —— 默认从 **`https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`** 拉取 agent 清单并下载分发（`packages/provider-acp-registry/src/server/AcpRegistrySupport.ts:53`）；支持 `source: "registry" | "local"`（`packages/provider-acp-registry/src/settings.ts:9`），`local` 模式直接给本机可执行命令 —— **内网接 omp 走 `source: "local"` + `commandPath: omp`**。
  - agent 特化 flavor 在 `packages/provider-acp-registry/src/server/adapter.ts:198-245` 按 agentId/二进制名判定：`isOmp` = local 模式且可执行名为 `omp`（:203-205）→ 挂 `extractOmpElicitationForm`（:281-283，实现在 `server/ompAcp.ts:21`，解析 omp 的 `qN`/`qN__other` askDialog 表单）。已知 agent 还包括 claude-acp、factory-droid、kimi-code、github-copilot-cli、opencode(-v2)、glm-acp-agent、mistral-vibe、antigravity(`agy`)、devin。

### 2.4 远程 / T3 Connect 面

- 云链路：`apps/server/src/cloud/`（`CloudLink.ts`、`ConnectReachability.ts`、`ManagedEndpointRuntime.ts`、`CliTokenManager.ts`）+ web 侧 `apps/web/src/cloud/`（`t3ConnectState.ts`、`linkEnvironment.ts`、`connectCliAuth.ts`）。
- 外部端点（供屏蔽票参考）：ACP registry CDN（上引）、`https://nightly.app.t3.codes`（`apps/server/src/cloud/publicConfig.ts:118`）、npm registry `https://registry.npmjs.org/t3/`（`apps/server/src/cloud/npmRelease.ts:66`）、DoH `https://1.1.1.1/dns-query`（`apps/server/src/cloud/ConnectReachability.ts:37`）、安装脚本 `https://t3.codes/install.sh`（`apps/server/src/cloud/servicePreflight.ts:54`）、well-known 探测 `https://<host>/.well-known/t3/environment`（`ConnectReachability.ts:306`）。
- desktop 更新：electron-updater generic feed（`apps/desktop/src/electron/ElectronUpdater.ts:7`，`setFeedURL` provider "generic"，`apps/desktop/src/updates/DesktopUpdates.ts:1303-1311`；feedUrl 可被策略覆盖 `apps/desktop/src/updates/DesktopUpdatePolicy.ts:22`）；恢复页硬编码 `https://github.com/pingdotgg/t3code/releases`（`apps/desktop/src/app/DesktopStartupRecovery.ts:23`）。

## 3. 给其余票的导览要点

- 屏蔽外网：grep 锚点集中在 `apps/server/src/cloud/`、`apps/web/src/cloud/`、`apps/desktop/src/updates/`、`packages/provider-acp-registry/src/server/AcpRegistrySupport.ts`（ACP registry 拉取）。构建期 public config 缺省时 connect 面已自然禁用。
- omp 接入：确认走 AcpRegistry `source:"local"` + `commandPath` 名为 `omp` 即触发 `isOmp` flavor，无需改 adapter。
- 中文：离线维护 zh.json 即可；`i18n:check` 离线可跑；gt translate 是唯一构建期外网点（可跳过，已有 catalog 覆盖 100% 现有键）。
