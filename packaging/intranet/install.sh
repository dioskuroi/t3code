#!/bin/sh
# Places the preview browser that t3code would otherwise download from the internet.
# Idempotent: a completed copy is left alone and an interrupted one is replaced.
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/bundle.env"

T3_HOME="${T3CODE_HOME:-$HOME/.t3}"
PARENT="$T3_HOME/tools/chrome-headless-shell/mac-arm64"
TARGET="$PARENT/$CHROME_VERSION"

if [ -f "$TARGET/.bundle-complete" ] && [ -x "$TARGET/chrome-headless-shell" ]; then
  echo "chrome-headless-shell $CHROME_VERSION 已就位：$TARGET"
else
  mkdir -p "$PARENT"
  rm -rf "$PARENT"/.staging.*
  STAGING=$(mktemp -d "$PARENT/.staging.XXXXXX")
  cp -Rp "$HERE/chrome-headless-shell/." "$STAGING/" || {
    rm -rf "$STAGING"
    exit 1
  }
  chmod +x "$STAGING/chrome-headless-shell"
  touch "$STAGING/.bundle-complete"
  rm -rf "$TARGET"
  mv "$STAGING" "$TARGET"
  echo "已落位 chrome-headless-shell $CHROME_VERSION：$TARGET"
fi

echo "omp 配置包在：$HERE/omp-acp（按其中 README.md 操作）"
