'use strict';
// Pengganti `ssh` untuk tes (HUB_SSH_BIN). Meniru banner "ssh -T" per host dari FAKE_SSH_MAP (JSON):
//   { "github.com": { "out": "Hi dimas! You've successfully authenticated...", "code": 1 }, ... }
// Setiap pemanggilan dicatat (argumen) ke FAKE_SSH_LOG agar tes bisa memeriksa opsi yang dipakai.
const fs = require('node:fs');
const args = process.argv.slice(2);
if (process.env.FAKE_SSH_LOG) fs.appendFileSync(process.env.FAKE_SSH_LOG, `${JSON.stringify(args)}\n`);
const dest = args.find((a) => a.startsWith('git@')) || '';
const target = dest.replace(/^git@/, '');
const map = JSON.parse(process.env.FAKE_SSH_MAP || '{}');
const hit = map[target];
if (!hit) { process.stderr.write(`ssh: Could not resolve hostname ${target}: No such host is known.\n`); process.exit(255); }
process.stderr.write(`${hit.out}\n`);
process.exit(hit.code == null ? 0 : hit.code);
