#!/usr/bin/env bash
# Packs dist/linux-unpacked (from `electron-builder --linux --dir`) into dist/DSH-NoDeps-linux-x64.tar.gz: one
# "DSH NoDeps" folder with the app in app/ and the dsh-nodeps launcher. It needs nothing installed to run.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
stage="$root/dist/linux-stage"
[ -x "$root/dist/linux-unpacked/DshLauncher" ] || { echo "Run electron-builder --linux --dir first" >&2; exit 1; }

rm -rf "$stage"
mkdir -p "$stage/DSH NoDeps"
cp -a "$root/dist/linux-unpacked" "$stage/DSH NoDeps/app"
install -m 755 "$root/build/dsh-nodeps.sh" "$stage/DSH NoDeps/dsh-nodeps"
tar -C "$stage" --owner=0 --group=0 -czf "$root/dist/DSH-NoDeps-linux-x64.tar.gz" "DSH NoDeps"
rm -rf "$stage"
ls -la "$root/dist/DSH-NoDeps-linux-x64.tar.gz"
