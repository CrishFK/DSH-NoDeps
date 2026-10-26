// Reads, validates and saves the DeepSeek API key in dsh's credentials file ($DSH_HOME/.credentials.yaml,
// refs section).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { net } = require('electron');

const BalanceUrl = 'https://api.deepseek.com/user/balance';

const KeyLine = /^(\s*)DEEPSEEK_API_KEY\s*:\s*(.*?)\s*$/;
const RefsLine = /^refs\s*:\s*(\{\s*\})?\s*$/;
// The only inline form we can read or rewrite without losing other refs: refs: { DEEPSEEK_API_KEY: ... }
const InlineRefsKey = /^refs\s*:\s*\{\s*DEEPSEEK_API_KEY\s*:\s*([^,{}]*?)\s*\}\s*$/;

function dshHome() {
  const env = process.env.DSH_HOME;
  return env && env.trim() ? env : path.join(os.homedir(), '.dsh');
}

const filePath = () => path.join(dshHome(), '.credentials.yaml');

/** Stored key, or null if there is no file or it contains none. */
function readKey() {
  try {
    if (!fs.existsSync(filePath())) return null;
    for (const line of fs.readFileSync(filePath(), 'utf8').split(/\r?\n/)) {
      const value = line.match(KeyLine)?.[2] ?? line.match(InlineRefsKey)?.[1];
      if (value === undefined) continue;
      const v = value.trim().replace(/^["']+|["']+$/g, '');
      return v.length === 0 ? null : v;
    }
  } catch { }
  return null;
}

/** Asks the DeepSeek API whether the key is valid: 'valid', 'invalid', or 'unknown' when offline. */
async function check(key, signal) {
  try {
    const timeout = AbortSignal.timeout(8_000);
    const resp = await net.fetch(BalanceUrl, {
      headers: { Authorization: `Bearer ${key}` },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (resp.ok) return 'valid';
    if (resp.status === 401) return 'invalid';
    return 'unknown';
  } catch { return 'unknown'; }
}

/** Writes the key to refs.DEEPSEEK_API_KEY without touching the rest of the file. A timestamped backup is made first. */
function saveKey(key) {
  if (/\s/.test(key) || key.includes('#') || key.includes(':'))
    throw new Error('The key contains invalid characters.');

  const file = filePath();
  fs.mkdirSync(dshHome(), { recursive: true });
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (text.length > 0) {
    const d = new Date(), p = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    fs.copyFileSync(file, `${file}.bak-${stamp}`);
  }

  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.length === 0 ? [] : text.replace(/\r\n/g, '\n').split('\n');

  const entry = 'DEEPSEEK_API_KEY: ' + key;
  const existing = lines.findIndex((l) => KeyLine.test(l));
  if (existing >= 0) {
    lines[existing] = lines[existing].match(KeyLine)[1] + entry;
  } else {
    const refs = lines.findIndex((l) => RefsLine.test(l));
    const inlineRefs = refs >= 0 ? -1 : lines.findIndex((l) => InlineRefsKey.test(l));
    if (refs >= 0) {
      lines[refs] = 'refs:';
      lines.splice(refs + 1, 0, '  ' + entry);
    } else if (inlineRefs >= 0) {
      lines[inlineRefs] = 'refs:';
      lines.splice(inlineRefs + 1, 0, '  ' + entry);
    } else if (lines.some((l) => /^refs\s*:/.test(l))) {
      throw new Error('Unexpected format in .credentials.yaml (refs section).');
    } else {
      while (lines.length > 0 && lines.at(-1).trim().length === 0) lines.pop();
      if (lines.length === 0) lines.push('version: 1');
      lines.push('refs:', '  ' + entry, '');
    }
  }

  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, lines.join(nl), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

module.exports = { dshHome, readKey, check, saveKey };
