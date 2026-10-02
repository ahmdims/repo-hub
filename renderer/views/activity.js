// Aktivitas: jejak semua aksi yang pernah dijalankan aplikasi ini (push, merge, review, rilis, ...).
import { html, icon, badge, fmtTime, mount as setHtml } from '../lib/h.js';
import { dialog, confirmDialog, notify, call } from '../lib/ui.js';

export const title = 'Aktivitas';
let host = null, items = [];

const LABEL = { 'git.push': 'Push', 'git.mirror': 'Mirror', 'git.fetch': 'Fetch', 'pulls.merge': 'Merge', 'pulls.review': 'Review', 'pulls.comment': 'Komentar', 'pulls.close': 'Tutup PR/MR', 'pulls.create': 'Buat PR/MR', release: 'Rilis', 'repo.add': 'Tambah repo', 'repo.update': 'Ubah repo', 'repo.remove': 'Hapus repo' };

function render() {
  setHtml(host, html`
    <div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div class="min-w-0"><h2 class="font-display text-2xl font-bold text-slate-900 sm:text-3xl">Aktivitas</h2><p class="mt-1 text-sm text-slate-500">Jejak aksi yang dijalankan dari aplikasi ini (maks. 500 terakhir, disimpan lokal). Token dan kata sandi tidak pernah dicatat.</p></div>
      <div class="flex shrink-0 gap-2.5"><button type="button" class="btn-outline btn-md text-danger-600" data-clear ${items.length ? '' : 'disabled'}>${icon('trash')}Hapus riwayat</button></div>
    </div>
    ${items.length ? html`<div class="table-wrap" id="actTable" data-table data-page-size="15" data-item-label="aktivitas">
      <div class="table-toolbar"><div class="relative w-full sm:w-72">${icon('magnifying-glass', 'pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400')}<input type="search" class="input h-9 pl-9" placeholder="Cari aksi, repo, atau ringkasan..." data-table-search /></div></div>
      <div class="overflow-x-auto"><table class="table table-lg table-fit table-head-soft"><thead><tr>
        <th scope="col" class="table-col-num">No</th><th scope="col">Waktu</th><th scope="col">Aksi</th><th scope="col" data-sort="text">Repo</th><th scope="col">Ringkasan</th><th scope="col">Hasil</th><th scope="col" class="table-col-actions text-right">Detail</th>
      </tr></thead><tbody>${items.map((a, i) => html`<tr data-i="${i}">
        <td class="table-col-num" data-num>${i + 1}</td><td class="whitespace-nowrap text-sm text-slate-500">${fmtTime(a.time)}</td>
        <td>${badge('neutral', LABEL[a.action] || a.action)}</td><td class="text-sm font-medium text-slate-700">${a.repo || '—'}</td>
        <td class="max-w-[28rem] text-sm text-slate-600"><span class="line-clamp-2">${a.summary}</span></td>
        <td>${a.ok ? badge('success', 'Berhasil', 'check') : badge('danger', 'Gagal', 'x')}</td>
        <td class="table-col-actions"><div class="flex justify-end"><button type="button" class="btn-outline btn-sm max-xl:w-8 max-xl:px-0" data-detail ${a.detail ? '' : 'disabled'} title="Lihat detail" aria-label="Detail">${icon('eye')}</button></div></td></tr>`)}</tbody></table></div>
      <div class="table-empty" data-table-empty hidden>Tidak ada yang cocok.</div>
      <div class="table-footer"><span data-table-info></span><nav data-table-pages class="flex items-center gap-1" aria-label="Halaman"></nav></div>
    </div>` : html`<div class="card px-6 py-14 text-center"><span class="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-neutral-100 text-slate-400">${icon('clock-counter-clockwise', 'h-6 w-6')}</span><p class="mt-3 text-sm text-slate-500">Belum ada aktivitas. Push, merge, review, dan rilis akan tercatat di sini.</p></div>`}`);
  const t = host.querySelector('#actTable'); if (t) window.KKTable.init(t);
}

export async function mount(el) {
  host = el;
  host.addEventListener('click', async (e) => {
    const d = e.target.closest('[data-detail]');
    if (d) { const a = items[Number(d.closest('tr').dataset.i)]; return dialog({ title: `${LABEL[a.action] || a.action} · ${a.repo || ''}`, description: fmtTime(a.time), size: 'modal-lg', body: html`<p class="mb-3 text-sm text-slate-700">${a.summary}</p><pre class="hub-console" style="max-height:24rem;white-space:pre-wrap;word-break:break-word">${a.detail}</pre>`, footer: html`<button type="button" class="btn-primary btn-md" data-dialog-close>Tutup</button>` }); }
    if (e.target.closest('[data-clear]')) {
      const ok = await confirmDialog({ title: 'Hapus seluruh riwayat?', body: html`<p class="text-sm text-slate-600">Hanya log di aplikasi ini yang dihapus; repo tidak terpengaruh.</p>`, confirmLabel: 'Hapus riwayat', danger: true, iconName: 'trash' });
      if (ok) { await call('activity:clear', {}); items = []; render(); notify('success', 'Riwayat dihapus.'); }
    }
  });
  const r = await call('activity:list', { limit: 300 }, { silent: true });
  items = r.items || [];
  if (host === el) render();
}
export function unmount() { host = null; }
