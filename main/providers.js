'use strict';
// Satu antarmuka untuk PR (GitHub) dan MR (GitLab): daftar lintas repo, detail, review, merge, buat.
const github = require('./github');
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

  async function mapLimit(items, n, fn) {
    const out = new Array(items.length); let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
    return out;
  }

  async function listOne(repo, platform, state) {
    if (!hasPlatform(repo, platform)) return { items: [], error: null };
    const res = platform === 'github' ? await github.list(repo.github.repo, repo.id, { state }) : await gitlab.list(repo.gitlab.baseUrl, repo.gitlab.path, repo.id, { state });
    return res.ok ? { items: res.items, error: null } : { items: [], error: res.error };
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
      const errors = results.filter((r) => r.error).map((r) => ({ repoId: r.repo.id, repoName: r.repo.name, platform: r.platform, error: r.error }));
      return { ok: true, items, errors };
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
    async accounts() {
      const out = { github: await github.viewer(), gitlab: {} };
      const hosts = new Map();
      for (const r of store.repos()) if (r.gitlab) hosts.set(new URL(r.gitlab.baseUrl).host, r.gitlab.baseUrl);
      for (const [host, base] of hosts) {
        const token = await auth.describe(host);
        const v = token.has ? await gitlab.viewer(base) : { ok: false, error: 'No token set.' };
        out.gitlab[host] = { baseUrl: base, token, ...(v.ok ? { ok: true, login: v.login, name: v.name } : { ok: false, error: v.error }) };
      }
      return out;
    },
  };
}

module.exports = { createProviders };
