#!/bin/sh
# Builds everything that goes into the intranet, from an intranet/main checkout:
#
#   release/T3-Code-<version>-intranet-arm64.dmg
#   release/t3code-intranet-bundle-<version>-mac-arm64.tar.gz (and .sha256)
#
#   sh scripts/build-intranet.sh --omp-kit <dir> [--version <version>] [--archive <zip>]
#
# The version defaults to the tag intranet/base points at, without its leading "v". It is stamped
# into the package manifests for the build and restored afterwards. Login, updates and T3 Connect
# are compiled out only when the upstream cloud variables below stay unset in this shell.
#
# Local builds have no signing certificate. The packaged app then keeps the ad-hoc signature of
# the stock Electron binaries, whose resource seal no longer matches: macOS reports such an app as
# damaged as soon as it carries a quarantine attribute. The script therefore re-signs the whole
# bundle ad-hoc, which verifies clean, and makes a plain dmg itself. Upstream's styled dmg step
# (dmg-builder) is not used; it stalled at `hdiutil create` on the machine this was written on.
set -eu

usage() {
  echo "usage: $0 --omp-kit <dir> [--version <version>] [--archive <zip>]" >&2
  exit 2
}

OMP_KIT=""
VERSION=""
ARCHIVE=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --omp-kit) OMP_KIT="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    --archive) ARCHIVE="$2"; shift 2 ;;
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

for name in GITHUB_REPOSITORY T3CODE_RELAY_URL T3CODE_CLERK_PUBLISHABLE_KEY \
  T3CODE_CLERK_CLI_OAUTH_CLIENT_ID T3CODE_DESKTOP_UPDATE_REPOSITORY; do
  if printenv "$name" >/dev/null 2>&1; then
    echo "$name is set; unset it before building the intranet app" >&2
    exit 1
  fi
done

MANIFESTS="apps/desktop/package.json apps/server/package.json apps/web/package.json packages/contracts/package.json"
git diff --quiet -- $MANIFESTS || {
  echo "package manifests have local changes; commit or revert them first" >&2
  exit 1
}

sh scripts/intranet-patch-budget.sh
node scripts/update-release-package-versions.ts "$VERSION"
trap 'git checkout -q -- $MANIFESTS' EXIT

STAGE=$(mktemp -d)
restore() {
  git checkout -q -- $MANIFESTS
  rm -rf "$STAGE"
}
trap 'restore' EXIT

# The build runs in a subshell with errexit, so the first failure stops it, and the manifests are
# restored here either way. An EXIT trap alone is not enough: `sh scripts/...` does not run it on
# every shell.
result=0
(
  set -eu
  rm -rf release/mac-arm64
  node scripts/build-desktop-artifact.ts --platform mac --target dir --arch arm64

  APP=$(ls -d release/mac-arm64/*.app | head -1)
  [ -n "$APP" ] || {
    echo "no packaged .app under release/mac-arm64" >&2
    exit 1
  }
  codesign --force --deep --sign - --timestamp=none "$APP"
  codesign --verify --deep --strict "$APP"

  cp -Rp "$APP" "$STAGE/"
  ln -s /Applications "$STAGE/Applications"
  DMG="release/T3-Code-$VERSION-intranet-arm64.dmg"
  rm -f "$DMG" "$DMG.sha256"
  hdiutil create -volname "T3 Code $VERSION" -srcfolder "$STAGE" -ov -format UDZO -fs HFS+ "$DMG" >/dev/null
  (cd release && shasum -a 256 "$(basename "$DMG")" > "$(basename "$DMG").sha256")

  sh scripts/build-intranet-bundle.sh --omp-kit "$OMP_KIT" ${ARCHIVE:+--archive "$ARCHIVE"}
) || result=$?
restore
exit "$result"
