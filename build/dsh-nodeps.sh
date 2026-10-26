#!/bin/sh
# Starts DSH NoDeps on Linux. The app itself lives in app/ next to this script.
# Chromium's sandbox needs unprivileged user namespaces. Where the system forbids them (Ubuntu 24.04 and later restrict
# them through AppArmor) Electron would refuse to start, so it runs without the sandbox there instead.
here="$(dirname "$(readlink -f "$0")")"
if [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null)" = 1 ] ||
   [ "$(cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null)" = 0 ]; then
  exec "$here/app/DshLauncher" --no-sandbox "$@"
fi
exec "$here/app/DshLauncher" "$@"
