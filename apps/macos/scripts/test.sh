#!/bin/sh
# Runs `swift test` for one or more Swift packages of the macOS app.
#   apps/macos/scripts/test.sh                      # every package
#   apps/macos/scripts/test.sh DailyDoListModels    # one package (directory under Packages/, or "app")
#   apps/macos/scripts/test.sh DailyDoListModels -- --filter ContractFixture
# With only the Command Line Tools (no Xcode), Swift Testing needs explicit framework/rpath flags.
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EXTRA=""
if xcode-select -p 2>/dev/null | grep -q CommandLineTools; then
  F=/Library/Developer/CommandLineTools/Library/Developer/Frameworks
  L=/Library/Developer/CommandLineTools/Library/Developer/usr/lib
  EXTRA="-Xswiftc -F -Xswiftc $F -Xlinker -F -Xlinker $F -Xlinker -rpath -Xlinker $F -Xlinker -rpath -Xlinker $L"
fi

PACKAGES=""
PASSTHROUGH=""
while [ $# -gt 0 ]; do
  case "$1" in
    --) shift; PASSTHROUGH="$*"; break ;;
    *) PACKAGES="$PACKAGES $1"; shift ;;
  esac
done
if [ -z "$PACKAGES" ]; then
  PACKAGES="$(ls "$ROOT/Packages") app"
fi

for pkg in $PACKAGES; do
  if [ "$pkg" = "app" ]; then dir="$ROOT"; else dir="$ROOT/Packages/$pkg"; fi
  echo "==> swift test ($pkg)"
  # shellcheck disable=SC2086
  (cd "$dir" && swift test $EXTRA $PASSTHROUGH)
done
