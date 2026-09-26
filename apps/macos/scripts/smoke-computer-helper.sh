#!/bin/sh
# Smoke-tests a built ddl-computer: validly signed, and answering the passive `hello` and
# `permissions` methods (they never prompt).
#   apps/macos/scripts/smoke-computer-helper.sh "Daily Do List.app/Contents/Resources/daemon/bin/ddl-computer"
#   apps/macos/scripts/smoke-computer-helper.sh apps/macos/.build/tests/debug/ddl-computer
set -eu

[ $# -eq 1 ] || { echo "usage: smoke-computer-helper.sh PATH" >&2; exit 2; }
helper="$1"
[ -x "$helper" ] || { echo "smoke-computer-helper: no executable at $helper" >&2; exit 1; }
codesign --verify --strict "$helper"
out="$(printf '%s\n' '{"id":1,"method":"hello"}' '{"id":2,"method":"permissions"}' | "$helper" serve)"
echo "$out"
echo "$out" | grep -q '^{"id":1,"result":{"version":1,'
echo "$out" | grep -q '^{"id":2,"result":{"accessibility":'
echo "smoke-computer-helper: ok"
