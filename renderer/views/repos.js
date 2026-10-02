// Repositori: daftar repo yang dikelola + tambah (dari folder / pindai folder induk), ubah, uji koneksi, hapus.
import { html, esc, icon, badge, mount as setHtml } from '../lib/h.js';
import { dialog, confirmDialog, notify, call, busy } from '../lib/ui.js';
import { state, bus, loadRepos, refreshAll, repoById } from '../state.js';

export const title = 'Repositori';
let host = null, offs = [];

const stepsText = (r) => r.flow.steps.map((s) => `${s.from === '$BRANCH' ? 'branch rilis' : s.from} → ${s.to}`).join('  ›  ');

function render() {
  if (!host) return;
  setHtml(host, html`
    <div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div class="min-w-0"><h2 class="font-display text-2xl font-bold text-slate-900 sm:text-3xl">Repositori</h2><p class="mt-1 text-sm text-slate-500">Daftar repo yang dikelola. Tambah sebanyak yang Anda mau; tiap repo punya pasangan GitHub/GitLab dan alur rilisnya sendiri.</p></div>
      <div class="flex shrink-0 flex-wrap gap-2.5"><button type="button" class="btn-outline btn-md" data-add="scan">${icon('magnifying-glass')}Pindai folder induk</button><button type="button" class="btn-primary btn-md" data-add="folder">${icon('plus')}Tambah dari folder</button></div>
    </div>
    ${state.repos.length ? html`
    <div class="table-wrap">
      <div class="overflow-x-auto"><table class="table table-lg table-fit table-head-soft"><thead><tr>
        <th scope="col" class="table-col-num">No</th><th scope="col">Repositori</th><th scope="col">GitHub</th><th scope="col">GitLab</th><th scope="col">Alur rilis</th><th scope="col" class="table-col-actions text-right">Aksi</th>
      </tr></thead><tbody>${state.repos.map((r, i) => html`<tr data-id="${r.id}">
        <td class="table-col-num">${i + 1}</td>
        <td><span class="block font-medium text-slate-800">${r.name}</span><p class="mt-0.5 max-w-[15rem] truncate text-xs text-slate-400" title="${r.path}">${r.path}</p></td>
        <td>${r.github ? html`<span class="inline-flex items-center gap-1.5 text-sm text-slate-700">${icon('github-logo', 'h-4 w-4 text-slate-400')}${r.github.repo}</span>` : html`<span class="text-xs text-slate-400">—</span>`}</td>
        <td>${r.gitlab ? html`<span class="inline-flex items-center gap-1.5 text-sm text-slate-700">${icon('gitlab-logo', 'h-4 w-4 text-slate-400')}${r.gitlab.path}</span><p class="text-xs text-slate-400">${r.gitlab.baseUrl.replace(/^https?:\/\//, '')}</p>` : html`<span class="text-xs text-slate-400">—</span>`}</td>
        <td class="max-w-[14rem]"><p class="truncate text-xs text-slate-600" title="${stepsText(r)}">${stepsText(r)}</p><p class="mt-0.5 text-xs text-slate-400">${r.flow.method}${r.flow.mirror ? ' · mirror' : ''}${r.flow.waitChecks ? ' · tunggu check' : ''}</p></td>
        <td class="table-col-actions"><div class="flex items-center justify-end gap-1.5">
          <button type="button" class="btn-outline btn-sm max-2xl:w-8 max-2xl:px-0" data-act="test" title="Uji koneksi GitHub/GitLab" aria-label="Uji koneksi ${r.name}">${icon('plug')}<span class="hidden 2xl:inline">Uji</span></button>
          <button type="button" class="btn-outline btn-sm max-2xl:w-8 max-2xl:px-0" data-act="edit" title="Ubah pengaturan" aria-label="Ubah ${r.name}">${icon('pencil-simple')}<span class="hidden 2xl:inline">Ubah</span></button>
          <button type="button" class="btn-outline btn-sm w-8 px-0 text-danger-600" data-act="remove" title="Hapus dari daftar" aria-label="Hapus ${r.name} dari daftar">${icon('trash')}</button>
        </div></td></tr>`)}</tbody></table></div>
    </div>` : html`<div class="card px-6 py-14 text-center"><p class="text-sm text-slate-500">Belum ada repo. Tambahkan folder repo git untuk mulai.</p></div>`}`);
}

export function mount(el) {
  host = el; render();
  host.addEventListener('click', onClick);
  offs = [];
}
export function unmount() { offs.forEach((f) => f()); offs = []; host = null; }

async function onClick(e) {
  const add = e.target.closest('[data-add]');
  if (add) return openAddMenu(add.dataset.add);
  const act = e.target.closest('[data-act]');
  if (!act) return;
  const id = act.closest('tr').dataset.id;
  const r = repoById(id);
  if (act.dataset.act === 'edit') return openRepoForm({ repo: r });
  if (act.dataset.act === 'remove') {
    const ok = await confirmDialog({ title: `Hapus "${r.name}" dari daftar?`, body: html`<p class="text-sm text-slate-600">Hanya entri di aplikasi ini yang dihapus. <b>Folder, riwayat git, dan repo di GitHub/GitLab tidak disentuh.</b></p>`, confirmLabel: 'Hapus dari daftar', danger: true, iconName: 'trash' });
    if (!ok) return;
    const res = await call('repos:remove', { id });
    if (res.ok) { notify('success', `"${r.name}" dihapus dari daftar.`); await loadRepos(); }
    return;
  }
  if (act.dataset.act === 'test') return busy(act, async () => {
    const t = await call('repos:test', { id });
    if (!t.ok) return;
    const row = (name, x, extra) => html`<div class="flex items-start gap-3 rounded-xl border border-border p-3.5">${icon(x && x.ok ? 'check-circle' : 'warning-circle', `mt-0.5 h-5 w-5 shrink-0 ${x && x.ok ? 'text-success-600' : 'text-danger-600'}`)}<div class="min-w-0"><p class="font-medium text-slate-800">${name}</p><p class="text-sm ${x && x.ok ? 'text-slate-500' : 'text-danger-700'}">${x ? (x.ok ? extra : x.error) : 'Tidak dikonfigurasi'}</p></div></div>`;
    dialog({ title: `Uji koneksi · ${r.name}`, size: 'modal-md', body: html`<div class="space-y-3">
      ${row('Folder lokal', { ok: t.folder, error: 'Folder tidak ditemukan.' }, r.path)}
      ${r.github ? row('GitHub', t.github, `Akses: ${t.github && t.github.permission}${t.github && t.github.isPrivate ? ' · privat' : ''} · default: ${t.github && t.github.defaultBranch}`) : ''}
      ${r.gitlab ? row('GitLab', t.gitlab, `Level akses: ${t.gitlab && t.gitlab.accessLevel} · default: ${t.gitlab && t.gitlab.defaultBranch} · ${t.gitlab && t.gitlab.visibility}`) : ''}</div>`, footer: html`<button type="button" class="btn-primary btn-md" data-dialog-close>Tutup</button>` });
  });
}

/* ------------------------------------------------------------------ tambah */
export function openAddMenu(kind) {
  if (kind === 'folder') return addFromFolder();
  if (kind === 'scan') return scanParent();
  const d = dialog({ title: 'Tambah repo', size: 'modal-md', body: html`<div class="grid gap-3">
    <button type="button" class="flex items-start gap-3 rounded-xl border border-border p-4 text-left transition-colors hover:border-primary-300 hover:bg-primary-50/40" data-pick="folder"><span class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary-50 text-primary-600">${icon('folder-open', 'h-5 w-5')}</span><span><span class="block font-medium text-slate-800">Dari satu folder</span><span class="text-sm text-slate-500">Pilih folder repo git; remote dikenali otomatis.</span></span></button>
    <button type="button" class="flex items-start gap-3 rounded-xl border border-border p-4 text-left transition-colors hover:border-primary-300 hover:bg-primary-50/40" data-pick="scan"><span class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-info-50 text-info-600">${icon('magnifying-glass', 'h-5 w-5')}</span><span><span class="block font-medium text-slate-800">Pindai folder induk</span><span class="text-sm text-slate-500">Temukan semua repo di dalam satu folder lalu tambahkan sekaligus.</span></span></button></div>` });
  d.el.addEventListener('click', (e) => { const p = e.target.closest('[data-pick]'); if (p) { d.close(undefined); openAddMenu(p.dataset.pick); } });
}

async function pickFolder(title) { const r = await call('dialog:pickFolder', { title }, { silent: true }); return r.ok ? r.path : null; }

async function addFromFolder() {
  const p = await pickFolder('Pilih folder repo git');
  if (!p) return;
  const d = await call('repos:detect', { path: p });
  if (!d.ok) return;
  if (d.alreadyAdded) return notify('warning', 'Folder ini sudah ada di daftar.');
  openRepoForm({ suggest: d.suggest });
}

async function scanParent() {
  const p = await pickFolder('Pilih folder induk yang berisi banyak repo');
  if (!p) return;
  const res = await call('repos:scan', { folder: p });
  if (!res.ok) return;
  if (!res.repos.length) return notify('warning', 'Tidak ada repo git langsung di dalam folder itu.');
  const d = dialog({ title: `Ditemukan ${res.repos.length} repo`, description: p, size: 'modal-lg',
    body: html`<div class="space-y-2">${res.repos.map((r, i) => html`<label class="flex items-center gap-3 rounded-xl border border-border p-3 ${r.alreadyAdded ? 'opacity-60' : ''}"><input type="checkbox" class="form-check form-check-sm" data-i="${i}" ${r.alreadyAdded || (!r.github && !r.gitlab) ? 'disabled' : 'checked'} /><span class="min-w-0 flex-1"><span class="block font-medium text-slate-800">${r.name}</span><span class="block truncate text-xs text-slate-400">${r.path}</span></span><span class="flex shrink-0 gap-1.5">${r.github ? badge('neutral', 'GitHub', 'github-logo') : ''}${r.gitlab ? badge('neutral', 'GitLab', 'gitlab-logo') : ''}${r.alreadyAdded ? badge('success', 'Sudah ada') : !r.github && !r.gitlab ? badge('warning', 'Tanpa remote') : ''}</span></label>`)}</div>`,
    footer: html`<button type="button" class="btn-outline btn-md" data-dialog-close>Batal</button><button type="button" class="btn-primary btn-md" data-add-selected>${icon('plus')}Tambahkan terpilih</button>` });
  d.$('[data-add-selected]').addEventListener('click', async (e) => {
    const picked = d.$$('[data-i]').filter((c) => c.checked).map((c) => res.repos[Number(c.dataset.i)]);
    if (!picked.length) return notify('warning', 'Pilih minimal satu repo.');
    await busy(e.currentTarget, async () => {
      let n = 0; const errs = [];
      for (const r of picked) { const a = await call('repos:add', { repo: { name: r.name, path: r.path, github: r.github, gitlab: r.gitlab, primary: r.github ? 'github' : 'gitlab', defaultBranch: r.defaultBranch } }, { silent: true }); if (a.ok) n++; else errs.push(`${r.name}: ${a.error}`); }
      d.close(true); await loadRepos();
      notify(errs.length ? 'warning' : 'success', errs.length ? `${n} ditambahkan, ${errs.length} gagal: ${errs[0]}` : `${n} repo ditambahkan.`);
      refreshAll({ fetch: false });
    });
  });
}

/* ------------------------------------------------------------------ form tambah/ubah */
export function openRepoForm({ repo, suggest }) {
  const editing = !!repo;
  const src = repo || { ...suggest, flow: { steps: [{ from: '$BRANCH', to: suggest.defaultBranch || 'master' }], mirror: true, method: 'merge', waitChecks: true, checkDeployments: true }, warnBranches: ['release'], ignoreRefs: [], deployBranch: '' };
  const v = (x) => x == null ? '' : x;
  const steps = src.flow.steps;
  const stepRow = (s) => html`<div class="flex items-center gap-2" data-step><input class="input h-9 flex-1 font-mono text-xs" data-from value="${s.from}" placeholder="$BRANCH atau nama branch" aria-label="Dari" />${icon('arrow-right', 'h-4 w-4 shrink-0 text-slate-400')}<input class="input h-9 flex-1 font-mono text-xs" data-to value="${s.to}" placeholder="branch tujuan" aria-label="Ke" /><button type="button" class="btn-outline btn-sm w-8 px-0" data-del-step aria-label="Hapus langkah">${icon('x', 'h-3.5 w-3.5')}</button></div>`;
  const field = (label, name, value, { hint, ph, mono } = {}) => html`<div><label class="form-label" for="f-${name}">${label}</label><input id="f-${name}" name="${name}" class="input ${mono ? 'font-mono text-xs' : ''}" value="${v(value)}" placeholder="${ph || ''}" />${hint ? html`<p class="form-hint">${hint}</p>` : ''}</div>`;
  const d = dialog({
    title: editing ? `Ubah ${repo.name}` : 'Tambah repo', size: 'modal-xl',
    description: editing ? repo.path : 'Periksa hasil deteksi, lalu simpan.',
    body: html`<form class="space-y-6" data-form>
      <section class="grid gap-4 sm:grid-cols-2">
        ${field('Nama tampilan', 'name', src.name)}
        <div><label class="form-label">Folder</label><div class="flex gap-2"><input class="input flex-1 font-mono text-xs" name="path" value="${v(src.path)}" readonly /><button type="button" class="btn-outline btn-md" data-change-folder>${icon('folder-open')}Ganti</button></div></div>
      </section>
      <section><p class="mb-3 text-sm font-semibold text-slate-800">Remote</p><div class="grid gap-4 sm:grid-cols-2">
        ${field('GitHub (owner/repo)', 'github', src.github && src.github.repo, { ph: 'foxtrot-sevima/KarirKit', mono: true })}
        ${field('GitLab: URL dasar', 'glBase', src.gitlab && src.gitlab.baseUrl, { ph: 'https://gitlab.perusahaan.com', mono: true })}
        <div><label class="form-label" for="f-primary">Platform utama (PR/rilis)</label><select id="f-primary" name="primary" class="input"><option value="github" ${src.primary !== 'gitlab' ? 'selected' : ''}>GitHub</option><option value="gitlab" ${src.primary === 'gitlab' ? 'selected' : ''}>GitLab</option></select></div>
        ${field('GitLab: path project', 'glPath', src.gitlab && src.gitlab.path, { ph: 'grup/proyek', mono: true })}
      </div></section>
      <section><p class="mb-3 text-sm font-semibold text-slate-800">Branch</p><div class="grid gap-4 sm:grid-cols-2">
        ${field('Branch default', 'defaultBranch', src.defaultBranch, { mono: true })}
        ${field('Branch deploy (opsional)', 'deployBranch', src.deployBranch, { ph: 'karirkit/vercel', mono: true })}
        ${field('Branch berbahaya', 'warnBranches', (src.warnBranches || []).join(', '), { hint: 'Dipisah koma. Push ke branch ini diberi peringatan merah (mis. branch yang memicu publish).', mono: true })}
        ${field('Ref diabaikan saat membandingkan mirror', 'ignoreRefs', (src.ignoreRefs || []).join(', '), { hint: 'Mis. refs/heads/main jika GitLab punya branch yang bukan milik Anda.', mono: true })}
      </div></section>
      <section><div class="mb-3 flex items-center justify-between"><p class="text-sm font-semibold text-slate-800">Alur rilis</p><button type="button" class="btn-outline btn-sm" data-add-step>${icon('plus', 'h-3.5 w-3.5')}Tambah langkah</button></div>
        <p class="form-hint mb-3">Tiap langkah = satu PR dari kiri ke kanan yang di-merge berurutan. <span class="kbd-ref">$BRANCH</span> diganti branch rilis yang Anda pilih di halaman Rilis.</p>
        <div class="space-y-2" data-steps>${steps.map(stepRow)}</div>
        <div class="mt-4 grid gap-4 sm:grid-cols-2">
          <div><label class="form-label" for="f-method">Metode merge</label><select id="f-method" name="method" class="input">${['merge', 'squash', 'rebase'].map((m) => html`<option value="${m}" ${src.flow.method === m ? 'selected' : ''}>${m}</option>`)}</select></div>
          <div class="space-y-2 pt-1 text-sm text-slate-700">
            <label class="flex items-center gap-2"><input type="checkbox" class="form-check form-check-sm" name="waitChecks" ${src.flow.waitChecks ? 'checked' : ''}/>Tunggu check hijau sebelum merge</label>
            <label class="flex items-center gap-2"><input type="checkbox" class="form-check form-check-sm" name="mirror" ${src.flow.mirror ? 'checked' : ''}/>Samakan GitLab setelah rilis</label>
            <label class="flex items-center gap-2"><input type="checkbox" class="form-check form-check-sm" name="checkDeployments" ${src.flow.checkDeployments ? 'checked' : ''}/>Pantau status deployment</label>
          </div></div></section>
      <details class="rounded-xl border border-border p-4"><summary class="cursor-pointer text-sm font-semibold text-slate-800">Lanjutan: URL git eksplisit</summary>
        <div class="mt-3 grid gap-4 sm:grid-cols-2">
          ${field('URL git GitHub', 'ghUrl', src.github && src.github.url, { hint: 'Kosongkan untuk memakai https://github.com/owner/repo.git', mono: true })}
          ${field('URL git GitLab', 'glUrl', src.gitlab && src.gitlab.url, { hint: 'Kosongkan untuk memakai URL dasar + path project.', mono: true })}
        </div></details>
      <p class="hidden rounded-lg bg-danger-50 p-3 text-sm text-danger-700" data-error></p>
    </form>`,
    footer: html`<button type="button" class="btn-outline btn-md" data-dialog-close>Batal</button><button type="button" class="btn-primary btn-md" data-save>${icon('check')}${editing ? 'Simpan perubahan' : 'Tambahkan repo'}</button>`,
  });
  const form = d.$('[data-form]');
  form.addEventListener('submit', (e) => e.preventDefault());
  const val = (n) => (form.elements[n] ? form.elements[n].value.trim() : '');
  const list = (n) => val(n).split(',').map((x) => x.trim()).filter(Boolean);
  d.$('[data-add-step]').addEventListener('click', () => d.$('[data-steps]').insertAdjacentHTML('beforeend', stepRow({ from: '', to: '' }).s));
  d.el.addEventListener('click', (e) => { const del = e.target.closest('[data-del-step]'); if (del) del.closest('[data-step]').remove(); });
  d.$('[data-change-folder]').addEventListener('click', async () => {
    const p = await pickFolder('Pilih folder repo git'); if (!p) return;
    const det = await call('repos:detect', { path: p }); if (!det.ok) return;
    form.elements.path.value = det.root;
  });
  d.$('[data-save]').addEventListener('click', async (e) => {
    const gh = val('github'), glBase = val('glBase'), glPath = val('glPath');
    const payload = {
      name: val('name'), path: val('path'), primary: val('primary'), defaultBranch: val('defaultBranch'), deployBranch: val('deployBranch'),
      warnBranches: list('warnBranches'), ignoreRefs: list('ignoreRefs'),
      github: gh ? { repo: gh, url: val('ghUrl') } : null,
      gitlab: glBase || glPath ? { baseUrl: glBase, path: glPath, url: val('glUrl') } : null,
      flow: { steps: d.$$('[data-step]').map((s) => ({ from: s.querySelector('[data-from]').value.trim(), to: s.querySelector('[data-to]').value.trim() })).filter((s) => s.from && s.to), method: val('method'), waitChecks: form.elements.waitChecks.checked, mirror: form.elements.mirror.checked, checkDeployments: form.elements.checkDeployments.checked },
    };
    const err = d.$('[data-error]');
    await busy(e.currentTarget, async () => {
      const res = editing ? await call('repos:update', { id: repo.id, patch: payload }, { silent: true }) : await call('repos:add', { repo: payload }, { silent: true });
      if (!res.ok) { err.textContent = res.error; err.classList.remove('hidden'); return; }
      d.close(true); await loadRepos();
      notify('success', editing ? 'Pengaturan disimpan.' : `"${res.repo.name}" ditambahkan.`);
      refreshAll({ fetch: false, ids: [res.repo.id] });
    });
  });
}
