#!/bin/sh
# Simulator by default. For a device: DDL_IOS_DESTINATION='generic/platform=iOS'.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
: "${DEVELOPER_DIR:=/Applications/Xcode.app/Contents/Developer}"
export DEVELOPER_DIR
"$ROOT/scripts/generate.sh"
exec xcodebuild build -quiet -project "$ROOT/DailyDoList.xcodeproj" -scheme DailyDoList \
  -destination "${DDL_IOS_DESTINATION:-generic/platform=iOS Simulator}" \
  -derivedDataPath "$ROOT/.build/DerivedData" CODE_SIGNING_ALLOWED=NO "$@"
