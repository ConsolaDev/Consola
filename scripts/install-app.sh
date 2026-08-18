#!/usr/bin/env bash
#
# Swaps the freshly packaged app into /Applications. Run via `npm run release`,
# which builds and packages first.
set -euo pipefail

cd "$(dirname "$0")/.."

APP="Consola.app"
SRC="release/mac-arm64/$APP"
DEST="/Applications/$APP"

if [ ! -d "$SRC" ]; then
    echo "No packaged app at $SRC -- run 'npm run package' first." >&2
    exit 1
fi

# Replacing the bundle under a live process leaves it reading files that no
# longer exist, and it dies part-way through whatever session was running.
if pgrep -f "$DEST/Contents/MacOS/Consola" >/dev/null 2>&1; then
    echo "Consola is running. Quit it (Cmd+Q) and run this again." >&2
    exit 1
fi

rm -rf "$DEST"
cp -R "$SRC" "$DEST"

echo "Installed $DEST ($(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$DEST/Contents/Info.plist"))"
