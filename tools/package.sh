#!/bin/sh
# Builds the zip that goes to the Chrome Web Store: the manifest, the icons,
# src/ and the licences, and nothing else. Tests, tools and docs stay
# out, since Chrome would load them and the store would review them.
#
#   npm run package
set -e
cd "$(dirname "$0")/.."
version=$(node -p "require('./manifest.json').version")
out="dist/textmemory-$version.zip"
mkdir -p dist
rm -f "$out"
zip -qr "$out" manifest.json icons src LICENSE THIRD-PARTY-NOTICES.md -x '*.DS_Store'
echo "$out ($(du -h "$out" | cut -f1))"
