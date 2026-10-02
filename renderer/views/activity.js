// Aktivitas: jejak semua aksi yang pernah dijalankan aplikasi ini (push, merge, review, rilis, ...).
import { html, icon, badge, fmtTime, mount as setHtml } from '../lib/h.js';
import { dialog, confirmDialog, notify, call } from '../lib/ui.js';

export const title = 'Activity';
let host = null, items = [];

const LABEL = { 'git.push': 'Push', 'git.mirror': 'Mirror', 'git.fetch': 'Fetch', 'pulls.merge': 'Merge', 'pulls.review': 'Review', 'pulls.comment': 'Comment', 'pulls.close': 'Close PR/MR', 'pulls.create': 'Create PR/MR', release: 'Release', 'repo.add': 'Add repo', 'repo.update': 'Edit repo', 'repo.remove': 'Remove repo' };

function render() {
  setHtml(host, html`
    <div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div class="min-w-0"><h2 class="font-display text-2xl font-bold text-slate-900 sm:text-3xl">Activity</h2><p class="mt-1 text-sm text-slate-500">A trail of actions run from this app (last 500 at most, stored locally). Tokens and passwords are never logged.</p></div>
      <div class="flex shrink-0 gap-2.5"><button type="button" class="btn-outline btn-md text-danger-600" data-clear ${items.length ? '' : 'disabled'}>${icon('trash')}Clear history</button></div>
    </div>
    ${items.length ? html`<div class="table-wrap" id="actTable" data-table data-page-size="15" data-item-label="activities">
      <div class="table-toolbar"><div class="relative w-full sm:w-72">${icon('magnifying-glass', 'pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400')}<input type="search" class="input h-9 pl-9" placeholder="Search action, repo, or summary..." data-table-search /></div></div>
      <div class="overflow-x-auto"><table class="table table-lg table-fit table-head-soft"><thead><tr>
        <th scope="col" class="table-col-num">#</th><th scope="col">Time</th><th scope="col">Action</th><th scope="col" data-sort="text">Repo</th><th scope="col">Summary</th><th scope="col">Result</th><th scope="col" class="table-col-actions text-right">Details</th>
      </tr></thead><tbody>${items.map((a, i) => html`<tr data-i="${i}">
        <td class="table-col-num" data-num>${i + 1}</td><td class="whitespace-nowrap text-sm text-slate-500">${fmtTime(a.time)}</td>
        <td>${badge('neutral', LABEL[a.action] || a.action)}</td><td class="text-sm font-medium text-slate-700">${a.repo || '—'}</td>
        <td class="max-w-[28rem] text-sm text-slate-600"><span class="line-clamp-2">${a.summary}</span></td>
        <td>${a.ok ? badge('success', 'Success', 'check') : badge('danger', 'Failed', 'x')}</td>
        <td class="table-col-actions"><div class="flex justify-end"><button type="button" class="btn-outline btn-sm max-xl:w-8 max-xl:px-0" data-detail ${a.detail ? '' : 'disabled'} title="View details" aria-label="Details">${icon('eye')}</button></div></td></tr>`)}</tbody></table></div>
      <div class="table-empty" data-table-empty hidden>No matches.</div>
      <div class="table-footer"><span data-table-info></span><nav data-table-pages class="flex items-center gap-1" aria-label="Pagination"></nav></div>
    </div>` : html`<div class="card px-6 py-14 text-center"><span class="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-neutral-100 text-slate-400">${icon('clock-counter-clockwise', 'h-6 w-6')}</span><p class="mt-3 text-sm text-slate-500">No activity yet. Pushes, merges, reviews, and releases will be logged here.</p></div>`}`);
  const t = host.querySelector('#actTable'); if (t) window.KKTable.init(t);
}

export async function mount(el) {
  host = el;
  host.addEventListener('click', async (e) => {
    const d = e.target.closest('[data-detail]');
    if (d) { const a = items[Number(d.closest('tr').dataset.i)]; return dialog({ title: `${LABEL[a.action] || a.action} · ${a.repo || ''}`, description: fmtTime(a.time), size: 'modal-lg', body: html`<p class="mb-3 text-sm text-slate-700">${a.summary}</p><pre class="hub-console" style="max-height:24rem;white-space:pre-wrap;word-break:break-word">${a.detail}</pre>`, footer: html`<button type="button" class="btn-primary btn-md" data-dialog-close>Close</button>` }); }
    if (e.target.closest('[data-clear]')) {
      const ok = await confirmDialog({ title: 'Clear all history?', body: html`<p class="text-sm text-slate-600">Only the log in this app is cleared; your repos are not affected.</p>`, confirmLabel: 'Clear history', danger: true, iconName: 'trash' });
      if (ok) { await call('activity:clear', {}); items = []; render(); notify('success', 'History cleared.'); }
    }
  });
  const r = await call('activity:list', { limit: 300 }, { silent: true });
  items = r.items || [];
  if (host === el) render();
}
export function unmount() { host = null; }
