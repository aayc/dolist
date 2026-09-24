#!/bin/sh
# Builds "Daily Do List.app" from the Swift package. The Command Line Tools are enough (no Xcode).
#
#   apps/macos/scripts/build-app.sh [--release] [--with-daemon] [--output DIR] [--zip] [--open]
#
#   --release       optimized build (default: debug)
#   --with-daemon   bundle a self-contained daemon (dist/ + production node_modules) in
#                   Contents/Resources/daemon; it runs on the system Node.js (24.4+)
#   --output DIR    where to write the app (default: apps/macos/build, which is gitignored)
#   --zip           also write "Daily Do List.zip" next to the app (ditto keeps the signature)
#   --open          launch the app when done
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MACOS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$MACOS_DIR/../.." && pwd)"
APP_NAME="Daily Do List"
EXECUTABLE="DailyDoList"

CONFIGURATION=debug
WITH_DAEMON=0
OUTPUT="$MACOS_DIR/build"
ZIP=0
OPEN=0

usage() { sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; }
step() { printf '\n==> %s\n' "$*"; }
fail() {
  echo "build-app: $*" >&2
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --release) CONFIGURATION=release ;;
    --debug) CONFIGURATION=debug ;;
    --with-daemon) WITH_DAEMON=1 ;;
    --output)
      [ $# -ge 2 ] || fail "--output needs a directory"
      OUTPUT="$2"
      shift
      ;;
    --zip) ZIP=1 ;;
    --open) OPEN=1 ;;
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

mkdir -p "$OUTPUT"
OUTPUT="$(cd "$OUTPUT" && pwd)"
APP="$OUTPUT/$APP_NAME.app"
# Intermediate files (icon cache, daemon deploy) that survive between builds.
WORK="$OUTPUT/.work"
mkdir -p "$WORK"

# 1. Compile ---------------------------------------------------------------------------------------
step "Building $EXECUTABLE ($CONFIGURATION)"
swift build --package-path "$MACOS_DIR" -c "$CONFIGURATION" --product "$EXECUTABLE"
BIN_DIR="$(swift build --package-path "$MACOS_DIR" -c "$CONFIGURATION" --show-bin-path)"
[ -x "$BIN_DIR/$EXECUTABLE" ] || fail "no executable at $BIN_DIR/$EXECUTABLE"

# 2. Version: apps/macos/VERSION, else the root package.json; build number: commit count ---------
VERSION=""
if [ -f "$MACOS_DIR/VERSION" ]; then
  VERSION="$(tr -d ' \t\r\n' <"$MACOS_DIR/VERSION")"
fi
if [ -z "$VERSION" ]; then
  VERSION="$(sed -n 's/^  "version": *"\([^"]*\)".*/\1/p' "$REPO_ROOT/package.json" | head -n 1)"
fi
[ -n "$VERSION" ] || fail "could not determine the version (apps/macos/VERSION or package.json)"
BUILD_NUMBER="$(git -C "$REPO_ROOT" rev-list --count HEAD 2>/dev/null || date +%Y%m%d%H%M)"

# 3. Bundle layout ---------------------------------------------------------------------------------
step "Assembling $APP_NAME.app $VERSION ($BUILD_NUMBER)"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN_DIR/$EXECUTABLE" "$APP/Contents/MacOS/$EXECUTABLE"
# SwiftPM resource bundles, if any package declares resources. Note: the generated Bundle.module
# looks next to the .app (where codesign forbids files), so packages should read resources from
# Bundle.main.resourceURL instead.
for bundle in "$BIN_DIR"/*.bundle; do
  if [ -d "$bundle" ]; then cp -R "$bundle" "$APP/Contents/Resources/"; fi
done
PLIST="$APP/Contents/Info.plist"
cp "$MACOS_DIR/Resources/Info.plist.template" "$PLIST"
plutil -replace CFBundleShortVersionString -string "$VERSION" "$PLIST"
plutil -replace CFBundleVersion -string "$BUILD_NUMBER" "$PLIST"
plutil -lint "$PLIST" >/dev/null
printf 'APPL????' >"$APP/Contents/PkgInfo"

# 4. Icon: rendered by make-icon.swift, cached until the script changes ---------------------------
ICNS="$WORK/AppIcon.icns"
if [ ! -f "$ICNS" ] || [ "$SCRIPT_DIR/make-icon.swift" -nt "$ICNS" ]; then
  step "Rendering the app icon"
  rm -rf "$WORK/AppIcon.iconset"
  swift "$SCRIPT_DIR/make-icon.swift" --iconset "$WORK/AppIcon.iconset"
  iconutil -c icns -o "$ICNS" "$WORK/AppIcon.iconset"
fi
cp "$ICNS" "$APP/Contents/Resources/AppIcon.icns"

# 5. Daemon (optional) -----------------------------------------------------------------------------
if [ "$WITH_DAEMON" = 1 ]; then
  step "Bundling the daemon"
  command -v pnpm >/dev/null 2>&1 || fail "--with-daemon needs pnpm (and Node.js 24.4+)"
  (cd "$REPO_ROOT" && pnpm --filter @ddl/daemon build)
  DEPLOY="$WORK/daemon-deploy"
  rm -rf "$DEPLOY"
  # pnpm 10 refuses to deploy workspaces without inject-workspace-packages unless --legacy. The
  # legacy layout (a .pnpm store with relative symlinks) is fine: codesign accepts relative links,
  # and the workspace packages are inlined into dist/main.js anyway. No lifecycle scripts run.
  (cd "$REPO_ROOT" && pnpm --filter @ddl/daemon deploy --prod --legacy --ignore-scripts "$DEPLOY")
  DAEMON="$APP/Contents/Resources/daemon"
  mkdir -p "$DAEMON"
  # package.json carries "type": "module", which dist/main.js needs.
  ditto "$DEPLOY/package.json" "$DAEMON/package.json"
  ditto "$DEPLOY/dist" "$DAEMON/dist"
  ditto "$DEPLOY/node_modules" "$DAEMON/node_modules"
  # Not needed at runtime: bundled workspace packages, bin shims and pnpm metadata (which embed
  # absolute paths of this machine).
  rm -rf "$DAEMON/node_modules/@ddl" "$DAEMON/node_modules/.pnpm/node_modules/@ddl" \
    "$DAEMON/node_modules/.modules.yaml" "$DAEMON/node_modules/.pnpm/lock.yaml"
  find "$DAEMON/node_modules/.pnpm" -maxdepth 1 -name '@ddl+*' -exec rm -rf {} +
  find "$DAEMON/node_modules" -name .bin -prune -exec rm -rf {} +
  # codesign fails on dangling links and rejects links that leave the bundle.
  find "$DAEMON" -type l ! -exec test -e {} \; -exec rm -f {} +
  if [ -n "$(find "$DAEMON" -type l -lname '/*' | head -n 1)" ]; then
    fail "the daemon bundle contains absolute symlinks"
  fi
  [ -f "$DAEMON/dist/main.js" ] || fail "the daemon bundle has no dist/main.js"
  echo "Bundled daemon: $(du -sh "$DAEMON" | cut -f1) (runs on the system Node.js 24.4+)"
fi

# 6. Ad-hoc signature ------------------------------------------------------------------------------
step "Signing (ad hoc)"
codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict "$APP"
echo "Signature OK"

# 7. Archive (optional) ----------------------------------------------------------------------------
if [ "$ZIP" = 1 ]; then
  step "Archiving"
  ZIP_PATH="$OUTPUT/$APP_NAME.zip"
  rm -f "$ZIP_PATH"
  ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP_PATH"
  echo "Archive: $ZIP_PATH"
fi

step "Done"
echo "App: $APP ($(du -sh "$APP" | cut -f1))"
if [ "$OPEN" = 1 ]; then open "$APP"; fi
