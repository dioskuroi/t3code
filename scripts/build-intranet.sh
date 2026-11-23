#!/bin/sh
# Builds the intranet app, bundle, checksums and install note into release/.
# See docs/operations/intranet-build.md for what is checked, why the app is re-signed, and why
# the dmg is made here rather than by upstream's dmg-builder.
# Usage: sh scripts/build-intranet.sh --omp-kit <dir> [--version <version>] [--archive <zip>]
set -eu

usage() {
  echo "usage: $0 --omp-kit <dir> [--version <version>] [--archive <zip>]" >&2
  exit 2
}

needs_value() {
  [ "$#" -ge 2 ] && [ -n "$2" ] || usage
}

OMP_KIT=""
VERSION=""
ARCHIVE=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --omp-kit) needs_value "$@"; OMP_KIT="$2"; shift 2 ;;
    --version) needs_value "$@"; VERSION="$2"; shift 2 ;;
    --archive) needs_value "$@"; ARCHIVE="$2"; shift 2 ;;
    *) usage ;;
  esac
done
[ -n "$OMP_KIT" ] && [ -d "$OMP_KIT" ] || usage
[ -f scripts/build-desktop-artifact.ts ] || {
  echo "run this from the fork root" >&2
  exit 2
}

if [ -z "$VERSION" ]; then
  TAG=$(git describe --tags --exact-match intranet/base 2>/dev/null) || {
    echo "intranet/base has no exact tag; pass --version" >&2
    exit 1
  }
  VERSION=${TAG#v}
fi

# Login, updates and T3 Connect are compiled out only while none of these has a value. The build
# also reads them from a repo-root .env / .env.local and through the VITE_* aliases
# (scripts/lib/public-config.ts).
CLOUD_VARIABLES="T3CODE_RELAY_URL T3CODE_CLERK_PUBLISHABLE_KEY T3CODE_CLERK_CLI_OAUTH_CLIENT_ID
  GITHUB_REPOSITORY T3CODE_DESKTOP_UPDATE_REPOSITORY VITE_T3CODE_RELAY_URL
  VITE_CLERK_PUBLISHABLE_KEY VITE_CLERK_CLI_OAUTH_CLIENT_ID"
for name in $CLOUD_VARIABLES; do
  eval "value=\${$name-}"
  if [ -n "$value" ]; then
    echo "$name is set; unset it before building the intranet app" >&2
    exit 1
  fi
done
for file in .env .env.local; do
  [ -f "$file" ] || continue
  for name in $CLOUD_VARIABLES; do
    if grep -Eq "^[[:space:]]*(export[[:space:]]+)?${name}=[[:space:]]*[^[:space:]]" "$file"; then
      echo "$file gives $name a value; remove it before building the intranet app" >&2
      exit 1
    fi
  done
done

MANIFESTS="apps/desktop/package.json apps/server/package.json apps/web/package.json packages/contracts/package.json"
git diff --quiet -- $MANIFESTS || {
  echo "package manifests have local changes; commit or revert them first" >&2
  exit 1
}

sh scripts/intranet-patch-budget.sh

STAGE=$(mktemp -d)
DONE="$STAGE/done"
restore() {
  git checkout -q -- $MANIFESTS
  rm -rf "$STAGE"
}
trap 'restore' EXIT
DMG="T3-Code-$VERSION-intranet-arm64.dmg"
BUNDLE="t3code-intranet-bundle-$VERSION-mac-arm64.tar.gz"

# Errexit stays off from here on, so the manifests are restored on every path without relying on
# the trap above (it only covers signals). The steps run in a plain subshell with errexit, where the
# first failure stops the rest. That subshell must not sit in a `||` or `if` condition: there the
# shell ignores errexit for the whole subshell even after `set -e`, and a failed step would be
# followed by the next one. Success is judged by the marker the last step writes.
set +e
node scripts/update-release-package-versions.ts "$VERSION" || {
  restore
  exit 1
}
(
  set -eu
  rm -rf release/mac-arm64
  rm -f "release/$DMG" "release/$BUNDLE" release/SHA256SUMS release/安装说明.md
  node scripts/build-desktop-artifact.ts --platform mac --target dir --arch arm64

  APP=$(ls -d release/mac-arm64/*.app | head -1)
  [ -n "$APP" ] || {
    echo "no packaged .app under release/mac-arm64" >&2
    exit 1
  }
  RESOURCES="$APP/Contents/Resources"
  [ ! -e "$RESOURCES/app-update.yml" ] || {
    echo "app-update.yml is present: the app would look for updates" >&2
    exit 1
  }
  if grep -a -q -E 'pk_(live|test)_[A-Za-z0-9]{10,}' "$RESOURCES/app.asar"; then
    echo "a Clerk publishable key is compiled into app.asar: the login surface is not off" >&2
    exit 1
  fi
  codesign --force --deep --sign - --timestamp=none "$APP"
  codesign --verify --deep --strict "$APP"

  cp -Rp "$APP" "$STAGE/"
  ln -s /Applications "$STAGE/Applications"
  hdiutil create -volname "T3 Code $VERSION" -srcfolder "$STAGE" -ov -format UDZO -fs HFS+ \
    "release/$DMG" >/dev/null

  sh scripts/build-intranet-bundle.sh --omp-kit "$OMP_KIT" ${ARCHIVE:+--archive "$ARCHIVE"}
  cp packaging/intranet/安装说明.md release/安装说明.md
  (cd release && shasum -a 256 "$DMG" "$BUNDLE" > SHA256SUMS && shasum -a 256 -c SHA256SUMS)
  : > "$DONE"
)
ok=no
[ -f "$DONE" ] && ok=yes
restore
if [ "$ok" != yes ]; then
  rm -f "release/$DMG" "release/$BUNDLE"
  echo "intranet build failed; see the output above" >&2
  exit 1
fi
