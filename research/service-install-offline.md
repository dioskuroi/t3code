# pinned runtime 离线种子可行性调研（#29 上下文）

调研基线：fork `dioskuroi/t3code` @ fork/main，HEAD `e04e9b3c5d`。全部结论基于该树实读，引用格式 `文件:行号`。

## 1. 版本目录完整清单

### 归档打包内容（`scripts/build-cli-archive.ts`）

`buildCliArchive`（`scripts/build-cli-archive.ts:474-560`）向归档根目录 `t3-<version>-<platformKey>/` 写入：

| 内容 | 来源 | 行号 |
| --- | --- | --- |
| `t3`（SEA 可执行文件，win 为 `t3.exe`） | `apps/server/dist-exe/t3-<targetKey>` 或宿主构建 | build-cli-archive.ts:493-511, 516 |
| `client/`（web 前端静态文件，含 `index.html`） | `apps/server/dist/client`，去除 `.map` | build-cli-archive.ts:512, 245-256 |
| `resource-monitor/`（Rust 产物目录，内含 `t3-resource-monitor[.exe]`，release CI 按 `resource_key` 分子目录） | `apps/server/dist/resource-monitor` 或 `--resource-monitor-dir` | build-cli-archive.ts:513-515, 517 |
| `node_modules/` + `package.json` + `pnpm-workspace.yaml`（runtime externals：fff-node 平台二进制、node-pty prebuilds 等，hoisted、仅本平台 prebuilds） | `stageRuntimeExternals`，vp install --prod | build-cli-archive.ts:135-217 |
| `lib/libatomic.so.1` + LICENSE（仅 Linux，patchelf 设置 `$ORIGIN/lib` RUNPATH） | `bundleLinuxLibatomic` | build-cli-archive.ts:259-310, 525-527 |

归档名 `t3-<version>-<platformKey>.tar.gz`（win 为 `.zip`），`platformKey` 形如 `darwin-arm64`（`packages/shared/src/cliRelease.ts:19-32`、`cliArchiveFileName` `cliRelease.ts:47-49`）。

### 解包后落位（`apps/server/src/cloud/pinnedRuntime.ts`）

`installFromArchive` 用 tar `--strip-components=1` 把 stem 目录剥掉，使内容直接落在 staging 目录（`pinnedRuntime.ts:211-235`）；成功后 validate 并写 sentinel，最后 rename 成正式版本目录（`pinnedRuntime.ts:335-370`）。所以 `~/.t3/runtime/versions/<version>/` 内容 = 上表全部（`t3`、`client/`、`resource-monitor/`、`node_modules/`、Linux 另有 `lib/`）+ `.install-complete`（内容为版本号字符串）。

### 两个入口各自依赖其中什么

- **`validate`**：`pinnedRuntimeCommand` 返回 `{ command: paths.entryPath, args: [] }`（`pinnedRuntime.ts:41-46`）；`entryPath = <versionDir>/t3`（win 为 `t3.exe`，`pinnedRuntimePaths` `pinnedRuntime.ts:48-63`）。bootService 的 validate 执行 `t3 --version` 并要求 stdout 末尾匹配 `/\bv(\S+)\s*$/` 且等于 `input.cliVersion`（`bootService.ts:792-814`）。即 validate **只依赖 SEA 可执行文件本身**，不需要 client/resource-monitor/node_modules。
- **`__service-launcher`**：`plan.program = [runtimePaths.entryPath, "__service-launcher"]`（`bootService.ts:653-655`），systemd `ExecStart=`（`bootService.ts:107`）与 launchd `ProgramArguments` 第一项都是它（`bootServiceProgramOf` 解析 `bootService.ts:73-84`）。SEA 运行的 server：
  - web client：`resolveStaticDir` 取 `import.meta.dirname/client/index.html`（SEA 下 `import.meta.dirname` 即可执行文件目录），否则 monorepo 回退（`apps/server/src/config.ts:270-287`）——**依赖 `client/`**；
  - resource-monitor：候选含 `<execDir>/resource-monitor/<platformKey>/<bin>`、`<execDir>/resource-monitor/<bin>`、`<execDir>/../resource-monitor/<bin>`（`apps/server/src/resourceTelemetry/ResourceMonitorBinary.ts:150-170`），可被 `T3CODE_RESOURCE_MONITOR_PATH` 或 bootstrap 覆盖；缺了只是降级（devcontainer 注释：「server degrades gracefully without the binary」，`.devcontainer/devcontainer.json:13-14`）——**软依赖 `resource-monitor/`**；
  - native 包：SEA 二进制仍从旁边 `node_modules` 解析原生模块（`apps/server/scripts/cli.ts:165` 描述文案；打包时 `findEsmImportsOfExternalPackages` 保证无裸 import 泄漏 `cli.ts:145-149`）——**依赖 `node_modules/`（其中原生包；纯 JS 部分已打进 bundle）**。

## 2. 离线直接种子的可行路径

判定为已装的条件（`installPinnedRuntime`，`pinnedRuntime.ts:281-287`）：`entryPath` 存在 且 sentinel 存在且内容 trim 后等于目标版本。满足后（无 `requirePublishedRelease`）直接 `cached` → validate → 返回，**全程无网络**。因此种子目标就是：合法填出版本目录 + 写 sentinel。

### (a) 本地构建产物种子

1. `node apps/server/scripts/cli.ts build-exe` 产出 `apps/server/dist-exe/t3`（SEA；描述明确它「expects client/, resource-monitor/, and the runtime-external node_modules beside it」`cli.ts:159-161`）。
2. `vp run --filter t3 build` 产出 `apps/server/dist/client`（`build-cli-archive.ts:193-194` 的 requireInput 提示）。
3. `cargo build --release --manifest-path native/resource-monitor/Cargo.toml`，取 `native/resource-monitor/target/release/t3-resource-monitor`（release CI 同源 `release-desktop.yml:260,393-399`）。
4. 组装 `~/.t3/runtime/versions/<version>/`：`t3`（chmod 0755）、`client/`、`resource-monitor/`（release CI 放 `resource-monitor/<platformKey>/t3-resource-monitor`，server 两个候选都能命中）、`node_modules/`（这一步等价于 `stageRuntimeExternals`：按 server 依赖 + `resolveFffNativeDependencies` + `selectCliRuntimeExternalDependencies` 做 hoisted 安装，`build-cli-archive.ts:135-217`——**这是最麻烦的一步**，可偷懒直接复用 build-cli-archive 的 staging 或干脆跑一次 `build-cli-archive` 再手动解包）。
5. `printf '%s\n' <version> > <versionDir>/.install-complete`。

坑：
- validate 只查 `t3 --version` 输出版本号；SEA 里 `--version` 打的是构建时 package 版本，**版本目录名必须与该值一致**，否则 bootService validate（`bootService.ts:792-814`）失败。
- Linux 需 `lib/libatomic.so.1` + patchelf RUNPATH（`build-cli-archive.ts:259-310`）；缺了在无 libatomic 的宿主上 SEA 起不来。
- darwin 需对 `t3`、`.node`、`spawn-helper`、`t3-resource-monitor` 签名（`build-cli-archive.ts:318-370`）；自建 ad-hoc 签名（`codesign -s -`）可过本机 Gatekeeper。
- `node_modules` 里 node-pty prebuilds 只保留本平台（`build-cli-archive.ts:198-206`），混入其他平台目录不影响运行只影响体积。
- prune 风险：种好的 runtime 若无 launcher/服务状态/进程引用，1 小时宽限后可能被 `prunePinnedRuntimes` 回收（`pinnedRuntime.ts:395-405` 宽限注释）；bootService 安装后 service state 写入 `activeVersion`（`bootService.ts:882-894`）即受保护，种子紧接 `t3 service install` 时窗口极小。

### (b) app bundle 内嵌 server 种子

用 `apps/server/dist/bin.mjs` + node/Electron 伪造 entryPath：
- `entryPath` 被直接执行且无参数（`pinnedRuntimeCommand` `pinnedRuntime.ts:41-46`），所以 entry 必须是**可执行文件**：要么带 shebang（`#!/usr/bin/env node`）的 wrapper 去 import bin.mjs，要么做符号链接到 Electron 并依赖 `ELECTRON_RUN_AS_NODE`（服务环境无人设置，**不可靠**）。
- validate 层面：`t3 --version` 只要求 stdout 以 `v<version>` 结尾，`bin.mjs` 正常 CLI 输出即可过；`__service-launcher` 参数会经 `"$@"` 透传给 wrapper，`serviceLauncherCommand`（`apps/server/src/cloud/serviceLauncher.ts:7-15`）也能处理。**validate 与 launcher 语义上都通**。
- 但坑明显：
  1. 服务 PATH 受限：launchd plist 的 PATH 由 bootService 显式渲染（`bootService.ts:592-617`），`/usr/bin` 在列但用户级 node（nvm/homebrew）不一定；SEA 无此依赖。
  2. bin.mjs 的 `import.meta.dirname` 指向 wrapper 所在版本目录，需要同目录补 `client/`（`config.ts:270-287`）和**完整** node_modules——bundle 里 `app.asar` 内的 node_modules 拷出来还要 hoisted 布局正确，比 (a) 更脆。
  3. `resolveStaticDir` 有 monorepo 回退（`../../web/dist`），但版本目录下不会有，client 必须自带。
  4. Electron 直接跑 `.mjs`（不经 `ELECTRON_RUN_AS_NODE`）会当 GUI 启动，行为完全不对——wrapper shebang 指向真 node 是唯一稳妥形态。

**结论：(a) 为正道；(b) 仅 validate 层面可行，服务环境风险高，不建议作为 #27 修复方向。**

### 离线种子最小步骤（可转种子脚本 spec）

输入：`version`、`entryExecutable`（SEA 路径）、可选 `clientDir`/`resourceMonitorDir`/`nodeModulesDir`。
1. mkdir `~/.t3/runtime/versions/<version>`；
2. 复制 entry → `<dir>/t3`，chmod 0755（win: `t3.exe`）；
3. 复制 `client/`、`resource-monitor/`（含 `<platformKey>` 子目录布局）、`node_modules/`（若有）；
4. 写 `<dir>/.install-complete` = `<version>\n`；
5. 自校验：spawn `<dir>/t3 --version`，断言 stdout 末尾 `v<version>`（对齐 `pinnedRuntime.ts:335-339` 与 `bootService.ts:792-814`）；
6. 置 `~/.t3/runtime/launchers` 记录（可选，防 prune 依赖）。

不碰网络、不碰 SHA256SUMS；sentinel 命中后 `ensurePinnedRuntimeInstalled` 直接走 `cached`（`pinnedRuntime.ts:287-302`）。

## 3. `requirePublishedRelease === true` 的触发条件

- 定义与语义：仅当「cached 命中」时，额外调 `publishedArchive` 拉一次 SHA256SUMS 确认该版本仍发布着（`pinnedRuntime.ts:115-116` 注释「Reuse a cached runtime only while the release source still lists it, as a policy mirror does」，强制路径 `pinnedRuntime.ts:288-303`，`publishedArchive` `pinnedRuntime.ts:246-268`）。
- 全部调用点（grep 全仓）：`apps/server/src/cli/update.ts:506`（`requirePublishedRelease: mirror !== undefined`）与 `apps/server/src/cloud/selfUpdate.ts:214`（同式）。**`bootService.ts:784-795` 不传该字段** → 服务安装路径即使 sentinel 命中也绝不回源。
- `mirror` 来自 update 命令的镜像参数/策略镜像 feed（update.ts、selfUpdate.ts 上下文；`mirror?.feedUrl` 同时作为 `releaseBaseUrl`）。即：**只有经策略镜像（policy mirror）执行 `t3 update`/selfUpdate 时才强制回源**；默认 GitHub 直连（`CLI_RELEASE_DEFAULT_BASE_URL`，`cliRelease.ts:38`）不走。
- renamed 版本 `0.1.7-omp.1`：`cliReleaseChannelOf` 正则 `^[^-+]+-(nightly|preview)\.\d{8}\.\d+$`（`cliRelease.ts:84-86`），`omp.1` 不匹配 nightly/preview → 归类 **stable**；`crossesReleaseTrack` 对 stable↔stable 为 false（`cliRelease.ts:88-94`），不触发 track switch。因此 `0.1.7-omp.1` **只在「被当作 mirror 场景的 target 版本」时可能踩中强制回源**——mirror（如组织镜像）通常没有这个 renamed release 的 SHA256SUMS/归档，届时 `publishedArchive` 404/找不到条目，`isUnpublishedRelease`（`pinnedRuntime.ts:270-277`）报「release source does not publish」。bootService 安装/重装服务不受影响。

## 4. shim 与 runtime 的分工

- **shim**（`~/.t3/bin/t3`，桌面 app 写入，`apps/desktop/src/app/DesktopCliShim.ts`）：`launcherPath = <baseDir>/bin/t3`（`DesktopCliShim.ts:84-90`）；内容 `renderCliShim`（`DesktopCliShim.ts:55-81`）：
  - direct：`exec "$app" '<serverRoot>/apps/server/dist/bin.mjs' "$@"`（`SERVER_ENTRY` `DesktopCliShim.ts:9`，`$app` 为 `process.execPath` 即 Electron）；
  - AppImage：先 `--appimage-mount`（失败则 `--appimage-extract`）再运行 `<mount>/<executableName> <mount>/resources/app.asar/apps/server/dist/bin.mjs`；
  - Windows：`process.execPath <entry>`（`target.kind === "windows"`，`DesktopCliShim.ts:44-46`）。
  即 shim **始终指向 app bundle 内嵌 server**，从不指向 pinned runtime。
- **pinned runtime**：`~/.t3/runtime/versions/<version>/t3`，是 install script / `t3 update` repoint 后的 launcher 目标（`update.ts:549-552` repointLauncher），也是服务实体。
- 各命令走哪条入口：
  - `t3 service install`：无论从 shim 还是 pinned launcher 调起，CLI 都是同一套代码；它经 `BootService.install` → `ensurePinnedRuntimeInstalled`（`bootService.ts:784`）确保 pinned runtime，并把 `ExecStart`/`ProgramArguments` 指到 `<versions>/<v>/t3 __service-launcher`。**服务跑的永远是 pinned runtime，不是 shim**。
  - `t3 up`：`upCommand`（`apps/server/src/cli/up.ts:421`）在**当前进程**内起 server，不装 runtime——入口由调用者决定（shim → bundle server；pinned launcher → SEA runtime）。
  - `t3 pair`（`apps/server/src/cli/pair.ts:476`）：同样在当前进程执行，无 pinned runtime 参与。
- **`__service-launcher` 与 shim 不指向同一实体**：前者是 `versions/<v>/t3`（SEA），后者是 bundle 内 `apps/server/dist/bin.mjs`。两者的 `--version`/版本可能不同步（bundle 更新走桌面 app 更新，runtime 走 `t3 update`）。

## 补丁大小粗估：「bootService 加离线路径」

目标：`BootService.install` 在回源安装前先尝试本地/既有目录种子。

- `apps/server/src/cloud/pinnedRuntime.ts`：新增导出函数（如 `seedPinnedRuntimeFromLocal` / 或给 `ensurePinnedRuntimeInstalled` 增加 `localArchive?: { path } | localDir?: string` 输入，命中 staging 语义复用 validate + sentinel + rename 逻辑）。约 **60–100 行**（含复用现有 `installPinnedRuntime` 的 alreadyPinned/staging/validate 分支）。
- `apps/server/src/cloud/bootService.ts`：`install`（784 行附近）在调 `ensurePinnedRuntimeInstalled` 前加一次种子尝试，失败回退现有网络路径（或对 `isUnpublishedRelease` 容错）。约 **15–30 行**。
- 可选：`apps/server/src/cloud/bootService.test.ts` 补 1–2 个用例，约 30–50 行。
- **合计约 100–180 行，动 2 个产品文件**；不碰 `cliRelease.ts` 与 update/selfUpdate。风险点：validate 失败时的半成品目录清理（复用 `installPinnedRuntime` 已有的 remove-incomplete 分支 `pinnedRuntime.ts:305-312`）与 prune 竞态（沿用 1 小时宽限即可）。
