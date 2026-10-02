'use strict';
// Transport SSH palsu untuk git (GIT_SSH_COMMAND): git@<alias>:<path> dipetakan ke repo bare lokal lewat
// FAKE_GIT_SSH_MAP = { "<alias>:<path>": "<folder bare>" } (JSON). Tanpa jaringan dan tanpa server SSH.
const { spawn } = require('node:child_process');
const args = process.argv.slice(2);
const i = args.findIndex((a) => a.startsWith('git@'));
const alias = i >= 0 ? args[i].slice(4) : '';
const cmd = i >= 0 ? args.slice(i + 1).join(' ') : '';
const m = /^git-(upload-pack|receive-pack) '(.+)'$/.exec(cmd);
const map = JSON.parse(process.env.FAKE_GIT_SSH_MAP || '{}');
const dir = m && map[`${alias}:${m[2].replace(/^\//, '')}`];
if (!dir) { process.stderr.write(`ssh: fake transport has no repo for ${alias} (${cmd})\nPermission denied (publickey).\n`); process.exit(255); }
const child = spawn('git', [m[1], dir], { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code == null ? 1 : code));
