'use strict';
// Akses ke ~/.ssh dengan batas ketat:
//  - dibaca: config, known_hosts, dan kunci PUBLIK (*.pub). Kunci privat TIDAK PERNAH dibuka; hanya keberadaannya diperiksa.
//  - ditulis: kunci baru (tidak pernah menimpa), blok Host baru di config (setelah backup, hanya menambah di akhir),
//    dan satu baris known_hosts yang dikonfirmasi pengguna. Tidak ada yang dihapus.
//  - semua nama file/alias/host divalidasi; tidak ada path dari UI yang dipakai mentah-mentah.
// HUB_SSH_DIR mengganti folder (untuk tes dan profil terpisah) sehingga tes tidak menyentuh ~/.ssh asli.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { run } = require('./exec');

const sshDir = () => process.env.HUB_SSH_DIR || path.join(os.homedir(), '.ssh');

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/; // nama file di dalam folder ssh
const ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;
const USER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const COMMENT_RE = /^[\w.@+ -]{0,100}$/;

/* ------------------------------------------------------------------ config */
// Pengurai sederhana: blok "Host", HostName, User, Port, IdentityFile. "Match" dan "Include" tidak diikuti (ditandai saja).
function parseConfig(text) {
  const blocks = []; let cur = null; let hasInclude = false; let hasMatch = false;
  const lines = String(text || '').split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const m = /^(\w+)(?:\s*=\s*|\s+)(.*)$/.exec(line);
    if (!m) return;
    const key = m[1].toLowerCase(); const val = m[2].trim().replace(/^"(.*)"$/, '$1');
    if (key === 'host') { cur = { patterns: val.split(/\s+/).filter(Boolean), hostName: null, user: null, port: null, identityFiles: [], identitiesOnly: false, line: i + 1 }; blocks.push(cur); return; }
    if (key === 'match') { cur = null; hasMatch = true; return; }
    if (key === 'include') { hasInclude = true; return; }
    if (!cur) return;
    if (key === 'hostname' && !cur.hostName) cur.hostName = val;
    else if (key === 'user' && !cur.user) cur.user = val;
    else if (key === 'port' && !cur.port) cur.port = Number(val) || null;
    else if (key === 'identityfile') cur.identityFiles.push(val);
    else if (key === 'identitiesonly') cur.identitiesOnly = /^yes$/i.test(val);
  });
  return { blocks, hasInclude, hasMatch };
}

const isPlainHost = (p) => !/[*?!]/.test(p);

// "~/.ssh/id_x" atau path absolut di dalam folder ssh -> nama file; selain itu null
function identityName(value, dir = sshDir()) {
  if (!value) return null;
  const v = String(value).replace(/\\/g, '/');
  if (v.split('/').includes('..')) return null;
  const base = path.posix.basename(v);
  if (!NAME_RE.test(base)) return null;
  if (v.startsWith('~/.ssh/') || v.startsWith('.ssh/')) return base;
  const norm = (p) => path.resolve(p).replace(/\\/g, '/').toLowerCase();
  return norm(path.dirname(value)) === norm(dir) ? base : null;
}

function readConfig(dir = sshDir()) {
  const file = path.join(dir, 'config');
  if (!fs.existsSync(file)) return { exists: false, blocks: [], hasInclude: false, hasMatch: false };
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return { exists: true, blocks: [], hasInclude: false, hasMatch: false, error: 'Could not read the ssh config.' }; }
  return { exists: true, ...parseConfig(text) };
}

// satu alias per blok Host sederhana (tanpa wildcard): { alias, hostName, user, port, identityFile }
function hostAliases(dir = sshDir()) {
  const cfg = readConfig(dir);
  const out = [];
  for (const b of cfg.blocks) for (const p of b.patterns) {
    if (!isPlainHost(p)) continue;
    out.push({ alias: p, hostName: b.hostName || p, user: b.user, port: b.port, identityFile: identityName(b.identityFiles[0], dir), line: b.line });
  }
  return { ...cfg, aliases: out };
}

/* ------------------------------------------------------------------ kunci publik */
// SHA256:<base64 tanpa padding> dari blob kunci, sama dengan keluaran "ssh-keygen -l"
function fingerprintOf(blobB64) {
  return `SHA256:${crypto.createHash('sha256').update(Buffer.from(blobB64, 'base64')).digest('base64').replace(/=+$/, '')}`;
}

function parsePublicKey(text) {
  const m = /^(ssh-[a-z0-9]+|ecdsa-sha2-[a-z0-9]+|sk-[a-z0-9@.-]+)\s+([A-Za-z0-9+/=]+)(?:\s+(.*))?$/m.exec(String(text || '').trim());
  if (!m) return null;
  const typeMap = { 'ssh-ed25519': 'ED25519', 'ssh-rsa': 'RSA', 'ssh-dss': 'DSA' };
  return { keyType: m[1], type: typeMap[m[1]] || (m[1].startsWith('ecdsa') ? 'ECDSA' : m[1]), blob: m[2], comment: (m[3] || '').trim(), fingerprint: fingerprintOf(m[2]) };
}

function listPublicKeys(dir = sshDir()) {
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.pub') && NAME_RE.test(n)); } catch { return []; }
  const out = [];
  for (const file of names.sort()) {
    let text = '';
    try { text = fs.readFileSync(path.join(dir, file), 'utf8'); } catch { continue; }
    const k = parsePublicKey(text);
    if (!k) continue;
    out.push({ file, type: k.type, fingerprint: k.fingerprint, comment: k.comment, hasPrivate: fs.existsSync(path.join(dir, file.slice(0, -4))) });
  }
  return out;
}

function readPublicKey(file, dir = sshDir()) {
  if (!NAME_RE.test(String(file || '')) || !String(file).endsWith('.pub')) return { ok: false, error: 'Not a public key file name.' };
  const full = path.join(dir, file);
  if (!fs.existsSync(full)) return { ok: false, error: 'Public key not found.' };
  const text = fs.readFileSync(full, 'utf8').trim();
  const k = parsePublicKey(text);
  if (!k) return { ok: false, error: 'This file does not look like a public key.' };
  return { ok: true, file, publicKey: text, fingerprint: k.fingerprint, comment: k.comment, type: k.type };
}

/* ------------------------------------------------------------------ tulis (selalu lewat konfirmasi di services) */
async function createKey({ name, comment }, dir = sshDir()) {
  const slug = String(name || '').trim();
  if (!NAME_RE.test(slug) || /\.pub$/i.test(slug)) return { ok: false, error: 'Key name may only use letters, digits, dot, dash and underscore.' };
  const cmt = String(comment == null ? '' : comment).trim();
  if (!COMMENT_RE.test(cmt)) return { ok: false, error: 'Key comment contains characters that are not allowed.' };
  const privName = `id_ed25519_${slug}`;
  const priv = path.join(dir, privName), pub = `${priv}.pub`;
  if (!NAME_RE.test(privName)) return { ok: false, error: 'Key name is too long.' };
  if (fs.existsSync(priv) || fs.existsSync(pub)) return { ok: false, error: `A key named ${privName} already exists. Choose another name; existing keys are never overwritten.` };
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const r = await run('ssh-keygen', ['-t', 'ed25519', '-f', priv, '-C', cmt, '-N', ''], { timeout: 60000 });
  if (!r.ok || !fs.existsSync(priv) || !fs.existsSync(pub)) {
    return { ok: false, error: /ENOENT|not found|not recognized/i.test(r.stderr) ? 'ssh-keygen was not found. Install the OpenSSH client first.' : `Could not create the key: ${(r.stderr || 'ssh-keygen failed').split('\n')[0]}` };
  }
  return { ok: true, privateFile: privName, ...readPublicKey(`${privName}.pub`, dir) };
}

function backupStamp() { return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-'); }

// Menambah satu blok Host di akhir config. Backup dulu; konten lama tidak diubah sama sekali (append).
function appendHostBlock({ alias, hostName, user = 'git', port, identityFile, label }, dir = sshDir()) {
  if (!ALIAS_RE.test(String(alias || ''))) return { ok: false, error: 'Alias may only use letters, digits, dot, dash and underscore.' };
  if (!HOST_RE.test(String(hostName || ''))) return { ok: false, error: 'Host name is not valid.' };
  if (!USER_RE.test(String(user || ''))) return { ok: false, error: 'User name is not valid.' };
  const p = port == null || port === '' ? null : Number(port);
  if (p != null && !(Number.isInteger(p) && p >= 1 && p <= 65535)) return { ok: false, error: 'Port must be a number between 1 and 65535.' };
  if (!NAME_RE.test(String(identityFile || '')) || identityFile.endsWith('.pub') || !fs.existsSync(path.join(dir, identityFile))) return { ok: false, error: 'Identity file must be an existing key inside the ssh folder.' };

  const file = path.join(dir, 'config');
  let text = '';
  if (fs.existsSync(file)) {
    text = fs.readFileSync(file, 'utf8');
    if (parseConfig(text).blocks.some((b) => b.patterns.includes(alias))) return { ok: false, error: `The ssh config already has a Host named "${alias}". Choose another alias; existing entries are never changed.` };
  }
  let backup = null;
  if (fs.existsSync(file)) {
    const stamp = backupStamp();
    for (let n = 0; n < 50 && !backup; n++) {
      const name = `config.bak-${stamp}${n ? `-${n + 1}` : ''}`;
      try { fs.copyFileSync(file, path.join(dir, name), fs.constants.COPYFILE_EXCL); backup = name; } catch (e) { if (e.code !== 'EEXIST') return { ok: false, error: `Could not back up the ssh config, so nothing was changed (${e.code || e.message}).` }; }
    }
    if (!backup) return { ok: false, error: 'Could not back up the ssh config (too many backups with the same timestamp), so nothing was changed.' };
  } else fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const tag = String(label || '').replace(/[^\w .@+-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const lines = [`# Added by Repo Hub${tag ? `: ${tag}` : ''}`, `Host ${alias}`, `    HostName ${hostName}`, `    User ${user}`];
  if (p) lines.push(`    Port ${p}`);
  lines.push(`    IdentityFile ~/.ssh/${identityFile}`, '    IdentitiesOnly yes');
  const block = (text && !/\n$/.test(text) ? eol : '') + (text ? eol : '') + lines.join(eol) + eol;
  fs.appendFileSync(file, block, 'utf8');
  return { ok: true, backup, block: lines.join('\n') };
}

/* ------------------------------------------------------------------ known_hosts */
// "host keytype base64" (atau "[host]:port keytype base64") dari ssh-keyscan -> [{ line, type, fingerprint }]
function parseKeyscan(stdout) {
  const out = [];
  for (const raw of String(stdout || '').split(/\r?\n/)) {
    const m = /^(\S+)\s+(ssh-[a-z0-9]+|ecdsa-sha2-[a-z0-9]+)\s+([A-Za-z0-9+/=]+)\s*$/.exec(raw.trim());
    if (m) out.push({ line: `${m[1]} ${m[2]} ${m[3]}`, type: m[2] === 'ssh-ed25519' ? 'ED25519' : m[2] === 'ssh-rsa' ? 'RSA' : 'ECDSA', fingerprint: fingerprintOf(m[3]) });
  }
  return out;
}

async function scanHostKeys(host, port) {
  if (!HOST_RE.test(String(host || ''))) return { ok: false, error: 'Host name is not valid.' };
  const args = ['-T', '10', '-t', 'ed25519,ecdsa,rsa'];
  if (port && Number(port) !== 22) { if (!Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535) return { ok: false, error: 'Port is not valid.' }; args.push('-p', String(Number(port))); }
  args.push(host);
  const r = await run('ssh-keyscan', args, { timeout: 30000 });
  const keys = parseKeyscan(r.stdout);
  if (!keys.length) return { ok: false, error: /ENOENT|not found|not recognized/i.test(r.stderr) ? 'ssh-keyscan was not found. Install the OpenSSH client first.' : `Could not read the host's key (${(r.stderr || 'no response').split('\n')[0]}).` };
  return { ok: true, keys };
}

async function knownHostsHas(host, port, dir = sshDir()) {
  const target = port && Number(port) !== 22 ? `[${host}]:${Number(port)}` : host;
  const file = path.join(dir, 'known_hosts');
  if (!fs.existsSync(file)) return false;
  const r = await run('ssh-keygen', ['-F', target, '-f', file], { timeout: 15000 });
  return r.ok && r.stdout.trim().length > 0;
}

function appendKnownHost(line, dir = sshDir()) {
  const file = path.join(dir, 'known_hosts');
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); }
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  fs.appendFileSync(file, (text && !/\n$/.test(text) ? eol : '') + line + eol, 'utf8');
  return { ok: true };
}

module.exports = {
  sshDir, parseConfig, readConfig, hostAliases, identityName, fingerprintOf, parsePublicKey, listPublicKeys, readPublicKey,
  createKey, appendHostBlock, parseKeyscan, scanHostKeys, knownHostsHas, appendKnownHost,
  NAME_RE, ALIAS_RE, HOST_RE,
};
