#!/bin/sh
# Fetch the reviewed official release into ignored build tooling; no global install is needed.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/.build/tools"
ARCHIVE="$DEST/xcodegen-2.46.0.zip"
mkdir -p "$DEST"
curl --fail --location --silent --show-error \
  https://github.com/yonaskolb/XcodeGen/releases/download/2.46.0/xcodegen.zip -o "$ARCHIVE"
printf '%s  %s\n' 4d9e34b62172d645eed6457cac13fc222569974098ef4ee9c3368bedf0196806 "$ARCHIVE" \
  | shasum -a 256 --check --status
unzip -q -o "$ARCHIVE" -d "$DEST"
"$DEST/xcodegen/bin/xcodegen" --version
