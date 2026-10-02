'use strict';
// Penyimpanan lokal (JSON): daftar repo, pengaturan, rahasia terenkripsi, dan log aktivitas.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const git = require('./git');

const DEFAULT_FLOW = { steps: [{ from: '$BRANCH', to: 'master' }, { from: 'master', to: 'karirkit/vercel' }], mirror: true, method: 'merge', waitChecks: true, checkDeployments: true };

const str = (v, max = 300) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const refName = (v) => { const s = str(v, 200); return s && (s === '$BRANCH' || git.isSafeRef(s)) ? s : ''; };

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

class Store {
  constructor(dir) {
    fs.mkdirSync(dir, { recursive: true });
    this.dir = dir;
    this.file = path.join(dir, 'config.json');
    this.logFile = path.join(dir, 'activity.json');
    const cfg = this._read(this.file, {});
    this.data = { version: 1, repos: Array.isArray(cfg.repos) ? cfg.repos : [], settings: cfg.settings || {}, secrets: cfg.secrets || {} };
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

module.exports = { Store, normalizeRepo, DEFAULT_FLOW };
