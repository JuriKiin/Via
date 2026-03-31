#!/usr/bin/env bash
#
# Patch the local Electron.app to show "Via" branding during development
#
set -e
cd "$(dirname "$0")/.."

PLIST="node_modules/electron/dist/Electron.app/Contents/Info.plist"
ICON_SRC="build/icon.icns"
ICON_DST="node_modules/electron/dist/Electron.app/Contents/Resources/via.icns"

if [ ! -f "$PLIST" ]; then
    echo "Electron not installed yet, skipping patch."
    exit 0
fi

echo "Patching Electron.app for Via branding..."

# Patch Info.plist
plutil -replace CFBundleName -string "Via" "$PLIST"
plutil -replace CFBundleDisplayName -string "Via" "$PLIST"
plutil -replace CFBundleIdentifier -string "com.via.gitui" "$PLIST"

# Copy icon and point plist at it
if [ -f "$ICON_SRC" ]; then
    cp "$ICON_SRC" "$ICON_DST"
    plutil -replace CFBundleIconFile -string "via.icns" "$PLIST"
    echo "  Icon updated."
fi

echo "  Done. Electron.app plist patched for Via branding."
echo "  Note: Dock name only works properly with built app (./build.sh)."
