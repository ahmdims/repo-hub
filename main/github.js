'use strict';
// GitHub lewat GitHub CLI (`gh`): memakai login yang sudah ada di komputer ini, aplikasi tidak
// menyimpan token GitHub sama sekali.
const { run } = require('./exec');

const LIST_FIELDS = 'number,title,url,author,isDraft,state,headRefName,baseRefName,createdAt,updatedAt,statusCheckRollup,reviewDecision,mergeStateStatus,mergeable,labels,additions,deletions,changedFiles';
const DETAIL_FIELDS = `${LIST_FIELDS},body,reviews,comments,commits,files,mergedAt,reviewRequests`;

const fail = (r, fallback) => ({ ok: false, error: (r.stderr || fallback || 'gh failed').split('\n').slice(0, 4).join(' ').slice(0, 500) });

function checksFrom(rollup) {
  const items = (rollup || []).map((c) => {
    const name = c.name || c.context || 'check';
    let state = 'pending';
    if (c.__typename === 'StatusContext' || (!c.status && c.state)) {
      state = { SUCCESS: 'success', FAILURE: 'failure', ERROR: 'failure', PENDING: 'pending', EXPECTED: 'pending' }[c.state] || 'pending';
    } else if (c.status === 'COMPLETED') {
      state = { SUCCESS: 'success', NEUTRAL: 'success', SKIPPED: 'success', FAILURE: 'failure', TIMED_OUT: 'failure', STARTUP_FAILURE: 'failure', ACTION_REQUIRED: 'failure', CANCELLED: 'failure', STALE: 'pending' }[c.conclusion] || 'pending';
    }
    return { name, state, url: c.detailsUrl || c.targetUrl || null };
  });
  let state = 'none';
  if (items.length) state = items.some((i) => i.state === 'failure') ? 'failure' : items.some((i) => i.state === 'pending') ? 'pending' : 'success';
  return { state, total: items.length, items };
}

function reviewFrom(decision) {
  return { state: { APPROVED: 'approved', CHANGES_REQUESTED: 'changes_requested', REVIEW_REQUIRED: 'review_required' }[decision] || 'none' };
}

function mergeableFrom(p) {
  const s = p.mergeStateStatus, m = p.mergeable;
  if (m === 'CONFLICTING' || s === 'DIRTY') return 'conflict';
  if (s === 'CLEAN' || s === 'UNSTABLE' || s === 'HAS_HOOKS') return 'clean';
  if (s === 'BLOCKED') return 'blocked';
  if (s === 'BEHIND') return 'behind';
  if (s === 'DRAFT') return 'draft';
  return 'unknown';
}

function normalize(p, repoId) {
  return {
    platform: 'github', repoId, id: p.number, title: p.title, url: p.url,
    author: { login: p.author && p.author.login, name: (p.author && (p.author.name || p.author.login)) || '' },
    isDraft: !!p.isDraft, state: (p.state || '').toLowerCase() === 'open' ? 'open' : (p.state || '').toLowerCase() === 'merged' ? 'merged' : 'closed',
    head: p.headRefName, base: p.baseRefName, createdAt: p.createdAt, updatedAt: p.updatedAt,
    checks: checksFrom(p.statusCheckRollup), review: reviewFrom(p.reviewDecision), mergeable: mergeableFrom(p),
    labels: (p.labels || []).map((l) => l.name), additions: p.additions, deletions: p.deletions, changedFiles: p.changedFiles,
  };
}

async function viewer() {
  const r = await run('gh', ['api', 'user', '--jq', '.login'], { timeout: 20000 });
  return r.ok ? { ok: true, login: r.stdout.trim() } : fail(r, 'Not signed in to GitHub (run: gh auth login)');
}

async function list(repo, repoId, { state = 'open', limit = 40 } = {}) {
  const r = await run('gh', ['pr', 'list', '-R', repo, '--state', state, '--limit', String(limit), '--json', LIST_FIELDS], { timeout: 60000 });
  if (!r.ok) return fail(r);
  try { return { ok: true, items: JSON.parse(r.stdout || '[]').map((p) => normalize(p, repoId)) }; } catch { return { ok: false, error: 'Could not parse the gh response.' }; }
}

async function detail(repo, repoId, number) {
  const r = await run('gh', ['pr', 'view', String(number), '-R', repo, '--json', DETAIL_FIELDS], { timeout: 60000 });
  if (!r.ok) return fail(r);
  try {
    const p = JSON.parse(r.stdout);
    return {
      ok: true,
      item: {
        ...normalize(p, repoId), body: p.body || '', mergedAt: p.mergedAt,
        files: (p.files || []).map((f) => ({ path: f.path, additions: f.additions, deletions: f.deletions })),
        commits: (p.commits || []).map((c) => ({ sha: (c.oid || '').slice(0, 7), title: c.messageHeadline, author: (c.authors && c.authors[0] && (c.authors[0].name || c.authors[0].login)) || '', date: c.committedDate })),
        reviews: (p.reviews || []).map((x) => ({ author: x.author && x.author.login, state: (x.state || '').toLowerCase(), body: x.body || '', date: x.submittedAt })),
        comments: (p.comments || []).map((x) => ({ author: x.author && x.author.login, body: x.body || '', date: x.createdAt })),
      },
    };
  } catch { return { ok: false, error: 'Could not parse the gh response.' }; }
}

async function diff(repo, number) {
  const r = await run('gh', ['pr', 'diff', String(number), '-R', repo, '--color', 'never'], { timeout: 90000, maxBuffer: 128 * 1024 * 1024 });
  return r.ok ? { ok: true, patch: r.stdout } : fail(r);
}

async function review(repo, number, { action, body }) {
  const flag = { approve: '--approve', changes: '--request-changes', comment: '--comment' }[action];
  if (!flag) return { ok: false, error: 'Unknown review action.' };
  if ((action === 'changes' || action === 'comment') && !String(body || '').trim()) return { ok: false, error: 'Comment is required.' };
  const args = ['pr', 'review', String(number), '-R', repo, flag];
  if (body && String(body).trim()) args.push('-b', String(body));
  const r = await run('gh', args, { timeout: 60000 });
  return r.ok ? { ok: true } : fail(r);
}

async function comment(repo, number, body) {
  if (!String(body || '').trim()) return { ok: false, error: 'Comment is required.' };
  const r = await run('gh', ['pr', 'comment', String(number), '-R', repo, '-b', String(body)], { timeout: 60000 });
  return r.ok ? { ok: true } : fail(r);
}

async function merge(repo, number, { method = 'merge', deleteBranch = false } = {}) {
  const flag = { merge: '--merge', squash: '--squash', rebase: '--rebase' }[method];
  if (!flag) return { ok: false, error: 'Unknown merge method.' };
  const args = ['pr', 'merge', String(number), '-R', repo, flag];
  if (deleteBranch) args.push('--delete-branch');
  const r = await run('gh', args, { timeout: 120000 });
  return r.ok ? { ok: true } : fail(r);
}

async function close(repo, number, body) {
  const args = ['pr', 'close', String(number), '-R', repo];
  if (body && String(body).trim()) args.push('-c', String(body));
  const r = await run('gh', args, { timeout: 60000 });
  return r.ok ? { ok: true } : fail(r);
}

async function create(repo, { base, head, title, body, draft }) {
  const args = ['pr', 'create', '-R', repo, '--base', base, '--head', head, '--title', title, '--body', body || ''];
  if (draft) args.push('--draft');
  const r = await run('gh', args, { timeout: 90000 });
  if (!r.ok) return fail(r);
  const url = (r.stdout.match(/https:\/\/\S+\/pull\/(\d+)/) || [])[0] || r.stdout.trim().split('\n').pop();
  const number = Number((url.match(/\/pull\/(\d+)/) || [])[1]) || null;
  return { ok: true, url, number };
}

// status deployment (Vercel, dll.) untuk sebuah commit
async function deployments(repo, sha) {
  const r = await run('gh', ['api', `repos/${repo}/deployments?sha=${encodeURIComponent(sha)}&per_page=10`], { timeout: 30000 });
  if (!r.ok) return fail(r);
  let list; try { list = JSON.parse(r.stdout || '[]'); } catch { return { ok: false, error: 'Could not parse the gh response.' }; }
  const out = [];
  for (const d of list) {
    const s = await run('gh', ['api', `repos/${repo}/deployments/${d.id}/statuses?per_page=1`], { timeout: 30000 });
    let st = null; try { st = JSON.parse(s.stdout || '[]')[0] || null; } catch { /* abaikan */ }
    out.push({ id: d.id, environment: d.environment, state: st ? st.state : 'pending', url: st ? (st.environment_url || st.target_url) : null });
  }
  return { ok: true, items: out };
}

async function repoInfo(repo) {
  const r = await run('gh', ['repo', 'view', repo, '--json', 'nameWithOwner,defaultBranchRef,viewerPermission,isPrivate'], { timeout: 30000 });
  if (!r.ok) return fail(r);
  try { return { ok: true, info: JSON.parse(r.stdout) }; } catch { return { ok: false, error: 'Could not parse the gh response.' }; }
}

module.exports = { viewer, list, detail, diff, review, comment, merge, close, create, deployments, repoInfo, checksFrom, normalize };
