# 内网版构建（fork）

本 fork（`dioskuroi/t3code`）用于把 T3 Code 部署到无外网的公司内网。背景、调研与完整方案在
[dioskuroi/t3code-migration](https://github.com/dioskuroi/t3code-migration) 的 `docs/spec/intranet-migration.md`。

## 分支

- `intranet/base`：上游 nightly 快照，不做任何修改。升级时把它前移到新的 nightly tag。
- `intranet/main`：`intranet/base` + 内网补丁。每个补丁一个线性小提交。

## 补丁面

上游没有开关、且会自行联网的三个服务端行为，在内网构建里默认关闭。默认值集中在
`apps/server/src/intranet.ts`：

| 文件                                            | 作用                   | 重新开启                         |
| ----------------------------------------------- | ---------------------- | -------------------------------- |
| `apps/server/src/intranet.ts`                   | 内网默认值的唯一来源   | —                                |
| `apps/server/src/usage/UsageService.ts`         | 不再定时拉取模型价格表 | `T3CODE_REMOTE_USAGE_RATES=1`    |
| `apps/server/src/provider/ModelManifest.ts`     | 只用随包内置的模型清单 | `T3CODE_REMOTE_MODEL_MANIFEST=1` |
| `apps/server/src/telemetry/AnalyticsService.ts` | 产品分析默认关闭       | `T3CODE_TELEMETRY_ENABLED=true`  |

- 这两个 `T3CODE_REMOTE_*` 开关只为让上游测试继续覆盖联网路径，以及让有外网的机器能恢复原行为。
  它们**只对终端启动的服务端生效**：桌面版只把登录 shell 发现名单
  （`apps/desktop/src/shell/DesktopShellEnvironment.ts`）里的变量传给服务端，名单里没有它们。
  内网使用不需要重新打开。
- 两个测试文件（`UsageService.test.ts`、`ModelManifest.test.ts`）通过各自的环境层声明打开开关，各另有一个用例覆盖默认不联网。

登录、自动更新、T3 Connect 不需要补丁：构建时不给 `T3CODE_RELAY_URL`、`T3CODE_CLERK_PUBLISHABLE_KEY`、
`T3CODE_CLERK_CLI_OAUTH_CLIENT_ID`、`GITHUB_REPOSITORY`、`T3CODE_DESKTOP_UPDATE_REPOSITORY`，它们就整体停用。

守门：`sh scripts/intranet-patch-budget.sh`，`git diff intranet/base...HEAD` 的源码文件数 ≤ 6（当前 4；超即失败）。
`intranet/main` 上的推送不触发 CI（`ci.yml` 只在 PR 与 `main` 上触发），所以由构建脚本每次执行。

## 构建

在外网机器上、`intranet/main` 检出下执行（依赖装过一次后可省略 `vp i`）：

```sh
vp i
sh scripts/build-intranet.sh --omp-kit <t3code-migration 检出>/intranet-config/omp-acp [--archive <已下载的 chrome-headless-shell zip>]
```

脚本依次完成：

1. 拒绝不可信的构建环境：上列五个变量及其 `VITE_*` 别名在环境里或仓库根 `.env` / `.env.local` 里有值即退出；
   四个 `package.json` 有未提交改动即退出。
2. 补丁面守门。
3. 写入版本号（取 `intranet/base` 所指 tag；上游源码里的版本号停在发布前的值）。
4. `build-desktop-artifact.ts --target dir` 产出 `.app`，然后断言：没有 `app-update.yml`、`app.asar` 里没有
   Clerk 公钥。
5. 重做 adhoc 签名并校验，见下。
6. `hdiutil` 生成 dmg。
7. `scripts/build-intranet-bundle.sh` 组装资源包：按 `PreviewBrowser.ts` 里写死的字节数与 SHA-256 校验浏览器安装包。
8. 产出 `SHA256SUMS`（dmg + 资源包，并自校验）与 `安装说明.md`（源文件是 `packaging/intranet/安装说明.md`），还原版本号。

产物都在 `release/`：dmg、`t3code-intranet-bundle-<版本>-mac-arm64.tar.gz`、`SHA256SUMS`、`安装说明.md`。
把这四样一起拷进内网。

- 工具链：Node 与 pnpm 版本以根 `package.json` 的 `engines` / `packageManager` 为准（pnpm 由 vite-plus 托管），`vp`、
  `node`、`codesign`、`hdiutil` 需在 PATH 上。
- **为什么重签名**：本地没有签名证书时，打包出的 app 沿用 Electron 原始二进制的 adhoc 签名，资源封印与包内文件
  对不上，`codesign --verify` 不通过；这样的 app 一旦带上隔离属性，macOS 会直接报「已损坏」。脚本把整个包重签为
  自洽的 adhoc 签名。adhoc 不是苹果认可的开发商签名：文件带隔离属性时（例如经浏览器下载），首次打开需在
  「系统设置 → 隐私与安全性」里点「仍要打开」；经普通文件拷贝的一般不带该属性。
- **为什么自制 dmg**：上游带背景图的 dmg 流程（dmg-builder）在编写本脚本的机器上卡在 `hdiutil create`，所以脚本用
  `hdiutil create -srcfolder` 生成朴素 dmg。

## 本机预演

构建后、拷进内网前，在构建机上跑一次无界面的端到端：

```sh
sh scripts/intranet-dry-run/run.sh --omp-kit <t3code-migration 检出>/intranet-config/omp-acp
```

它在临时目录里造一个假的 HOME，用包内服务端以命令行模式启动（`serve`），预置一个指向本机 `omp` 的 ACP 实例，
用 `t3 thread start --wait` 新建会话并发一句话，由本地模拟网关应答。服务端的所有 HTTP(S) 请求必须经过本地记录型
代理，代理记下目标主机（带时间戳）并拒绝转发。选项之后可以追加给服务端的环境变量，例如
`T3CODE_REMOTE_MODEL_MANIFEST=1` 用来做对照；排查时加 `--keep` 保留现场目录（omp 日志在其中的 `home/.omp/logs/`）。

输出里「external targets」就是这次运行试图访问的外网主机，omp 那部分每次运行不尽相同。2026-11-24 在
`0.1.12-nightly.20261123.5124`、omp 19.1.1 上的基线：

| 给服务端的环境 | t3code                          | omp                                |
| -------------- | ------------------------------- | ---------------------------------- |
| 出厂默认       | 无                              | `catalog.stencil.so:443`，每次都有 |
| 打开三个开关   | `raw.githubusercontent.com:443` | 同上                               |

t3code 这一列是确定的。omp 的外联有两类，都没有设置能整体关掉，失败后都回退内置目录，对话照常完成：

- `catalog.stencil.so:443`：获取共享模型目录，每次启动都有。
- 内置云端 provider 的模型列表地址：启动时的模型刷新在没有凭据时也会偶发去拉，与时序有关。已观察到
  `coding-intl.dashscope.aliyuncs.com:443`（`alibaba-coding-plan`）和 `hyper.charm.land:443`（`charm-hyper`）：
  出厂默认下约 16 次出现 1 次，打开三个开关时约 11 次出现 10 次。

配置包设的 `enabledProviders` 只影响模型选择器，两类都挡不住；`disabledProviders` 能挡住点到名的 provider，但探测会
落到别的内置 provider 上。所以要多跑几次再对照基线，单次结果不算数。出现上表以外的主机，说明上游或 omp 新增了外联，
先弄清再分发。

预演看不到的：图形界面（见下）、WebSocket 与原始 TCP 外联、长时间空闲、真实网关。
**图形界面无法在装有官方版的机器上隔离启动**：构建产物与官方版身份相同（同一个 userData 目录），启动会被并进官方版。
界面事实（无登录入口、添加实例、选模型、中文）在内网机器首次启动时确认。

## 升级

```sh
git fetch upstream --tags
git branch -f intranet/base <新的 nightly tag>
git rebase intranet/main   # 冲突只应出现在上表四个文件和两个测试文件里
```

然后按「构建」重新构建、按「本机预演」核对基线，再重新分发。补丁若已被上游提供的开关取代，直接删掉对应提交。
