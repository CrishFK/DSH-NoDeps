// Where the app keeps everything it owns. All of it lives under one base folder, so removing that folder removes
// the whole app: the dependencies (runtime) and the app's own data (data).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app } = require('electron');

function resolveBase() {
  // `npm start` from a checkout: keep everything next to the project, never inside node_modules.
  if (!app.isPackaged) return { base: path.join(__dirname, '..', '.dev-data'), fallback: false };

  // Windows: the install folder (next to the .exe). Linux: the "DSH NoDeps" folder that was unpacked, which holds
  // the app in app/. When it is not writable, %LOCALAPPDATA%\DshLauncher or ~/.local/share/dsh-nodeps instead.
  const exeDir = path.dirname(process.execPath);
  const dir = process.platform === 'win32' ? exeDir : path.dirname(exeDir);
  try {
    const probe = path.join(dir, '.write-test');
    fs.writeFileSync(probe, '');
    fs.unlinkSync(probe);
    return { base: dir, fallback: false };
  } catch {
    if (process.platform === 'win32') {
      const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
      return { base: path.join(local, 'DshLauncher'), fallback: true };
    }
    const data = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
    return { base: path.join(data, 'dsh-nodeps'), fallback: true };
  }
}

const { base, fallback } = resolveBase();

module.exports = {
  base,
  /** True when base is the fallback folder rather than the app's own folder. */
  usesFallback: fallback,
  /** Linux: the unpacked "DSH NoDeps" folder, whose app/ holds this executable. */
  linuxAppFolder: path.dirname(path.dirname(process.execPath)),
  /** Portable Node.js, dsh and the npm cache. */
  runtime: path.join(base, 'runtime'),
  /** The embedded browser profile (cookies, preferences) and window placement. */
  data: path.join(base, 'data'),

  /**
   * Records which install folder owns the fallback data. The uninstaller removes %LOCALAPPDATA%\DshLauncher only
   * when this marker names that install folder.
   */
  writeInstallMarker() {
    if (!fallback || process.platform !== 'win32') return;
    try {
      fs.mkdirSync(base, { recursive: true });
      fs.writeFileSync(path.join(base, 'install-path.ini'),
        '[install]\r\npath=' + path.dirname(process.execPath) + '\r\n');
    } catch { }
  },
};
