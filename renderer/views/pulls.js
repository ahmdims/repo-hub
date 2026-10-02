// Pull Request (GitHub) + Merge Request (GitLab) dari semua repo dalam satu daftar: lihat detail & diff,
// review/approve, merge, tutup, buat baru, dan aksi massal (approve / merge banyak sekaligus).
import { html, esc, icon, badge, timeAgo, platformName, prWord, initials, mount as setHtml } from '../lib/h.js';
import { dialog, confirmDialog, notify, call, busy } from '../lib/ui.js';
import { state, bus, repoById, refreshAll } from '../state.js';
import { renderDiff } from '../lib/diff.js';

// Plural helper (local): plural(2, 'file') -> "2 files"; plural(1, 'file') -> "1 file"
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export const title = 'Pull Requests';
let host = null, root = null, offs = [], selected = new Set();
let data = { items: [], errors: [], disabled: [], loaded: false, loading: false };
const filters = { repo: '', platform: '', state: 'open' };

const keyOf = (p) => `${p.repoId}|${p.platform}|${p.id}`;
const byKey = (k) => data.items.find((p) => keyOf(p) === k);

/* ------------------------------------------------------------------ badge status */
const checkBadge = (c) => ({ success: badge('success', 'Checks passed', 'check-circle'), failure: badge('danger', 'Checks failed', 'x-circle'), pending: badge('warning', 'Checks running', 'circle-notch'), none: badge('neutral', 'No checks') }[c.state] || badge('neutral', '—'));
const reviewBadge = (r) => ({ approved: badge('success', 'Approved', 'seal-check'), changes_requested: badge('danger', 'Changes requested', 'warning'), review_required: badge('warning', 'Review required'), none: badge('neutral', 'Not reviewed') }[r.state] || badge('neutral', 'Review ?'));
const mergeBadge = (p) => p.state === 'merged' ? badge('primary', 'Merged', 'git-merge') : p.state === 'closed' ? badge('neutral', 'Closed') : p.isDraft ? badge('neutral', 'Draft') : ({ clean: badge('success', 'Ready to merge', 'git-merge'), conflict: badge('danger', 'Conflict', 'warning'), blocked: badge('warning', 'Blocked'), behind: badge('warning', 'Behind'), unknown: badge('neutral', 'Unknown') }[p.mergeable] || badge('neutral', '—'));

function counts() {
  const open = data.items.filter((p) => p.state === 'open');
  return { open: open.length, ready: open.filter((p) => !p.isDraft && p.mergeable === 'clean' && p.checks.state !== 'failure' && p.checks.state !== 'pending').length, review: open.filter((p) => p.review.state === 'review_required').length, failing: open.filter((p) => p.checks.state === 'failure' || p.mergeable === 'conflict').length };
}

/* ------------------------------------------------------------------ render */
function rowHtml(p, i) {
  const repo = repoById(p.repoId);
  const canMerge = p.state === 'open' && !p.isDraft && p.mergeable !== 'conflict';
  const canApprove = p.state === 'open';
  return html`<tr data-key="${keyOf(p)}">
    <td class="table-col-check"><input type="checkbox" class="form-check form-check-sm" data-table-select aria-label="Select ${p.title}" ${selected.has(keyOf(p)) ? 'checked' : ''} ${p.state === 'open' ? '' : 'disabled'} /></td>
    <td class="table-col-num" data-num>${i + 1}</td>
    <td class="max-w-[30rem]"><div class="flex items-start gap-2.5"><span class="mt-0.5 shrink-0 text-slate-400" title="${platformName(p.platform)}">${icon(p.platform === 'github' ? 'github-logo' : 'gitlab-logo', 'h-4 w-4')}</span>
      <div class="min-w-0"><button type="button" class="block max-w-full truncate text-left font-medium text-slate-800 hover:text-primary-600 hover:underline" data-act="detail" title="${p.title}">${p.title}</button>
      <p class="mt-0.5 truncate text-xs text-slate-500">${repo ? repo.name : p.repoName} · ${prWord(p.platform)} #${p.id} · <span class="font-mono">${p.head}</span> → <span class="font-mono">${p.base}</span></p></div></div></td>
    <td><span class="inline-flex items-center gap-2 text-sm text-slate-700"><span class="avatar h-6 w-6 text-[10px]">${initials(p.author.name || p.author.login)}</span>${p.author.login || p.author.name}</span></td>
    <td><div class="flex flex-wrap gap-1">${mergeBadge(p)}${p.state === 'open' ? html`${checkBadge(p.checks)}${reviewBadge(p.review)}` : ''}</div></td>
    <td class="whitespace-nowrap text-sm text-slate-500">${timeAgo(p.updatedAt)}</td>
    <td class="table-col-actions"><div class="flex items-center justify-end gap-1.5">
      <button type="button" class="btn-outline btn-sm whitespace-nowrap" data-act="detail" title="View details & diff">${icon('eye')}<span class="hidden xl:inline">Details</span></button>
      <button type="button" class="btn-outline btn-sm whitespace-nowrap" data-act="approve" ${canApprove ? '' : 'disabled'} title="Approve">${icon('seal-check')}<span class="hidden xl:inline">Approve</span></button>
      <button type="button" class="btn-primary btn-sm whitespace-nowrap" data-act="merge" ${canMerge ? '' : 'disabled'} title="Merge">${icon('git-merge')}<span class="hidden xl:inline">Merge</span></button>
    </div></td></tr>`;
}

function statsHtml() {
  const c = counts();
  return html`<div class="flex flex-wrap gap-2.5">
    ${['open', 'ready', 'review', 'failing'].map((k) => html`<span class="inline-flex items-center gap-2 rounded-full border border-border bg-surface px-3.5 py-1.5 text-sm text-slate-600"><b class="font-display text-base ${k === 'failing' && c[k] ? 'text-danger-600' : k === 'ready' && c[k] ? 'text-success-600' : 'text-slate-900'}">${c[k]}</b>${{ open: 'open', ready: 'ready to merge', review: 'awaiting review', failing: 'failing (failed checks/conflicts)' }[k]}</span>`)}
  </div>`;
}

function shell() {
  const repos = state.repos;
  return html`
    <div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div class="min-w-0"><h2 class="font-display text-2xl font-bold text-slate-900 sm:text-3xl">Pull Requests & Merge Requests</h2><p class="mt-1 text-sm text-slate-500">GitHub PRs and GitLab MRs from all your repos. Select several to approve or merge them at once.</p></div>
      <div class="flex shrink-0 gap-2.5"><button type="button" class="btn-outline btn-md" data-top="reload">${icon('arrows-clockwise')}Reload</button><button type="button" class="btn-primary btn-md" data-top="create" ${repos.length ? '' : 'disabled'}>${icon('plus')}Create PR/MR</button></div>
    </div>
    <div id="prStats">${statsHtml()}</div>
    <div class="table-wrap overflow-visible" id="prTable" data-table data-page-size="15" data-item-label="PR/MR">
      <div class="table-toolbar">
        <div class="relative w-full sm:w-64">${icon('magnifying-glass', 'pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400')}<input type="search" class="input h-9 pl-9" placeholder="Search title, branch, author..." data-table-search /></div>
        <div class="ml-auto flex flex-wrap items-center gap-2">
          <select class="input h-9 w-auto py-0 text-sm" data-filter="repo" aria-label="Repo"><option value="">All repos</option>${repos.map((r) => html`<option value="${r.id}" ${filters.repo === r.id ? 'selected' : ''}>${r.name}</option>`)}</select>
          <select class="input h-9 w-auto py-0 text-sm" data-filter="platform" aria-label="Platform"><option value="">GitHub + GitLab</option><option value="github" ${filters.platform === 'github' ? 'selected' : ''}>GitHub</option><option value="gitlab" ${filters.platform === 'gitlab' ? 'selected' : ''}>GitLab</option></select>
          <select class="input h-9 w-auto py-0 text-sm" data-filter="state" aria-label="Status">${[['open', 'Open'], ['merged', 'Merged'], ['closed', 'Closed']].map(([v, l]) => html`<option value="${v}" ${filters.state === v ? 'selected' : ''}>${l}</option>`)}</select>
        </div>
      </div>
      <div class="table-bulk" data-table-bulk hidden>
        <span><b data-table-selected-count>0</b> selected</span>
        <div class="ml-auto flex flex-wrap gap-2"><button type="button" class="btn-outline btn-sm" data-bulk="approve">${icon('seal-check', 'h-3.5 w-3.5')}Approve selected</button><button type="button" class="btn-primary btn-sm" data-bulk="merge">${icon('git-merge', 'h-3.5 w-3.5')}Merge selected</button></div>
      </div>
      <div id="prErrors"></div>
      <div class="overflow-x-auto"><table class="table table-lg table-fit table-head-soft">
        <thead><tr><th scope="col" class="table-col-check"><input type="checkbox" class="form-check form-check-sm" data-table-select-all aria-label="Select all" /></th><th scope="col" class="table-col-num">#</th><th scope="col" data-sort="text">PR/MR</th><th scope="col" data-sort="text">Author</th><th scope="col">Status</th><th scope="col">Updated</th><th scope="col" class="table-col-actions text-right">Actions</th></tr></thead>
        <tbody id="prBody"></tbody></table></div>
      <div class="table-empty" data-table-empty hidden></div>
      <div class="table-footer"><span data-table-info></span><nav data-table-pages class="flex items-center gap-1" aria-label="Pagination"></nav></div>
    </div>`;
}

function paint() {
  if (!host || !root) return;
  const body = host.querySelector('#prBody');
  const loading = data.loading && !data.loaded;
  setHtml(body, loading ? html`<tr><td colspan="7" class="py-10 text-center text-sm text-slate-500">${icon('circle-notch', 'h-4 w-4 animate-spin inline')} Loading PRs/MRs from all repos…</td></tr>` : data.items.map((p, i) => rowHtml(p, i)));
  const empty = host.querySelector('[data-table-empty]');
  empty.textContent = data.loaded && !data.items.length ? (state.repos.length ? `No ${filters.state === 'open' ? 'open PRs/MRs' : 'results'} for this filter.` : 'No repos yet.') : 'No matching results.';
  const table = window.KKTable.get(root);
  if (table) table.render();
  setHtml(host.querySelector('#prStats'), statsHtml());
  const offNames = [...new Set((data.disabled || []).map((d) => d.repoName))];
  const offNote = offNames.length ? html`<div class="callout-info m-4 flex items-start gap-3">${icon('info', 'h-4 w-4 shrink-0 text-info-600')}<div class="text-sm"><p><b>GitLab MRs are off</b> for ${offNames.join(', ')}: no GitLab token is set. Push, fetch and sync still work through git. To see MRs here, add a token under Settings → GitLab.</p></div></div>` : '';
  const errNote = data.errors.length ? html`<div class="callout-warning m-4 flex items-start gap-3">${icon('warning', 'h-4 w-4 shrink-0 text-warning-600')}<div class="text-sm">${data.errors.map((e) => html`<p><b>${e.repoName}</b> (${platformName(e.platform)}): ${e.error}</p>`)}</div></div>` : '';
  setHtml(host.querySelector('#prErrors'), html`${errNote}${offNote}`);
}

async function load() {
  data.loading = true; paint();
  const platforms = filters.platform ? [filters.platform] : undefined;
  const r = await call('pulls:list', { repoIds: filters.repo ? [filters.repo] : undefined, platforms, state: filters.state }, { silent: true });
  data = { items: r.items || [], errors: r.errors || (r.ok === false ? [{ repoName: '—', platform: 'github', error: r.error }] : []), disabled: r.disabled || [], loaded: true, loading: false };
  selected = new Set([...selected].filter((k) => byKey(k)));
  paint();
}

export function mount(el) {
  host = el; selected = new Set();
  host.innerHTML = shell().s;
  root = host.querySelector('#prTable');
  window.KKTable.init(root);
  root.addEventListener('change', (e) => {
    const f = e.target.closest('[data-filter]');
    if (f) { filters[f.dataset.filter] = f.value; return load(); }
    if (e.target.matches('[data-table-select], [data-table-select-all]')) syncSelection();
  });
  root.addEventListener('click', onClick);
  host.addEventListener('click', onTop);
  offs = [];
  paint(); load();
}
export function unmount() { offs.forEach((f) => f()); offs = []; host = null; root = null; }

function onTop(e) {
  const t = e.target.closest('[data-top]');
  if (!t) return;
  if (t.dataset.top === 'reload') return busy(t, load);
  if (t.dataset.top === 'create') return createDialog();
}

function syncSelection() {
  selected = new Set([...root.querySelectorAll('#prBody tr[data-key]')].filter((r) => r.querySelector('[data-table-select]').checked).map((r) => r.dataset.key));
}

async function onClick(e) {
  const bulk = e.target.closest('[data-bulk]');
  if (bulk) { syncSelection(); const items = [...selected].map(byKey).filter(Boolean); return items.length && (bulk.dataset.bulk === 'merge' ? mergeDialog(items) : approveDialog(items)); }
  const act = e.target.closest('[data-act]');
  if (!act) return;
  const p = byKey(act.closest('tr').dataset.key);
  if (!p) return;
  if (act.dataset.act === 'detail') return detailDialog(p);
  if (act.dataset.act === 'approve') return approveDialog([p]);
  if (act.dataset.act === 'merge') return mergeDialog([p]);
}

/* ------------------------------------------------------------------ aksi massal */
async function runBatch(d, items, fn, okText) {
  d.lock(true);
  let ok = 0;
  for (const p of items) {
    const out = d.$(`[data-item="${keyOf(p)}"] [data-out]`); out.classList.remove('hidden'); out.innerHTML = '<span class="text-slate-500">Processing…</span>';
    const r = await fn(p);
    out.innerHTML = r.ok ? `<span class="text-success-700">✓ ${esc(okText)}</span>` : `<span class="text-danger-700">✕ ${esc(r.error || 'Failed')}</span>`;
    if (r.ok) ok++;
  }
  d.lock(false);
  d.setFooter(html`<button type="button" class="btn-primary btn-md" data-dialog-close>Done</button>`);
  notify(ok === items.length ? 'success' : 'warning', `${ok} of ${items.length} succeeded.`);
  selected = new Set(); load(); refreshAll({ fetch: false });
  return ok;
}

const itemCard = (p, extra = '') => html`<div class="rounded-xl border border-border p-3.5" data-item="${keyOf(p)}"><div class="flex items-start gap-2.5">${icon(p.platform === 'github' ? 'github-logo' : 'gitlab-logo', 'mt-0.5 h-4 w-4 shrink-0 text-slate-400')}<div class="min-w-0 flex-1"><p class="font-medium text-slate-800">${p.title}</p><p class="text-xs text-slate-500">${p.repoName} · ${prWord(p.platform)} #${p.id} · ${p.head} → ${p.base}</p><div class="mt-1.5 flex flex-wrap gap-1">${checkBadge(p.checks)}${reviewBadge(p.review)}${mergeBadge(p)}</div>${extra}</div></div><div class="mt-2 hidden text-xs" data-out></div></div>`;

function approveDialog(items) {
  const eligible = items.filter((p) => p.state === 'open');
  const d = dialog({ title: eligible.length === 1 ? `Approve ${prWord(eligible[0].platform)} #${eligible[0].id}` : `Approve ${eligible.length} PRs/MRs`, description: 'Approving submits your review approval for these changes.', size: 'modal-lg',
    body: html`<div class="space-y-3">${eligible.map((p) => itemCard(p, p.platform === 'github' ? html`<p class="mt-1.5 text-xs text-slate-500">${icon('info', 'h-3.5 w-3.5 inline')} GitHub does not allow approving your own PR; that item will fail with GitHub's error message.</p>` : ''))}</div>`,
    footer: html`<button type="button" class="btn-outline btn-md" data-dialog-close>Cancel</button><button type="button" class="btn-primary btn-md" data-go>${icon('seal-check')}Approve</button>` });
  d.$('[data-go]').addEventListener('click', () => runBatch(d, eligible, (p) => call('pulls:review', { repoId: p.repoId, platform: p.platform, id: p.id, action: 'approve', confirmed: true }, { silent: true }), 'approved'));
}

function mergeDialog(items) {
  const eligible = items.filter((p) => p.state === 'open' && !p.isDraft && p.mergeable !== 'conflict');
  const skipped = items.length - eligible.length;
  if (!eligible.length) return notify('warning', 'None of these items can be merged (drafts, conflicts, or already closed).');
  const d = dialog({ title: eligible.length === 1 ? `Merge ${prWord(eligible[0].platform)} #${eligible[0].id}` : `Merge ${eligible.length} PRs/MRs`, description: skipped ? `Skipped ${plural(skipped, 'item')}: drafts, conflicts, or not open.` : 'A merge cannot be undone from this app.', size: 'modal-lg',
    body: html`<div class="mb-4 grid gap-4 sm:grid-cols-2"><div><label class="form-label" for="mm">Merge method</label><select id="mm" class="input" data-method><option value="merge">Merge commit</option><option value="squash">Squash</option><option value="rebase">Rebase (GitHub)</option></select></div><label class="flex items-center gap-2 pt-6 text-sm text-slate-700"><input type="checkbox" class="form-check form-check-sm" data-delete /> Delete source branch after merge</label></div>
      <div class="space-y-3">${eligible.map((p) => itemCard(p, p.checks.state === 'failure' ? html`<p class="mt-1.5 text-xs text-danger-700">${icon('warning', 'h-3.5 w-3.5 inline')} Checks failed; you can still merge if the branch rules allow it.</p>` : p.checks.state === 'pending' ? html`<p class="mt-1.5 text-xs text-warning-700">${icon('warning', 'h-3.5 w-3.5 inline')} Checks are still running.</p>` : ''))}</div>`,
    footer: html`<button type="button" class="btn-outline btn-md" data-dialog-close>Cancel</button><button type="button" class="btn-primary btn-md" data-go>${icon('git-merge')}Merge now</button>` });
  d.$('[data-go]').addEventListener('click', () => {
    const method = d.$('[data-method]').value, deleteBranch = d.$('[data-delete]').checked;
    runBatch(d, eligible, (p) => call('pulls:merge', { repoId: p.repoId, platform: p.platform, id: p.id, method, deleteBranch, confirmed: true }, { silent: true }), 'merged');
  });
}

/* ------------------------------------------------------------------ detail */
async function detailDialog(p) {
  const d = dialog({ title: `${prWord(p.platform)} #${p.id} · ${p.title}`, description: `${p.repoName} · ${p.head} → ${p.base}`, size: 'modal-2xl', body: html`<p class="py-10 text-center text-sm text-slate-500">${icon('circle-notch', 'h-4 w-4 animate-spin inline')} Loading details…</p>` });
  const res = await call('pulls:detail', { repoId: p.repoId, platform: p.platform, id: p.id }, { silent: true });
  if (!res.ok) return d.setBody(html`<div class="callout-warning flex gap-3">${icon('warning', 'h-4 w-4 shrink-0 text-warning-600')}<p class="text-sm">${res.error}</p></div>`);
  const it = res.item;
  const web = (url) => call('shell:openExternal', { url });
  const stateBadge = it.state === 'merged' ? badge('primary', 'Merged', 'git-merge') : it.state === 'closed' ? badge('neutral', 'Closed') : badge('success', 'Open', 'git-pull-request');
  const tabBtn = (id, label, n) => html`<button type="button" class="tab ${id === 'ringkasan' ? 'tab-active' : ''}" data-tab="${id}">${label}${n != null ? html` <span class="ml-1 text-xs opacity-70">${n}</span>` : ''}</button>`;
  d.setBody(html`
    <div class="mb-4 flex flex-wrap items-center gap-2">${stateBadge}${it.isDraft ? badge('neutral', 'Draft') : ''}${mergeBadge(it)}${it.state === 'open' ? html`${checkBadge(it.checks)}${reviewBadge(it.review)}` : ''}
      <button type="button" class="btn-outline btn-sm ml-auto" data-web="${it.url}">${icon('arrow-square-out', 'h-3.5 w-3.5')}Open on ${platformName(it.platform)}</button></div>
    <p class="mb-4 text-sm text-slate-500">by <b class="text-slate-700">${it.author.login}</b> · created ${timeAgo(it.createdAt)} · updated ${timeAgo(it.updatedAt)}</p>
    <div class="mb-4 flex gap-1 rounded-xl bg-slate-100 p-1">${tabBtn('ringkasan', 'Overview')}${tabBtn('file', 'Files', it.files.length)}${tabBtn('komentar', 'Discussion', it.comments.length + it.reviews.filter((r) => r.body).length)}</div>
    <section data-pane="ringkasan">
      <div class="mb-5 whitespace-pre-wrap break-words rounded-xl bg-neutral-50 p-4 text-sm text-slate-700">${it.body || html`<span class="text-slate-400">No description.</span>`}</div>
      <h4 class="mb-2 text-sm font-semibold text-slate-800">Checks (${it.checks.total})</h4>
      <div class="mb-5 space-y-1.5">${it.checks.items.length ? it.checks.items.map((c) => html`<div class="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2 text-sm"><span class="truncate">${c.name}</span><span class="flex items-center gap-2">${checkBadge({ state: c.state })}${c.url ? html`<button type="button" class="text-slate-400 hover:text-primary-600" data-web="${c.url}" title="Open">${icon('arrow-square-out', 'h-3.5 w-3.5')}</button>` : ''}</span></div>`) : html`<p class="text-sm text-slate-400">No checks.</p>`}</div>
      <h4 class="mb-2 text-sm font-semibold text-slate-800">Commits (${it.commits.length})</h4>
      <div class="space-y-1.5">${it.commits.map((c) => html`<div class="flex items-center gap-3 rounded-lg border border-border px-3 py-2 text-sm"><span class="kbd-ref">${c.sha}</span><span class="min-w-0 flex-1 truncate">${c.title}</span><span class="shrink-0 text-xs text-slate-400">${c.author}</span></div>`)}</div>
    </section>
    <section data-pane="file" class="hidden"><div data-diff><button type="button" class="btn-outline btn-md" data-load-diff>${icon('git-diff')}Load diff (${plural(it.files.length, 'file')})</button>
      <div class="mt-4 space-y-1">${it.files.map((f) => html`<div class="flex items-center justify-between gap-3 text-sm"><span class="truncate font-mono text-xs">${f.path}</span><span class="shrink-0 text-xs"><b class="text-success-700">+${f.additions}</b> <b class="text-danger-600">−${f.deletions}</b></span></div>`)}</div></div></section>
    <section data-pane="komentar" class="hidden">
      <div class="space-y-3">${[...it.reviews.filter((r) => r.body).map((r) => ({ a: r.author, b: r.body, t: r.date, tag: r.state })), ...it.comments.map((c) => ({ a: c.author, b: c.body, t: c.date }))].map((c) => html`<div class="rounded-xl border border-border p-3.5"><p class="mb-1 text-xs text-slate-500"><b class="text-slate-700">${c.a}</b>${c.tag ? html` · ${c.tag}` : ''} · ${timeAgo(c.t)}</p><p class="whitespace-pre-wrap break-words text-sm text-slate-700">${c.b}</p></div>`)}</div>
      <div class="mt-4"><label class="form-label" for="cm">Write a comment</label><textarea id="cm" class="input h-auto py-2.5" rows="3" placeholder="Comment, or the reason for requesting changes..." data-comment></textarea>
        <div class="mt-2 flex flex-wrap gap-2"><button type="button" class="btn-outline btn-sm" data-send="comment">${icon('chat-text', 'h-3.5 w-3.5')}Post comment</button>${it.platform === 'github' ? html`<button type="button" class="btn-outline btn-sm text-danger-600" data-send="changes">${icon('warning', 'h-3.5 w-3.5')}Request changes</button>` : ''}</div></div>
    </section>`);
  const own = it.isOwn && it.platform === 'github';
  d.setFooter(it.state === 'open' ? html`
    <button type="button" class="btn-outline btn-md" data-dialog-close>Close</button>
    <button type="button" class="btn-outline btn-md text-danger-600" data-close-pr>${icon('x-circle')}Close ${prWord(it.platform)}</button>
    <span ${own ? 'title="GitHub does not allow approving your own PR"' : ''}><button type="button" class="btn-outline btn-md" data-approve ${own ? 'disabled' : ''}>${icon('seal-check')}Approve</button></span>
    <button type="button" class="btn-primary btn-md" data-merge ${it.isDraft || it.mergeable === 'conflict' ? 'disabled' : ''}>${icon('git-merge')}Merge…</button>` : html`<button type="button" class="btn-primary btn-md" data-dialog-close>Close</button>`);

  const el = d.el;
  el.addEventListener('click', async (e) => {
    const w = e.target.closest('[data-web]'); if (w) return web(w.dataset.web);
    const tab = e.target.closest('[data-tab]');
    if (tab) { el.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('tab-active', b === tab)); el.querySelectorAll('[data-pane]').forEach((s) => s.classList.toggle('hidden', s.dataset.pane !== tab.dataset.tab)); return; }
    if (e.target.closest('[data-load-diff]')) return busy(e.target.closest('[data-load-diff]'), async () => {
      const r = await call('pulls:diff', { repoId: it.repoId, platform: it.platform, id: it.id });
      if (r.ok) setHtml(el.querySelector('[data-diff]'), renderDiff(r.patch));
    });
    const send = e.target.closest('[data-send]');
    if (send) {
      const body = el.querySelector('[data-comment]').value.trim();
      if (!body) return notify('warning', 'Write a comment first.');
      return busy(send, async () => {
        const r = send.dataset.send === 'changes'
          ? await call('pulls:review', { repoId: it.repoId, platform: it.platform, id: it.id, action: 'changes', body, confirmed: true })
          : await call('pulls:comment', { repoId: it.repoId, platform: it.platform, id: it.id, body });
        if (r.ok) { notify('success', send.dataset.send === 'changes' ? 'Changes requested.' : 'Comment posted.'); d.close(true); load(); }
      });
    }
    if (e.target.closest('[data-approve]')) { d.close(true); return approveDialog([it]); }
    if (e.target.closest('[data-merge]')) { d.close(true); return mergeDialog([{ ...p, ...it }]); }
    if (e.target.closest('[data-close-pr]')) {
      d.close(true);
      const ok = await confirmDialog({ title: `Close ${prWord(it.platform)} #${it.id}?`, body: html`<p class="text-sm text-slate-600">${it.title}</p>`, confirmLabel: 'Close without merging', danger: true });
      if (!ok) return;
      const r = await call('pulls:close', { repoId: it.repoId, platform: it.platform, id: it.id, confirmed: true });
      if (r.ok) { notify('success', `${prWord(it.platform)} #${it.id} closed.`); load(); }
    }
  });
}

/* ------------------------------------------------------------------ buat */
async function createDialog() {
  const repos = state.repos;
  const first = repos.find((r) => r.id === filters.repo) || repos[0];
  const d = dialog({ title: 'Create Pull/Merge Request', size: 'modal-xl', description: 'From a branch that already exists on the remote.', body: html`<p class="py-8 text-center text-sm text-slate-500">${icon('circle-notch', 'h-4 w-4 animate-spin inline')} Loading…</p>` });
  let branches = { all: [], remote: [] }, repo = first;
  const draw = (subject) => {
    const head = d.$('[data-head]') ? d.$('[data-head]').value : '';
    d.setBody(html`<div class="grid gap-4 sm:grid-cols-2">
      <div class="sm:col-span-2"><label class="form-label" for="cr">Repo</label><select id="cr" class="input" data-repo>${repos.map((r) => html`<option value="${r.id}" ${r.id === repo.id ? 'selected' : ''}>${r.name}</option>`)}</select></div>
      <div><label class="form-label" for="ch">From (head)</label><select id="ch" class="input font-mono text-xs" data-head>${branches.all.map((b) => html`<option ${b === head ? 'selected' : ''}>${b}</option>`)}</select></div>
      <div><label class="form-label" for="cb">To (base)</label><select id="cb" class="input font-mono text-xs" data-base>${branches.all.map((b) => html`<option ${b === repo.defaultBranch ? 'selected' : ''}>${b}</option>`)}</select></div>
      <div class="sm:col-span-2"><label class="form-label" for="ct">Title</label><input id="ct" class="input" data-title value="${subject || ''}" placeholder="Summary of changes" /></div>
      <div class="sm:col-span-2"><label class="form-label" for="cd">Description</label><textarea id="cd" class="input h-auto py-2.5" rows="4" data-body></textarea></div>
      <div class="flex flex-wrap items-center gap-5 text-sm text-slate-700 sm:col-span-2">
        ${repo.github ? html`<label class="flex items-center gap-2"><input type="checkbox" class="form-check form-check-sm" data-plat="github" ${repo.primary === 'github' ? 'checked' : ''}/>${icon('github-logo', 'h-4 w-4 text-slate-500')}GitHub (PR)</label>` : ''}
        ${repo.gitlab ? html`<label class="flex items-center gap-2"><input type="checkbox" class="form-check form-check-sm" data-plat="gitlab" ${repo.primary === 'gitlab' ? 'checked' : ''}/>${icon('gitlab-logo', 'h-4 w-4 text-slate-500')}GitLab (MR)</label>` : ''}
        <label class="flex items-center gap-2"><input type="checkbox" class="form-check form-check-sm" data-draft />Create as draft</label>
      </div>
      <p class="hidden rounded-lg bg-danger-50 p-3 text-sm text-danger-700 sm:col-span-2" data-error></p></div>`);
    d.setFooter(html`<button type="button" class="btn-outline btn-md" data-dialog-close>Cancel</button><button type="button" class="btn-primary btn-md" data-create>${icon('git-pull-request')}Create</button>`);
  };
  const loadBranches = async (headName) => { const b = await call('repos:branches', { id: repo.id, head: headName }, { silent: true }); branches = b.ok ? b : { all: [] }; draw(b.subject); };
  await loadBranches('');
  d.el.addEventListener('change', async (e) => {
    if (e.target.matches('[data-repo]')) { repo = repoById(e.target.value); await loadBranches(''); }
    if (e.target.matches('[data-head]')) { const b = await call('repos:branches', { id: repo.id, head: e.target.value }, { silent: true }); if (b.subject) d.$('[data-title]').value = b.subject; }
  });
  d.el.addEventListener('click', async (e) => {
    const go = e.target.closest('[data-create]'); if (!go) return;
    const platforms = d.$$('[data-plat]').filter((c) => c.checked).map((c) => c.dataset.plat);
    const err = d.$('[data-error]');
    if (!platforms.length) { err.textContent = 'Select at least one platform.'; return err.classList.remove('hidden'); }
    await busy(go, async () => {
      const r = await call('pulls:create', { repoId: repo.id, platforms, head: d.$('[data-head]').value, base: d.$('[data-base]').value, title: d.$('[data-title]').value, body: d.$('[data-body]').value, draft: d.$('[data-draft]').checked, confirmed: true }, { silent: true });
      const msgs = (r.results || []).map((x) => `${platformName(x.platform)}: ${x.ok ? `#${x.number} created` : x.error}`);
      if (!r.ok) { err.innerHTML = esc(r.error || msgs.join(' | ')).replace(/\n/g, '<br>'); err.classList.remove('hidden'); if (!(r.results || []).some((x) => x.ok)) return; }
      d.close(true); notify(r.ok ? 'success' : 'warning', msgs.join(' · ') || 'Done.'); load();
    });
  });
}
