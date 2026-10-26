// Runs dsh for the launcher and stops it, with everything it started, as soon as the launcher is gone, even if the
// launcher crashed. Started with the portable Node:  node watchdog.js <launcher pid> <program> [args…]
const { spawn, spawnSync } = require('node:child_process');

const isWindows = process.platform === 'win32';
const [launcherPid, program, ...args] = process.argv.slice(2);

// On Linux dsh leads its own process group, so the whole group can be stopped at once.
const child = spawn(program, args, { stdio: 'inherit', windowsHide: true, detached: !isWindows });

let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  if (child.exitCode !== null || child.signalCode !== null) process.exit(0);
  if (isWindows) {
    spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true });
    process.exit(0);
  }
  try { process.kill(-child.pid, 'SIGTERM'); } catch { }
  setTimeout(() => {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { }
    process.exit(0);
  }, 3000).unref();
}

function launcherAlive() {
  try { process.kill(Number(launcherPid), 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

child.on('exit', (code, signal) => { if (!stopping) process.exit(code ?? (signal ? 1 : 0)); });
child.on('error', (e) => { console.error(e.message); process.exit(1); });
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
setInterval(() => { if (!launcherAlive()) stop(); }, 1000);
