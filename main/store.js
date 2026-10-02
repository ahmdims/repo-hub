'use strict';
// Penyimpanan lokal (JSON): daftar repo, pengaturan, rahasia terenkripsi, dan log aktivitas.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const git = require('./git');

const DEFAULT_FLOW = { steps: [{ from: '$BRANCH', to: 'master' }, { from: 'master', to: 'karirkit/vercel' }], mirror: true, method: 'merge', waitChecks: true, checkDeployments: true };

const str = (v, max = 300) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const refName = (v) => { const s = str(v, 200); return s && (s === '$BRANCH' || git.isSafeRef(s)) ? s : ''; };
// kaitan ke akun dan URL sebelumnya (untuk kembali dari SSH ke HTTPS) ikut tersimpan di remote repo
const carry = (dst, src) => { const a = str(src.account, 40); if (a) dst.account = a; const p = str(src.prevUrl, 400); if (p) dst.prevUrl = p; };

function normalizeRepo(input, existing = {}) {
  const i = { ...existing, ...input };
  const errors = [];
  const name = str(i.name, 80);
  if (!name) errors.push('Repo name is required.');
  const p = str(i.path, 500);
  if (!p || !path.isAbsolute(p)) errors.push('Folder location must be an absolute path.');

  const gh = i.github && (str(i.github.url, 400) || str(i.github.repo, 200)) ? { url: str(i.github.url, 400), repo: str(i.github.repo, 200).replace(/\.git$/, '') } : null;
  if (gh && !/^[\w.-]+\/[\w.-]+$/.test(gh.repo)) errors.push('GitHub must be in owner/repo format.');
  if (gh && !gh.url) gh.url = `https://github.com/${gh.repo}.git`;

  let gl = null;
  if (i.gitlab && (str(i.gitlab.url, 400) || str(i.gitlab.path, 300))) {
    const g = i.gitlab; const base = str(g.baseUrl, 200).replace(/\/$/, '');
    gl = { url: str(g.url, 400), baseUrl: base, path: str(g.path, 300).replace(/\.git$/, '').replace(/^\//, '') };
    if (!/^https?:\/\/[^\s/]+$/.test(gl.baseUrl)) errors.push('Invalid GitLab base URL (example: https://gitlab.company.com).');
    if (!/^[\w.\-/]+$/.test(gl.path)) errors.push('Invalid GitLab project path (example: group/project).');
    if (!gl.url && gl.baseUrl && gl.path) gl.url = `${gl.baseUrl}/${gl.path}.git`;
  }
  if (gh) carry(gh, i.github);
  if (gl) carry(gl, i.gitlab);
  if (!gh && !gl) errors.push('Provide at least one: GitHub or GitLab.');

  const defaultBranch = refName(i.defaultBranch) || 'master';
  const flowIn = i.flow || {};
  const steps = (Array.isArray(flowIn.steps) ? flowIn.steps : DEFAULT_FLOW.steps).map((s) => ({ from: refName(s.from), to: refName(s.to) })).filter((s) => s.from && s.to && s.to !== '$BRANCH');
  const primary = i.primary === 'gitlab' && gl ? 'gitlab' : gh ? 'github' : 'gitlab';
  const repo = {
    id: i.id || `r_${crypto.randomBytes(4).toString('hex')}`,
    name, path: p ? path.normalize(p) : '', github: gh, gitlab: gl, primary, defaultBranch,
    deployBranch: refName(i.deployBranch),
    warnBranches: (Array.isArray(i.warnBranches) ? i.warnBranches : ['release']).map(refName).filter(Boolean),
    ignoreRefs: (Array.isArray(i.ignoreRefs) ? i.ignoreRefs : []).map((r) => str(r, 200)).filter((r) => r.startsWith('refs/')),
    flow: { steps: steps.length ? steps : DEFAULT_FLOW.steps, mirror: flowIn.mirror !== false, method: ['merge', 'squash', 'rebase'].includes(flowIn.method) ? flowIn.method : 'merge', waitChecks: flowIn.waitChecks !== false, checkDeployments: flowIn.checkDeployments !== false },
    addedAt: i.addedAt || new Date().toISOString(),
  };
  return { repo, errors };
}

// Akun = penyedia + host + (pemilik/org opsional) + identitas SSH opsional. Dipakai untuk mengelompokkan remote repo.
const ACCOUNT_PROVIDERS = ['github', 'gitlab', 'other'];
const SSH_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
function normalizeAccount(input, existing = {}) {
  const i = { ...existing, ...input };
  const errors = [];
  const label = str(i.label, 60);
  if (!label) errors.push('Account label is required.');
  const provider = ACCOUNT_PROVIDERS.includes(i.provider) ? i.provider : 'other';
  const host = str(i.host, 253).toLowerCase();
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(host)) errors.push('Host is not valid (example: github.com).');
  const login = str(i.login, 100);
  if (login && !/^[\w.@-]+$/.test(login)) errors.push('Login contains characters that are not allowed.');
  const owners = [...new Set((Array.isArray(i.owners) ? i.owners : []).map((o) => str(o, 100).toLowerCase()).filter(Boolean))].slice(0, 20);
  if (owners.some((o) => !/^[\w.-]+$/.test(o))) errors.push('Owners may only use letters, digits, dot, dash and underscore.');
  let sshCfg = null;
  if (i.ssh && (str(i.ssh.alias, 100) || str(i.ssh.identityFile, 64))) {
    const alias = str(i.ssh.alias, 100), identityFile = str(i.ssh.identityFile, 64);
    if (alias && !SSH_NAME.test(alias)) errors.push('SSH alias is not valid.');
    if (identityFile && !SSH_NAME.test(identityFile)) errors.push('SSH key file name is not valid.');
    const port = i.ssh.port == null || i.ssh.port === '' ? null : Number(i.ssh.port);
    if (port != null && !(Number.isInteger(port) && port >= 1 && port <= 65535)) errors.push('SSH port is not valid.');
    sshCfg = { alias, identityFile, ...(port ? { port } : {}) };
  }
  const account = { id: i.id || `a_${crypto.randomBytes(4).toString('hex')}`, label, provider, host, login, owners, ssh: sshCfg, addedAt: i.addedAt || new Date().toISOString() };
  return { account, errors };
}

class Store {
  constructor(dir) {
    fs.mkdirSync(dir, { recursive: true });
    this.dir = dir;
    this.file = path.join(dir, 'config.json');
    this.logFile = path.join(dir, 'activity.json');
    const cfg = this._read(this.file, {});
    this.data = { version: 1, repos: Array.isArray(cfg.repos) ? cfg.repos : [], accounts: Array.isArray(cfg.accounts) ? cfg.accounts : [], settings: cfg.settings || {}, secrets: cfg.secrets || {} };
    const log = this._read(this.logFile, []);
    this.log = Array.isArray(log) ? log : [];
  }
  _read(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
  _write(file, data) {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  }
  save() { this._write(this.file, this.data); }

  repos() { return this.data.repos; }
  repo(id) { return this.data.repos.find((r) => r.id === id) || null; }
  addRepo(input) {
    const { repo, errors } = normalizeRepo(input);
    if (errors.length) return { ok: false, error: errors.join(' ') };
    const key = (p) => p.toLowerCase();
    if (this.data.repos.some((r) => key(r.path) === key(repo.path))) return { ok: false, error: 'This folder is already registered.' };
    this.data.repos.push(repo); this.save();
    return { ok: true, repo };
  }
  updateRepo(id, patch) {
    const cur = this.repo(id);
    if (!cur) return { ok: false, error: 'Repo not found.' };
    const { repo, errors } = normalizeRepo({ ...patch, id }, cur);
    if (errors.length) return { ok: false, error: errors.join(' ') };
    Object.assign(cur, repo); this.save();
    return { ok: true, repo: cur };
  }
  removeRepo(id) {
    const n = this.data.repos.length;
    this.data.repos = this.data.repos.filter((r) => r.id !== id);
    if (this.data.repos.length === n) return { ok: false, error: 'Repo not found.' };
    this.save(); return { ok: true };
  }

  accounts() { return this.data.accounts; }
  account(id) { return this.data.accounts.find((a) => a.id === id) || null; }
  addAccount(input) {
    const { account, errors } = normalizeAccount(input);
    if (errors.length) return { ok: false, error: errors.join(' ') };
    const sig = (a) => `${a.host}|${[...a.owners].sort().join(',')}`;
    if (this.data.accounts.some((a) => a.label.toLowerCase() === account.label.toLowerCase())) return { ok: false, error: 'An account with this label already exists.' };
    if (this.data.accounts.some((a) => sig(a) === sig(account))) return { ok: false, error: 'An account for this host and owner already exists.' };
    this.data.accounts.push(account); this.save();
    return { ok: true, account };
  }
  updateAccount(id, patch) {
    const cur = this.account(id);
    if (!cur) return { ok: false, error: 'Account not found.' };
    const { account, errors } = normalizeAccount({ ...patch, id }, cur);
    if (errors.length) return { ok: false, error: errors.join(' ') };
    if (this.data.accounts.some((a) => a.id !== id && a.label.toLowerCase() === account.label.toLowerCase())) return { ok: false, error: 'An account with this label already exists.' };
    Object.assign(cur, account); this.save();
    return { ok: true, account: cur };
  }
  // menghapus akun hanya melepas kaitannya dari repo; repo dan folder tidak disentuh
  removeAccount(id) {
    const n = this.data.accounts.length;
    this.data.accounts = this.data.accounts.filter((a) => a.id !== id);
    if (this.data.accounts.length === n) return { ok: false, error: 'Account not found.' };
    for (const r of this.data.repos) for (const k of ['github', 'gitlab']) if (r[k] && r[k].account === id) delete r[k].account;
    this.save(); return { ok: true };
  }

  settings() { return { postBuffer: 1048576, useGitCredential: true, ...this.data.settings }; }
  setSettings(patch) {
    const s = { ...this.data.settings };
    if (patch.postBuffer != null) { const n = Number(patch.postBuffer); if (Number.isFinite(n) && n >= 65536 && n <= 1073741824) s.postBuffer = Math.round(n); }
    if (patch.useGitCredential != null) s.useGitCredential = !!patch.useGitCredential;
    this.data.settings = s; this.save(); return this.settings();
  }
  getSecret(key) { return this.data.secrets[key] || null; }
  setSecret(key, value) { if (value) this.data.secrets[key] = value; else delete this.data.secrets[key]; this.save(); }

  activity(limit = 200) { return this.log.slice(-limit).reverse(); }
  addActivity(e) {
    this.log.push({ id: crypto.randomBytes(5).toString('hex'), time: new Date().toISOString(), ...e });
    if (this.log.length > 500) this.log = this.log.slice(-500);
    this._write(this.logFile, this.log);
  }
  clearActivity() { this.log = []; this._write(this.logFile, this.log); }
}

module.exports = { Store, normalizeRepo, normalizeAccount, DEFAULT_FLOW };
