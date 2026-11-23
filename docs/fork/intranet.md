# 内网版 fork 说明

本 fork（`dioskuroi/t3code`）用于把 T3 Code 部署到无外网的公司内网。背景、调研与完整方案在
[dioskuroi/t3code-migration](https://github.com/dioskuroi/t3code-migration) 的 `docs/spec/intranet-migration.md`。

## 分支

- `intranet/base`：上游 nightly 快照，不做任何修改。升级时把它前移到新的 nightly tag。
- `intranet/main`：`intranet/base` + 内网补丁。每个补丁一个线性小提交。

## 补丁面

上游没有开关、且会自行联网的三个服务端行为，在内网构建里默认关闭。开关集中在 `apps/server/src/intranet.ts`：

| 文件                                            | 作用                         | 重新开启的方式                   |
| ----------------------------------------------- | ---------------------------- | -------------------------------- |
| `apps/server/src/intranet.ts`                   | 内网构建的默认值（唯一来源） | —                                |
| `apps/server/src/usage/UsageService.ts`         | 不再定时拉取模型价格表       | `T3CODE_REMOTE_USAGE_RATES=1`    |
| `apps/server/src/provider/ModelManifest.ts`     | 只用随包内置的模型清单       | `T3CODE_REMOTE_MODEL_MANIFEST=1` |
| `apps/server/src/telemetry/AnalyticsService.ts` | 产品分析默认关闭             | `T3CODE_TELEMETRY_ENABLED=true`  |

两个测试文件（`UsageService.test.ts`、`ModelManifest.test.ts`）在顶部声明开启开关，继续覆盖联网路径；
各另有一个用例覆盖默认不联网。

登录、自动更新、T3 Connect 不需要补丁：构建时不给 `T3CODE_RELAY_URL`、`T3CODE_CLERK_PUBLISHABLE_KEY`、
`T3CODE_CLERK_CLI_OAUTH_CLIENT_ID`、`GITHUB_REPOSITORY`，它们就整体停用。

守门：`sh scripts/intranet-patch-budget.sh`，源码补丁面超过 6 个文件即失败。

## 构建

在外网机器上、`intranet/main` 检出下执行（依赖装过一次后可省略 `vp i`）：

```sh
vp i
sh scripts/build-intranet.sh --omp-kit <t3code-migration 检出>/intranet-config/omp-acp
```

- 一条命令依次完成：补丁面守门、写入版本号（取 `intranet/base` 所指的 tag）、构建出 `.app`、重做 adhoc
  签名并校验、生成 dmg、组装资源包、还原版本号。
- Node 与 pnpm 版本以根 `package.json` 的 `engines` / `packageManager` 为准，`vp` 与 Node 需在 PATH 上。
- 构建环境里不要设置上面列出的四个变量，脚本检测到会直接报错退出。
- 为什么重签名：本地没有签名证书时，打包出的 app 沿用 Electron 原始二进制的 adhoc 签名，资源封印与包内
  文件对不上，`codesign --verify` 不通过；这样的 app 一旦带上隔离属性，macOS 会直接报「已损坏」。脚本把
  整个包重签为自洽的 adhoc 签名。adhoc 不是苹果认可的开发商签名：文件带隔离属性时（例如经浏览器
  下载），首次打开需在「系统设置 → 隐私与安全性」里点「仍要打开」；经普通文件拷贝的一般不带该属性。
- 为什么自制 dmg：上游带背景图的 dmg 流程（dmg-builder）在编写本脚本的机器上卡在 `hdiutil create`，
  所以脚本用 `hdiutil create -srcfolder` 生成朴素 dmg。
- 产物：`release/` 下的 dmg，以及 `t3code-intranet-bundle-<版本>-mac-arm64.tar.gz`（预览浏览器种子 +
  omp 配置包 + `install.sh`）。
- 资源包脚本会按 `PreviewBrowser.ts` 里写死的字节数和 SHA-256 校验浏览器安装包，所以资源包与 dmg
  必须同一次构建产出。

## 升级

```sh
git fetch upstream --tags
git branch -f intranet/base <新的 nightly tag>
git rebase intranet/base intranet/main   # 冲突只应出现在上表四个文件和两个测试文件里
sh scripts/intranet-patch-budget.sh
```

然后按「构建」重新构建并重新分发。补丁若已被上游提供的开关取代，直接删掉对应提交。
