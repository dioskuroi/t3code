#!/bin/sh
# Assembles the intranet resource bundle: the preview browser seed, the omp ACP config kit and
# install.sh. Run from the fork root:
#
#   sh scripts/build-intranet-bundle.sh --omp-kit <dir> [--archive <chrome-headless-shell zip>] [--out <dir>]
#
# --omp-kit   directory holding the omp(acp) config kit (intranet-config/omp-acp in
#             dioskuroi/t3code-migration).
# --archive   an already downloaded Chrome for Testing zip. Without it the zip is downloaded from
#             storage.googleapis.com. Either way it must match the byte size and SHA-256 pinned in
#             apps/server/src/preview/PreviewBrowser.ts, so the seed always fits this exact build.
# --out       output directory, release/ by default.
set -eu

usage() {
  echo "usage: $0 --omp-kit <dir> [--archive <zip>] [--out <dir>]" >&2
  exit 2
}

OMP_KIT=""
ARCHIVE=""
OUT="release"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --omp-kit) OMP_KIT="$2"; shift 2 ;;
    --archive) ARCHIVE="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    *) usage ;;
  esac
done
[ -n "$OMP_KIT" ] && [ -d "$OMP_KIT" ] || usage
[ -f packaging/intranet/install.sh ] || {
  echo "run this from the fork root" >&2
  exit 2
}

RELEASE_SOURCE=apps/server/src/preview/PreviewBrowser.ts
VERSION=$(sed -n 's/^export const VERSION = "\(.*\)";$/\1/p' "$RELEASE_SOURCE")
BYTES=$(awk '/^  "mac-arm64": \{/{f=1} f && /bytes:/{gsub(/[^0-9]/, "", $2); print $2; exit}' "$RELEASE_SOURCE")
SHA256=$(awk '/^  "mac-arm64": \{/{f=1} f && /sha256:/{print $2; exit}' "$RELEASE_SOURCE" | tr -dc '0-9a-f')
[ -n "$VERSION" ] && [ -n "$BYTES" ] && [ -n "$SHA256" ] || {
  echo "could not read the mac-arm64 release from $RELEASE_SOURCE" >&2
  exit 1
}
APP_VERSION=$(sed -n 's/^  "version": "\(.*\)",$/\1/p' apps/server/package.json)
NAME="t3code-intranet-bundle-$APP_VERSION-mac-arm64"

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
ROOT="$STAGE/$NAME"
mkdir -p "$ROOT/chrome-headless-shell" "$ROOT/omp-acp"

ZIP="$ARCHIVE"
if [ -z "$ZIP" ]; then
  ZIP="$STAGE/chrome-headless-shell-mac-arm64.zip"
  echo "downloading chrome-headless-shell $VERSION"
  curl -fsSL -o "$ZIP" \
    "https://storage.googleapis.com/chrome-for-testing-public/$VERSION/mac-arm64/chrome-headless-shell-mac-arm64.zip"
fi
[ "$(wc -c < "$ZIP" | tr -d ' ')" = "$BYTES" ] || {
  echo "archive size mismatch, expected $BYTES bytes" >&2
  exit 1
}
[ "$(shasum -a 256 "$ZIP" | awk '{print $1}')" = "$SHA256" ] || {
  echo "archive sha256 mismatch, expected $SHA256" >&2
  exit 1
}

# Same layout the app installs into: the archive's top-level directory is dropped, modes are kept.
unzip -q -o "$ZIP" -d "$STAGE/unpacked"
cp -Rp "$STAGE/unpacked/chrome-headless-shell-mac-arm64/." "$ROOT/chrome-headless-shell/"
[ -x "$ROOT/chrome-headless-shell/chrome-headless-shell" ] || {
  echo "chrome-headless-shell executable missing after unpack" >&2
  exit 1
}

cp -Rp "$OMP_KIT/." "$ROOT/omp-acp/"
cp packaging/intranet/install.sh "$ROOT/install.sh"
cp packaging/intranet/README.md "$ROOT/README.md"
chmod +x "$ROOT/install.sh"
printf 'CHROME_VERSION=%s\nT3CODE_VERSION=%s\n' "$VERSION" "$APP_VERSION" > "$ROOT/bundle.env"

mkdir -p "$OUT"
tar -C "$STAGE" -czf "$OUT/$NAME.tar.gz" "$NAME"
(cd "$OUT" && shasum -a 256 "$NAME.tar.gz" > "$NAME.tar.gz.sha256")
rm -rf "$STAGE"
echo "wrote $OUT/$NAME.tar.gz"
