// This app's own version, the check for a newer release on GitHub, and the self-update: download the new build,
// verify its SHA-256 and hand over to it. Nothing here runs unless the user says yes.
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');
const paths = require('./paths');
const toolchain = require('./toolchain');

const Repo = 'CrishFK/DSH-NoDeps';
const DownloadPrefix = `https://github.com/${Repo}/releases/download/`;
const Headers = { 'User-Agent': 'DSH-NoDeps/1', Accept: 'application/vnd.github+json' };

/** The release asset for this system: the installer on Windows, the AppImage on Linux. */
const Asset = process.platform === 'win32' ? 'DSH-NoDeps-Setup.exe' : 'DSH-NoDeps-x86_64.AppImage';

/** The version of this build, e.g. "1.2.0" (set from the git tag by the release workflow). */
const currentVersion = app.getVersion();

/** Where the Windows installer is downloaded to: inside the install folder, so it never lands anywhere else. */
const updateDir = path.join(paths.base, 'update');

/**
 * The running AppImage, when it can be replaced in place: the folder that holds it must be writable, because the new
 * file is downloaded next to it and then renamed over it.
 */
function replaceableAppImage() {
  const file = process.env.APPIMAGE;
  if (process.platform !== 'linux' || !file || !app.isPackaged) return null;
  try {
    fs.accessSync(path.dirname(file), fs.constants.W_OK);
    return file;
  } catch { return null; }
}

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

/** True when this build can install the update itself; otherwise the user is sent to the download page. */
function canSelfUpdate(update) {
  if (!update.fileUrl || !update.checksumUrl) return false;
  return process.platform === 'win32' ? app.isPackaged : replaceableAppImage() !== null;
}

/**
 * Downloads the new build and checks it against the release's SHA-256 file. A file that does not match is deleted
 * and reported as an error. Returns the path of the verified file.
 */
async function downloadAndVerify(update, progress, signal) {
  const checksumText = await toolchain.getString(update.checksumUrl, signal, { headers: Headers });
  const m = /\b([0-9a-fA-F]{64})\b/.exec(checksumText);
  if (!m) throw new Error("The release's checksum file does not contain a SHA-256 value.");

  // An AppImage is downloaded next to the running one, so that the final rename stays on the same disk.
  const dir = process.platform === 'win32' ? updateDir : path.dirname(replaceableAppImage());
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, process.platform === 'win32' ? Asset : `.${Asset}.download`);
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

/** Removes a leftover download from a previous update. Failure is harmless: it is retried next start. */
function cleanLeftovers() {
  try { fs.rmSync(updateDir, { recursive: true, force: true }); } catch { }
  const appImage = replaceableAppImage();
  if (appImage) try { fs.rmSync(path.join(path.dirname(appImage), `.${Asset}.download`), { force: true }); } catch { }
}

module.exports = { currentVersion, check, canSelfUpdate, downloadAndVerify, cleanLeftovers, replaceableAppImage };
