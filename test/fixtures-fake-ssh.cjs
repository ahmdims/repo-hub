'use strict';
// Pengganti `ssh` untuk tes (HUB_SSH_BIN). Meniru banner "ssh -T" per host dari FAKE_SSH_MAP (JSON):
//   { "github.com": { "out": "Hi dimas! You've successfully authenticated...", "code": 1 }, ... }
// Setiap pemanggilan dicatat (argumen) ke FAKE_SSH_LOG agar tes bisa memeriksa opsi yang dipakai.
// Opsional: FAKE_SSH_TRUST_FILE = berkas known_hosts. Bila diatur dan host asli tujuan belum ada di berkas itu, jawabannya
// kegagalan verifikasi host (seperti ssh dengan StrictHostKeyChecking=yes); host asli = HostName milik alias di config (-F).
const fs = require('node:fs');
const args = process.argv.slice(2);
if (process.env.FAKE_SSH_LOG) fs.appendFileSync(process.env.FAKE_SSH_LOG, `${JSON.stringify(args)}\n`);
const dest = args.find((a) => a.startsWith('git@')) || '';
const target = dest.replace(/^git@/, '');
const map = JSON.parse(process.env.FAKE_SSH_MAP || '{}');
const hit = map[target];
if (!hit) { process.stderr.write(`ssh: Could not resolve hostname ${target}: No such host is known.\n`); process.exit(255); }

if (process.env.FAKE_SSH_TRUST_FILE) {
  let realHost = target;
  const f = args.indexOf('-F');
  if (f >= 0 && fs.existsSync(args[f + 1])) {
    let inBlock = false;
    for (const line of fs.readFileSync(args[f + 1], 'utf8').split(/\r?\n/)) {
      const m = /^\s*(\w+)\s+(.*?)\s*$/.exec(line);
      if (!m) continue;
      if (/^host$/i.test(m[1])) inBlock = m[2].split(/\s+/).includes(target);
      else if (inBlock && /^hostname$/i.test(m[1])) realHost = m[2];
    }
  }
  let known = '';
  try { known = fs.readFileSync(process.env.FAKE_SSH_TRUST_FILE, 'utf8'); } catch { /* belum ada */ }
  const trusted = known.split(/\r?\n/).some((l) => (l.trim().split(/\s+/)[0] || '').split(',').includes(realHost));
  if (!trusted) {
    process.stderr.write(`No ED25519 host key is known for ${realHost} and you have requested strict checking.\nHost key verification failed.\n`);
    process.exit(255);
  }
}
process.stderr.write(`${hit.out}\n`);
process.exit(hit.code == null ? 0 : hit.code);
