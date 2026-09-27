#!/bin/sh
# Generate the Xcode project from its reviewed specification.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION=2.46.0
if [ -x "$ROOT/.build/tools/xcodegen/bin/xcodegen" ]; then
  PATH="$ROOT/.build/tools/xcodegen/bin:$PATH"
  export PATH
fi
command -v xcodegen >/dev/null 2>&1 || {
  echo "Install XcodeGen $VERSION before generating the iPhone project." >&2
  exit 1
}
INSTALLED="$(xcodegen --version | awk '{print $NF}')"
[ "$INSTALLED" = "$VERSION" ] || {
  echo "Expected XcodeGen $VERSION; found $INSTALLED." >&2
  exit 1
}
exec xcodegen generate --spec "$ROOT/project.yml" --project "$ROOT"
