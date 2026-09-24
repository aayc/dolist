#!/bin/sh
# Runs `swift test` for one or more Swift packages of the macOS app.
#   apps/macos/scripts/test.sh                      # every package under Packages/, then "app"
#   apps/macos/scripts/test.sh DailyDoListModels    # one package (directory under Packages/, or "app")
#   apps/macos/scripts/test.sh integration          # IntegrationTests/ (needs Node 24 + a built daemon)
#   apps/macos/scripts/test.sh DailyDoListModels -- --filter ContractFixture
# With only the Command Line Tools (no Xcode), Swift Testing needs explicit framework/rpath flags;
# with Xcode selected no flags are added. Every package runs even if an earlier one fails; the exit
# status is non-zero when any failed.
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

FAILED=""
for pkg in $PACKAGES; do
  case "$pkg" in
    app) dir="$ROOT" ;;
    integration) dir="$ROOT/IntegrationTests" ;;
    *) dir="$ROOT/Packages/$pkg" ;;
  esac
  if [ ! -f "$dir/Package.swift" ]; then
    echo "test.sh: no package named '$pkg' (expected $dir/Package.swift)" >&2
    FAILED="$FAILED $pkg"
    continue
  fi
  echo "==> swift test ($pkg)"
  # shellcheck disable=SC2086
  if ! (cd "$dir" && swift test $EXTRA $PASSTHROUGH); then
    FAILED="$FAILED $pkg"
  fi
done

if [ -n "$FAILED" ]; then
  echo "==> failed:$FAILED" >&2
  exit 1
fi
