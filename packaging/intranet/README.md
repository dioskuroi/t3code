# t3code 内网资源包

配套的 t3code dmg 需要单独安装。本包只补齐 dmg 装不进去的两样东西：

- `chrome-headless-shell/`：t3code 预览功能用的浏览器。内网下载不了，由 `install.sh` 放到位。
- `omp-acp/`：omp 接入内网网关与 t3code 的配置包，按其中 `README.md` 操作。

## 安装

```sh
sh install.sh
```

脚本幂等，重复执行只会提示「已就位」。它写入的目录是 `$T3CODE_HOME/tools/chrome-headless-shell/mac-arm64/<版本>`
（未设置 `T3CODE_HOME` 时为 `~/.t3/tools/...`），不碰其他任何文件。

`chrome-headless-shell` 的版本必须与 dmg 同批构建，所以资源包和 dmg 要成对安装、成对升级。
