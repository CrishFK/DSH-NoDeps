#!/usr/bin/env bash
# Runs npm with the portable Node.js from .tools (see scripts/local-node.sh). Every cache stays inside .tools.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
tools="$root/.tools"
[ -x "$tools/node/bin/node" ] || "$root/scripts/local-node.sh"

export PATH="$tools/node/bin:$PATH"
export npm_config_cache="$tools/npm-cache"
export npm_config_update_notifier=false
export ELECTRON_CACHE="$tools/electron-cache"
export electron_config_cache="$tools/electron-cache"
export ELECTRON_BUILDER_CACHE="$tools/electron-builder-cache"
# Anything else that follows the XDG cache convention (electron-builder downloads Electron there) stays here too.
export XDG_CACHE_HOME="$tools/cache"

cd "$root"
exec npm "$@"
