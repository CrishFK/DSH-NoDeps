// This app's own version, the check for a newer release on GitHub, and the self-update: download the new build,
// verify its SHA-256 and hand over to it. Nothing here runs unless the user says yes.
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { app } = require('electron');
const paths = require('./paths');
const toolchain = require('./toolchain');

const Repo = 'CrishFK/DSH-NoDeps';
const DownloadPrefix = `https://github.com/${Repo}/releases/download/`;
const Headers = { 'User-Agent': 'DSH-NoDeps/1', Accept: 'application/vnd.github+json' };
const isWindows = process.platform === 'win32';

/** The release asset for this system: the installer on Windows, the packed app folder on Linux. */
const Asset = isWindows ? 'DSH-NoDeps-Setup.exe' : 'DSH-NoDeps-linux-x64.tar.gz';

/** The version of this build, e.g. "1.2.0" (set from the git tag by the release workflow). */
const currentVersion = app.getVersion();

/** Where the update is downloaded to: inside the app's folder, so it never lands anywhere else. */
const updateDir = path.join(paths.base, 'update');

/** Linux: the folder with the app's files, replaced as a whole by an update. */
const linuxAppDir = path.join(paths.linuxAppFolder, 'app');

/** The newest release if it is newer than this build; null if up to date, offline or the repo has no releases. */
async function check(signal) {
  try {
    const timeout = AbortSignal.any([signal, AbortSignal.timeout(6_000)]);
    const json = await toolchain.getString(`https://api.github.com/repos/${Repo}/releases?per_page=20`, timeout,
      { headers: Headers });
    return pickNewest(JSON.parse(json), currentVersion);
  } catch (e) {
    if (signal.aborted) throw e;
    return null; // no network, rate limit… never a reason to bother the user
  }
}

/**
 * Highest published release (tag vMAJOR.MINOR.PATCH[-suffix]) that is newer than current. Drafts are ignored, and
 * pre-releases only count when the running build is itself a pre-release. Only links that point into this
 * repository's own release downloads are accepted.
 */
function pickNewest(releases, current) {
  const allowPre = current.includes('-');
  let best = null;
  for (const release of releases) {
    if (release.draft) continue;
    if (!allowPre && release.prerelease) continue;

    const m = /^v(\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?)$/.exec(release.tag_name ?? '');
    if (!m) continue;
    const page = release.html_url;
    if (typeof page !== 'string' || !page.startsWith('https://github.com/')) continue;

    const version = m[1];
    if (best !== null && toolchain.compareVersions(version, best.version) <= 0) continue;

    let file = null, checksum = null;
    for (const a of release.assets ?? []) {
      const url = a.browser_download_url;
      if (typeof url !== 'string' || !url.startsWith(DownloadPrefix)) continue;
      if (a.name === Asset) file = url;
      else if (a.name === Asset + '.sha256') checksum = url;
    }
    best = { version, pageUrl: page, fileUrl: file, checksumUrl: checksum };
  }
  return best !== null && toolchain.compareVersions(best.version, current) > 0 ? best : null;
}

/**
 * True when this build can install the update itself; otherwise the user is sent to the download page. On Linux
 * the app's folder must be writable, since its app/ folder is replaced.
 */
function canSelfUpdate(update) {
  if (!update.fileUrl || !update.checksumUrl || !app.isPackaged) return false;
  if (isWindows) return true;
  try {
    fs.accessSync(paths.linuxAppFolder, fs.constants.W_OK);
    return fs.existsSync(path.join(linuxAppDir, 'DshLauncher'));
  } catch { return false; }
}

/**
 * Downloads the new build and checks it against the release's SHA-256 file. A file that does not match is deleted
 * and reported as an error. Returns the path of the verified file.
 */
async function downloadAndVerify(update, progress, signal) {
  const checksumText = await toolchain.getString(update.checksumUrl, signal, { headers: Headers });
  const m = /\b([0-9a-fA-F]{64})\b/.exec(checksumText);
  if (!m) throw new Error("The release's checksum file does not contain a SHA-256 value.");

  fs.mkdirSync(updateDir, { recursive: true });
  const file = path.join(updateDir, Asset);
  try {
    await toolchain.download(update.fileUrl, file, progress, signal);
    if ((await toolchain.sha256(file)) !== m[1].toLowerCase())
      throw new Error("The downloaded file is corrupt (its SHA-256 does not match the release's). It was discarded.");
    return file;
  } catch (e) {
    try { fs.rmSync(file, { force: true }); } catch { }
    throw e;
  }
}

/**
 * Hands over to the verified download and starts the new version; the caller then closes this one.
 * Windows: the installer runs silently (/SILENT shows only its progress window) and starts the app when it finishes
 * (/relaunch=1). Linux: the new app/ folder replaces this one (this process keeps running from the old files until it
 * exits) and the new version is started.
 */
function install(file) {
  if (isWindows) {
    spawn(file, ['/SILENT', '/NORESTART', '/relaunch=1'], { detached: true, stdio: 'ignore' }).unref();
    return;
  }

  // Unpack next to the app's folder, so that the final renames stay on the same disk.
  const unpacked = path.join(paths.linuxAppFolder, '.update-unpacked');
  fs.rmSync(unpacked, { recursive: true, force: true });
  fs.mkdirSync(unpacked);
  const tar = spawnSync('tar', ['-xzf', file, '-C', unpacked], { encoding: 'utf8' });
  if (tar.status !== 0) throw new Error(`Could not unpack the update.\n\n${tar.stderr ?? tar.error?.message ?? ''}`);
  const newFolder = path.join(unpacked, 'DSH NoDeps');
  if (!fs.existsSync(path.join(newFolder, 'app', 'DshLauncher')) || !fs.existsSync(path.join(newFolder, 'dsh-nodeps')))
    throw new Error('The update does not contain what was expected.');

  const old = linuxAppDir + '.old';
  fs.rmSync(old, { recursive: true, force: true });
  fs.renameSync(linuxAppDir, old);
  try {
    fs.renameSync(path.join(newFolder, 'app'), linuxAppDir);
  } catch (e) {
    fs.renameSync(old, linuxAppDir);
    throw e;
  }
  const launcher = path.join(paths.linuxAppFolder, 'dsh-nodeps');
  fs.copyFileSync(path.join(newFolder, 'dsh-nodeps'), launcher);
  fs.chmodSync(launcher, 0o755);
  fs.rmSync(unpacked, { recursive: true, force: true });
  spawn(launcher, [], { detached: true, stdio: 'ignore' }).unref();
}

/** Removes what a previous update left behind. Failure is harmless: it is retried next start. */
function cleanLeftovers() {
  try { fs.rmSync(updateDir, { recursive: true, force: true }); } catch { }
  if (!isWindows && app.isPackaged) {
    try { fs.rmSync(linuxAppDir + '.old', { recursive: true, force: true }); } catch { }
    try { fs.rmSync(path.join(paths.linuxAppFolder, '.update-unpacked'), { recursive: true, force: true }); } catch { }
  }
}

module.exports = { currentVersion, check, canSelfUpdate, downloadAndVerify, install, cleanLeftovers };
