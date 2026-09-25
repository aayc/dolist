#!/bin/sh
# The local code-signing identity build-app.sh signs with, so macOS keeps the permissions granted to
# Daily Do List (Accessibility, Screen Recording) across rebuilds. An ad-hoc signature changes with
# every build, and macOS then treats each build as a new app.
#
#   apps/macos/scripts/signing-identity.sh [--create] [--name NAME]
#
#   (no option)   report whether the identity exists and is valid for code signing
#   --create      create it in the login keychain if missing: a self-signed certificate trusted
#                 for code signing only (macOS asks for your password once, to trust it)
#   --name NAME   identity name (default: $DDL_SIGN_IDENTITY, else "Daily Do List Local Signing")
#
# Anything signed with this identity gets the permissions granted to Daily Do List, so the private
# key stays in the login keychain and only codesign may use it. Delete the certificate in Keychain
# Access to revoke it.
set -eu

NAME="${DDL_SIGN_IDENTITY:-Daily Do List Local Signing}"
CREATE=0
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

usage() { sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; }
fail() {
  echo "signing-identity: $*" >&2
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --create) CREATE=1 ;;
    --name)
      [ $# -ge 2 ] || fail "--name needs a value"
      NAME="$2"
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      fail "unknown option: $1"
      ;;
  esac
  shift
done

# `security find-identity -v` lists only identities codesign accepts (trusted for code signing).
valid() { security find-identity -v -p codesigning | grep -F "\"$NAME\"" >/dev/null; }
present() { security find-identity -p codesigning | grep -F "\"$NAME\"" >/dev/null; }

if valid; then
  echo "✔ \"$NAME\" is ready: build-app.sh signs with it."
  exit 0
fi
if [ "$CREATE" = 0 ]; then
  if present; then
    echo "✖ \"$NAME\" exists but isn't trusted for code signing. Run with --create to trust it."
  else
    echo "✖ \"$NAME\" doesn't exist. Run with --create to make it."
  fi
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
umask 077

if present; then
  security find-certificate -c "$NAME" -p "$KEYCHAIN" >"$WORK/cert.pem"
else
  cat >"$WORK/openssl.cnf" <<EOF
[ req ]
distinguished_name = dn
prompt = no
x509_extensions = codesign
[ dn ]
CN = $NAME
[ codesign ]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
subjectKeyIdentifier = hash
EOF
  # /usr/bin/openssl (LibreSSL) writes PKCS#12 files that `security import` reads; OpenSSL 3's
  # defaults don't import.
  /usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -config "$WORK/openssl.cnf" \
    -keyout "$WORK/key.pem" -out "$WORK/cert.pem" 2>/dev/null
  PASSWORD="$(/usr/bin/openssl rand -hex 24)"
  /usr/bin/openssl pkcs12 -export -inkey "$WORK/key.pem" -in "$WORK/cert.pem" -name "$NAME" \
    -out "$WORK/identity.p12" -passout "pass:$PASSWORD"
  security import "$WORK/identity.p12" -k "$KEYCHAIN" -f pkcs12 -P "$PASSWORD" \
    -T /usr/bin/codesign >/dev/null
  echo "Created \"$NAME\" in the login keychain."
fi

echo "macOS asks for your password once, to trust the certificate for code signing."
security add-trusted-cert -r trustRoot -p codeSign -k "$KEYCHAIN" "$WORK/cert.pem"
valid || fail "\"$NAME\" still isn't valid for code signing"
echo "✔ \"$NAME\" is ready: build-app.sh signs with it."
