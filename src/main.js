const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const { app, BrowserWindow, WebContentsView, Menu, dialog, ipcMain, screen, shell } = require('electron');
const paths = require('./paths');

// Keep Chromium's profile (cookies, cache, the single-instance lock) inside the app's own folder.
// This must happen before anything else touches it.
app.setPath('userData', path.join(paths.data, 'electron'));

const toolchain = require('./toolchain');
const appUpdate = require('./appUpdate');
const credentials = require('./credentials');

const PreferredPort = 8421;
const AppId = 'io.github.crishfk.dsh-nodeps';
const Title = 'DSH NoDeps';
const BaseTitle = `${Title} v${appUpdate.currentVersion}`;
const KeysPage = 'https://platform.deepseek.com/api_keys';
const icon = path.join(__dirname, '..', 'build', 'icon.png');
const preload = path.join(__dirname, 'preload.js');
const ui = (file) => path.join(__dirname, 'ui', file);

let win = null;
let dsh = null;
let closing = false;
let webShown = false;
const abort = new AbortController();
const signal = abort.signal;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
  app.on('window-all-closed', () => app.quit());
  ipcMain.on('open:keys-page', () => openUrl(KeysPage));
  if (process.platform === 'win32') app.setAppUserModelId(AppId);
  app.whenReady().then(start);
}

async function start() {
  Menu.setApplicationMenu(null);
  paths.writeInstallMarker();
  fs.mkdirSync(paths.data, { recursive: true });
  addToLinuxMenu();
  // The profile of the WebView2 builds (1.0.x) cannot be read by this browser; it is just dead weight now.
  fs.rm(path.join(paths.data, 'WebView2'), { recursive: true, force: true }, () => { });

  const bounds = loadBounds();
  win = new BrowserWindow({
    title: BaseTitle,
    width: 1280,
    height: 800,
    minWidth: 640,
    minHeight: 480,
    ...bounds?.rect,
    show: false,
    icon,
    webPreferences: { preload, sandbox: true, contextIsolation: true },
  });
  win.on('page-title-updated', (e) => e.preventDefault());
  win.on('close', shutdown);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  await win.loadFile(ui('launcher.html'));
  if (bounds?.maximized) win.maximize();
  win.show();
  await run();
}

/**
 * Linux: puts the app in the desktop's application menu, the way the Windows installer adds a Start menu shortcut.
 * The entry points at this folder's launcher; after moving the folder, opening it once from there fixes the entry.
 */
function addToLinuxMenu() {
  if (process.platform !== 'linux' || !app.isPackaged) return;
  try {
    const launcher = path.join(paths.linuxAppFolder, 'dsh-nodeps');
    if (!fs.existsSync(launcher)) return;
    // The menu needs the icon as a real file; the one in the app is inside app.asar.
    const iconFile = path.join(paths.data, 'icon.png');
    const iconData = fs.readFileSync(icon);
    if (!fs.existsSync(iconFile) || !fs.readFileSync(iconFile).equals(iconData)) fs.writeFileSync(iconFile, iconData);

    const quote = (s) => '"' + s.replace(/(["`$\\])/g, '\\$1') + '"';
    const entry = [
      '[Desktop Entry]',
      'Type=Application',
      `Name=${Title}`,
      'Comment=Self-contained launcher for DeepSeek Harness (unofficial)',
      `Exec=${quote(launcher)}`,
      `Icon=${iconFile}`,
      'Terminal=false',
      'Categories=Development;',
      'StartupWMClass=DshLauncher', // Electron's app id comes from desktopName in package.json
      '',
    ].join('\n');
    const dir = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'applications');
    const file = path.join(dir, 'DshLauncher.desktop');
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === entry) return;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, entry, { mode: 0o755 });
  } catch { }
}

function setStatus(text) {
  if (!closing) win?.webContents.send('launcher:status', text);
}

/** Appends a line to the visible log. */
function log(line) {
  // dsh keeps logging after the UI is up (e.g. the model listing); nobody sees the log any more by then.
  if (!closing && !webShown) win?.webContents.send('launcher:log', line);
}

function message(parent, options) {
  return dialog.showMessageBox(parent, { title: Title, buttons: ['OK'], ...options });
}

async function run() {
  try {
    await checkAppUpdate();
    if (closing) return;
    // Own dependencies: Node.js and dsh go in the runtime folder and are updated on every launch. If there is no
    // network or an update fails, the app carries on with what is already there.
    await toolchain.ensureNode(setStatus, log, signal);
    await toolchain.ensureDsh(setStatus, log, signal);
    if (closing) return;
    await ensureApiKey();
    if (closing) return;

    setStatus('Starting DeepSeek Harness…');
    log('> dsh web');
    const url = await startDsh();

    setStatus('Loading interface…');
    showWeb(url);
  } catch (e) {
    if (closing) return;
    await message(win, { type: 'error', message: e.message });
    win.close();
  }
}

function openUrl(url) {
  shell.openExternal(url).catch(() => { });
}

const isWebUrl = (url) => /^https?:\/\//i.test(url);

function isLoopback(url) {
  try { return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname); }
  catch { return false; }
}

// ---- New version of this app ---------------------------------------------

/**
 * Looks for a newer release of DSH NoDeps on GitHub. If the user says yes it downloads the new build (with a
 * progress bar), verifies its SHA-256 and hands over to it: on Windows the installer runs silently and starts the
 * app again, on Linux the new app/ folder replaces this one and is started. Offline, or with no releases, it says
 * nothing.
 */
async function checkAppUpdate() {
  if (!app.isPackaged) return; // `npm start` from a checkout has no release to compare with
  appUpdate.cleanLeftovers();
  setStatus('Checking for a new version of DSH NoDeps…');
  const update = await appUpdate.check(signal);
  if (!update || closing) return;

  const selfUpdate = appUpdate.canSelfUpdate(update);
  const { response } = await message(win, {
    type: 'info',
    message: 'A new version of DSH NoDeps is available.',
    detail: `You have: ${appUpdate.currentVersion}\nNew: ${update.version}\n\n` +
      (selfUpdate ? 'Update now? The app will restart when it is done.' : 'Open the download page?'),
    buttons: ['Yes', 'No'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) return;
  if (!selfUpdate) { openUrl(update.pageUrl); return; }

  const file = await downloadUpdate(update);
  if (!file || closing) return; // cancelled or failed: carry on with the current version

  setStatus(`Installing DSH NoDeps v${update.version}…`);
  try {
    // Release the single-instance lock first, so the new version can start while this one is closing.
    app.releaseSingleInstanceLock();
    appUpdate.install(file);
    win.close();
  } catch (e) {
    app.requestSingleInstanceLock();
    await message(win, { type: 'warning', message: 'Could not install the new version.', detail: e.message });
  }
}

/** The "downloading the new version" window. Resolves with the verified file, or null if cancelled or failed. */
function downloadUpdate(update) {
  return new Promise((resolve) => {
    const cancel = new AbortController();
    const w = modal('update.html', 460, 150);
    let file = null, finished = false;

    const onCancel = (e) => { if (e.sender === w.webContents) cancel.abort(); };
    const onAppClosing = () => cancel.abort();
    ipcMain.on('update:cancel', onCancel);
    signal.addEventListener('abort', onAppClosing);
    // Closing the window means cancelling; it goes away once the download has stopped.
    w.on('close', (e) => { if (!finished) { e.preventDefault(); cancel.abort(); } });
    w.on('closed', () => {
      ipcMain.removeListener('update:cancel', onCancel);
      signal.removeEventListener('abort', onAppClosing);
      resolve(file);
    });

    w.webContents.once('did-finish-load', async () => {
      const send = (progress) => { if (!w.isDestroyed()) w.webContents.send('update:progress', progress); };
      const text = `Downloading DSH NoDeps v${update.version}…`;
      const mb = (n) => Math.floor(n / 1048576);
      send({ text, percent: null });
      try {
        file = await appUpdate.downloadAndVerify(update, (done, total) => send(total
          ? { text: `${text}  ${mb(done)} / ${mb(total)} MB`, percent: Math.min(100, Math.floor(done * 100 / total)) }
          : { text: `${text}  ${mb(done)} MB`, percent: null }), cancel.signal);
        send({ text: 'Verified. Installing…', percent: 100, done: true });
      } catch (e) {
        file = null;
        if (!cancel.signal.aborted)
          await message(w, {
            type: 'warning',
            message: 'The update could not be downloaded.',
            detail: `${e.message}\n\nThe app will keep running the current version.`,
          });
      }
      finished = true;
      if (!w.isDestroyed()) w.close();
    });
  });
}

/** A small dialog window of the app's own, modal to the main window. */
function modal(file, width, height) {
  const w = new BrowserWindow({
    parent: win,
    modal: true,
    width,
    height,
    useContentSize: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    show: false,
    title: Title,
    icon,
    webPreferences: { preload, sandbox: true, contextIsolation: true },
  });
  w.removeMenu();
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.once('ready-to-show', () => w.show());
  w.loadFile(ui(file));
  return w;
}

// ---- API key -------------------------------------------------------------

/**
 * If a key is stored and DeepSeek rejects it (401), asks for a new one. With no stored key it does nothing: the
 * user can sign in with their DeepSeek account from the UI itself.
 */
async function ensureApiKey() {
  const key = credentials.readKey();
  if (!key) return;

  setStatus('Checking the API key…');
  if (await credentials.check(key, signal) !== 'invalid') return;

  await new Promise((resolve) => {
    const w = modal('apikey.html', 500, 290);
    ipcMain.handle('apikey:save', async (e, value) => {
      if (e.sender !== w.webContents) return 'Unexpected request.';
      const key = String(value);
      const status = await credentials.check(key);
      if (status === 'invalid') return 'DeepSeek rejects this key. Check it or create another one.';
      if (status === 'unknown') {
        const { response } = await message(w, {
          type: 'question',
          message: 'Could not verify the key (offline?).',
          detail: 'Save it anyway?',
          buttons: ['Yes', 'No'],
          defaultId: 0,
          cancelId: 1,
        });
        if (response !== 0) return '';
      }
      try {
        credentials.saveKey(key);
        setImmediate(() => { if (!w.isDestroyed()) w.close(); });
        return 'saved';
      } catch (err) { return 'Could not save: ' + err.message; }
    });
    const skip = (e) => { if (e.sender === w.webContents) w.close(); };
    ipcMain.on('apikey:skip', skip);
    w.on('closed', () => {
      ipcMain.removeHandler('apikey:save');
      ipcMain.removeListener('apikey:skip', skip);
      resolve();
    });
  });
}

// ---- dsh server ----------------------------------------------------------

function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

/** Starts `dsh web` and resolves with the URL it prints. */
async function startDsh() {
  const port = await isPortFree(PreferredPort) ? PreferredPort : 0;
  log('> native picker owner: ' + toolchain.patchNativePickerOwner());

  // dsh runs under a small watchdog that stops it if this app goes away without closing it, even after a crash.
  // The portable Node cannot read inside app.asar, so the watchdog ships unpacked next to it.
  const watchdog = path.join(__dirname, 'watchdog.js')
    .replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
  dsh = spawn(toolchain.nodeExe, [
    watchdog, String(process.pid),
    toolchain.nodeExe, toolchain.dshBin, 'web', '--no-open', '--port', String(port),
  ], { env: toolchain.childEnv(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

  return new Promise((resolve, reject) => {
    let output = '';
    let urlSeen = false;
    const fail = (e) => { clearTimeout(timer); reject(e); };
    const timer = setTimeout(() =>
      fail(new Error('dsh did not respond within 60 s.\n\n' + toolchain.tail(output))), 60_000);
    signal.addEventListener('abort', () => fail(new Error('Cancelled')), { once: true });

    toolchain.readLines(dsh, (line) => {
      output = (output + line + '\n').slice(-20_000);
      log(line.replace(/token=[\w-]+/g, 'token=…')); // the token is never shown
      const m = /https?:\/\/\S+/.exec(line);
      if (m && line.includes('dsh web') && !urlSeen) {
        urlSeen = true;
        clearTimeout(timer);
        resolve(m[0]);
      }
    });
    dsh.on('error', fail);
    dsh.on('exit', () => {
      // Give the last lines a moment to arrive, so the error shows why it stopped.
      setTimeout(() => {
        if (!urlSeen) fail(new Error('dsh exited while starting.\n\n' + toolchain.tail(output)));
        else if (!closing)
          message(win, { type: 'warning', message: 'The DeepSeek Harness server has stopped.' })
            .then(() => win?.close());
      }, 200);
    });
  });
}

function stopDsh() {
  if (!dsh || dsh.exitCode !== null) return;
  try {
    if (process.platform === 'win32')
      spawnSync('taskkill', ['/T', '/F', '/PID', String(dsh.pid)], { windowsHide: true });
    else dsh.kill('SIGTERM'); // the watchdog stops dsh and everything it started
  } catch { }
}

// ---- The interface -------------------------------------------------------

function showWeb(url) {
  // dsh's page gets its own view, without the preload of the app's own pages.
  const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true } });
  win.contentView.addChildView(view);
  const fit = () => {
    const [width, height] = win.getContentSize();
    view.setBounds({ x: 0, y: 0, width, height });
  };
  fit();
  win.on('resize', fit);

  const wc = view.webContents;
  wc.setWindowOpenHandler(({ url }) => {
    // The web UI calls window.open("about:blank") and later redirects that window to DeepSeek's authorization page
    // (sign-in). It needs a real window to do so.
    if (!url || url === 'about:blank') {
      const b = win.getBounds(), width = 520, height = 740;
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          parent: win,
          width,
          height,
          x: Math.round(b.x + (b.width - width) / 2),
          y: Math.round(b.y + (b.height - height) / 2),
          title: 'DeepSeek',
          icon,
          webPreferences: { sandbox: true, contextIsolation: true },
        },
      };
    }
    if (isWebUrl(url)) {
      if (isLoopback(url)) wc.loadURL(url);
      else openUrl(url);
    }
    return { action: 'deny' };
  });
  wc.on('did-create-window', (popup) => {
    popup.removeMenu();
    popup.webContents.setWindowOpenHandler(({ url }) => {
      if (isWebUrl(url)) popup.webContents.loadURL(url);
      return { action: 'deny' };
    });
    addBrowserBehaviour(popup.webContents);
  });
  // "v1.2.0 — <chat name> — DeepSeek Harness": the version first, then the page's own title.
  wc.on('page-title-updated', (_e, title) =>
    win.setTitle(title.trim() ? `v${appUpdate.currentVersion} — ${title}` : BaseTitle));
  addBrowserBehaviour(wc);

  webShown = true;
  wc.loadURL(url);
}

/** What a browser window is expected to do: an edit menu on right click, zoom and reload from the keyboard. */
function addBrowserBehaviour(wc) {
  wc.on('context-menu', (_e, p) => {
    const items = [];
    if (p.linkURL && isWebUrl(p.linkURL))
      items.push({ label: 'Open link in browser', click: () => openUrl(p.linkURL) },
        { label: 'Copy link', click: () => require('electron').clipboard.writeText(p.linkURL) },
        { type: 'separator' });
    if (p.isEditable)
      items.push({ role: 'undo', enabled: p.editFlags.canUndo }, { role: 'redo', enabled: p.editFlags.canRedo },
        { type: 'separator' }, { role: 'cut', enabled: p.editFlags.canCut });
    if (p.isEditable || p.selectionText) items.push({ role: 'copy', enabled: p.editFlags.canCopy });
    if (p.isEditable) items.push({ role: 'paste', enabled: p.editFlags.canPaste });
    items.push({ role: 'selectAll' });
    Menu.buildFromTemplate(items).popup();
  });
  wc.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    const ctrl = input.control || input.meta;
    if (input.key === 'F5' || (ctrl && input.key.toLowerCase() === 'r')) wc.reload();
    else if (ctrl && (input.key === '+' || input.key === '=')) wc.setZoomLevel(Math.min(wc.getZoomLevel() + 0.5, 5));
    else if (ctrl && input.key === '-') wc.setZoomLevel(Math.max(wc.getZoomLevel() - 0.5, -3));
    else if (ctrl && input.key === '0') wc.setZoomLevel(0);
    else return;
    e.preventDefault();
  });
}

// ---- Shutdown ------------------------------------------------------------

function shutdown() {
  if (closing) return;
  closing = true;
  abort.abort();
  saveBounds();
  stopDsh();
}

const boundsFile = path.join(paths.data, 'window.json');

function saveBounds() {
  try {
    const b = win.getNormalBounds();
    fs.writeFileSync(boundsFile, JSON.stringify({
      X: b.x, Y: b.y, Width: b.width, Height: b.height, Maximized: win.isMaximized(),
    }));
  } catch { }
}

function loadBounds() {
  try {
    const r = JSON.parse(fs.readFileSync(boundsFile, 'utf8'));
    const rect = { x: r.X, y: r.Y, width: r.Width, height: r.Height };
    if (!Object.values(rect).every(Number.isInteger)) return null;
    const visible = screen.getAllDisplays().some(({ workArea: a }) =>
      rect.x < a.x + a.width && a.x < rect.x + rect.width && rect.y < a.y + a.height && a.y < rect.y + rect.height);
    return visible ? { rect, maximized: r.Maximized === true } : null;
  } catch { return null; }
}
