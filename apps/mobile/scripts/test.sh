#!/bin/sh
# Run native input/lifecycle tests and real-input UI journeys in an iPhone simulator.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
: "${DEVELOPER_DIR:=/Applications/Xcode.app/Contents/Developer}"
export DEVELOPER_DIR
"$ROOT/scripts/generate.sh"
if [ -z "${DDL_IOS_DESTINATION:-}" ]; then
  DEVICE="$(xcrun simctl list devices available --json | python3 -c '
import json,sys
for devices in json.load(sys.stdin)["devices"].values():
    for device in devices:
        if device["name"].startswith("iPhone"):
            print(device["udid"])
            sys.exit(0)
sys.exit("No iPhone simulator is installed")
')"
  DDL_IOS_DESTINATION="platform=iOS Simulator,id=$DEVICE"
fi
exec xcodebuild test -quiet -project "$ROOT/DailyDoList.xcodeproj" -scheme DailyDoList \
  -destination "${DDL_IOS_DESTINATION}" \
  -derivedDataPath "$ROOT/.build/DerivedData" \
  -parallel-testing-enabled NO CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- "$@"
