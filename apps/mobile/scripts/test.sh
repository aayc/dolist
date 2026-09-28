#!/bin/sh
# Run native input/lifecycle tests and real-input UI journeys in an iPhone simulator.
#   test.sh [build-for-testing | test-without-building] [xcodebuild arguments…]
# DDL_BUILD_TIMING=1 prints xcodebuild's build timing summary instead of running quietly.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
: "${DEVELOPER_DIR:=/Applications/Xcode.app/Contents/Developer}"
export DEVELOPER_DIR
ACTION="test"
case "${1:-}" in
  build-for-testing | test-without-building)
    ACTION=$1
    shift
    ;;
esac
OUTPUT=-quiet
if [ -n "${DDL_BUILD_TIMING:-}" ]; then OUTPUT=-showBuildTimingSummary; fi
[ "$ACTION" = test-without-building ] || "$ROOT/scripts/generate.sh"
if [ -z "${DDL_IOS_DESTINATION:-}" ]; then
  DDL_IOS_DESTINATION="platform=iOS Simulator,id=$("$ROOT/scripts/simulator-id.sh")"
fi
# No index store: only Xcode's editor reads it, from its own DerivedData.
exec xcodebuild "$ACTION" "$OUTPUT" -project "$ROOT/DailyDoList.xcodeproj" -scheme DailyDoList \
  -destination "${DDL_IOS_DESTINATION}" \
  -derivedDataPath "$ROOT/.build/DerivedData" \
  -parallel-testing-enabled NO CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- \
  COMPILER_INDEX_STORE_ENABLE=NO "$@"
