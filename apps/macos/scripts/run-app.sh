#!/bin/sh
# Builds the app (debug unless --release) and opens it, replacing a running copy.
#
#   apps/macos/scripts/run-app.sh [--demo] [--release] [--with-daemon] [--env VAR=value]… [-- args…]
#
#   --demo          start in demo mode (its own daemon, mock agent, a throwaway demo vault)
#   --env VAR=value pass an environment variable to the app, e.g. --env DDL_AGENT_MODE=mock
#   -- args…        pass the remaining arguments to the app
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MACOS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
APP="$MACOS_DIR/build/Daily Do List.app"

BUILD_ARGS=""
DEMO=0
# `open` options (--env) and app arguments, kept as positional parameters to preserve spaces.
OPEN_ENV=""
while [ $# -gt 0 ]; do
  case "$1" in
    --demo) DEMO=1 ;;
    --release | --with-daemon) BUILD_ARGS="$BUILD_ARGS $1" ;;
    --env)
      [ $# -ge 2 ] || { echo "run-app: --env needs VAR=value" >&2; exit 2; }
      OPEN_ENV="$OPEN_ENV
$2"
      shift
      ;;
    --)
      shift
      break
      ;;
    -h | --help)
      sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "run-app: unknown option: $1 (use -- to pass arguments to the app)" >&2
      exit 2
      ;;
  esac
  shift
done

# shellcheck disable=SC2086
"$SCRIPT_DIR/build-app.sh" $BUILD_ARGS

# A running copy would just be activated by `open`. Its managed daemon notices the app going
# away (stdin closes) and shuts down gracefully.
if pgrep -x DailyDoList >/dev/null 2>&1; then
  echo "Quitting the running copy…"
  pkill -x DailyDoList || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    pgrep -x DailyDoList >/dev/null 2>&1 || break
    sleep 0.5
  done
fi

if [ "$DEMO" = 1 ]; then set -- --demo "$@"; fi
set -- "$APP" --args "$@"
# Prepend --env options (newline-separated so values may contain spaces).
OLD_IFS=$IFS
IFS='
'
for assignment in $OPEN_ENV; do
  set -- --env "$assignment" "$@"
done
IFS=$OLD_IFS

echo "Opening $APP"
open "$@"
