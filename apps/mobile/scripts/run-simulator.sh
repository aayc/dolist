#!/bin/sh
# Build and install the iPhone app on a chosen simulator, never the production Mac daemon.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
: "${DEVELOPER_DIR:=/Applications/Xcode.app/Contents/Developer}"
export DEVELOPER_DIR
DEVICE="${DDL_IOS_SIMULATOR_ID:-$("$ROOT/scripts/simulator-id.sh")}"
"$ROOT/scripts/build.sh"
STATE="$(xcrun simctl list devices available --json | python3 -c '
import json,sys
wanted=sys.argv[1]
print(next(d["state"] for ds in json.load(sys.stdin)["devices"].values() for d in ds if d["udid"]==wanted))
' "$DEVICE")"
if [ "$STATE" != Booted ]; then xcrun simctl boot "$DEVICE"; fi
xcrun simctl bootstatus "$DEVICE" -b
xcrun simctl install "$DEVICE" "$ROOT/.build/DerivedData/Build/Products/Debug-iphonesimulator/DailyDoList.app"
exec xcrun simctl launch "$DEVICE" app.dailydolist.iphone "$@"
