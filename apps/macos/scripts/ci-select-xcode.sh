#!/bin/sh
# CI: selects the newest non-beta Xcode of the runner image (the packages need a recent Swift 6
# toolchain; images ship several) and writes `key=<runner OS>-<arch>-<Xcode version hash>` to
# $GITHUB_OUTPUT, the toolchain part of the SwiftPM build caches' keys.
set -eu

xcode="$(printf '%s\n' /Applications/Xcode_*.app | grep -viE 'beta|release_candidate' | sort -V | tail -n 1 || true)"
if [ -d "$xcode" ]; then sudo xcode-select -s "$xcode"; fi
xcode-select -p
xcodebuild -version
swift --version
node --version 2>/dev/null || true

version="$(xcodebuild -version | tr '\n' ' ')"
key="${ImageOS:-macos}-$(uname -m)-$(printf '%s' "$version" | shasum | cut -c1-12)"
echo "cache key prefix: $key ($version)"
if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "key=$key" >>"$GITHUB_OUTPUT"; fi
