#!/bin/sh
# t3code 内网资源包安装脚本（macOS）。幂等，可重复执行。
# 只做一件事：把 t3code 预览浏览器需要的 chrome-headless-shell 落位到 T3 home。
# 不修改 ~/.omp，也不修改 t3code 的任何设置。
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/bundle.env"

T3_HOME="${T3CODE_HOME:-$HOME/.t3}"
TARGET="$T3_HOME/tools/chrome-headless-shell/mac-arm64/$CHROME_VERSION"

if [ -x "$TARGET/chrome-headless-shell" ]; then
  echo "chrome-headless-shell $CHROME_VERSION 已就位：$TARGET"
else
  mkdir -p "$TARGET"
  cp -Rp "$HERE/chrome-headless-shell/." "$TARGET/"
  chmod +x "$TARGET/chrome-headless-shell"
  echo "已落位 chrome-headless-shell $CHROME_VERSION：$TARGET"
fi

echo "omp 配置包在：$HERE/omp-acp（按其中 README.md 操作）"
