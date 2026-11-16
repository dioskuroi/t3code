# Runtime 种子脚本（离线 pinned runtime）

fork 的 renamed 版本号（如 `0.1.7-omp.1`）在上游 release feed 不存在，`t3 service install` 会因 404 失败。本脚本把已验证的手动 workaround 固化为一条命令：本地构建 → 直接填出 `~/.t3/runtime/versions/<version>/` 并写 `.install-complete` sentinel，之后 `t3 service install` sentinel 命中、全程无网络。

设计与决策记录：[migration repo spec](https://github.com/dioskuroi/t3code-migration/blob/main/docs/spec/runtime-seed-script.md)（方向决议见 [#30](https://github.com/dioskuroi/t3code-migration/issues/30)）。

`docs/fork/` 是 fork 专属文档命名空间（与上游 docs/ 各类并列）：放只对 fork 维护者有意义、上游永不会收的内容，隔离以减 rebase 冲突。

## 用法

```bash
node scripts/seed-pinned-runtime.mjs [--skip-build] [--force]
```

- 版本号读 `apps/server/package.json`，与 SEA 烧入版本一致才写 sentinel；platform/arch 固定本机。
- `--skip-build`：产物已在，只重做归档 + 种子（秒级）。
- `--force`：无视已种的合法目录强制重种；服务正跑该版本时需重启后台服务才吃到新构建。
- 已种且合法 → no-op 退出 0；半成品/损坏 → 自动重种。

前置：用 Node 26.12.1 启动（build-exe 自带硬检查；脚本会把该 node 与仓库 `node_modules/.bin` 前置到子进程 PATH，`vp` 无需全局安装）、cargo、workspace 已 `pnpm install`。home 解析 `T3CODE_HOME` > `~/.t3`。

## rebase 循环中的位置

每次 rebase 出新版本号后：`pnpm install` → （改代码，bump `apps/server/package.json` 版本号）→ `node scripts/seed-pinned-runtime.mjs` → `t3 service install`。种子后 1 小时 prune 宽限内要完成 install（或确认服务 activeVersion 已指向该版本）。

## 失败排查

- `could not run cargo/vp`：前置不在 PATH。
- `--skip-build: .../dist-exe/t3 is missing`：先跑一次完整构建。
- `staged entry ... reports <v>; expected <version>`：目录名与 SEA 版本不一致——确认没手改版本号后重跑构建。
