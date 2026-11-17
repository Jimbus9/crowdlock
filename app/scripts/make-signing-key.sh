#!/usr/bin/env bash
# Makes the signing key for the REAL-bitcoin Crowdlock app, on your own computer.
#
# Every Android app is stamped with a signing key, and a phone only accepts an
# update stamped with the same key as the app already installed. Until now the
# real-bitcoin app was stamped with Expo's public development key, which anyone
# can download. This makes a key only you hold.
#
# Run it once, in Git Bash, from your crowdlock folder:
#
#     bash app/scripts/make-signing-key.sh
#
# It makes a folder in your home folder, crowdlock-signing-key, holding:
#   crowdlock-release.p12   the key itself. Back it up. Never put it in the repository.
#   password.txt            its password. Back it up apart from the key.
#   key-for-github.txt      the key written as text, to paste into GitHub. Delete it once pasted.
#
# Nothing is sent anywhere. Lose the key and everyone has to reinstall the app;
# let someone copy it and they can make an "update" phones will accept.

set -euo pipefail
trap 'echo; echo "Something went wrong on the line above. Nothing has been sent anywhere. Send a screenshot of this window."' ERR
# Git Bash on Windows: don't turn "/CN=..." into a file path. Every file below
# is named without a leading slash, relative to the key's folder, so openssl
# (a Windows program there) gets paths it understands.
export MSYS_NO_PATHCONV=1

command -v openssl >/dev/null || { echo "openssl is missing. Run this in Git Bash (it comes with Git for Windows)."; exit 1; }

dir="$HOME/crowdlock-signing-key"
if [ -e "$dir/crowdlock-release.p12" ]; then
  echo "There is already a key in $dir. Not making another: a second key would force everyone to reinstall."
  exit 1
fi
mkdir -p "$dir"
cd "$dir"

echo "Making the key in $dir (this takes a few seconds)…"
password="$(openssl rand -hex 24)"
work="working-files"
rm -rf "$work"; mkdir "$work"
trap 'rm -rf "$work"' EXIT

openssl req -x509 -newkey rsa:4096 -sha256 -days 18250 -nodes \
  -subj "/CN=Crowdlock/O=Crowdlock" \
  -keyout "$work/key.pem" -out "$work/cert.pem"
openssl pkcs12 -export -name crowdlock \
  -inkey "$work/key.pem" -in "$work/cert.pem" \
  -out crowdlock-release.p12 -passout "pass:$password"

printf '%s\n' "$password" > password.txt
openssl base64 -A -in crowdlock-release.p12 > key-for-github.txt

fingerprint="$(openssl x509 -in "$work/cert.pem" -noout -fingerprint -sha256 | cut -d= -f2)"
printf '%s\n' "$fingerprint" > fingerprint.txt

echo
echo "Done. Your key is in: $dir"
echo
echo "Its fingerprint (anyone can check an app against this; it is not secret):"
echo "  $fingerprint"
echo
echo "Next: paste key-for-github.txt and password.txt into GitHub, as the instructions say."
