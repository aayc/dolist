#!/bin/sh
# Runs `swift test` for Swift packages of the macOS app.
#   apps/macos/scripts/test.sh                      # every package under Packages/, then "app"
#   apps/macos/scripts/test.sh --changed            # only what the changes since main affect
#   apps/macos/scripts/test.sh --since REF          # only what the changes since REF affect
#   apps/macos/scripts/test.sh DailyDoListModels    # one package (directory under Packages/, or "app")
#   apps/macos/scripts/test.sh integration          # IntegrationTests/ (needs Node 24 + a built daemon)
#   apps/macos/scripts/test.sh DailyDoListModels -- --filter ContractFixture
#   --list      print the packages that would run, then exit
#   --thorough  full fuzz and performance iteration counts (DDL_TEST_THOROUGH=1)
#
# Every package builds into one scratch path, apps/macos/.build/tests, so a module compiles once
# however many packages use it. App builds (build-app.sh, run-app.sh) keep apps/macos/.build: a
# test build compiles modules with other flags, and sharing one directory would recompile
# everything at each switch. Packages run in dependency order; every package runs even if an
# earlier one fails, and the exit status is non-zero when any failed.
#
# --changed compares the working tree (untracked files included) with the merge base of HEAD and
# main (else origin/main). A change to a package's sources or manifest selects it and every
# package that depends on it; a change to its Tests/ selects only it. Files outside apps/macos
# that tests read select the packages reading them: the vim vectors (Vim, Editor), the contract
# fixtures (Models, Client), computer-keys.ts (Computer), the drawing fixtures (Drawing), and the
# daemon, the sync service and what they bundle (integration). A change to this script selects
# everything.
#
# With only the Command Line Tools (no Xcode), Swift Testing needs explicit framework/rpath flags;
# with Xcode selected no flags are added.
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$ROOT/../.." && pwd)"
SCRATCH="$ROOT/.build/tests"
EXTRA=""
if xcode-select -p 2>/dev/null | grep -q CommandLineTools; then
  F=/Library/Developer/CommandLineTools/Library/Developer/Frameworks
  L=/Library/Developer/CommandLineTools/Library/Developer/usr/lib
  EXTRA="-Xswiftc -F -Xswiftc $F -Xlinker -F -Xlinker $F -Xlinker -rpath -Xlinker $F -Xlinker -rpath -Xlinker $L"
fi

usage() { sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; }

PACKAGES=""
PASSTHROUGH=""
CHANGED=0
SINCE=""
LIST=0
while [ $# -gt 0 ]; do
  case "$1" in
    --) shift; PASSTHROUGH="$*"; break ;;
    --changed) CHANGED=1 ;;
    --since)
      [ $# -ge 2 ] || { echo "test.sh: --since needs a git revision" >&2; exit 2; }
      CHANGED=1
      SINCE="$2"
      shift
      ;;
    --list) LIST=1 ;;
    --thorough) DDL_TEST_THOROUGH=1; export DDL_TEST_THOROUGH ;;
    -h | --help) usage; exit 0 ;;
    -*) echo "test.sh: unknown option $1" >&2; usage >&2; exit 2 ;;
    *) PACKAGES="$PACKAGES $1" ;;
  esac
  shift
done

ALL=""
for manifest in "$ROOT"/Packages/*/Package.swift; do
  p="${manifest%/Package.swift}"
  ALL="$ALL ${p##*/}"
done
ALL="$ALL app"

dir_of() {
  case "$1" in
    app) echo "$ROOT" ;;
    integration) echo "$ROOT/IntegrationTests" ;;
    *) echo "$ROOT/Packages/$1" ;;
  esac
}

# The local packages a package depends on, from its manifest's `.package(path:)` entries.
deps_of() {
  manifest="$(dir_of "$1")/Package.swift"
  [ -f "$manifest" ] || return 0
  sed -n 's/.*\.package(path: *"\([^"]*\)").*/\1/p' "$manifest" | sed 's|.*/||'
}

contains() { case " $1 " in *" $2 "*) return 0 ;; esac; return 1; }

# Adds to $1 every package (integration included) that depends on one in it, transitively.
with_dependents() {
  closure="$1"
  grew=1
  while [ "$grew" = 1 ]; do
    grew=0
    for p in $ALL integration; do
      contains "$closure" "$p" && continue
      for d in $(deps_of "$p"); do
        if contains "$closure" "$d"; then
          closure="$closure $p"
          grew=1
          break
        fi
      done
    done
  done
  echo "$closure"
}

# Packages whose tests the changes since the base revision may affect.
changed_packages() {
  if [ -n "$SINCE" ]; then
    base="$(git -C "$REPO" rev-parse --verify --quiet "$SINCE^{commit}")" || {
      echo "test.sh: unknown revision $SINCE" >&2
      exit 2
    }
  else
    base="$(git -C "$REPO" merge-base HEAD main 2>/dev/null || git -C "$REPO" merge-base HEAD origin/main)"
  fi
  files="$(
    git -C "$REPO" diff --name-only "$base"
    git -C "$REPO" ls-files --others --exclude-standard
  )"
  sources=""
  tests=""
  # One path per line, taken literally (paths may contain spaces or glob characters).
  set -f
  saved_ifs="$IFS"
  IFS='
'
  for file in $files; do
    case "$file" in
      apps/macos/scripts/test.sh) sources="$ALL" ;;
      apps/macos/Packages/*/Tests/*)
        p="${file#apps/macos/Packages/}"
        tests="$tests ${p%%/*}"
        ;;
      apps/macos/Packages/*/*)
        p="${file#apps/macos/Packages/}"
        sources="$sources ${p%%/*}"
        ;;
      apps/macos/Tests/*) tests="$tests app" ;;
      apps/macos/Sources/* | apps/macos/Package.swift | apps/macos/Package.resolved) sources="$sources app" ;;
      apps/macos/IntegrationTests/*) tests="$tests integration" ;;
      packages/editor/test/vim/*) tests="$tests DailyDoListVim DailyDoListEditor" ;;
      packages/contract/*) tests="$tests DailyDoListModels DailyDoListClient integration" ;;
      packages/agent/src/execution/local/computer-keys.ts) tests="$tests DailyDoListComputer integration" ;;
      packages/core/test/drawings/*) tests="$tests DailyDoListDrawing" ;;
      apps/daemon/* | apps/sync/* | packages/core/* | packages/agent/* | packages/storage/* | \
        packages/connectors/* | package.json | pnpm-lock.yaml | pnpm-workspace.yaml | .nvmrc)
        tests="$tests integration"
        ;;
    esac
  done
  IFS="$saved_ifs"
  set +f
  selected="$(with_dependents "$sources") $tests"
  # Known packages only (a deleted package's files name a directory that no longer exists).
  out=""
  for p in $ALL integration; do
    if contains "$selected" "$p"; then out="$out $p"; fi
  done
  echo "$out"
}

if [ "$CHANGED" = 1 ]; then
  [ -z "$PACKAGES" ] || { echo "test.sh: --changed and package names don't mix" >&2; exit 2; }
  PACKAGES="$(changed_packages)" || exit 2
  if [ -z "$(echo "$PACKAGES" | tr -d ' ')" ]; then
    echo "==> nothing to test: no change affects a Swift package"
    exit 0
  fi
elif [ -z "$PACKAGES" ]; then
  PACKAGES="$ALL"
fi

# Dependency order: a package runs after the selected packages it depends on, so a compile
# error shows first in the package that has it.
ORDERED=""
remaining="$PACKAGES"
while [ -n "$(echo "$remaining" | tr -d ' ')" ]; do
  next=""
  progressed=0
  for p in $remaining; do
    ready=1
    for d in $(deps_of "$p"); do
      if contains "$remaining" "$d"; then ready=0; fi
    done
    if [ "$ready" = 1 ]; then
      ORDERED="$ORDERED $p"
      progressed=1
    else
      next="$next $p"
    fi
  done
  if [ "$progressed" = 0 ]; then
    ORDERED="$ORDERED $next"
    break
  fi
  remaining="$next"
done

if [ "$LIST" = 1 ]; then
  for p in $ORDERED; do echo "$p"; done
  exit 0
fi

FAILED=""
SUMMARY=""
START=$(date +%s)
for pkg in $ORDERED; do
  dir="$(dir_of "$pkg")"
  if [ ! -f "$dir/Package.swift" ]; then
    echo "test.sh: no package named '$pkg' (expected $dir/Package.swift)" >&2
    FAILED="$FAILED $pkg"
    continue
  fi
  echo "==> swift test ($pkg)"
  t0=$(date +%s)
  # shellcheck disable=SC2086
  if (cd "$dir" && swift test --scratch-path "$SCRATCH" $EXTRA $PASSTHROUGH); then
    result=ok
  else
    result=FAILED
    FAILED="$FAILED $pkg"
  fi
  SUMMARY="$SUMMARY
  $pkg: $result ($(($(date +%s) - t0)) s)"
done

echo "==> $(echo "$ORDERED" | wc -w | tr -d ' ') package(s) in $(($(date +%s) - START)) s:$SUMMARY"
if [ -n "$FAILED" ]; then
  echo "==> failed:$FAILED" >&2
  exit 1
fi
