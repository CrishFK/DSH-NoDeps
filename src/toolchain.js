// The app's own dependencies, with nothing installed on the system: a portable Node.js and dsh
// (@deepseek-ai/dsh) inside the runtime folder.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { once } = require('node:events');
const { spawn, spawnSync } = require('node:child_process');
const { net } = require('electron');
const paths = require('./paths');

const Package = '@deepseek-ai/dsh';
const FallbackNode = 'v24.22.0';
const AllowScripts = '@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs';

const isWindows = process.platform === 'win32';
const root = paths.runtime;
const nodeDir = path.join(root, 'node');
const nodeExe = isWindows ? path.join(nodeDir, 'node.exe') : path.join(nodeDir, 'bin', 'node');
const npmCli = isWindows
  ? path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js')
  : path.join(nodeDir, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
const dshPrefix = path.join(root, 'dsh');
const dshPackageDir = path.join(dshPrefix, 'node_modules', '@deepseek-ai', 'dsh');
const dshBin = path.join(dshPackageDir, 'lib', 'bin.js');

const nodeInstalled = () => fs.existsSync(nodeExe) && fs.existsSync(npmCli);
const dshInstalled = () => fs.existsSync(dshBin);

/**
 * dsh's native folder dialog on Windows calls IFileOpenDialog::Show with a null owner. A dialog without an owner is
 * not modal to the launcher, so the window never learns that it closed and can stay stuck until a click. Pass the
 * foreground window (the launcher) as the owner, the same way Chromium's own file picker is owned. dsh updates
 * replace this file, so the patch is re-applied on every start.
 */
function patchNativePickerOwner() {
  if (!isWindows) return 'not needed on this system';
  try {
    const file = path.join(dshPrefix, 'node_modules', '@deepseek-ai',
      'dsh-host-directory-picker-native', 'lib', 'worker.cjs');
    if (!fs.existsSync(file)) return 'worker.cjs not found';
    const text = fs.readFileSync(file, 'utf8');
    if (text.includes('getForegroundWindow: () => getForegroundWindow()')) return 'already patched';

    let updated = text.replace(
      'const getCurrentThreadId = kernel32.func("__stdcall", "GetCurrentThreadId", "uint32", []);',
      'const getCurrentThreadId = kernel32.func("__stdcall", "GetCurrentThreadId", "uint32", []);\n' +
      '\tconst getForegroundWindow = user32.func("__stdcall", "GetForegroundWindow", "void *", []);');
    updated = updated.replace(
      'currentThreadId: () => getCurrentThreadId(),',
      'currentThreadId: () => getCurrentThreadId(),\n\t\tgetForegroundWindow: () => getForegroundWindow(),');
    updated = updated.replace(
      'show: () => method(dialog, SLOT_SHOW, protoShow)(null),',
      'show: (owner) => method(dialog, SLOT_SHOW, protoShow)(owner ?? null),');
    updated = updated.replace(
      /bindings\.pressAltForForeground\(\);\s*const shown = dialog\.show\(\);/,
      'const owner = bindings.getForegroundWindow();\n' +
      '\t\t\tbindings.pressAltForForeground();\n' +
      '\t\t\tconst shown = dialog.show(owner);');

    if (!updated.includes('const getForegroundWindow = user32.func') ||
      !updated.includes('getForegroundWindow: () => getForegroundWindow()') ||
      !updated.includes('show: (owner) => method(dialog, SLOT_SHOW, protoShow)(owner ?? null)') ||
      !updated.includes('dialog.show(owner)'))
      return 'pattern mismatch';

    const backup = file + '.dsh-no-deps.bak';
    if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
    fs.writeFileSync(file, updated);
    return 'patched';
  } catch (e) { return 'failed: ' + e.message; }
}

/** The environment for a child process: the portable Node first on the PATH, so dsh and npm scripts find it. */
function childEnv(extra = {}) {
  const env = { ...process.env };
  // Windows spells it "Path"; keep a single entry whatever its case.
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  const current = env[key] ?? '';
  delete env[key];
  env.PATH = nodeDir + (isWindows ? '' : path.sep + 'bin') + path.delimiter + current;
  return { ...env, ...extra };
}

// ---- Processes -----------------------------------------------------------

/** Stops a process and everything it started. */
function killTree(child) {
  if (!child.pid || child.exitCode !== null) return;
  try {
    if (isWindows) spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true });
    else process.kill(-child.pid, 'SIGTERM'); // started detached: it leads its own process group
  } catch { }
}

/** Calls onLine for every line the process writes, on stdout or stderr. */
function readLines(child, onLine) {
  readline.createInterface({ input: child.stdout }).on('line', onLine);
  readline.createInterface({ input: child.stderr }).on('line', onLine);
}

function abortError() {
  const e = new Error('Cancelled');
  e.name = 'AbortError';
  return e;
}

/** Runs a program to the end. Each output line is passed to onLine as soon as it appears. */
function run(file, args, { cwd, env, onLine, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const child = spawn(file, args, { cwd, env, windowsHide: true, detached: !isWindows });
    let output = '';
    readLines(child, (line) => { output += line + '\n'; onLine?.(line); });
    const abort = () => killTree(child);
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', (e) => { signal?.removeEventListener('abort', abort); reject(e); });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted) reject(abortError());
      else resolve({ code: code ?? 1, output });
    });
  });
}

/** Runs npm with the portable Node. */
function runNpm(onLine, signal, ...args) {
  return run(nodeExe, [npmCli, ...args], {
    cwd: root,
    onLine,
    signal,
    env: childEnv({
      npm_config_update_notifier: 'false',
      // Keep npm from leaving anything outside the runtime folder (by default it uses a cache in the user profile).
      npm_config_cache: path.join(root, 'npm-cache'),
    }),
  });
}

// ---- Versions -------------------------------------------------------------

function installedDshVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(dshPackageDir, 'package.json'), 'utf8')).version ?? null; }
  catch { return null; }
}

/**
 * The highest version published under any npm tag (latest, next, alpha…), so the app always tracks the newest build
 * even though DeepSeek has not marked anything as stable.
 */
async function latestDshVersion(signal) {
  const { code, output } = await runNpm(null, signal, 'view', Package, 'dist-tags', '--json');
  if (code !== 0) return null;
  try {
    const start = output.indexOf('{'), end = output.lastIndexOf('}');
    if (start < 0 || end < start) return null;
    let best = null;
    for (const v of Object.values(JSON.parse(output.slice(start, end + 1)))) {
      if (typeof v !== 'string' || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(v)) continue;
      if (best === null || compareVersions(v, best) > 0) best = v;
    }
    return best;
  } catch { return null; }
}

/** Compares "0.2.1-rc.2" with "0.2.0-rc.2" (a leading "v" is accepted). No suffix counts as stable, i.e. greater. */
function compareVersions(a, b) {
  const parse = (v) => {
    const [main, pre] = v.replace(/^v+/, '').split(/-(.*)/s);
    return {
      nums: main.split('.').map((x) => (/^\d+$/.test(x) ? Number(x) : 0)),
      pre: pre ? pre.split('.') : [],
    };
  };
  const comparePrerelease = (a, b) => {
    if (a.length === 0 || b.length === 0) return Math.sign(b.length - a.length); // stable sorts last
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const an = /^\d+$/.test(a[i]), bn = /^\d+$/.test(b[i]);
      const c = an && bn ? Math.sign(Number(a[i]) - Number(b[i]))
        : an ? -1                                                   // numeric identifiers sort before text
          : bn ? 1
            : a[i] < b[i] ? -1 : a[i] > b[i] ? 1 : 0;
      if (c !== 0) return c;
    }
    return Math.sign(a.length - b.length);
  };
  const x = parse(a), y = parse(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const p = x.nums[i] ?? 0, q = y.nums[i] ?? 0;
    if (p !== q) return Math.sign(p - q);
  }
  return comparePrerelease(x.pre, y.pre);
}

function tail(s) {
  return s.split('\n').slice(-12).join('\n');
}

// ---- dsh -------------------------------------------------------------------

/**
 * Installs dsh if missing (mandatory) or updates it to the latest version (optional: if that fails the current one
 * is kept). Throws only when dsh ends up unusable.
 */
async function ensureDsh(status, log, signal) {
  if (!dshInstalled()) {
    status('Installing DeepSeek Harness…');
    const first = await tryLatest(signal);
    const { code, output } = await installDsh(first ?? 'next', log, signal);
    if (code !== 0 || !dshInstalled() || installedDshVersion() === null)
      throw new Error(`Could not install DeepSeek Harness.\n\n${tail(output)}`);
    return;
  }

  try {
    status('Checking for DeepSeek Harness updates…');
    const latest = await tryLatest(signal);
    const installed = installedDshVersion();
    if (latest !== null && (installed === null || compareVersions(latest, installed) > 0)) {
      status(`Updating DeepSeek Harness to ${latest}…`);
      const { code, output } = await installDsh(latest, log, signal);
      if (code !== 0) throw new Error(`npm install exited with code ${code}.\n\n${tail(output)}`);
      const updated = installedDshVersion();
      if (updated === null || compareVersions(updated, latest) < 0)
        throw new Error(`DeepSeek Harness reports ${updated ?? '(unknown)'} after installing ${latest}.`);
    }
  } catch (e) {
    if (signal.aborted) throw e;
    log('> dsh update failed, keeping the installed version: ' + e.message.split('\n')[0]);
  }

  // If a half-finished update left the package unusable, reinstall from scratch.
  if (!dshInstalled() || installedDshVersion() === null) {
    status('Repairing DeepSeek Harness…');
    const { code, output } = await installDsh('next', log, signal);
    if (code !== 0 || !dshInstalled() || installedDshVersion() === null)
      throw new Error(`DeepSeek Harness was left damaged after updating and could not be repaired.\n\n${tail(output)}`);
  }
}

async function tryLatest(signal) {
  const timeout = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
  try { return await latestDshVersion(timeout); }
  catch (e) {
    if (signal.aborted) throw e;
    return null;
  }
}

/** Installs (or updates) dsh in runtime/dsh. If this npm does not understand --allow-scripts, retries without it. */
async function installDsh(version, log, signal) {
  fs.mkdirSync(dshPrefix, { recursive: true });
  const args = [
    'install', '--prefix', dshPrefix, `${Package}@${version}`, '--no-audit', '--no-fund',
    '--loglevel=http', // without a terminal npm draws no progress bar; this makes every download visible
  ];
  log(`> npm install ${Package}@${version}`);
  let result = await runNpm(log, signal, ...args, `--allow-scripts=${AllowScripts}`);
  if (result.code !== 0) {
    log('> retrying without --allow-scripts');
    result = await runNpm(log, signal, ...args);
  }
  return result;
}

// ---- Portable Node.js -----------------------------------------------------

/** Node's name for this system in its downloads, e.g. "win-x64" or "linux-x64". */
const nodePlatform = `${isWindows ? 'win' : 'linux'}-${process.arch}`;
// zip on Windows (tar.exe ships with Windows 10 and later and reads zip); tar.gz elsewhere.
const nodeArchiveExt = isWindows ? '.zip' : '.tar.gz';

/**
 * Installs Node.js if missing and otherwise updates it to the latest LTS. A failed update (offline, corrupt
 * download…) is not an error: the version that already works is kept.
 */
async function ensureNode(status, log, signal) {
  if (!nodeInstalled()) {
    fs.mkdirSync(root, { recursive: true });
    status('Preparing Node.js…');
    await installNode(status, log, await latestNodeLts(signal, true), signal);
    return;
  }

  try {
    status('Checking for Node.js updates…');
    const latest = await latestNodeLts(signal, false);
    const installed = await installedNodeVersion(signal);
    if (latest !== null && (installed === null || compareVersions(latest, installed) > 0))
      await installNode(status, log, latest, signal);
  } catch (e) {
    if (signal.aborted) throw e;
    // keep the current version
  }
}

async function installedNodeVersion(signal) {
  const { code, output } = await run(nodeExe, ['--version'], { signal });
  const v = output.trim();
  return code === 0 && v.startsWith('v') ? v : null;
}

async function installNode(status, log, version, signal) {
  const name = `node-${version}-${nodePlatform}`;
  const baseUrl = `https://nodejs.org/dist/${version}/`;
  log(`> Node.js ${version}: ${baseUrl}${name}${nodeArchiveExt}`);

  const sums = await getString(baseUrl + 'SHASUMS256.txt', signal);
  const expected = sums.split('\n')
    .map((l) => l.trim().split(/\s+/))
    .find((p) => p.length === 2 && p[1] === name + nodeArchiveExt)?.[0];
  if (!expected) throw new Error('Could not get the Node.js checksum.');

  const archive = path.join(root, name + nodeArchiveExt);
  const tmp = path.join(root, 'node-extract');
  try {
    await download(baseUrl + name + nodeArchiveExt, archive, (done, total) => status(total
      ? `Downloading Node.js… ${mb(done)} / ${mb(total)} MB`
      : `Downloading Node.js… ${mb(done)} MB`), signal);

    log('> verifying SHA-256 against nodejs.org SHASUMS256.txt');
    status('Verifying Node.js…');
    if ((await sha256(archive)) !== expected.toLowerCase())
      throw new Error('The Node.js download is corrupt (SHA-256 mismatch). Please try again.');

    log('> extracting Node.js');
    status('Extracting Node.js…');
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    const tar = isWindows ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
    const { code, output } = await run(tar, [isWindows ? '-xf' : '-xzf', archive, '-C', tmp], { signal });
    if (code !== 0) throw new Error(`Could not extract Node.js.\n\n${tail(output)}`);

    // Safe swap: the previous version is only deleted once the new one is in place.
    const old = nodeDir + '.old';
    fs.rmSync(old, { recursive: true, force: true });
    const hadOld = fs.existsSync(nodeDir);
    if (hadOld) fs.renameSync(nodeDir, old);
    try {
      fs.renameSync(path.join(tmp, name), nodeDir);
      if (!nodeInstalled()) throw new Error('Node.js was downloaded but its contents are not what was expected.');
    } catch (e) {
      fs.rmSync(nodeDir, { recursive: true, force: true });
      if (hadOld) fs.renameSync(old, nodeDir);
      throw e;
    }
    if (hadOld) try { fs.rmSync(old, { recursive: true, force: true }); } catch { }
    log(`> Node.js ${version} ready`);
  } finally {
    try { fs.rmSync(archive, { force: true }); } catch { }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { }
  }
}

/** Latest Node LTS for this system. Offline it returns the fallback version, or null. */
async function latestNodeLts(signal, fallback) {
  try {
    const fileKey = isWindows ? `${nodePlatform}-zip` : nodePlatform;
    for (const release of JSON.parse(await getString('https://nodejs.org/dist/index.json', signal))) {
      if (typeof release.lts !== 'string') continue;
      if (!release.files?.includes(fileKey)) continue;
      return release.version;
    }
  } catch (e) {
    if (signal.aborted) throw e;
  }
  return fallback ? FallbackNode : null;
}

// ---- Downloads ---------------------------------------------------------------

const mb = (n) => Math.floor(n / 1048576);

async function getString(url, signal, init = {}) {
  const resp = await net.fetch(url, { ...init, signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  return resp.text();
}

/** Downloads url to dest, reporting (bytes done, total or null) at most every 200 ms. */
async function download(url, dest, progress, signal) {
  const resp = await net.fetch(url, { signal });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  const total = Number(resp.headers.get('content-length')) || null;
  const file = fs.createWriteStream(dest);
  let done = 0, last = 0;
  try {
    for await (const chunk of resp.body) {
      if (!file.write(chunk)) await once(file, 'drain');
      done += chunk.length;
      if (Date.now() - last > 200) { progress(done, total); last = Date.now(); }
    }
  } finally {
    await new Promise((resolve) => file.end(resolve));
  }
  progress(done, total);
}

async function sha256(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

module.exports = {
  Package, nodeExe, dshBin, childEnv, killTree, readLines,
  patchNativePickerOwner, compareVersions, tail,
  ensureNode, ensureDsh, getString, download, sha256,
};
