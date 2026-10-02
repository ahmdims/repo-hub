'use strict';
// Satu antarmuka untuk PR (GitHub) dan MR (GitLab): daftar lintas repo, detail, review, merge, buat.
const fs = require('node:fs');
const github = require('./github');
const { run } = require('./exec');
const { createGitlab } = require('./gitlab');

function createProviders({ store, auth }) {
  const gitlab = createGitlab(auth);
  let ghViewer = { at: 0, login: null };

  const repoOf = (id) => { const r = store.repo(id); if (!r) throw new Error('Repo not found.'); return r; };
  const hasPlatform = (repo, platform) => (platform === 'github' ? !!repo.github : !!repo.gitlab);
  const need = (repo, platform) => { if (!hasPlatform(repo, platform)) throw new Error(`${repo.name} has no ${platform === 'github' ? 'GitHub' : 'GitLab'} remote configured.`); };

  async function viewerLogin() {
    if (Date.now() - ghViewer.at < 10 * 60 * 1000) return ghViewer.login;
    const v = await github.viewer();
    ghViewer = { at: Date.now(), login: v.ok ? v.login : null };
    return ghViewer.login;
  }

  // Akses git ke remote GitLab (baca saja, tanpa mengunduh apa pun): status koneksi di Settings tanpa token/API.
  const accessCache = new Map(); // url -> { at, res }
  async function gitAccess(repo, fresh) {
    const url = repo.gitlab.url;
    const hit = accessCache.get(url);
    if (!fresh && hit && Date.now() - hit.at < 60 * 1000) return hit.res;
    const r = await run('git', ['ls-remote', '--heads', url, 'HEAD'], { cwd: repo.path, timeout: 30000 });
    const line = (r.stderr || '').split('\n').map((l) => l.trim()).filter(Boolean).pop();
    const msg = r.timedOut ? 'git did not respond (timed out).' : (line || 'git ls-remote failed');
    const res = r.ok ? { ok: true } : { ok: false, error: msg.replace(/(\w+:\/\/)[^@/\s]+@/g, '$1').slice(0, 300) };
    accessCache.set(url, { at: Date.now(), res });
    return res;
  }

  async function mapLimit(items, n, fn) {
    const out = new Array(items.length); let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
    return out;
  }

  async function listOne(repo, platform, state) {
    if (!hasPlatform(repo, platform)) return { items: [], error: null };
    const res = platform === 'github' ? await github.list(repo.github.repo, repo.id, { state }) : await gitlab.list(repo.gitlab.baseUrl, repo.gitlab.path, repo.id, { state });
    return res.ok ? { items: res.items, error: null } : { items: [], error: res.error, code: res.code };
  }

  return {
    gitlab,
    async list({ repoIds, platforms = ['github', 'gitlab'], state = 'open' } = {}) {
      const repos = (repoIds && repoIds.length ? repoIds.map(repoOf) : store.repos());
      const jobs = [];
      for (const repo of repos) for (const platform of platforms) if (hasPlatform(repo, platform)) jobs.push({ repo, platform });
      const results = await mapLimit(jobs, 4, async ({ repo, platform }) => ({ repo, platform, ...(await listOne(repo, platform, state)) }));
      const items = results.flatMap((r) => r.items.map((it) => ({ ...it, repoName: r.repo.name })));
      items.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
      // GitLab tanpa token bukan galat: fitur MR-nya sekadar nonaktif (push/mirror/fetch memakai git biasa)
      const off = (r) => r.code === 'NO_TOKEN';
      const errors = results.filter((r) => r.error && !off(r)).map((r) => ({ repoId: r.repo.id, repoName: r.repo.name, platform: r.platform, error: r.error }));
      const disabled = results.filter(off).map((r) => ({ repoId: r.repo.id, repoName: r.repo.name, platform: r.platform, reason: 'no-token', host: new URL(r.repo.gitlab.baseUrl).host }));
      return { ok: true, items, errors, disabled };
    },
    async detail({ repoId, platform, id }) {
      const repo = repoOf(repoId); need(repo, platform);
      const res = platform === 'github' ? await github.detail(repo.github.repo, repo.id, id) : await gitlab.detail(repo.gitlab.baseUrl, repo.gitlab.path, repo.id, id);
      if (!res.ok) return res;
      const viewer = platform === 'github' ? await viewerLogin() : (await gitlab.viewer(repo.gitlab.baseUrl)).login || null;
      res.item.repoName = repo.name; res.item.viewer = viewer;
      res.item.isOwn = !!viewer && res.item.author.login === viewer;
      return res;
    },
    async diff({ repoId, platform, id }) {
      const repo = repoOf(repoId); need(repo, platform);
      return platform === 'github' ? github.diff(repo.github.repo, id) : gitlab.diff(repo.gitlab.baseUrl, repo.gitlab.path, id);
    },
    async review({ repoId, platform, id, action, body }) {
      const repo = repoOf(repoId); need(repo, platform);
      return platform === 'github' ? github.review(repo.github.repo, id, { action, body }) : gitlab.review(repo.gitlab.baseUrl, repo.gitlab.path, id, { action, body });
    },
    async comment({ repoId, platform, id, body }) {
      const repo = repoOf(repoId); need(repo, platform);
      return platform === 'github' ? github.comment(repo.github.repo, id, body) : gitlab.comment(repo.gitlab.baseUrl, repo.gitlab.path, id, body);
    },
    async merge({ repoId, platform, id, method, deleteBranch }) {
      const repo = repoOf(repoId); need(repo, platform);
      return platform === 'github' ? github.merge(repo.github.repo, id, { method, deleteBranch }) : gitlab.merge(repo.gitlab.baseUrl, repo.gitlab.path, id, { method, deleteBranch });
    },
    async close({ repoId, platform, id, body }) {
      const repo = repoOf(repoId); need(repo, platform);
      return platform === 'github' ? github.close(repo.github.repo, id, body) : gitlab.close(repo.gitlab.baseUrl, repo.gitlab.path, id);
    },
    async create({ repoId, platform, base, head, title, body, draft }) {
      const repo = repoOf(repoId); need(repo, platform);
      return platform === 'github' ? github.create(repo.github.repo, { base, head, title, body, draft }) : gitlab.create(repo.gitlab.baseUrl, repo.gitlab.path, { base, head, title, body, draft });
    },
    async findOpen(repo, platform, head, base) {
      const res = await listOne(repo, platform, 'open');
      if (res.error) return { ok: false, error: res.error };
      return { ok: true, item: res.items.find((p) => p.head === head && p.base === base) || null };
    },
    async deployments(repo, sha) { return repo.github ? github.deployments(repo.github.repo, sha) : { ok: true, items: [] }; },
    async accounts({ fresh = false } = {}) {
      const out = { github: await github.viewer(), gitlab: {} };
      const hosts = new Map(); // host -> { base, repos }
      for (const r of store.repos()) if (r.gitlab) { const h = new URL(r.gitlab.baseUrl).host; if (!hosts.has(h)) hosts.set(h, { base: r.gitlab.baseUrl, repos: [] }); hosts.get(h).repos.push(r); }
      for (const [host, { base, repos }] of hosts) {
        const token = await auth.describe(host);
        const v = token.has ? await gitlab.viewer(base) : { ok: false, error: 'No token set.' };
        const probe = repos.find((r) => fs.existsSync(r.path));
        const git = probe ? { ...(await gitAccess(probe, fresh)), repo: probe.name } : { ok: false, error: 'No repo folder for this host was found on disk.' };
        out.gitlab[host] = { baseUrl: base, token, git, ...(v.ok ? { ok: true, login: v.login, name: v.name } : { ok: false, error: v.error }) };
      }
      return out;
    },
  };
}

module.exports = { createProviders };
