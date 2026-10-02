'use strict';
// Perlengkapan tes: repo kerja + dua remote bare (pengganti GitHub dan GitLab), tanpa jaringan.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const emptyCfg = path.join(os.tmpdir(), 'hub-empty-gitconfig');
fs.writeFileSync(emptyCfg, '');
Object.assign(process.env, { GIT_CONFIG_GLOBAL: emptyCfg, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Tes', GIT_AUTHOR_EMAIL: 'tes@example.com', GIT_COMMITTER_NAME: 'Tes', GIT_COMMITTER_EMAIL: 'tes@example.com' });

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function makeRig(name = 'demo') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-rig-'));
  const gh = path.join(root, 'github.git'), gl = path.join(root, 'gitlab.git'), work = path.join(root, name);
  sh(root, 'init', '--bare', '-b', 'master', gh);
  sh(root, 'init', '--bare', '-b', 'master', gl);
  fs.mkdirSync(work);
  sh(work, 'init', '-b', 'master');
  sh(work, 'remote', 'add', 'origin', gh);
  sh(work, 'config', 'remote.origin.pushurl', gh);
  sh(work, 'config', '--add', 'remote.origin.pushurl', gl);
  const rig = {
    root, gh, gl, work, sh: (...a) => sh(work, ...a),
    commit(msg, file = 'README.md') { fs.appendFileSync(path.join(work, file), `${msg}\n`); sh(work, 'add', '-A'); sh(work, 'commit', '-m', msg); return sh(work, 'rev-parse', 'HEAD'); },
    head: (bare, ref = 'master') => sh(bare, 'rev-parse', `refs/heads/${ref}`),
    cleanup() { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* windows kadang menahan file */ } },
  };
  rig.commit('commit awal');
  sh(work, 'push', gh, 'master'); sh(work, 'push', gl, 'master');
  sh(work, 'fetch', 'origin');
  return rig;
}

module.exports = { makeRig, sh, fs, path, os };
