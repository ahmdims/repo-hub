'use strict';
// Pengganti `ssh-keyscan` untuk tes (HUB_SSH_KEYSCAN_BIN): FAKE_KEYSCAN = { "host": "ssh-ed25519 AAAA..." } (JSON).
const args = process.argv.slice(2);
const host = args[args.length - 1];
const pi = args.indexOf('-p');
const label = pi >= 0 ? `[${host}]:${args[pi + 1]}` : host;
const key = JSON.parse(process.env.FAKE_KEYSCAN || '{}')[host];
if (!key) { process.stderr.write(`getaddrinfo ${host}: No such host is known.\n`); process.exit(1); }
process.stdout.write(`# ${host}:22 SSH-2.0-fake\n${label} ${key}\n`);
