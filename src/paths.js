// Where the app keeps everything it owns. All of it lives under one base folder, so removing that folder removes
// the whole app: the dependencies (runtime) and the app's own data (data).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app } = require('electron');

function resolveBase() {
  // `npm start` from a checkout: keep everything next to the project, never inside node_modules.
  if (!app.isPackaged) return { base: path.join(__dirname, '..', '.dev-data'), fallback: false };

  if (process.platform === 'win32') {
    // The install folder (next to the .exe) when it is writable; otherwise %LOCALAPPDATA%\DshLauncher.
    const exeDir = path.dirname(process.execPath);
    try {
      const probe = path.join(exeDir, '.write-test');
      fs.writeFileSync(probe, '');
      fs.unlinkSync(probe);
      return { base: exeDir, fallback: false };
    } catch {
      const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
      return { base: path.join(local, 'DshLauncher'), fallback: true };
    }
  }

  // Linux: an AppImage runs from a read-only mount, so its folder lives in the XDG data directory.
  const data = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return { base: path.join(data, 'dsh-nodeps'), fallback: false };
}

const { base, fallback } = resolveBase();

module.exports = {
  base,
  /** True when base is the %LOCALAPPDATA% fallback rather than the .exe folder (Windows only). */
  usesFallback: fallback,
  /** Portable Node.js, dsh and the npm cache. */
  runtime: path.join(base, 'runtime'),
  /** The embedded browser profile (cookies, preferences) and window placement. */
  data: path.join(base, 'data'),

  /**
   * Records which install folder owns the fallback data. The uninstaller removes %LOCALAPPDATA%\DshLauncher only
   * when this marker names that install folder.
   */
  writeInstallMarker() {
    if (!fallback) return;
    try {
      fs.mkdirSync(base, { recursive: true });
      fs.writeFileSync(path.join(base, 'install-path.ini'),
        '[install]\r\npath=' + path.dirname(process.execPath) + '\r\n');
    } catch { }
  },
};
