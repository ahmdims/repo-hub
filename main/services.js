'use strict';
// Semua logika aplikasi (tanpa Electron) sebagai peta handler: dipanggil lewat IPC di aplikasi dan
// langsung oleh tes. Aksi yang mengubah sesuatu di luar komputer ini WAJIB membawa confirmed: true.
const fs = require('node:fs');
const path = require('node:path');
const git = require('./git');
const github = require('./github');
const { createAuth } = require('./auth');
const { createProviders } = require('./providers');
const { createRelease } = require('./release');

const PLATFORMS = ['github', 'gitlab'];
const mapLimit = async (items, n, fn) => {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
};

function createServices({ store, emit = () => {} }) {
  const auth = createAuth(store);
  const providers = createProviders({ store, auth });
  const release = createRelease({ store, providers });
  git.setNetwork({ postBuffer: store.settings().postBuffer });

  const repoOf = (id) => { const r = store.repo(id); if (!r) throw new Error('Repo not found.'); return r; };
  const confirmed = (p) => (p && p.confirmed === true ? null : { ok: false, error: 'This action needs user confirmation.' });
  const log = (action, repo, ok, summary, detail) => store.addActivity({ action, repoId: repo && repo.id, repo: repo ? repo.name : '', ok, summary, detail: detail ? String(detail).slice(0, 4000) : '' });
  const targetsOf = (repo, wanted) => {
    const t = [];
    if (wanted.includes('github') && repo.github) t.push({ platform: 'github', url: repo.github.url });
    if (wanted.includes('gitlab') && repo.gitlab) t.push({ platform: 'gitlab', url: repo.gitlab.url });
    return t;
  };

  async function statusOne(repo, { fetch = false, parity = true, pulls = true } = {}) {
    const out = { id: repo.id };
    if (!fs.existsSync(repo.path)) return { ...out, status: { ok: false, error: 'Folder not found.' } };
    if (fetch) out.fetch = await git.fetchOrigin(repo.path);
    const jobs = [git.status(repo.path).then((s) => { out.status = s; })];
    if (parity && repo.github && repo.gitlab) jobs.push(git.parity(repo.path, { githubUrl: repo.github.url, gitlabUrl: repo.gitlab.url, ignoreRefs: repo.ignoreRefs }).then((p) => { out.parity = p; }));
    if (pulls) jobs.push(providers.list({ repoIds: [repo.id], state: 'open' }).then((l) => { out.pulls = { github: l.items.filter((x) => x.platform === 'github').length, gitlab: l.items.filter((x) => x.platform === 'gitlab').length, errors: l.errors.map((e) => `${e.platform}: ${e.error}`) }; }));
    await Promise.all(jobs);
    return out;
  }

  const handlers = {
    /* ------------------------------------------------------------ akun & pengaturan */
    async 'accounts'() { return { ok: true, ...(await providers.accounts()) }; },
    async 'settings:get'() { return { ok: true, settings: store.settings(), canEncrypt: auth.canEncrypt() }; },
    async 'settings:set'(p) { const s = store.setSettings(p || {}); git.setNetwork({ postBuffer: s.postBuffer }); return { ok: true, settings: s }; },
    async 'gitlab:saveToken'(p) {
      const host = String(p.host || '').trim();
      if (!/^[\w.-]+(:\d+)?$/.test(host) || !String(p.token || '').trim()) return { ok: false, error: 'Invalid host or token.' };
      return auth.saveToken(host, p.token);
    },
    async 'gitlab:clearToken'(p) { return auth.clearToken(String(p.host || '')); },

    /* ------------------------------------------------------------ repo */
    async 'repos:list'() { return { ok: true, repos: store.repos() }; },
    async 'repos:detect'(p) {
      const d = await git.detect(String(p.path || ''));
      if (!d.ok) return d;
      const exists = store.repos().some((r) => r.path.toLowerCase() === d.root.toLowerCase());
      return { ...d, alreadyAdded: exists, suggest: { name: d.name, path: d.root, github: d.github, gitlab: d.gitlab, primary: d.github ? 'github' : 'gitlab', defaultBranch: d.defaultBranch } };
    },
    async 'repos:scan'(p) {
      const folder = String(p.folder || '');
      let entries = [];
      try { entries = fs.readdirSync(folder, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules').slice(0, 300); } catch { return { ok: false, error: 'Could not read the folder.' }; }
      const found = (await mapLimit(entries, 4, async (e) => {
        const full = path.join(folder, e.name);
        if (!fs.existsSync(path.join(full, '.git'))) return null;
        const d = await git.detect(full);
        if (!d.ok) return null;
        return { name: d.name, path: d.root, github: d.github, gitlab: d.gitlab, defaultBranch: d.defaultBranch, branch: d.branch, alreadyAdded: store.repos().some((r) => r.path.toLowerCase() === d.root.toLowerCase()) };
      })).filter(Boolean);
      return { ok: true, repos: found };
    },
    async 'repos:add'(p) {
      const res = store.addRepo(p.repo || {});
      if (res.ok) log('repo.add', res.repo, true, `Repo "${res.repo.name}" added`);
      return res;
    },
    async 'repos:update'(p) { const res = store.updateRepo(String(p.id), p.patch || {}); if (res.ok) log('repo.update', res.repo, true, `Settings for "${res.repo.name}" updated`); return res; },
    async 'repos:remove'(p) { const r = store.repo(String(p.id)); const res = store.removeRepo(String(p.id)); if (res.ok && r) log('repo.remove', r, true, `Repo "${r.name}" removed from the list (folder left untouched)`); return res; },
    async 'repos:branches'(p) { const r = repoOf(p.id); return { ok: true, ...(await git.branches(r.path)), subject: p.head ? await git.lastSubject(r.path, p.head) : '' }; },
    async 'repos:test'(p) {
      const r = repoOf(p.id);
      const out = { ok: true, folder: fs.existsSync(r.path), github: null, gitlab: null };
      if (r.github) { const i = await github.repoInfo(r.github.repo); out.github = i.ok ? { ok: true, permission: i.info.viewerPermission, isPrivate: i.info.isPrivate, defaultBranch: i.info.defaultBranchRef && i.info.defaultBranchRef.name } : { ok: false, error: i.error }; }
      if (r.gitlab) { const i = await providers.gitlab.repoInfo(r.gitlab.baseUrl, r.gitlab.path); out.gitlab = i.ok ? { ok: true, defaultBranch: i.info.defaultBranch, visibility: i.info.visibility, accessLevel: i.info.accessLevel } : { ok: false, error: i.error }; }
      return out;
    },

    /* ------------------------------------------------------------ status + git */
    async 'status:refresh'(p = {}) {
      const repos = (p.ids && p.ids.length ? p.ids.map(repoOf) : store.repos());
      const results = await mapLimit(repos, 3, async (repo) => {
        const r = await statusOne(repo, { fetch: !!p.fetch, parity: p.parity !== false, pulls: p.pulls !== false });
        emit('status:update', r);
        return r;
      });
      return { ok: true, results };
    },
    async 'git:push'(p) {
      const c = confirmed(p); if (c) return c;
      const repo = repoOf(p.repoId);
      const targets = targetsOf(repo, Array.isArray(p.targets) && p.targets.length ? p.targets : PLATFORMS);
      if (!targets.length) return { ok: false, error: 'No push targets are configured.' };
      const branch = p.branch || (await git.status(repo.path)).branch;
      if (!git.isSafeRef(branch)) return { ok: false, error: 'Invalid branch, or HEAD is detached.' };
      const results = await git.push(repo.path, { branch, targets });
      const ok = results.every((r) => r.ok);
      log('git.push', repo, ok, `Push ${branch} → ${results.map((r) => `${r.platform}:${r.ok ? (r.upToDate ? 'up to date' : 'ok') : 'failed'}`).join(', ')}`, results.map((r) => `${r.platform}: ${r.ok ? r.summary : r.error}`).join('\n'));
      return { ok, branch, results };
    },
    async 'git:mirror'(p) {
      const repo = repoOf(p.repoId);
      if (!repo.github || !repo.gitlab) return { ok: false, error: 'This repo needs both GitHub and GitLab configured.' };
      const from = p.from === 'gitlab' ? repo.gitlab : repo.github, to = p.from === 'gitlab' ? repo.github : repo.gitlab;
      if (!p.dryRun) { const c = confirmed(p); if (c) return c; }
      const res = await git.mirror(repo.path, { fromUrl: from.url, toUrl: to.url, ignoreRefs: repo.ignoreRefs, dryRun: !!p.dryRun });
      await git.cleanupHubRefs(repo.path);
      if (!p.dryRun) log('git.mirror', repo, !!res.ok, res.ok ? (res.upToDate ? 'Mirror: already in sync' : `Mirror: ${res.pushed.length} ${res.pushed.length === 1 ? 'ref' : 'refs'} copied, ${res.skipped.length} skipped`) : `Mirror failed: ${res.error || (res.failed || []).map((f) => f.note).join('; ')}`, JSON.stringify({ pushed: res.pushed, skipped: res.skipped, failed: res.failed }));
      return res;
    },
    async 'git:pull'(p) {
      const c = confirmed(p); if (c) return c;
      const repo = repoOf(p.repoId);
      const res = await git.pull(repo.path);
      const n = res.updated || 0;
      log('git.pull', repo, !!res.ok, res.ok ? (res.upToDate ? `Pull ${res.branch}: already up to date` : `Pull ${res.branch}: fast-forwarded ${n} ${n === 1 ? 'commit' : 'commits'} from ${res.upstream}`) : `Pull failed: ${res.error}`, res.ok && !res.upToDate ? `${res.from}..${res.to}` : res.error);
      return res;
    },
    async 'git:fetch'(p) { const repo = repoOf(p.repoId); const r = await git.fetchOrigin(repo.path); log('git.fetch', repo, r.ok, r.ok ? 'Fetched origin' : 'Fetch failed', r.error); return r; },

    /* ------------------------------------------------------------ PR / MR */
    async 'pulls:list'(p = {}) { return providers.list({ repoIds: p.repoIds, platforms: p.platforms, state: p.state || 'open' }); },
    async 'pulls:detail'(p) { return providers.detail(p); },
    async 'pulls:diff'(p) { return providers.diff(p); },
    async 'pulls:review'(p) {
      const c = confirmed(p); if (c) return c;
      const repo = repoOf(p.repoId); const r = await providers.review(p);
      log('pulls.review', repo, r.ok, `${p.platform === 'github' ? 'PR' : 'MR'} #${p.id}: ${p.action}${r.ok ? '' : ' failed'}`, r.ok ? p.body : r.error);
      return r;
    },
    async 'pulls:comment'(p) { const repo = repoOf(p.repoId); const r = await providers.comment(p); log('pulls.comment', repo, r.ok, `Comment on #${p.id}`, r.ok ? p.body : r.error); return r; },
    async 'pulls:merge'(p) {
      const c = confirmed(p); if (c) return c;
      const repo = repoOf(p.repoId); const r = await providers.merge(p);
      log('pulls.merge', repo, r.ok, `Merge ${p.platform === 'github' ? 'PR' : 'MR'} #${p.id} (${p.method || 'merge'})${r.ok ? '' : ' failed'}`, r.ok ? '' : r.error);
      return r;
    },
    async 'pulls:close'(p) { const c = confirmed(p); if (c) return c; const repo = repoOf(p.repoId); const r = await providers.close(p); log('pulls.close', repo, r.ok, `Close #${p.id}${r.ok ? '' : ' failed'}`, r.ok ? '' : r.error); return r; },
    async 'pulls:create'(p) {
      const c = confirmed(p); if (c) return c;
      const repo = repoOf(p.repoId);
      if (!git.isSafeRef(p.head) || !git.isSafeRef(p.base)) return { ok: false, error: 'Invalid branch.' };
      if (!String(p.title || '').trim()) return { ok: false, error: 'Title is required.' };
      const platforms = (Array.isArray(p.platforms) && p.platforms.length ? p.platforms : [repo.primary]).filter((x) => (x === 'github' && repo.github) || (x === 'gitlab' && repo.gitlab));
      const results = [];
      for (const platform of platforms) {
        const r = await providers.create({ repoId: repo.id, platform, base: p.base, head: p.head, title: String(p.title).trim(), body: p.body || '', draft: !!p.draft });
        results.push({ platform, ...r });
        log('pulls.create', repo, r.ok, `${platform === 'github' ? 'PR' : 'MR'} ${p.head} → ${p.base}${r.ok ? ` created (#${r.number})` : ' failed'}`, r.ok ? r.url : r.error);
      }
      return { ok: results.length > 0 && results.every((r) => r.ok), results };
    },

    /* ------------------------------------------------------------ rilis */
    async 'release:plan'(p) {
      const repo = repoOf(p.repoId);
      if (!git.isSafeRef(p.branch)) return { ok: false, error: 'Select a valid release branch.' };
      return { ok: true, plan: release.plan(repo.id, p.branch) };
    },
    async 'release:run'(p) {
      const c = confirmed(p); if (c) return c;
      const repo = repoOf(p.repoId);
      const runId = String(p.runId || Date.now());
      const res = await release.run({ repoId: repo.id, branch: p.branch, runId, emit: (e) => emit('release:progress', e) });
      const done = (res.steps || []).filter((s) => s.status === 'done').length;
      const total = (res.steps || []).length;
      log('release', repo, !!res.ok, `Release ${p.branch}: ${done}/${total} ${total === 1 ? 'step' : 'steps'} completed${res.ok ? '' : ' (stopped on failure)'}`, JSON.stringify(res.steps));
      return res;
    },
    async 'release:cancel'(p) { release.cancel(String(p.runId)); return { ok: true }; },

    /* ------------------------------------------------------------ aktivitas */
    async 'activity:list'(p = {}) { return { ok: true, items: store.activity(Number(p.limit) || 200) }; },
    async 'activity:clear'() { store.clearActivity(); return { ok: true }; },
  };

  return { handlers, providers, auth, release, store };
}

module.exports = { createServices };
