'use strict';
// Operasi git untuk satu repo: deteksi remote, status, push ke dua remote, perbandingan ref
// GitHub vs GitLab (parity) dan mirror yang hanya menambah / fast-forward (tidak pernah force).
const path = require('node:path');
const { run } = require('./exec');

let net = { postBuffer: 1048576 };
function setNetwork(cfg) { net = { ...net, ...cfg }; }
const netArgs = () => ['-c', `http.postBuffer=${net.postBuffer}`];

const BRANCH_RE = /^(?!-)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._\/-]+(?<![\/.])$/;
const isSafeRef = (name) => typeof name === 'string' && name.length > 0 && name.length < 200 && BRANCH_RE.test(name);

/* ------------------------------------------------------------------ URL helpers */
function parseRemoteUrl(raw) {
  const url = String(raw || '').trim();
  let m;
  if ((m = /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/i.exec(url))) return { host: m[1].toLowerCase(), path: m[2] };
  if ((m = /^[^@/\s]+@([^:/\s]+):(.+?)(?:\.git)?\/?$/.exec(url))) return { host: m[1].toLowerCase(), path: m[2] };
  return { host: '', path: url };
}
function kindOfUrl(raw) {
  const { host } = parseRemoteUrl(raw);
  if (host === 'github.com' || host === 'www.github.com') return 'github';
  if (host.includes('gitlab')) return 'gitlab';
  return 'other';
}
// jangan pernah menampilkan kata sandi / token yang menempel di URL
function redactUrl(raw) { return String(raw || '').replace(/^(\w+:\/\/)[^@/\s]+@/, '$1'); }

/* ------------------------------------------------------------------ detection */
async function topLevel(dir) {
  const r = await run('git', ['rev-parse', '--show-toplevel'], { cwd: dir, timeout: 15000 });
  return r.ok ? path.normalize(r.stdout.trim()) : null;
}

async function detect(dir) {
  const root = await topLevel(dir);
  if (!root) return { ok: false, error: 'Bukan folder git.' };
  const remotesOut = await run('git', ['remote'], { cwd: root, timeout: 15000 });
  const names = remotesOut.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  const urls = [];
  for (const name of names) {
    const fetch = await run('git', ['config', '--get-all', `remote.${name}.url`], { cwd: root, timeout: 15000 });
    const push = await run('git', ['config', '--get-all', `remote.${name}.pushurl`], { cwd: root, timeout: 15000 });
    for (const u of fetch.stdout.split('\n').map((s) => s.trim()).filter(Boolean)) urls.push({ remote: name, url: u, role: 'fetch' });
    for (const u of push.stdout.split('\n').map((s) => s.trim()).filter(Boolean)) urls.push({ remote: name, url: u, role: 'push' });
  }
  const pick = (kind) => urls.find((u) => kindOfUrl(u.url) === kind);
  const gh = pick('github'), gl = pick('gitlab');
  const github = gh ? { url: gh.url, repo: parseRemoteUrl(gh.url).path } : null;
  const gitlab = gl ? { url: gl.url, baseUrl: `https://${parseRemoteUrl(gl.url).host}`, path: parseRemoteUrl(gl.url).path } : null;
  const branch = (await run('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: root, timeout: 15000 })).stdout.trim() || null;
  let defaultBranch = (await run('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd: root, timeout: 15000 })).stdout.trim().replace(/^origin\//, '');
  if (!defaultBranch) {
    const refs = (await run('git', ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes/origin'], { cwd: root, timeout: 15000 })).stdout.split('\n');
    defaultBranch = ['master', 'main'].find((b) => refs.includes(b) || refs.includes(`origin/${b}`)) || branch || 'main';
  }
  return { ok: true, root, name: path.basename(root), branch, defaultBranch, github, gitlab, remotes: urls.map((u) => ({ ...u, url: redactUrl(u.url) })) };
}

/* ------------------------------------------------------------------ status */
async function status(dir) {
  const r = await run('git', ['status', '--porcelain=v2', '--branch'], { cwd: dir, timeout: 30000 });
  if (!r.ok) return { ok: false, error: r.stderr || 'git status gagal' };
  const s = { ok: true, branch: null, detached: false, upstream: null, ahead: null, behind: null, staged: 0, changed: 0, untracked: 0, conflicts: 0, oid: null };
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('# branch.head ')) { s.branch = line.slice(14).trim(); if (s.branch === '(detached)') { s.detached = true; s.branch = null; } }
    else if (line.startsWith('# branch.oid ')) s.oid = line.slice(13).trim();
    else if (line.startsWith('# branch.upstream ')) s.upstream = line.slice(18).trim();
    else if (line.startsWith('# branch.ab ')) { const m = /\+(\d+) -(\d+)/.exec(line); if (m) { s.ahead = +m[1]; s.behind = +m[2]; } }
    else if (line.startsWith('1 ') || line.startsWith('2 ')) { const xy = line.split(' ')[1]; if (xy[0] !== '.') s.staged++; if (xy[1] !== '.') s.changed++; }
    else if (line.startsWith('u ')) s.conflicts++;
    else if (line.startsWith('? ')) s.untracked++;
  }
  const last = await run('git', ['log', '-1', '--format=%h%x1f%an%x1f%aI%x1f%s'], { cwd: dir, timeout: 15000 });
  if (last.ok && last.stdout.trim()) { const [hash, author, date, subject] = last.stdout.trim().split('\x1f'); s.last = { hash, author, date, subject }; }
  s.dirty = s.staged + s.changed + s.untracked + s.conflicts > 0;
  return s;
}

async function branches(dir) {
  const r = await run('git', ['for-each-ref', '--format=%(refname:short)%09%(refname)', 'refs/heads', 'refs/remotes/origin'], { cwd: dir, timeout: 30000 });
  const local = new Set(), remote = new Set();
  for (const line of r.stdout.split('\n').filter(Boolean)) {
    const [short, full] = line.split('\t');
    if (full.startsWith('refs/heads/')) local.add(short);
    else if (full.startsWith('refs/remotes/origin/') && !full.endsWith('/HEAD')) remote.add(short.replace(/^origin\//, ''));
  }
  return { local: [...local].sort(), remote: [...remote].sort(), all: [...new Set([...local, ...remote])].sort() };
}

async function lastSubject(dir, ref) {
  if (!isSafeRef(ref)) return '';
  for (const candidate of [`refs/heads/${ref}`, `refs/remotes/origin/${ref}`]) {
    const r = await run('git', ['log', '-1', '--format=%s', candidate, '--'], { cwd: dir, timeout: 15000 });
    if (r.ok && r.stdout.trim()) return r.stdout.trim();
  }
  return '';
}

async function fetchOrigin(dir) {
  const r = await run('git', [...netArgs(), 'fetch', 'origin', '--prune', '--quiet'], { cwd: dir, timeout: 120000 });
  return { ok: r.ok, error: r.ok ? null : r.stderr };
}

/* ------------------------------------------------------------------ push */
async function pushTo(dir, url, branch) {
  if (!isSafeRef(branch)) return { ok: false, error: 'Nama branch tidak valid.' };
  // tanpa --force, tanpa --delete: hanya menambah commit / fast-forward
  const r = await run('git', [...netArgs(), 'push', '--porcelain', url, `refs/heads/${branch}:refs/heads/${branch}`], { cwd: dir, timeout: 180000 });
  const lines = r.stdout.split('\n').filter((l) => /^[ +\-*=!]\t/.test(l));
  const rejected = lines.find((l) => l.startsWith('!'));
  const upToDate = lines.some((l) => l.startsWith('=')) && !rejected;
  return { ok: r.ok && !rejected, upToDate, summary: lines.map((l) => l.split('\t').slice(1).join(' ')).join('; '), error: r.ok && !rejected ? null : (rejected ? rejected.split('\t').slice(1).join(' ') : r.stderr) };
}

async function push(dir, { branch, targets }) {
  const results = [];
  for (const t of targets) {
    const res = await pushTo(dir, t.url, branch);
    results.push({ platform: t.platform, url: redactUrl(t.url), ...res });
  }
  await fetchOrigin(dir); // segarkan ahead/behind (remote-tracking) setelah push
  return results;
}

/* ------------------------------------------------------------------ parity + mirror */
async function lsRemote(dir, url) {
  const r = await run('git', [...netArgs(), 'ls-remote', '--heads', '--tags', url], { cwd: dir, timeout: 90000 });
  if (!r.ok) return { ok: false, error: r.stderr || 'ls-remote gagal' };
  const refs = {};
  for (const line of r.stdout.split('\n').filter(Boolean)) { const [sha, ref] = line.split('\t'); if (ref) refs[ref] = sha; }
  return { ok: true, refs };
}

function diffRefs(a, b, ignore = []) {
  const skip = new Set(ignore);
  const onlyA = [], onlyB = [], different = [];
  for (const ref of Object.keys(a)) {
    if (skip.has(ref)) continue;
    if (!(ref in b)) onlyA.push(ref);
    else if (a[ref] !== b[ref]) different.push({ ref, a: a[ref], b: b[ref] });
  }
  for (const ref of Object.keys(b)) if (!skip.has(ref) && !(ref in a)) onlyB.push(ref);
  return { identical: !onlyA.length && !onlyB.length && !different.length, onlyA, onlyB, different };
}

async function parity(dir, { githubUrl, gitlabUrl, ignoreRefs = [] }) {
  const [gh, gl] = await Promise.all([lsRemote(dir, githubUrl), lsRemote(dir, gitlabUrl)]);
  if (!gh.ok) return { ok: false, error: `GitHub: ${gh.error}` };
  if (!gl.ok) return { ok: false, error: `GitLab: ${gl.error}` };
  const d = diffRefs(gh.refs, gl.refs, ignoreRefs);
  return { ok: true, identical: d.identical, onlyGithub: d.onlyA, onlyGitlab: d.onlyB, different: d.different.map((x) => ({ ref: x.ref, github: x.a, gitlab: x.b })), counts: { github: Object.keys(gh.refs).filter((r) => !r.endsWith('^{}')).length, gitlab: Object.keys(gl.refs).filter((r) => !r.endsWith('^{}')).length } };
}

// Menyalin ref dari `from` ke `to`. Aman: ref baru dibuat, branch hanya maju (fast-forward),
// tag yang sudah ada tidak pernah dipindah, dan tidak ada penghapusan.
async function mirror(dir, { fromUrl, toUrl, ignoreRefs = [], dryRun = false }) {
  const [src, dst] = await Promise.all([lsRemote(dir, fromUrl), lsRemote(dir, toUrl)]);
  if (!src.ok) return { ok: false, error: `Sumber: ${src.error}` };
  if (!dst.ok) return { ok: false, error: `Tujuan: ${dst.error}` };
  const skip = new Set(ignoreRefs);
  const wanted = Object.keys(src.refs).filter((r) => !r.endsWith('^{}') && !skip.has(r) && (r.startsWith('refs/heads/') || r.startsWith('refs/tags/')) && isSafeRef(r.replace(/^refs\/(heads|tags)\//, '')));
  const todo = wanted.filter((r) => src.refs[r] !== dst.refs[r]);
  if (!todo.length) return { ok: true, plan: [], pushed: [], skipped: [], failed: [], upToDate: true };

  // objek sumber & tujuan dibawa ke namespace privat supaya tidak menyentuh refs/remotes milik pengguna
  const f1 = await run('git', [...netArgs(), 'fetch', '--no-tags', '--quiet', fromUrl, '+refs/heads/*:refs/hub/src/heads/*', '+refs/tags/*:refs/hub/src/tags/*'], { cwd: dir, timeout: 180000 });
  if (!f1.ok) return { ok: false, error: `Fetch sumber gagal: ${f1.stderr}` };
  const f2 = await run('git', [...netArgs(), 'fetch', '--no-tags', '--quiet', toUrl, '+refs/heads/*:refs/hub/dst/heads/*'], { cwd: dir, timeout: 180000 });
  if (!f2.ok && !/couldn't find remote ref/i.test(f2.stderr)) return { ok: false, error: `Fetch tujuan gagal: ${f2.stderr}` };

  const plan = [], skipped = [];
  for (const ref of todo) {
    const isTag = ref.startsWith('refs/tags/');
    if (!(ref in dst.refs)) { plan.push({ ref, kind: isTag ? 'tag baru' : 'branch baru', sha: src.refs[ref] }); continue; }
    if (isTag) { skipped.push({ ref, reason: 'Tag sudah ada di tujuan dengan commit berbeda; tidak dipindah.' }); continue; }
    const anc = await run('git', ['merge-base', '--is-ancestor', dst.refs[ref], src.refs[ref]], { cwd: dir, timeout: 30000 });
    if (anc.ok) plan.push({ ref, kind: 'fast-forward', sha: src.refs[ref], from: dst.refs[ref] });
    else skipped.push({ ref, reason: 'Tujuan punya commit yang tidak ada di sumber (non-fast-forward); dilewati, tidak ada force.' });
  }
  if (dryRun || !plan.length) return { ok: true, dryRun, plan, pushed: [], skipped, failed: [], upToDate: !plan.length && !skipped.length };

  const specs = plan.map((p) => `refs/hub/src/${p.ref.startsWith('refs/tags/') ? 'tags' : 'heads'}/${p.ref.replace(/^refs\/(heads|tags)\//, '')}:${p.ref}`);
  const r = await run('git', [...netArgs(), 'push', '--porcelain', toUrl, ...specs], { cwd: dir, timeout: 300000 });
  const pushed = [], failed = [];
  for (const line of r.stdout.split('\n').filter((l) => /^[ +\-*=!]\t/.test(l))) {
    const [flag, refspec, ...rest] = line.split('\t');
    const target = (refspec || '').split(':')[1] || refspec;
    (flag === '!' ? failed : pushed).push({ ref: target, note: rest.join(' ') });
  }
  if (!pushed.length && !failed.length && !r.ok) failed.push({ ref: '(semua)', note: r.stderr });
  return { ok: !failed.length, plan, pushed, skipped, failed };
}

async function cleanupHubRefs(dir) {
  const r = await run('git', ['for-each-ref', '--format=%(refname)', 'refs/hub'], { cwd: dir, timeout: 30000 });
  for (const ref of r.stdout.split('\n').filter(Boolean)) await run('git', ['update-ref', '-d', ref], { cwd: dir, timeout: 15000 });
}

module.exports = { setNetwork, isSafeRef, parseRemoteUrl, kindOfUrl, redactUrl, detect, status, branches, lastSubject, fetchOrigin, push, pushTo, lsRemote, diffRefs, parity, mirror, cleanupHubRefs };
