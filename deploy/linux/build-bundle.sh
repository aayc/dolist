#!/usr/bin/env bash
# Builds the always-on machine's bundle, ddl-linux-<arch>.tar.gz: the daemon with its production
# dependencies, the built web app where the daemon looks for it, the sync service and a README.
# It runs on the system Node.js 24.4+ of a glibc Linux (Ubuntu LTS). Works on Linux and macOS.
#
#   deploy/linux/build-bundle.sh [--arch x64|arm64] [--output DIR]
#
#   --arch ARCH    target CPU (default: this machine's). Optional native packages are installed for
#                  linux-ARCH (glibc) whatever machine builds the bundle.
#   --output DIR   where to write the tarball and its .sha256 (default: deploy/linux/build, which
#                  is gitignored)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ARCH=""
OUTPUT="$SCRIPT_DIR/build"

usage() { sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; }
step() { printf '\n==> %s\n' "$*"; }
fail() {
  echo "build-bundle: $*" >&2
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --arch)
      [ $# -ge 2 ] || fail "--arch needs x64 or arm64"
      ARCH="$2"
      shift
      ;;
    --output)
      [ $# -ge 2 ] || fail "--output needs a directory"
      OUTPUT="$2"
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      fail "unknown option: $1"
      ;;
  esac
  shift
done

if [ -z "$ARCH" ]; then
  case "$(uname -m)" in
    x86_64 | amd64) ARCH=x64 ;;
    aarch64 | arm64) ARCH=arm64 ;;
    *) fail "unknown CPU $(uname -m); pass --arch x64 or --arch arm64" ;;
  esac
fi
case "$ARCH" in
  x64 | arm64) ;;
  *) fail "--arch must be x64 or arm64 (got $ARCH)" ;;
esac

command -v node >/dev/null 2>&1 || fail "needs Node.js 24.4+"
command -v pnpm >/dev/null 2>&1 || fail "needs pnpm (corepack enable)"
node -e 'const [a, b] = process.versions.node.split(".").map(Number);
process.exit(a > 24 || (a === 24 && b >= 4) ? 0 : 1)' ||
  fail "needs Node.js 24.4+ (found $(node --version))"

NAME="ddl-linux-$ARCH"
mkdir -p "$OUTPUT"
OUTPUT="$(cd "$OUTPUT" && pwd)"
WORK="$OUTPUT/.work"
STAGE="$WORK/$NAME"
DEPLOY="$WORK/daemon-deploy"
TARBALL="$OUTPUT/$NAME.tar.gz"
rm -rf "$WORK"
mkdir -p "$WORK"

# 1. Build ----------------------------------------------------------------------------------------
step "Building the daemon, the web app and the sync service"
(cd "$REPO_ROOT" && pnpm exec turbo run build --filter=@ddl/daemon --filter=@ddl/web --filter=@ddl/sync)

# 2. The daemon's production dependencies, for the target platform --------------------------------
step "Installing the daemon's production dependencies for linux-$ARCH"
# Same as the Mac app (apps/macos/scripts/build-app.sh): pnpm 10 deploys a workspace package only
# with --legacy, whose .pnpm store uses relative symlinks. --os/--cpu/--libc pick the optional
# native packages (esbuild's binary, pulled in by the Pi harness) for the VM, not this machine.
(cd "$REPO_ROOT" && pnpm --filter @ddl/daemon deploy --prod --legacy --ignore-scripts \
  --os=linux --cpu="$ARCH" --libc=glibc "$DEPLOY")

# 3. Layout: the daemon resolves its web app at <dist/main.js>/../../web/dist ---------------------
step "Assembling $NAME"
DAEMON="$STAGE/daemon"
mkdir -p "$DAEMON" "$STAGE/web" "$STAGE/sync"
# package.json carries "type": "module", which dist/main.js needs. Moved, not copied: the deploy
# is scratch, and copying node_modules file by file takes minutes on macOS.
mv "$DEPLOY/package.json" "$DEPLOY/dist" "$DEPLOY/node_modules" "$DAEMON/"
# Not needed at runtime: the workspace packages (inlined into dist/), bin shims and pnpm metadata
# (which embeds absolute paths of this machine).
rm -rf "$DAEMON/node_modules/@ddl" "$DAEMON/node_modules/.pnpm/node_modules/@ddl" \
  "$DAEMON/node_modules/.modules.yaml" "$DAEMON/node_modules/.pnpm/lock.yaml"
find "$DAEMON/node_modules/.pnpm" -maxdepth 1 -name '@ddl+*' -exec rm -rf {} +
find "$DAEMON/node_modules" -name .bin -prune -exec rm -rf {} +
find "$DAEMON" -type l ! -exec test -e {} \; -exec rm -f {} +

cp -RP "$REPO_ROOT/apps/web/dist" "$STAGE/web/dist"
rm -rf "$STAGE/web/dist/.vite"

cp -RP "$REPO_ROOT/apps/sync/dist" "$STAGE/sync/dist"
printf '{ "name": "ddl-sync", "private": true, "type": "module" }\n' >"$STAGE/sync/package.json"

cp "$SCRIPT_DIR/bundle-readme.md" "$STAGE/README.md"
cp "$REPO_ROOT/LICENSE" "$REPO_ROOT/THIRD_PARTY_NOTICES.md" "$STAGE/"

VERSION="$(cd "$REPO_ROOT" && node -p 'JSON.parse(require("node:fs").readFileSync("package.json", "utf8")).version')"
COMMIT="$(git -C "$REPO_ROOT" rev-parse --short=12 HEAD 2>/dev/null || echo unknown)"
if [ "$COMMIT" != unknown ] && ! git -C "$REPO_ROOT" diff --quiet HEAD 2>/dev/null; then
  COMMIT="$COMMIT-dirty"
fi
# shellcheck disable=SC2016 # a JavaScript template literal
BUNDLE_NAME="$NAME" BUNDLE_VERSION="$VERSION" BUNDLE_COMMIT="$COMMIT" BUNDLE_ARCH="$ARCH" node -e '
const env = process.env;
const info = {
  name: env.BUNDLE_NAME,
  version: env.BUNDLE_VERSION,
  commit: env.BUNDLE_COMMIT,
  release: `${env.BUNDLE_VERSION}-${env.BUNDLE_COMMIT}`,
  platform: "linux",
  arch: env.BUNDLE_ARCH,
  node: ">=24.4.0",
  builtAt: new Date().toISOString(),
};
process.stdout.write(`${JSON.stringify(info, null, 2)}\n`);
' >"$STAGE/bundle.json"

# 4. Checks ---------------------------------------------------------------------------------------
step "Checking the bundle"
for file in daemon/dist/main.js daemon/package.json web/dist/index.html sync/dist/main.js; do
  [ -f "$STAGE/$file" ] || fail "the bundle has no $file"
done
if [ -n "$(find "$STAGE" -type l -lname '/*' | head -n 1)" ]; then
  fail "the bundle contains absolute symlinks"
fi
foreign="$(find "$DAEMON/node_modules/.pnpm" -maxdepth 1 \( -name '*darwin*' -o -name '*win32*' \
  -o \( -name '*linux-*' ! -name "*linux-$ARCH*" \) \) | head -n 1)"
[ -z "$foreign" ] || fail "a dependency for another platform slipped in: ${foreign##*/}"
# The tarball may be published (CI artifacts): no paths of the machine that built it.
grep -rIlF -e "$REPO_ROOT" -e "$HOME/" "$STAGE" >"$WORK/local-paths" || true
if [ -s "$WORK/local-paths" ]; then
  fail "these files contain local paths: $(head -n 3 "$WORK/local-paths" | tr '\n' ' ')"
fi

# 5. Archive --------------------------------------------------------------------------------------
step "Archiving"
rm -f "$TARBALL" "$TARBALL.sha256"
if tar --version 2>/dev/null | grep -q 'GNU tar'; then
  tar -czf "$TARBALL" --owner=0 --group=0 --numeric-owner -C "$WORK" "$NAME"
else
  # bsdtar (macOS): no AppleDouble files or extended attributes, which GNU tar warns about.
  COPYFILE_DISABLE=1 tar -czf "$TARBALL" --uid 0 --gid 0 --uname root --gname root --no-xattrs \
    --no-mac-metadata -C "$WORK" "$NAME"
fi
if command -v sha256sum >/dev/null 2>&1; then
  (cd "$OUTPUT" && sha256sum "$NAME.tar.gz") >"$TARBALL.sha256"
else
  (cd "$OUTPUT" && shasum -a 256 "$NAME.tar.gz") >"$TARBALL.sha256"
fi
rm -rf "$WORK"

step "Done"
echo "Bundle: $TARBALL ($(du -h "$TARBALL" | awk '{print $1}'), release $VERSION-$COMMIT)"
echo "SHA-256: $(cut -d' ' -f1 "$TARBALL.sha256")"
