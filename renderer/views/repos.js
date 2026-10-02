// Repositori: daftar repo yang dikelola + tambah (dari folder / pindai folder induk), ubah, uji koneksi, hapus.
import { html, esc, icon, badge, plural, mount as setHtml } from '../lib/h.js';
import { dialog, confirmDialog, notify, call, busy } from '../lib/ui.js';
import { state, bus, loadRepos, loadAcct, refreshAll, repoById, acctById } from '../state.js';
import { PROVIDER_LABEL, providerIcon, isSshUrl, sshBadge, accountsForRemote, resolveRemote, sshUrlFor, redactUrl, mountTrust } from '../lib/ssh.js';

export const title = 'Repositories';
let host = null, offs = [];

const PLATFORMS = ['github', 'gitlab'];
// baris kecil di bawah remote pada tabel: akun + HTTPS/SSH
const remoteMeta = (remote) => { const a = remote.account ? acctById(remote.account) : null; return html`<p class="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-slate-500">${a ? html`<span class="truncate" title="${a.host}">${a.label}</span>` : html`<span class="text-slate-400">No account</span>`}${sshBadge(remote.url)}</p>`; };

const stepsText = (r) => r.flow.steps.map((s) => `${s.from === '$BRANCH' ? 'release branch' : s.from} → ${s.to}`).join('  ›  ');

function render() {
  if (!host) return;
  setHtml(host, html`
    <div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div class="min-w-0"><h2 class="font-display text-2xl font-bold text-slate-900 sm:text-3xl">Repositories</h2><p class="mt-1 text-sm text-slate-500">The repos you manage. Add as many as you like; each repo has its own GitHub/GitLab pairing and release flow.</p></div>
      <div class="flex shrink-0 flex-wrap gap-2.5"><button type="button" class="btn-outline btn-md" data-add="scan">${icon('magnifying-glass')}Scan parent folder</button><button type="button" class="btn-primary btn-md" data-add="folder">${icon('plus')}Add from folder</button></div>
    </div>
    ${state.repos.length ? html`
    <div class="table-wrap">
      <div class="overflow-x-auto"><table class="table table-lg table-fit table-head-soft"><thead><tr>
        <th scope="col" class="table-col-num">#</th><th scope="col">Repository</th><th scope="col">GitHub</th><th scope="col">GitLab</th><th scope="col">Release flow</th><th scope="col" class="table-col-actions text-right">Actions</th>
      </tr></thead><tbody>${state.repos.map((r, i) => html`<tr data-id="${r.id}">
        <td class="table-col-num">${i + 1}</td>
        <td><span class="block font-medium text-slate-800">${r.name}</span><p class="mt-0.5 max-w-[15rem] truncate text-xs text-slate-400" title="${r.path}">${r.path}</p></td>
        <td>${r.github ? html`<span class="inline-flex items-center gap-1.5 text-sm text-slate-700">${icon('github-logo', 'h-4 w-4 text-slate-400')}${r.github.repo}</span>${remoteMeta(r.github)}` : html`<span class="text-xs text-slate-400">—</span>`}</td>
        <td>${r.gitlab ? html`<span class="inline-flex items-center gap-1.5 text-sm text-slate-700">${icon('gitlab-logo', 'h-4 w-4 text-slate-400')}${r.gitlab.path}</span><p class="text-xs text-slate-400">${r.gitlab.baseUrl.replace(/^https?:\/\//, '')}</p>${remoteMeta(r.gitlab)}` : html`<span class="text-xs text-slate-400">—</span>`}</td>
        <td class="max-w-[14rem]"><p class="truncate text-xs text-slate-600" title="${stepsText(r)}">${stepsText(r)}</p><p class="mt-0.5 text-xs text-slate-400">${r.flow.method}${r.flow.mirror ? ' · mirror' : ''}${r.flow.waitChecks ? ' · wait for checks' : ''}</p></td>
        <td class="table-col-actions"><div class="flex items-center justify-end gap-1.5">
          <button type="button" class="btn-outline btn-sm max-2xl:w-8 max-2xl:px-0" data-act="test" title="Test GitHub/GitLab connection" aria-label="Test connection for ${r.name}">${icon('plug')}<span class="hidden 2xl:inline">Test</span></button>
          <button type="button" class="btn-outline btn-sm max-2xl:w-8 max-2xl:px-0" data-act="edit" title="Edit settings" aria-label="Edit ${r.name}">${icon('pencil-simple')}<span class="hidden 2xl:inline">Edit</span></button>
          <button type="button" class="btn-outline btn-sm w-8 px-0 text-danger-600" data-act="remove" title="Remove from list" aria-label="Remove ${r.name} from list">${icon('trash')}</button>
        </div></td></tr>`)}</tbody></table></div>
    </div>` : html`<div class="card px-6 py-14 text-center"><p class="text-sm text-slate-500">No repos yet. Add a git repo folder to get started.</p></div>`}`);
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
    const ok = await confirmDialog({ title: `Remove "${r.name}" from list?`, body: html`<p class="text-sm text-slate-600">Only the entry in this app is removed. <b>The folder, git history, and the repo on GitHub/GitLab are not touched.</b></p>`, confirmLabel: 'Remove from list', danger: true, iconName: 'trash' });
    if (!ok) return;
    const res = await call('repos:remove', { id });
    if (res.ok) { notify('success', `"${r.name}" removed from list.`); await loadRepos(); }
    return;
  }
  if (act.dataset.act === 'test') return busy(act, async () => {
    const t = await call('repos:test', { id });
    if (!t.ok) return;
    const off = (x) => !!x && !x.ok && x.code === 'NO_TOKEN';
    const row = (name, x, extra) => html`<div class="flex items-start gap-3 rounded-xl border border-border p-3.5">${icon(x && x.ok ? 'check-circle' : off(x) ? 'info' : 'warning-circle', `mt-0.5 h-5 w-5 shrink-0 ${x && x.ok ? 'text-success-600' : off(x) ? 'text-info-600' : 'text-danger-600'}`)}<div class="min-w-0"><p class="font-medium text-slate-800">${name}</p><p class="text-sm ${x && (x.ok || off(x)) ? 'text-slate-500' : 'text-danger-700'}">${x ? (x.ok ? extra : off(x) ? `${x.error} Push, fetch and sync still work through git.` : x.error) : 'Not configured'}</p></div></div>`;
    dialog({ title: `Test connection · ${r.name}`, size: 'modal-md', body: html`<div class="space-y-3">
      ${row('Local folder', { ok: t.folder, error: 'Folder not found.' }, r.path)}
      ${r.github ? row('GitHub', t.github, `Access: ${t.github && t.github.permission}${t.github && t.github.isPrivate ? ' · private' : ''} · default: ${t.github && t.github.defaultBranch}`) : ''}
      ${r.gitlab ? row('GitLab', t.gitlab, `Access level: ${t.gitlab && t.gitlab.accessLevel} · default: ${t.gitlab && t.gitlab.defaultBranch} · ${t.gitlab && t.gitlab.visibility}`) : ''}</div>`, footer: html`<button type="button" class="btn-primary btn-md" data-dialog-close>Close</button>` });
  });
}

/* ------------------------------------------------------------------ tambah */
export function openAddMenu(kind) {
  if (kind === 'folder') return addFromFolder();
  if (kind === 'scan') return scanParent();
  const d = dialog({ title: 'Add repo', size: 'modal-md', body: html`<div class="grid gap-3">
    <button type="button" class="flex items-start gap-3 rounded-xl border border-border p-4 text-left transition-colors hover:border-primary-300 hover:bg-primary-50/40" data-pick="folder"><span class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary-50 text-primary-600">${icon('folder-open', 'h-5 w-5')}</span><span><span class="block font-medium text-slate-800">From one folder</span><span class="text-sm text-slate-500">Choose a git repo folder; remotes are detected automatically.</span></span></button>
    <button type="button" class="flex items-start gap-3 rounded-xl border border-border p-4 text-left transition-colors hover:border-primary-300 hover:bg-primary-50/40" data-pick="scan"><span class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-info-50 text-info-600">${icon('magnifying-glass', 'h-5 w-5')}</span><span><span class="block font-medium text-slate-800">Scan parent folder</span><span class="text-sm text-slate-500">Find all repos inside one folder and add them at once.</span></span></button></div>` });
  d.el.addEventListener('click', (e) => { const p = e.target.closest('[data-pick]'); if (p) { d.close(undefined); openAddMenu(p.dataset.pick); } });
}

async function pickFolder(title) { const r = await call('dialog:pickFolder', { title }, { silent: true }); return r.ok ? r.path : null; }

async function addFromFolder() {
  const p = await pickFolder('Choose a git repo folder');
  if (!p) return;
  const d = await call('repos:detect', { path: p });
  if (!d.ok) return;
  if (d.alreadyAdded) return notify('warning', 'This folder is already in the list.');
  openRepoForm({ suggest: d.suggest });
}

async function scanParent() {
  const p = await pickFolder('Choose a parent folder that contains multiple repos');
  if (!p) return;
  const res = await call('repos:scan', { folder: p });
  if (!res.ok) return;
  if (!res.repos.length) return notify('warning', 'No git repos found directly inside that folder.');
  const d = dialog({ title: `Found ${res.repos.length} ${plural(res.repos.length, 'repo')}`, description: p, size: 'modal-lg',
    body: html`<div class="space-y-2">${res.repos.map((r, i) => html`<label class="flex items-center gap-3 rounded-xl border border-border p-3 ${r.alreadyAdded ? 'opacity-60' : ''}"><input type="checkbox" class="form-check form-check-sm" data-i="${i}" ${r.alreadyAdded || (!r.github && !r.gitlab) ? 'disabled' : 'checked'} /><span class="min-w-0 flex-1"><span class="block font-medium text-slate-800">${r.name}</span><span class="block truncate text-xs text-slate-400">${r.path}</span></span><span class="flex shrink-0 gap-1.5">${r.github ? badge('neutral', 'GitHub', 'github-logo') : ''}${r.gitlab ? badge('neutral', 'GitLab', 'gitlab-logo') : ''}${r.alreadyAdded ? badge('success', 'Already added') : !r.github && !r.gitlab ? badge('warning', 'No remote') : ''}</span></label>`)}</div>`,
    footer: html`<button type="button" class="btn-outline btn-md" data-dialog-close>Cancel</button><button type="button" class="btn-primary btn-md" data-add-selected>${icon('plus')}Add selected</button>` });
  d.$('[data-add-selected]').addEventListener('click', async (e) => {
    const picked = d.$$('[data-i]').filter((c) => c.checked).map((c) => res.repos[Number(c.dataset.i)]);
    if (!picked.length) return notify('warning', 'Select at least one repo.');
    await busy(e.currentTarget, async () => {
      let n = 0; const errs = [];
      for (const r of picked) { const a = await call('repos:add', { repo: { name: r.name, path: r.path, github: r.github, gitlab: r.gitlab, primary: r.github ? 'github' : 'gitlab', defaultBranch: r.defaultBranch } }, { silent: true }); if (a.ok) n++; else errs.push(`${r.name}: ${a.error}`); }
      d.close(true); await loadRepos();
      notify(errs.length ? 'warning' : 'success', errs.length ? `${n} added, ${errs.length} failed: ${errs[0]}` : `${n} ${plural(n, 'repo')} added.`);
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
  const stepRow = (s) => html`<div class="flex items-center gap-2" data-step><input class="input h-9 flex-1 font-mono text-xs" data-from value="${s.from}" placeholder="$BRANCH or branch name" aria-label="From" />${icon('arrow-right', 'h-4 w-4 shrink-0 text-slate-400')}<input class="input h-9 flex-1 font-mono text-xs" data-to value="${s.to}" placeholder="target branch" aria-label="To" /><button type="button" class="btn-outline btn-sm w-8 px-0" data-del-step aria-label="Remove step">${icon('x', 'h-3.5 w-3.5')}</button></div>`;
  // data remote terbaru (setelah Use SSH / Back to HTTPS isinya berubah di penyimpanan)
  const cur = () => (editing ? repoById(repo.id) || repo : null);
  const chosen = {}; // platform -> id akun terpilih ('' = Unassigned)
  if (editing) for (const p of PLATFORMS) if (repo[p]) chosen[p] = repo[p].account && acctById(repo[p].account) ? repo[p].account : '';
  const remoteName = (r, p) => (p === 'github' ? r.github.repo : r.gitlab.path);
  function remoteRow(r, p) {
    const rem = r[p], isSsh = isSshUrl(rem.url), sel = chosen[p] || '';
    const picked = sel ? acctById(sel) : null;
    const opts = accountsForRemote(state.acct.list, p, rem.url);
    if (picked && !opts.includes(picked)) opts.push(picked);
    const name = PROVIDER_LABEL[p];
    return html`<div class="rounded-xl border border-border p-3.5" data-remote="${p}">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <p class="flex min-w-0 items-center gap-2 text-sm font-medium text-slate-800">${icon(providerIcon(p), 'h-4 w-4 shrink-0 text-slate-400')}<span class="truncate font-mono text-xs">${remoteName(r, p)}</span><span data-proto>${sshBadge(rem.url)}</span></p>
        <div class="flex flex-wrap gap-2">
          ${isSsh ? '' : html`<button type="button" class="btn-outline btn-sm" data-use-ssh="${p}" ${picked ? '' : 'disabled'} title="${picked ? `Switch this remote to SSH with ${picked.label}` : 'Choose an account first'}">${icon('lock-key', 'h-3.5 w-3.5')}Use SSH</button>`}
          ${rem.prevUrl ? html`<button type="button" class="btn-outline btn-sm" data-back-https="${p}" title="Go back to ${redactUrl(rem.prevUrl)}">${icon('arrow-u-up-left', 'h-3.5 w-3.5')}Back to HTTPS</button>` : ''}
        </div>
      </div>
      <div class="mt-3 grid gap-3 sm:grid-cols-2 sm:items-end">
        <div><label class="form-label" for="f-acct-${p}">${name} account</label><select id="f-acct-${p}" name="acct-${p}" class="input" data-acct-select="${p}"><option value="">Unassigned</option>${opts.map((a) => html`<option value="${a.id}" ${a.id === sel ? 'selected' : ''}>${a.label} · ${a.host}</option>`)}</select></div>
        <p class="min-w-0 break-all font-mono text-xs text-slate-500" title="${redactUrl(rem.url)}" data-remote-url>${redactUrl(rem.url)}</p>
      </div>
      ${opts.length ? '' : html`<p class="form-hint mt-2">No ${name} account matches this remote yet. <a href="#/accounts" class="font-medium text-primary-600 hover:underline" data-dialog-close>Add one on the Accounts page.</a></p>`}
    </div>`;
  }
  const connHtml = () => { const r = cur(); const rows = PLATFORMS.filter((p) => r[p]).map((p) => remoteRow(r, p)); return rows.length ? html`<div class="space-y-3">${rows}</div>` : ''; };
  const renderConn = () => { const el = d.$('[data-conn]'); if (el) el.innerHTML = connHtml().s; };

  const field = (label, name, value, { hint, ph, mono } = {}) => html`<div><label class="form-label" for="f-${name}">${label}</label><input id="f-${name}" name="${name}" class="input ${mono ? 'font-mono text-xs' : ''}" value="${v(value)}" placeholder="${ph || ''}" />${hint ? html`<p class="form-hint">${hint}</p>` : ''}</div>`;
  const d = dialog({
    title: editing ? `Edit ${repo.name}` : 'Add repo', size: 'modal-xl',
    description: editing ? repo.path : 'Review the detected values, then save.',
    body: html`<form class="space-y-6" data-form>
      <section class="grid gap-4 sm:grid-cols-2">
        ${field('Display name', 'name', src.name)}
        <div><label class="form-label">Folder</label><div class="flex gap-2"><input class="input flex-1 font-mono text-xs" name="path" value="${v(src.path)}" readonly /><button type="button" class="btn-outline btn-md" data-change-folder>${icon('folder-open')}Change</button></div></div>
      </section>
      <section><p class="mb-3 text-sm font-semibold text-slate-800">Remote</p><div class="grid gap-4 sm:grid-cols-2">
        ${field('GitHub (owner/repo)', 'github', src.github && src.github.repo, { ph: 'foxtrot-sevima/KarirKit', mono: true })}
        ${field('GitLab: base URL', 'glBase', src.gitlab && src.gitlab.baseUrl, { ph: 'https://gitlab.company.com', mono: true })}
        <div><label class="form-label" for="f-primary">Primary platform (PR/release)</label><select id="f-primary" name="primary" class="input"><option value="github" ${src.primary !== 'gitlab' ? 'selected' : ''}>GitHub</option><option value="gitlab" ${src.primary === 'gitlab' ? 'selected' : ''}>GitLab</option></select></div>
        ${field('GitLab: project path', 'glPath', src.gitlab && src.gitlab.path, { ph: 'group/project', mono: true })}
      </div></section>
      <section data-conn-section><p class="mb-1 text-sm font-semibold text-slate-800">Accounts and access</p>
        <p class="form-hint mb-3">${editing ? 'Choose the account each remote belongs to. SSH is optional; HTTPS keeps working with your existing git login. The account is applied when you save; Use SSH and Back to HTTPS apply right away.' : 'Accounts are assigned automatically from the host and owner of each remote. After adding the repo, open Edit to change the account or switch a remote to SSH.'}</p>
        <div data-conn>${editing ? connHtml() : ''}</div></section>
      <section><p class="mb-3 text-sm font-semibold text-slate-800">Branch</p><div class="grid gap-4 sm:grid-cols-2">
        ${field('Default branch', 'defaultBranch', src.defaultBranch, { mono: true })}
        ${field('Deploy branch (optional)', 'deployBranch', src.deployBranch, { ph: 'karirkit/vercel', mono: true })}
        ${field('Dangerous branches', 'warnBranches', (src.warnBranches || []).join(', '), { hint: 'Comma-separated. Pushing to these branches shows a red warning (e.g. a branch that triggers a publish).', mono: true })}
        ${field('Refs ignored when comparing mirrors', 'ignoreRefs', (src.ignoreRefs || []).join(', '), { hint: 'E.g. refs/heads/main if GitLab has a branch that is not yours.', mono: true })}
      </div></section>
      <section><div class="mb-3 flex items-center justify-between"><p class="text-sm font-semibold text-slate-800">Release flow</p><button type="button" class="btn-outline btn-sm" data-add-step>${icon('plus', 'h-3.5 w-3.5')}Add step</button></div>
        <p class="form-hint mb-3">Each step is one PR from left to right, merged in order. <span class="kbd-ref">$BRANCH</span> is replaced by the release branch you pick on the Release page.</p>
        <div class="space-y-2" data-steps>${steps.map(stepRow)}</div>
        <div class="mt-4 grid gap-4 sm:grid-cols-2">
          <div><label class="form-label" for="f-method">Merge method</label><select id="f-method" name="method" class="input">${['merge', 'squash', 'rebase'].map((m) => html`<option value="${m}" ${src.flow.method === m ? 'selected' : ''}>${m}</option>`)}</select></div>
          <div class="space-y-2 pt-1 text-sm text-slate-700">
            <label class="flex items-center gap-2"><input type="checkbox" class="form-check form-check-sm" name="waitChecks" ${src.flow.waitChecks ? 'checked' : ''}/>Wait for green checks before merging</label>
            <label class="flex items-center gap-2"><input type="checkbox" class="form-check form-check-sm" name="mirror" ${src.flow.mirror ? 'checked' : ''}/>Sync GitLab after release</label>
            <label class="flex items-center gap-2"><input type="checkbox" class="form-check form-check-sm" name="checkDeployments" ${src.flow.checkDeployments ? 'checked' : ''}/>Monitor deployment status</label>
          </div></div></section>
      <details class="rounded-xl border border-border p-4"><summary class="cursor-pointer text-sm font-semibold text-slate-800">Advanced: explicit git URLs</summary>
        <div class="mt-3 grid gap-4 sm:grid-cols-2">
          ${field('GitHub git URL', 'ghUrl', src.github && src.github.url, { hint: 'Leave empty to use https://github.com/owner/repo.git', mono: true })}
          ${field('GitLab git URL', 'glUrl', src.gitlab && src.gitlab.url, { hint: 'Leave empty to use the base URL + project path.', mono: true })}
        </div></details>
      <p class="hidden rounded-lg bg-danger-50 p-3 text-sm text-danger-700" data-error></p>
    </form><div class="hidden space-y-4" data-panel></div>`,
    footer: html`<div class="contents" data-foot-main><button type="button" class="btn-outline btn-md" data-dialog-close>Cancel</button><button type="button" class="btn-primary btn-md" data-save>${icon('check')}${editing ? 'Save changes' : 'Add repo'}</button></div><div class="hidden" data-foot-panel></div>`,
  });
  const form = d.$('[data-form]');
  const panel = d.$('[data-panel]'), footMain = d.$('[data-foot-main]'), footPanel = d.$('[data-foot-panel]');
  let panelTitle = '';
  // panel di dalam dialog yang sama (formulir disembunyikan, bukan dibuang) supaya isian yang belum disimpan tidak hilang
  const showPanel = (on) => {
    form.classList.toggle('hidden', on); panel.classList.toggle('hidden', !on);
    footMain.classList.toggle('hidden', on); footMain.classList.toggle('contents', !on);
    footPanel.classList.toggle('hidden', !on); footPanel.classList.toggle('contents', on);
    d.setTitle(on ? panelTitle : editing ? `Edit ${repo.name}` : 'Add repo');
  };
  form.addEventListener('submit', (e) => e.preventDefault());
  const val = (n) => (form.elements[n] ? form.elements[n].value.trim() : '');
  const list = (n) => val(n).split(',').map((x) => x.trim()).filter(Boolean);
  d.$('[data-add-step]').addEventListener('click', () => d.$('[data-steps]').insertAdjacentHTML('beforeend', stepRow({ from: '', to: '' }).s));
  d.el.addEventListener('click', (e) => { const del = e.target.closest('[data-del-step]'); if (del) del.closest('[data-step]').remove(); });
  d.$('[data-change-folder]').addEventListener('click', async () => {
    const p = await pickFolder('Choose a git repo folder'); if (!p) return;
    const det = await call('repos:detect', { path: p }); if (!det.ok) return;
    form.elements.path.value = det.root;
  });
  /* ---- akun + SSH per remote ---- */
  form.addEventListener('change', (e) => { const s = e.target.closest('[data-acct-select]'); if (s) { chosen[s.dataset.acctSelect] = s.value; renderConn(); } });
  form.addEventListener('click', (e) => {
    const use = e.target.closest('[data-use-ssh]'), back = e.target.closest('[data-back-https]');
    if (use && !use.disabled) switchRemote(use.dataset.useSsh, false);
    if (back) switchRemote(back.dataset.backHttps, true);
  });

  // Use SSH / Back to HTTPS: pratinjau + konfirmasi di panel; URL remote di .git/config ditulis ulang hanya setelah dikonfirmasi
  function switchRemote(p, revert) {
    const r = cur(), rem = r[p];
    const acct = acctById(revert ? (rem.account || chosen[p]) : chosen[p]) || null;
    if (!revert && !acct) return notify('warning', 'Choose an account first.');
    const name = PROVIDER_LABEL[p];
    const path = resolveRemote(rem.url, state.acct.list).path;
    const from = redactUrl(rem.url);
    const to = revert ? redactUrl(rem.prevUrl) : sshUrlFor(acct, path);
    const title = revert ? `Back to HTTPS · ${name}` : `Use SSH · ${name}`;
    panelTitle = title;
    const lines = revert
      ? ["The remote URL in this repo's git config is rewritten back to the HTTPS URL it had before.", 'Only url / pushurl entries that match the current URL are changed; other remotes are not touched.', 'The account stays assigned.']
      : ['Repo Hub first checks that it can read this repository over SSH (git ls-remote). If that fails, nothing is changed.', "Then url / pushurl entries in this repo's git config that match the current URL are rewritten; other remotes are not touched.", 'The previous URL is remembered, so you can switch back with Back to HTTPS.'];
    const confirmView = (error) => {
      panel.innerHTML = html`<p class="text-sm text-slate-600">${revert ? html`Switch the ${name} remote of <b>${repo.name}</b> back to HTTPS.` : html`Switch the ${name} remote of <b>${repo.name}</b> to SSH.`}</p>
        <dl class="grid gap-x-4 gap-y-1.5 rounded-xl border border-border p-3.5 text-xs sm:grid-cols-[auto_1fr]"><dt class="text-slate-500">From</dt><dd class="break-all font-mono text-slate-700" data-plan-from>${from}</dd><dt class="text-slate-500">To</dt><dd class="break-all font-mono font-medium text-slate-900" data-plan-to>${to}</dd>${acct ? html`<dt class="text-slate-500">Account</dt><dd class="text-slate-700">${acct.label} · ${acct.host}</dd>` : ''}</dl>
        <ul class="list-disc space-y-1 pl-5 text-xs text-slate-600">${lines.map((l) => html`<li>${l}</li>`)}</ul>
        <p class="${error ? '' : 'hidden'} rounded-lg bg-danger-50 p-3 text-sm text-danger-700" data-panel-error>${error || ''}</p>`.s;
      footPanel.innerHTML = html`<button type="button" class="btn-outline btn-md" data-panel-cancel>Cancel</button><button type="button" class="btn-primary btn-md" data-panel-go>${icon(revert ? 'arrow-u-up-left' : 'lock-key')}${revert ? 'Switch back to HTTPS' : 'Switch to SSH'}</button>`.s;
      footPanel.querySelector('[data-panel-cancel]').addEventListener('click', () => showPanel(false));
      footPanel.querySelector('[data-panel-go]').addEventListener('click', run);
    };
    const resultView = (res) => {
      const n = res.replaced || 0;
      panel.innerHTML = html`<div class="flex items-start gap-3 rounded-xl bg-success-50 p-3.5 text-sm text-success-700" data-panel-ok>${icon('check-circle', 'mt-0.5 h-5 w-5 shrink-0')}<div class="min-w-0"><p class="font-medium">${revert ? 'The remote uses HTTPS again.' : 'The remote now uses SSH.'}</p><p class="mt-1 break-all font-mono text-xs"><span data-res-from>${res.from}</span> → <span data-res-to>${res.to}</span></p><p class="mt-1 text-xs">${n} ${plural(n, 'entry', 'entries')} updated in this repo's git config.</p></div></div>
        ${res.note ? html`<div class="callout-warning flex items-start gap-3">${icon('warning', 'mt-0.5 h-4 w-4 shrink-0 text-warning-600')}<p class="text-sm text-slate-600" data-res-note>${res.note}</p></div>` : ''}`.s;
      footPanel.innerHTML = html`<button type="button" class="btn-primary btn-md" data-panel-done>Done</button>`.s;
      footPanel.querySelector('[data-panel-done]').addEventListener('click', () => showPanel(false));
    };
    const run = async () => {
      panel.innerHTML = html`<p class="flex items-center gap-2 text-sm text-slate-500">${icon('circle-notch', 'h-4 w-4 animate-spin')}${revert ? 'Updating the remote…' : 'Checking SSH access, then updating the remote…'}</p>`.s;
      footPanel.innerHTML = '';
      d.lock(true);
      const res = await call('repos:useSsh', { repoId: repo.id, platform: p, accountId: acct ? acct.id : undefined, revert, confirmed: true }, { silent: true });
      d.lock(false);
      if (res.ok) {
        await Promise.all([loadRepos(), loadAcct()]);
        const fresh = cur();
        if (fresh[p] && fresh[p].account && acctById(fresh[p].account)) chosen[p] = fresh[p].account;
        const urlInput = form.elements[p === 'github' ? 'ghUrl' : 'glUrl']; if (urlInput && fresh[p]) urlInput.value = fresh[p].url;
        renderConn();
        if (res.unchanged) { showPanel(false); return notify('warning', 'The remote already uses this URL; nothing was changed.'); }
        return resultView(res);
      }
      if (res.code === 'HOST_KEY' && acct) {
        panel.innerHTML = html`<div class="callout-warning flex items-start gap-3">${icon('shield-warning', 'mt-0.5 h-4 w-4 shrink-0 text-warning-600')}<div class="min-w-0 text-sm text-slate-600"><p class="font-medium text-slate-800">${acct.host} is not trusted yet</p><p class="mt-1" data-panel-error>${res.error}</p><p class="mt-1">Nothing was changed. Review the host key and trust it, then Repo Hub tries again.</p></div></div>`.s;
        footPanel.innerHTML = html`<button type="button" class="btn-outline btn-md" data-panel-cancel>Cancel</button><button type="button" class="btn-primary btn-md" data-panel-review>${icon('shield-check')}Review host key</button>`.s;
        footPanel.querySelector('[data-panel-cancel]').addEventListener('click', () => showPanel(false));
        footPanel.querySelector('[data-panel-review]').addEventListener('click', async () => {
          d.setTitle(`Review host key · ${acct.host}`);
          const trusted = await mountTrust(panel, footPanel, { host: acct.host, port: acct.ssh && acct.ssh.port, provider: acct.provider });
          d.setTitle(title);
          if (trusted) run(); else confirmView();
        });
        return;
      }
      confirmView(res.error);
    };
    showPanel(true);
    confirmView();
  }

  d.$('[data-save]').addEventListener('click', async (e) => {
    const gh = val('github'), glBase = val('glBase'), glPath = val('glPath');
    const fresh = cur() || {}; // remote yang sudah ada disalin utuh: repos:update MENGGANTI objek github/gitlab, jadi account/prevUrl harus ikut
    const payload = {
      name: val('name'), path: val('path'), primary: val('primary'), defaultBranch: val('defaultBranch'), deployBranch: val('deployBranch'),
      warnBranches: list('warnBranches'), ignoreRefs: list('ignoreRefs'),
      github: gh ? { ...(fresh.github || {}), repo: gh, url: val('ghUrl') } : null,
      gitlab: glBase || glPath ? { ...(fresh.gitlab || {}), baseUrl: glBase, path: glPath, url: val('glUrl') } : null,
      flow: { steps: d.$$('[data-step]').map((s) => ({ from: s.querySelector('[data-from]').value.trim(), to: s.querySelector('[data-to]').value.trim() })).filter((s) => s.from && s.to), method: val('method'), waitChecks: form.elements.waitChecks.checked, mirror: form.elements.mirror.checked, checkDeployments: form.elements.checkDeployments.checked },
    };
    const err = d.$('[data-error]');
    await busy(e.currentTarget, async () => {
      const res = editing ? await call('repos:update', { id: repo.id, patch: payload }, { silent: true }) : await call('repos:add', { repo: payload }, { silent: true });
      if (!res.ok) { err.textContent = res.error; err.classList.remove('hidden'); return; }
      // akun dipilih lewat acct:setRepo (memeriksa host akun = host remote)
      const problems = [];
      if (editing) for (const p of PLATFORMS) {
        const now = (res.repo[p] && res.repo[p].account) || '';
        if (res.repo[p] && (chosen[p] || '') !== now) {
          const s = await call('acct:setRepo', { repoId: repo.id, platform: p, accountId: chosen[p] || null }, { silent: true });
          if (!s.ok) problems.push(`${PROVIDER_LABEL[p]} account: ${s.error}`);
        }
      }
      await Promise.all([loadRepos(), loadAcct()]);
      if (problems.length) { err.textContent = `The settings were saved, but ${problems.join(' ')}`; err.classList.remove('hidden'); return; }
      d.close(true);
      notify('success', editing ? 'Settings saved.' : `"${res.repo.name}" added.`);
      refreshAll({ fetch: false, ids: [res.repo.id] });
    });
  });
}
