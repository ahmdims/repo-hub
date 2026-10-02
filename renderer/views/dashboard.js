// Dasbor: status semua repo (branch, perubahan lokal, ahead/behind, kesamaan GitHub↔GitLab, PR/MR)
// + push dan sinkron mirror ke banyak repo sekaligus.
import { html, esc, icon, badge, mount as setHtml } from '../lib/h.js';
import { dialog, notify, call, busy } from '../lib/ui.js';
import { state, bus, summary, refreshAll, repoById } from '../state.js';
import { openAddMenu } from './repos.js';

// Plural helper (local): plural(2, 'repo') -> "2 repos"; plural(1, 'repo') -> "1 repo"
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export const title = 'Dashboard';
let offs = [];
let selected = new Set();
let root = null, host = null;

/* ------------------------------------------------------------------ sel-sel tabel */
function branchCell(r, s) {
  if (!s) return html`<span class="text-xs text-slate-400">${state.loading.has(r.id) ? 'Loading…' : '—'}</span>`;
  if (!s.ok) return badge('danger', 'Error', 'warning-circle');
  return html`<div class="flex flex-wrap items-center gap-1.5"><span class="inline-flex items-center gap-1 font-mono text-xs font-medium text-slate-800">${icon('git-branch', 'h-3.5 w-3.5 text-slate-400')}${s.branch || 'HEAD (detached)'}</span>${s.dirty ? html`<span title="${s.staged} staged · ${s.changed} modified · ${s.untracked} untracked · ${plural(s.conflicts, 'conflict')}">${badge('warning', plural(s.staged + s.changed + s.untracked + s.conflicts, 'change'))}</span>` : ''}</div>${s.last ? html`<p class="mt-0.5 hidden max-w-[14rem] truncate text-xs text-slate-400 2xl:block" title="${s.last.subject}">${s.last.hash} · ${s.last.subject}</p>` : ''}`;
}

function posCell(s) {
  if (!s || !s.ok) return html`<span class="text-xs text-slate-400">—</span>`;
  if (s.ahead == null) return badge('neutral', 'No upstream');
  if (!s.ahead && !s.behind) return badge('success', 'In sync', 'check');
  return html`<div class="flex flex-wrap gap-1">${s.ahead ? badge('primary', `${s.ahead} to push`, 'arrow-up') : ''}${s.behind ? badge('warning', `${s.behind} behind`, 'arrow-down') : ''}</div>`;
}

function mirrorCell(r) {
  if (!r.github || !r.gitlab) return html`<span class="text-xs text-slate-400" title="This repo has only one platform">—</span>`;
  const p = state.parity[r.id];
  if (!p) return html`<span class="text-xs text-slate-400">${state.loading.has(r.id) ? 'Checking…' : '—'}</span>`;
  if (!p.ok) return html`<span title="${p.error}">${badge('danger', 'Check failed', 'warning-circle')}</span>`;
  if (p.identical) return html`<span title="${plural(p.counts.github, 'ref')} on both GitHub and GitLab">${badge('success', 'Identical', 'check-circle')}</span>`;
  const n = p.onlyGithub.length + p.onlyGitlab.length + p.different.length;
  const tip = [p.onlyGithub.length && `${p.onlyGithub.length} only on GitHub`, p.onlyGitlab.length && `${p.onlyGitlab.length} only on GitLab`, p.different.length && `${p.different.length} on different commits`].filter(Boolean).join(' · ');
  return html`<span title="${tip}">${badge('warning', plural(n, 'differing ref'), 'warning')}</span>`;
}

function prCell(r) {
  const c = state.pulls[r.id];
  if (!c) return html`<span class="text-xs text-slate-400">${state.loading.has(r.id) ? 'Loading…' : '—'}</span>`;
  const parts = [];
  if (r.github) parts.push(`GH ${c.github}`);
  if (r.gitlab) parts.push(`GL ${c.gitlab}`);
  const title = c.errors && c.errors.length ? c.errors.join(' | ') : '';
  return html`<a href="#/pull-request" class="whitespace-nowrap text-sm font-medium ${c.github + c.gitlab ? 'text-primary-600' : 'text-slate-500'} hover:underline" title="${title}">${parts.join(' · ')}${title ? ' ⚠' : ''}</a>`;
}

function rowHtml(r, i) {
  const s = state.status[r.id];
  const loading = state.loading.has(r.id);
  return html`<tr data-id="${r.id}" class="${loading ? 'repo-row-loading' : ''}">
    <td class="table-col-check"><input type="checkbox" class="form-check form-check-sm" data-table-select aria-label="Select ${r.name}" ${selected.has(r.id) ? 'checked' : ''} /></td>
    <td class="table-col-num" data-num>${i + 1}</td>
    <td><span class="block font-medium text-slate-800">${r.name}</span><p class="mt-0.5 max-w-[14rem] truncate text-xs text-slate-400" title="${r.path}">${r.path}</p>
      <div class="mt-1 flex gap-1.5 text-slate-400">${r.github ? html`<span title="GitHub: ${r.github.repo}">${icon('github-logo', 'h-3.5 w-3.5')}</span>` : ''}${r.gitlab ? html`<span title="GitLab: ${r.gitlab.path}">${icon('gitlab-logo', 'h-3.5 w-3.5')}</span>` : ''}</div></td>
    <td>${branchCell(r, s)}</td>
    <td>${posCell(s)}</td>
    <td>${mirrorCell(r)}</td>
    <td>${prCell(r)}</td>
    <td class="table-col-actions"><div class="flex items-center justify-end gap-1.5">
      <button type="button" class="btn-outline btn-sm whitespace-nowrap" data-act="push" title="Push to GitHub + GitLab">${icon('upload-simple')}<span class="hidden xl:inline">Push</span></button>
      <button type="button" class="btn-outline btn-sm whitespace-nowrap max-2xl:w-8 max-2xl:px-0" data-act="mirror" title="Mirror GitHub to GitLab" aria-label="Sync ${r.name}" ${r.github && r.gitlab ? '' : 'disabled'}>${icon('arrows-clockwise')}<span class="hidden 2xl:inline">Sync</span></button>
      <button type="button" class="btn-outline btn-sm w-8 px-0" data-act="folder" title="Open folder" aria-label="Open folder ${r.name}">${icon('folder-open')}</button>
    </div></td>
  </tr>`;
}

/* ------------------------------------------------------------------ KPI */
function kpiHtml() {
  const k = summary();
  const card = (iconName, tone, value, label, hint) => html`<div class="card p-5"><div class="flex items-center justify-between"><span class="flex h-10 w-10 items-center justify-center rounded-xl ${tone}">${icon(iconName, 'h-5 w-5')}</span>${hint ? badge(hint.kind, hint.text) : ''}</div><p class="mt-4 font-display text-2xl font-bold text-slate-900">${value}</p><p class="text-sm text-slate-500">${label}</p></div>`;
  return html`<div class="grid grid-cols-2 gap-5 md:grid-cols-3 xl:grid-cols-5">
    ${card('folders', 'bg-primary-50 text-primary-600', k.repos, 'Managed repos')}
    ${card('upload-simple', 'bg-info-50 text-info-600', k.needPush, 'Needs push', k.needPush ? { kind: 'primary', text: 'new commits' } : null)}
    ${card('pencil-simple', 'bg-warning-50 text-warning-600', k.dirty, 'Local changes', k.dirty ? { kind: 'warning', text: 'uncommitted' } : null)}
    ${card('git-pull-request', 'bg-secondary-50 text-secondary-600', k.prs == null ? '…' : k.prs, 'Open PRs/MRs')}
    ${card('arrows-clockwise', 'bg-success-50 text-success-600', k.parityDiff, 'Mirrors out of sync', k.parityDiff ? { kind: 'warning', text: 'needs sync' } : null)}
  </div>`;
}

/* ------------------------------------------------------------------ render */
function shell() {
  if (!state.repos.length) {
    return html`
      <div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"><div><h2 class="font-display text-2xl font-bold text-slate-900 sm:text-3xl">Dashboard</h2><p class="mt-1 text-sm text-slate-500">One screen for all your repos: push, GitHub↔GitLab sync, PRs/MRs and releases.</p></div></div>
      <div class="card flex flex-col items-center px-6 py-16 text-center">
        <span class="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary-50 text-primary-600">${icon('folders', 'h-7 w-7')}</span>
        <h3 class="mt-4 text-lg font-semibold text-slate-800">No repos yet</h3>
        <p class="mt-1 max-w-md text-sm text-slate-500">Add a git repo folder from your computer. GitHub and GitLab remotes are detected automatically from your git config, and you can change them at any time.</p>
        <div class="mt-6 flex flex-wrap justify-center gap-3"><button type="button" class="btn-primary btn-md" data-add="folder">${icon('folder-open')}Choose repo folder</button><button type="button" class="btn-outline btn-md" data-add="scan">${icon('magnifying-glass')}Scan parent folder</button></div>
      </div>`;
  }
  return html`
    <div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div class="min-w-0"><h2 class="font-display text-2xl font-bold text-slate-900 sm:text-3xl">Dashboard</h2><p class="mt-1 text-sm text-slate-500">Select several repos, then push or sync them all at once. This app never force-pushes or deletes branches.</p></div>
      <div class="flex shrink-0 gap-2.5"><button type="button" class="btn-primary btn-md" data-add="menu">${icon('plus')}Add repo</button></div>
    </div>
    <div id="dashKpi">${kpiHtml()}</div>
    <div class="table-wrap overflow-visible" id="repoTable" data-table data-item-label="repos">
      <div class="table-toolbar">
        <div class="relative w-full sm:w-72">${icon('magnifying-glass', 'pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400')}<input type="search" class="input h-9 pl-9" placeholder="Search by repo or folder name..." data-table-search /></div>
        <div class="ml-auto flex items-center gap-2 text-xs text-slate-400" id="dashLast"></div>
      </div>
      <div class="table-bulk" data-table-bulk hidden>
        <span><b data-table-selected-count>0</b> selected</span>
        <div class="ml-auto flex flex-wrap gap-2">
          <button type="button" class="btn-outline btn-sm" data-bulk="fetch">${icon('arrows-clockwise', 'h-3.5 w-3.5')}Fetch</button>
          <button type="button" class="btn-outline btn-sm" data-bulk="mirror">${icon('git-merge', 'h-3.5 w-3.5')}Sync GitLab</button>
          <button type="button" class="btn-primary btn-sm" data-bulk="push">${icon('upload-simple', 'h-3.5 w-3.5')}Push selected</button>
        </div>
      </div>
      <div class="overflow-x-auto">
        <table class="table table-lg table-fit table-head-soft">
          <thead><tr>
            <th scope="col" class="table-col-check"><input type="checkbox" class="form-check form-check-sm" data-table-select-all aria-label="Select all repos" /></th>
            <th scope="col" class="table-col-num">#</th>
            <th scope="col" data-sort="text">Repository</th>
            <th scope="col">Branch</th>
            <th scope="col">Upstream</th>
            <th scope="col">GitHub ↔ GitLab</th>
            <th scope="col">PR/MR</th>
            <th scope="col" class="table-col-actions text-right">Actions</th>
          </tr></thead>
          <tbody id="repoBody"></tbody>
        </table>
      </div>
      <div class="table-empty" data-table-empty hidden>No matching repos.</div>
      <div class="table-footer"><span data-table-info></span><nav data-table-pages class="flex items-center gap-1" aria-label="Pagination"></nav></div>
    </div>`;
}

function paintRows() {
  const body = host.querySelector('#repoBody');
  if (!body) return;
  setHtml(body, state.repos.map((r, i) => rowHtml(r, i)));
  const table = window.KKTable && window.KKTable.get(root);
  if (table) table.render();
  const k = host.querySelector('#dashKpi'); if (k) setHtml(k, kpiHtml());
  const last = host.querySelector('#dashLast');
  if (last) last.textContent = state.loadingAll ? 'Refreshing…' : state.lastRefresh ? `Updated ${new Date(state.lastRefresh).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}` : '';
}

export function mount(el) {
  host = el; selected = new Set([...selected].filter((id) => repoById(id)));
  host.innerHTML = shell().s;
  root = host.querySelector('#repoTable');
  if (root) {
    window.KKTable.init(root);
    root.addEventListener('change', (e) => { if (e.target.matches('[data-table-select], [data-table-select-all]')) syncSelection(); });
    root.addEventListener('click', onClick);
    paintRows();
  }
  host.addEventListener('click', onAdd);
  offs = [bus.on('status', () => { if (host && root) paintRows(); })];
}

export function unmount() { offs.forEach((f) => f()); offs = []; host = null; root = null; }

function onAdd(e) {
  const a = e.target.closest('[data-add]');
  if (a) openAddMenu(a.dataset.add);
}

// pilihan dibaca dari DOM (table.js mencentang baris saat "pilih semua" tanpa memicu change per baris)
function syncSelection() {
  selected = new Set([...root.querySelectorAll('#repoBody tr[data-id]')].filter((r) => r.querySelector('[data-table-select]').checked).map((r) => r.dataset.id));
}

async function onClick(e) {
  const bulk = e.target.closest('[data-bulk]');
  if (bulk) {
    syncSelection();
    const ids = [...selected];
    if (!ids.length) return;
    if (bulk.dataset.bulk === 'push') return pushRepos(ids);
    if (bulk.dataset.bulk === 'mirror') return mirrorRepos(ids);
    return busy(bulk, async () => { await refreshAll({ fetch: true, ids }); notify('success', `Fetch finished for ${plural(ids.length, 'repo')}.`); });
  }
  const act = e.target.closest('[data-act]');
  if (!act) return;
  const id = act.closest('tr').dataset.id;
  if (act.dataset.act === 'push') return pushRepos([id]);
  if (act.dataset.act === 'mirror') return mirrorRepos([id]);
  if (act.dataset.act === 'folder') return call('shell:openFolder', { id });
}

/* ------------------------------------------------------------------ push */
export async function pushRepos(ids) {
  const repos = ids.map(repoById).filter(Boolean);
  const items = repos.map((r) => ({ r, s: state.status[r.id] || {} }));
  const card = ({ r, s }) => {
    const warns = [];
    if (!s.ok) warns.push(['danger', `Repo status could not be read${s.error ? `: ${s.error}` : ''}. Refresh first.`]);
    else if (!s.branch) warns.push(['danger', 'HEAD is detached; switch to a branch first.']);
    if (s.ok && s.branch && r.warnBranches.includes(s.branch)) warns.push(['danger', `Branch "${s.branch}" is flagged as dangerous: pushing to it may trigger a publish or release.`]);
    if (s.ok && s.behind > 0) warns.push(['warning', `Behind the remote by ${plural(s.behind, 'commit')}; the push may be rejected (non-fast-forward). Pull or rebase first.`]);
    if (s.ok && s.dirty) warns.push(['warning', `${plural(s.staged + s.changed + s.untracked, 'uncommitted change')} will not be pushed.`]);
    if (s.ok && s.ahead === 0) warns.push(['info', 'No new commits ahead of upstream; pushing is still safe (it only syncs the other remote).']);
    const blocked = !s.ok || !s.branch;
    return html`<div class="rounded-xl border border-border p-3.5" data-push="${r.id}">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="min-w-0"><p class="font-medium text-slate-800">${r.name}</p><p class="text-xs text-slate-500">branch <span class="kbd-ref">${s.branch || '—'}</span>${s.ahead ? ` · ${plural(s.ahead, 'commit')} will be pushed` : ''}</p></div>
        <div class="flex items-center gap-4 text-sm">
          ${r.github ? html`<label class="flex items-center gap-2"><input type="checkbox" class="form-check form-check-sm" data-target="github" checked ${blocked ? 'disabled' : ''}/>${icon('github-logo', 'h-4 w-4 text-slate-500')}GitHub</label>` : ''}
          ${r.gitlab ? html`<label class="flex items-center gap-2"><input type="checkbox" class="form-check form-check-sm" data-target="gitlab" checked ${blocked ? 'disabled' : ''}/>${icon('gitlab-logo', 'h-4 w-4 text-slate-500')}GitLab</label>` : ''}
        </div>
      </div>
      ${warns.length ? html`<ul class="mt-2.5 space-y-1.5">${warns.map(([k, t]) => html`<li class="flex items-start gap-2 text-xs ${k === 'danger' ? 'text-danger-700' : k === 'warning' ? 'text-warning-700' : 'text-slate-500'}">${icon(k === 'info' ? 'info' : 'warning', 'mt-0.5 h-3.5 w-3.5 shrink-0')}<span>${t}</span></li>`)}</ul>` : ''}
      <div class="mt-2.5 hidden space-y-1 text-xs" data-result></div>
    </div>`;
  };
  const d = dialog({
    title: items.length === 1 ? `Push ${items[0].r.name}` : `Push ${plural(items.length, 'repo')}`,
    description: 'The current branch of each repo is pushed to the checked targets as-is (no force).',
    size: 'modal-xl',
    body: html`<div class="space-y-3">${items.map(card)}</div>`,
    footer: html`<button type="button" class="btn-outline btn-md" data-dialog-close>Cancel</button><button type="button" class="btn-primary btn-md" data-run>${icon('upload-simple')}Push now</button>`,
  });
  d.$('[data-run]').addEventListener('click', async () => {
    const run = d.$('[data-run]'); run.disabled = true; d.lock(true);
    run.innerHTML = `${icon('circle-notch', 'h-4 w-4 animate-spin').s}Pushing…`;
    let okAll = true, count = 0;
    for (const { r, s } of items) {
      const box = d.$(`[data-push="${r.id}"]`);
      const targets = [...box.querySelectorAll('[data-target]')].filter((c) => c.checked && !c.disabled).map((c) => c.dataset.target);
      const out = box.querySelector('[data-result]'); out.classList.remove('hidden');
      if (!targets.length || !s.ok || !s.branch) { out.innerHTML = '<p class="text-slate-500">Skipped.</p>'; continue; }
      out.innerHTML = '<p class="text-slate-500">Pushing…</p>';
      const res = await call('git:push', { repoId: r.id, branch: s.branch, targets, confirmed: true }, { silent: true });
      const lines = (res.results || []).map((x) => `<p class="${x.ok ? 'text-success-700' : 'text-danger-700'}">${x.ok ? '✓' : '✕'} ${esc(x.platform === 'github' ? 'GitHub' : 'GitLab')}: ${esc(x.ok ? (x.upToDate ? 'up to date' : (x.summary || 'pushed')) : (x.error || 'failed'))}</p>`);
      out.innerHTML = lines.join('') || `<p class="text-danger-700">✕ ${esc(res.error || 'Failed')}</p>`;
      if (res.ok) count++; else okAll = false;
    }
    d.lock(false);
    d.setFooter(html`<button type="button" class="btn-primary btn-md" data-dialog-close>Done</button>`);
    notify(okAll ? 'success' : 'warning', okAll ? `Push finished for ${plural(count, 'repo')}.` : 'Push finished with some failures. See the dialog for details.');
    refreshAll({ fetch: false, ids: items.map((x) => x.r.id) });
  });
}

/* ------------------------------------------------------------------ mirror */
function planHtml(p) {
  if (!p.ok) return html`<p class="text-sm text-danger-700">✕ ${p.error}</p>`;
  if (p.upToDate) return html`<p class="text-sm text-success-700">✓ Already identical; nothing to copy.</p>`;
  const by = (k) => p.plan.filter((x) => x.kind === k).map((x) => x.ref.replace(/^refs\/(heads|tags)\//, ''));
  // 'kind' values come from main/git.js (mirror plan) and stay as keys; the English display labels are [singular, plural]
  const groups = [['new branch', 'new branches', by('branch baru')], ['fast-forward', 'fast-forwards', by('fast-forward')], ['new tag', 'new tags', by('tag baru')]].filter(([, , v]) => v.length);
  return html`<div class="space-y-1.5 text-sm">
    ${groups.map(([one, many, v]) => html`<p><span class="font-medium text-slate-700">${plural(v.length, one, many)}:</span> <span class="text-slate-500">${v.slice(0, 6).join(', ')}${v.length > 6 ? ` +${v.length - 6} more` : ''}</span></p>`)}
    ${p.skipped.length ? html`<div class="rounded-lg bg-warning-50 p-2.5 text-xs text-warning-800"><p class="font-medium">${p.skipped.length} skipped (not forced):</p>${p.skipped.map((s) => html`<p>• ${s.ref.replace(/^refs\/(heads|tags)\//, '')}: ${s.reason}</p>`)}</div>` : ''}
  </div>`;
}

export async function mirrorRepos(ids) {
  const repos = ids.map(repoById).filter((r) => r && r.github && r.gitlab);
  if (!repos.length) return notify('warning', 'Select repos that have both GitHub and GitLab.');
  const d = dialog({ title: repos.length === 1 ? `Sync ${repos[0].name}` : `Sync ${plural(repos.length, 'repo')}`, description: 'GitLab is mirrored from GitHub: new refs are created and branches only fast-forward. Nothing is forced or deleted.', size: 'modal-xl', body: html`<p class="text-sm text-slate-500">Checking plan…</p>`, footer: html`<button type="button" class="btn-outline btn-md" data-dialog-close>Cancel</button><button type="button" class="btn-primary btn-md" data-run disabled>${icon('git-merge')}Sync now</button>` });
  const plans = [];
  for (const r of repos) plans.push([r, await call('git:mirror', { repoId: r.id, from: 'github', dryRun: true }, { silent: true })]);
  d.setBody(html`<div class="space-y-3">${plans.map(([r, p]) => html`<div class="rounded-xl border border-border p-3.5" data-mirror="${r.id}"><p class="mb-2 font-medium text-slate-800">${r.name}</p><div data-plan>${planHtml(p)}</div></div>`)}</div>`);
  const work = plans.filter(([, p]) => p.ok && p.plan && p.plan.length);
  const run = d.$('[data-run]');
  run.disabled = !work.length;
  if (!work.length) { d.setFooter(html`<button type="button" class="btn-primary btn-md" data-dialog-close>Close</button>`); return; }
  run.addEventListener('click', async () => {
    run.disabled = true; d.lock(true); run.innerHTML = `${icon('circle-notch', 'h-4 w-4 animate-spin').s}Copying…`;
    let okAll = true;
    for (const [r] of work) {
      const out = d.$(`[data-mirror="${r.id}"] [data-plan]`);
      const res = await call('git:mirror', { repoId: r.id, from: 'github', confirmed: true }, { silent: true });
      okAll = okAll && !!res.ok;
      out.innerHTML = res.ok ? `<p class="text-success-700">✓ ${plural(res.pushed.length, 'ref')} copied${res.skipped.length ? `, ${res.skipped.length} skipped` : ''}.</p>` : `<p class="text-danger-700">✕ ${esc(res.error || (res.failed || []).map((f) => f.note).join('; ') || 'Failed')}</p>`;
    }
    d.lock(false);
    d.setFooter(html`<button type="button" class="btn-primary btn-md" data-dialog-close>Done</button>`);
    notify(okAll ? 'success' : 'warning', okAll ? 'GitLab now mirrors GitHub.' : 'Sync finished with some problems.');
    refreshAll({ fetch: false, ids: work.map(([r]) => r.id) });
  });
}
