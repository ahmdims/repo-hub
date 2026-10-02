'use strict';
// Menjalankan program eksternal (git, gh) TANPA shell: argumen selalu array, jadi teks dari UI
// tidak pernah bisa disisipi perintah. Semua hasil dikembalikan, tidak pernah dilempar.
const { execFile } = require('node:child_process');

const BASE_ENV = {
  GIT_TERMINAL_PROMPT: '0', // jangan pernah menunggu input kata sandi di terminal tersembunyi
  GCM_INTERACTIVE: 'never',
  LC_ALL: 'C',
  NO_COLOR: '1',
};

// Untuk pengujian: HUB_GH_BIN / HUB_SSH_BIN / HUB_SSH_KEYSCAN_BIN=skrip.cjs memakai Node (bukan program sungguhan).
const TEST_BINS = { gh: 'HUB_GH_BIN', ssh: 'HUB_SSH_BIN', 'ssh-keyscan': 'HUB_SSH_KEYSCAN_BIN' };
function resolveBin(cmd) {
  if (TEST_BINS[cmd] && process.env[TEST_BINS[cmd]]) {
    const bin = process.env[TEST_BINS[cmd]];
    if (/\.(c|m)?js$/i.test(bin)) return { file: process.execPath, prefix: [bin], env: { ELECTRON_RUN_AS_NODE: '1' } };
    return { file: bin, prefix: [], env: {} };
  }
  return { file: cmd, prefix: [], env: {} };
}

function run(cmd, args, opts = {}) {
  const bin = resolveBin(cmd);
  return new Promise((resolve) => {
    const started = Date.now();
    const child = execFile(
      bin.file,
      [...bin.prefix, ...args],
      {
        cwd: opts.cwd,
        env: { ...process.env, ...BASE_ENV, ...bin.env, ...(opts.env || {}) },
        windowsHide: true,
        maxBuffer: opts.maxBuffer || 64 * 1024 * 1024,
        timeout: opts.timeout || 120000,
        encoding: 'utf8',
      },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
          stdout: stdout || '',
          stderr: (stderr || '').trim() || (err && !stdout ? err.message : ''),
          ms: Date.now() - started,
          timedOut: !!(err && err.killed),
        });
      }
    );
    if (opts.input != null) { child.stdin.on('error', () => {}); child.stdin.end(String(opts.input)); }
  });
}

module.exports = { run };
