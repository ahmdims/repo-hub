'use strict';
// GitLab lewat REST API v4. Token diambil dari auth.js; tidak pernah disertakan di hasil/log.
const asId = (path) => encodeURIComponent(path);

function createGitlab(auth) {
  async function req(baseUrl, method, apiPath, { query, body } = {}) {
    const host = new URL(baseUrl).host;
    const token = await auth.getToken(host);
    if (!token) return { ok: false, code: 'NO_TOKEN', error: `GitLab token for ${host} is not set (Settings > GitLab).` };
    const url = new URL(`${baseUrl.replace(/\/$/, '')}/api/v4${apiPath}`);
    for (const [k, v] of Object.entries(query || {})) if (v != null) url.searchParams.set(k, String(v));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    try {
      const res = await fetch(url, { method, signal: ctrl.signal, headers: { 'PRIVATE-TOKEN': token, 'Content-Type': 'application/json', Accept: 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      const text = await res.text();
      let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
      if (!res.ok) {
        let msg = (data && (data.message || data.error)) || res.statusText || `HTTP ${res.status}`;
        if (typeof msg !== 'string') msg = JSON.stringify(msg);
        if (res.status === 401) { auth.forget(host); msg = 'GitLab rejected the token (401). Check the token in Settings > GitLab.'; }
        return { ok: false, status: res.status, error: msg.slice(0, 400) };
      }
      return { ok: true, status: res.status, data, headers: res.headers };
    } catch (e) {
      const why = e.cause && (e.cause.code || e.cause.message);
      return { ok: false, error: e.name === 'AbortError' ? 'GitLab did not respond (timed out after 30 seconds).' : `Could not connect to GitLab: ${e.message}${why ? ` (${why})` : ''}` };
    } finally { clearTimeout(timer); }
  }

  const pipelineState = (s) => ({ success: 'success', passed: 'success', skipped: 'success', failed: 'failure', canceled: 'failure', canceling: 'failure', running: 'pending', pending: 'pending', created: 'pending', preparing: 'pending', waiting_for_resource: 'pending', scheduled: 'pending', manual: 'pending' }[s] || 'pending');
  const mergeable = (d, hasConflicts) => {
    if (hasConflicts) return 'conflict';
    return { mergeable: 'clean', conflict: 'conflict', need_rebase: 'behind', draft_status: 'draft', not_open: 'unknown', checking: 'unknown', unchecked: 'unknown' }[d] || (d ? 'blocked' : 'unknown');
  };

  function normalize(m, repoId) {
    const p = m.head_pipeline || m.pipeline || null;
    const items = p ? [{ name: `Pipeline #${p.id}`, state: pipelineState(p.status), url: p.web_url || null }] : [];
    return {
      platform: 'gitlab', repoId, id: m.iid, title: m.title, url: m.web_url,
      author: { login: m.author && m.author.username, name: (m.author && (m.author.name || m.author.username)) || '' },
      isDraft: !!(m.draft || m.work_in_progress), state: m.state === 'opened' ? 'open' : m.state === 'merged' ? 'merged' : 'closed',
      head: m.source_branch, base: m.target_branch, createdAt: m.created_at, updatedAt: m.updated_at,
      checks: { state: items.length ? items[0].state : 'none', total: items.length, items },
      review: { state: 'unknown' }, mergeable: mergeable(m.detailed_merge_status, m.has_conflicts),
      labels: m.labels || [], changedFiles: m.changes_count ? Number(String(m.changes_count).replace('+', '')) : undefined,
    };
  }

  const approvalState = (a) => (a ? { state: a.approved ? 'approved' : (a.approvals_left > 0 ? 'review_required' : 'none'), approvals: (a.approved_by || []).length, required: a.approvals_required || 0, by: (a.approved_by || []).map((x) => x.user && x.user.username) } : { state: 'unknown' });

  async function mapLimit(items, n, fn) {
    const out = new Array(items.length); let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
    return out;
  }

  return {
    async viewer(baseUrl) {
      const r = await req(baseUrl, 'GET', '/user');
      return r.ok ? { ok: true, login: r.data.username, name: r.data.name } : r;
    },
    async repoInfo(baseUrl, project) {
      const r = await req(baseUrl, 'GET', `/projects/${asId(project)}`);
      if (!r.ok) return r;
      const a = r.data.permissions || {};
      const level = Math.max((a.project_access && a.project_access.access_level) || 0, (a.group_access && a.group_access.access_level) || 0);
      return { ok: true, info: { path: r.data.path_with_namespace, defaultBranch: r.data.default_branch, visibility: r.data.visibility, accessLevel: level } };
    },
    async list(baseUrl, project, repoId, { state = 'open', limit = 30 } = {}) {
      const r = await req(baseUrl, 'GET', `/projects/${asId(project)}/merge_requests`, { query: { state: state === 'open' ? 'opened' : state, order_by: 'updated_at', sort: 'desc', per_page: limit } });
      if (!r.ok) return r;
      const items = r.data.map((m) => normalize(m, repoId));
      if (state === 'open') {
        await mapLimit(items, 5, async (it) => { const a = await req(baseUrl, 'GET', `/projects/${asId(project)}/merge_requests/${it.id}/approvals`); it.review = approvalState(a.ok ? a.data : null); });
      }
      return { ok: true, items };
    },
    async detail(baseUrl, project, repoId, iid) {
      const base = `/projects/${asId(project)}/merge_requests/${iid}`;
      const [m, a, notes, commits, pipeJobs] = await Promise.all([
        req(baseUrl, 'GET', base), req(baseUrl, 'GET', `${base}/approvals`),
        req(baseUrl, 'GET', `${base}/notes`, { query: { sort: 'asc', per_page: 60 } }),
        req(baseUrl, 'GET', `${base}/commits`, { query: { per_page: 40 } }),
        Promise.resolve(null),
      ]);
      void pipeJobs;
      if (!m.ok) return m;
      const item = normalize(m.data, repoId);
      item.review = approvalState(a.ok ? a.data : null);
      item.body = m.data.description || '';
      item.mergedAt = m.data.merged_at;
      item.commits = (commits.ok ? commits.data : []).map((c) => ({ sha: (c.short_id || c.id || '').slice(0, 7), title: c.title, author: c.author_name, date: c.created_at }));
      item.comments = (notes.ok ? notes.data : []).filter((n) => !n.system).map((n) => ({ author: n.author && n.author.username, body: n.body, date: n.created_at }));
      item.reviews = [];
      const pid = m.data.head_pipeline && m.data.head_pipeline.id;
      if (pid) {
        const jobs = await req(baseUrl, 'GET', `/projects/${asId(project)}/pipelines/${pid}/jobs`, { query: { per_page: 50 } });
        if (jobs.ok && jobs.data.length) {
          item.checks = { ...item.checks, items: jobs.data.map((j) => ({ name: j.name, state: pipelineState(j.status), url: j.web_url || null })), total: jobs.data.length };
        }
      }
      const diffs = await req(baseUrl, 'GET', `${base}/diffs`, { query: { per_page: 100 } });
      item.files = (diffs.ok ? diffs.data : []).map((d) => {
        const lines = String(d.diff || '').split('\n');
        return { path: d.new_path, additions: lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length, deletions: lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length };
      });
      return { ok: true, item };
    },
    async diff(baseUrl, project, iid) {
      const r = await req(baseUrl, 'GET', `/projects/${asId(project)}/merge_requests/${iid}/diffs`, { query: { per_page: 100 } });
      if (!r.ok) return r;
      const patch = r.data.map((d) => {
        const a = d.new_file ? '/dev/null' : `a/${d.old_path}`, b = d.deleted_file ? '/dev/null' : `b/${d.new_path}`;
        return `diff --git a/${d.old_path} b/${d.new_path}\n${d.new_file ? 'new file mode 100644\n' : ''}${d.deleted_file ? 'deleted file mode 100644\n' : ''}--- ${a}\n+++ ${b}\n${d.diff || ''}`;
      }).join('\n');
      return { ok: true, patch };
    },
    async review(baseUrl, project, iid, { action, body }) {
      const base = `/projects/${asId(project)}/merge_requests/${iid}`;
      if (action === 'approve') { const r = await req(baseUrl, 'POST', `${base}/approve`); return r.ok ? { ok: true } : r; }
      if (action === 'unapprove') { const r = await req(baseUrl, 'POST', `${base}/unapprove`); return r.ok ? { ok: true } : r; }
      if (action === 'comment') {
        if (!String(body || '').trim()) return { ok: false, error: 'Comment is required.' };
        const r = await req(baseUrl, 'POST', `${base}/notes`, { body: { body: String(body) } }); return r.ok ? { ok: true } : r;
      }
      return { ok: false, error: 'This review action is not supported on GitLab.' };
    },
    async comment(baseUrl, project, iid, body) {
      if (!String(body || '').trim()) return { ok: false, error: 'Comment is required.' };
      const r = await req(baseUrl, 'POST', `/projects/${asId(project)}/merge_requests/${iid}/notes`, { body: { body: String(body) } });
      return r.ok ? { ok: true } : r;
    },
    async merge(baseUrl, project, iid, { method = 'merge', deleteBranch = false, auto = false } = {}) {
      if (method === 'rebase') return { ok: false, error: 'Rebase merge is not supported for GitLab yet; use merge or squash.' };
      const r = await req(baseUrl, 'PUT', `/projects/${asId(project)}/merge_requests/${iid}/merge`, { body: { squash: method === 'squash', should_remove_source_branch: !!deleteBranch, merge_when_pipeline_succeeds: !!auto } });
      return r.ok ? { ok: true } : r;
    },
    async close(baseUrl, project, iid) {
      const r = await req(baseUrl, 'PUT', `/projects/${asId(project)}/merge_requests/${iid}`, { body: { state_event: 'close' } });
      return r.ok ? { ok: true } : r;
    },
    async create(baseUrl, project, { base, head, title, body, draft }) {
      const r = await req(baseUrl, 'POST', `/projects/${asId(project)}/merge_requests`, { body: { source_branch: head, target_branch: base, title: draft && !/^draft:/i.test(title) ? `Draft: ${title}` : title, description: body || '' } });
      return r.ok ? { ok: true, url: r.data.web_url, number: r.data.iid } : r;
    },
  };
}

module.exports = { createGitlab };
