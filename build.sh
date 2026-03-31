#!/usr/bin/env bash
#
# Build Via.app and Via.dmg using electron-builder
#
set -e
cd "$(dirname "$0")"

echo "Building Via..."
npx electron-builder --mac

echo ""
echo "Done! Build outputs are in dist/"
echo ""
ls dist/*.dmg 2>/dev/null && echo "  ^ Drag-and-drop installer (share this!)"
echo ""
echo "To run directly:"
echo "  open dist/mac-*/Via.app"
echo ""
