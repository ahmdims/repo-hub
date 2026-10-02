// Akun: banyak akun per penyedia (GitHub / GitLab / host git lain), dikelompokkan lewat ~/.ssh.
// Halaman ini mendeteksi akun dari ssh config + repo + gh, mengecek koneksi lewat "ssh -T" (tanpa token),
// dan membuat kunci + alias SSH baru lewat wizard yang SELALU menampilkan pratinjau sebelum menulis apa pun.
import { html, icon, badge, mount as setHtml } from '../lib/h.js';
import { dialog, notify, call } from '../lib/ui.js';
import { state, bus, loadAcct, loadRepos, acctById } from '../state.js';
import { PROVIDER_LABEL, providerIcon, defaultHost, slug, shortFp, hostBlock, chip, keyPanel, bindKeyPanel, mountTrust, trustHostDialog } from '../lib/ssh.js';

export const title = 'Accounts';

// Plural helper (local): plural(2, 'repo') -> "2 repos"; plural(1, 'repo') -> "1 repo"
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

let host = null, offs = [];
// hasil deteksi dan hasil cek disimpan di modul: tampilan dibuat ulang tiap daftar repo/akun berubah
const ui = { detect: null, detectError: null, detecting: false, detectAt: 0, checks: {} };

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;
const OWNER_RE = /^[\w.-]+$/;

// Bentuk akun yang dikirim ke acct:save (tanpa repoCount/addedAt)
const acctPayload = (a) => ({ id: a.id, label: a.label, provider: a.provider, host: a.host, login: a.login || '', owners: a.owners || [], ssh: a.ssh || null });
const privFile = (pub) => String(pub).replace(/\.pub$/, '');
const iconBox = (name, extra = '') => html`<span class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-neutral-100 text-slate-700 ${extra}">${icon(name, 'h-5 w-5')}</span>`;
const ownersChips = (owners) => (owners && owners.length ? html`<span class="flex flex-wrap gap-1.5">${owners.map((o) => chip(o))}</span>` : html`<span class="text-slate-400">All owners on this host</span>`);
const sshLabel = (s) => (s && (s.alias || s.identityFile) ? html`<span class="inline-flex min-w-0 flex-wrap items-center gap-x-1.5"><span class="font-mono text-xs text-slate-800">${s.alias || '(no alias)'}</span><span class="text-slate-400">·</span><span class="font-mono text-xs text-slate-600">${s.identityFile || '(no key file)'}</span>${s.port ? html`<span class="text-slate-400">· port ${s.port}</span>` : ''}</span>` : html`<span class="text-slate-400">No SSH identity (HTTPS only)</span>`);

/* ------------------------------------------------------------------ data */
async function runDetect() {
  ui.detecting = true; render();
  const r = await call('acct:detect', {}, { silent: true });
  ui.detecting = false; ui.detectAt = Date.now();
  if (r && r.ok) { ui.detect = r; ui.detectError = null; } else ui.detectError = (r && r.error) || 'Detection failed.';
  render();
  return r;
}

// Setelah akun berubah: muat ulang akun + repo (repo mendapat kaitan akun baru), lalu deteksi ulang saran
async function afterChange() {
  await Promise.all([loadAcct(), loadRepos()]); // loadRepos membuat ulang tampilan aktif
  await runDetect();
}

/* ------------------------------------------------------------------ render */
function accountCard(a) {
  const hasKey = !!(a.ssh && a.ssh.identityFile);
  return html`<div class="card p-5" data-acct="${a.id}">
    <div class="flex items-start gap-3">
      ${iconBox(providerIcon(a.provider))}
      <div class="min-w-0 flex-1"><h4 class="truncate text-base font-semibold text-slate-800" title="${a.label}">${a.label}</h4>
        <p class="truncate text-sm text-slate-500">${a.host}${a.login ? html` · <span class="font-medium text-slate-700">@${a.login}</span>` : ''}</p></div>
      <div class="flex shrink-0 items-center gap-1.5">
        <button type="button" class="btn-outline btn-sm" data-do="check" title="Check the SSH connection">${icon('plug')}Check</button>
        <button type="button" class="btn-outline btn-sm" data-do="edit" title="Edit this account" aria-label="Edit ${a.label}">${icon('pencil-simple')}<span class="hidden sm:inline">Edit</span></button>
        <button type="button" class="btn-outline btn-sm w-8 px-0 text-danger-600" data-do="remove" title="Remove from list" aria-label="Remove ${a.label} from list">${icon('trash')}</button>
      </div>
    </div>
    <dl class="mt-4 space-y-2 text-sm">
      <div class="flex gap-3"><dt class="w-16 shrink-0 text-slate-500">Owners</dt><dd class="min-w-0">${ownersChips(a.owners)}</dd></div>
      <div class="flex gap-3"><dt class="w-16 shrink-0 text-slate-500">SSH</dt><dd class="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">${sshLabel(a.ssh)}${hasKey ? html`<button type="button" class="text-xs font-medium text-primary-600 hover:underline" data-do="pubkey">Public key</button>` : ''}</dd></div>
      <div class="flex gap-3"><dt class="w-16 shrink-0 text-slate-500">Repos</dt><dd>${a.repoCount ? plural(a.repoCount, 'remote') : html`<span class="text-slate-400">None assigned yet</span>`}</dd></div>
    </dl>
    <div class="mt-3 empty:mt-0" data-check-out>${checkOut(a)}</div>
  </div>`;
}

function checkOut(a) {
  const c = ui.checks[a.id];
  if (!c) return '';
  if (c.busy) return html`<p class="flex items-center gap-2 text-sm text-slate-500">${icon('circle-notch', 'h-4 w-4 animate-spin')}Checking the connection…</p>`;
  const r = c.res || {};
  if (r.ok) return html`<p class="flex items-start gap-2 rounded-lg bg-success-50 px-3 py-2 text-sm text-success-700">${icon('check-circle', 'mt-0.5 h-4 w-4 shrink-0')}<span>${r.login ? html`Connected as <b>${r.login}</b>` : 'Connected (the server did not say which account this is)'}</span></p>`;
  return html`<div class="rounded-lg bg-danger-50 px-3 py-2.5 text-sm text-danger-700"><p class="flex items-start gap-2">${icon('warning-circle', 'mt-0.5 h-4 w-4 shrink-0')}<span>${r.error}</span></p>
    ${r.code === 'HOST_KEY' ? html`<button type="button" class="btn-outline btn-sm mt-2.5" data-do="trust">${icon('shield-check', 'h-3.5 w-3.5')}Review host key</button>` : ''}
    ${r.code === 'AUTH' && a.ssh && a.ssh.identityFile ? html`<button type="button" class="btn-outline btn-sm mt-2.5" data-do="pubkey">${icon('key', 'h-3.5 w-3.5')}Show public key</button>` : ''}</div>`;
}

function accountsSection() {
  const list = state.acct.list;
  return html`<section class="space-y-4">
    <div><h3 class="text-lg font-semibold text-slate-800">Your accounts</h3><p class="text-sm text-slate-500">Repos are grouped by the account of each remote. Check connects with <span class="kbd-ref">ssh -T</span> and reads the account name; no token is used.</p></div>
    ${list.length ? html`<div class="grid gap-5 xl:grid-cols-2">${list.map(accountCard)}</div>` : html`<div class="card flex flex-col items-center px-6 py-12 text-center"><span class="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary-50 text-primary-600">${icon('identification-card', 'h-6 w-6')}</span><h4 class="mt-3 text-base font-semibold text-slate-800">No accounts yet</h4><p class="mt-1 max-w-lg text-sm text-slate-500">An account is a provider, a host, optionally the owners it covers, and optionally an SSH identity. Add the ones detected below, or create one yourself.</p><button type="button" class="btn-primary btn-md mt-5" data-do="add">${icon('plus')}Add account</button></div>`}
  </section>`;
}

function suggestionRow(s) {
  const repos = s.repoCount ? `${plural(s.repoCount, 'repo')}: ${s.repos.join(', ')}${s.repoCount > s.repos.length ? ', …' : ''}` : 'No repos use it yet';
  return html`<div class="flex flex-wrap items-center gap-3 rounded-xl border border-border p-3.5" data-sug="${s.key}">
    ${iconBox(providerIcon(s.provider))}
    <div class="min-w-0 flex-1 space-y-1">
      <p class="truncate font-medium text-slate-800" title="${s.label}">${s.label}</p>
      <p class="text-xs text-slate-500">${s.host}${s.login ? html` · @${s.login}` : ''} · ${s.source === 'ssh-config' ? 'from your ssh config' : 'from your repos'}</p>
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">${s.owners.length ? ownersChips(s.owners) : html`<span>All owners</span>`}<span class="truncate" title="${repos}">${repos}</span></div>
      <p class="flex flex-wrap items-center gap-1.5 text-xs text-slate-500">${icon('key', 'h-3.5 w-3.5 text-slate-400')}${s.ssh ? sshLabel(s.ssh) : 'No SSH identity found'}</p>
    </div>
    <button type="button" class="btn-outline btn-sm" data-do="sug-add">${icon('plus', 'h-3.5 w-3.5')}Add</button>
  </div>`;
}

function detectedSection() {
  const d = ui.detect;
  const head = html`<div class="flex flex-wrap items-center justify-between gap-3">
    <div><h3 class="text-lg font-semibold text-slate-800">Detected on this computer</h3><p class="text-sm text-slate-500">Found in your ssh folder, your ssh config, the GitHub CLI and your repos. Nothing changes until you add it. Private keys are never opened.</p></div>
    <div class="flex shrink-0 gap-2"><button type="button" class="btn-outline btn-sm" data-do="refresh" ${ui.detecting ? 'disabled' : ''}>${icon('arrows-clockwise', `h-3.5 w-3.5 ${ui.detecting ? 'animate-spin' : ''}`)}Refresh</button></div></div>`;
  if (!d) return html`<section class="space-y-4">${head}${ui.detectError ? html`<div class="callout-warning flex items-start gap-3">${icon('warning', 'mt-0.5 h-4 w-4 shrink-0 text-warning-600')}<p class="text-sm">${ui.detectError}</p></div>` : html`<div class="card px-6 py-10 text-center text-sm text-slate-500">${icon('circle-notch', 'mr-2 inline h-4 w-4 animate-spin')}Looking at your ssh folder, ssh config and GitHub CLI…</div>`}</section>`;
  const sug = d.suggestions || [];
  const fp = (k) => html`<span class="font-mono text-xs text-slate-500" title="${k.fingerprint}">${shortFp(k.fingerprint)}</span>`;
  return html`<section class="space-y-4">
    ${head}
    ${ui.detectError ? html`<div class="callout-warning flex items-start gap-3">${icon('warning', 'mt-0.5 h-4 w-4 shrink-0 text-warning-600')}<p class="text-sm">Could not refresh: ${ui.detectError}</p></div>` : ''}
    <div class="card p-5 sm:p-6">
      <div class="mb-3 flex flex-wrap items-center justify-between gap-2"><p class="text-sm font-semibold text-slate-800">Suggested accounts</p>${sug.length ? html`<button type="button" class="btn-outline btn-sm" data-do="sug-all">${icon('plus', 'h-3.5 w-3.5')}Add all (${sug.length})</button>` : ''}</div>
      ${sug.length ? html`<div class="space-y-3" data-suggestions>${sug.map(suggestionRow)}</div>` : html`<p class="text-sm text-slate-500" data-no-suggestions>No new accounts detected. Everything found on this computer is already in your list.</p>`}
    </div>
    <div class="card space-y-3 p-5 sm:p-6">
      <div class="flex flex-wrap items-center justify-between gap-2"><p class="text-sm font-semibold text-slate-800">SSH folder</p><span class="min-w-0 truncate font-mono text-xs text-slate-500" title="${d.sshDir}" data-ssh-dir>${d.sshDir}</span></div>
      ${!d.sshDirExists ? html`<div class="callout-info flex items-start gap-3">${icon('info', 'mt-0.5 h-4 w-4 shrink-0 text-info-600')}<p class="text-sm text-slate-600">This folder does not exist yet. It is created when you create your first key here.</p></div>` : ''}
      ${d.hasInclude ? html`<div class="callout-warning flex items-start gap-3">${icon('warning', 'mt-0.5 h-4 w-4 shrink-0 text-warning-600')}<p class="text-sm text-slate-600">Include lines in your ssh config are not followed, so hosts and keys defined in included files are not listed here.</p></div>` : ''}
    </div>
    <div class="grid gap-5 lg:grid-cols-2">
      <div class="card p-5 sm:p-6"><p class="mb-3 text-sm font-semibold text-slate-800">Public keys found</p>
        ${d.keys.length ? html`<ul class="space-y-2.5" data-keys>${d.keys.map((k) => html`<li class="rounded-xl border border-border p-3"><div class="flex flex-wrap items-center gap-2"><span class="font-mono text-xs font-medium text-slate-800">${k.file}</span>${badge('neutral', k.type)}${k.hasPrivate ? '' : html`<span title="Only the .pub file is here. ssh cannot use this key without its private file.">${badge('warning', 'No private key', 'warning')}</span>`}</div><p class="mt-1 text-xs text-slate-500">${fp(k)}${k.comment ? html` · ${k.comment}` : ''}</p></li>`)}</ul>` : html`<p class="text-sm text-slate-500">No public keys (*.pub) in the ssh folder.</p>`}</div>
      <div class="space-y-5">
        <div class="card p-5 sm:p-6"><p class="mb-3 text-sm font-semibold text-slate-800">SSH hosts found</p>
          ${d.hosts.length ? html`<ul class="space-y-2" data-hosts>${d.hosts.map((h) => html`<li class="text-sm"><span class="font-mono text-xs font-medium text-slate-800">${h.alias}</span><span class="text-slate-400"> → </span><span class="font-mono text-xs text-slate-600">${h.user ? `${h.user}@` : ''}${h.hostName}${h.port ? `:${h.port}` : ''}</span>${h.identityFile ? html`<span class="block text-xs text-slate-500">key ${h.identityFile}</span>` : ''}</li>`)}</ul>` : html`<p class="text-sm text-slate-500">No Host entries in your ssh config.</p>`}</div>
        <div class="card p-5 sm:p-6"><p class="mb-3 text-sm font-semibold text-slate-800">GitHub CLI logins</p>
          ${d.gh.length ? html`<ul class="space-y-2" data-gh>${d.gh.map((g) => html`<li class="flex items-center gap-2 text-sm">${icon('github-logo', 'h-4 w-4 text-slate-400')}<span class="font-medium text-slate-800">${g.login}</span><span class="text-xs text-slate-500">on ${g.host}</span>${g.active ? badge('success', 'Active') : ''}</li>`)}</ul>` : html`<p class="text-sm text-slate-500">No GitHub CLI logins found.</p>`}</div>
      </div>
    </div>
  </section>`;
}

function render() {
  if (!host) return;
  setHtml(host, html`
    <div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div class="min-w-0"><h2 class="font-display text-2xl font-bold text-slate-900 sm:text-3xl">Accounts</h2><p class="mt-1 text-sm text-slate-500">Use more than one GitHub, GitLab or other git account. Each account can have its own SSH key, found in or added to your <span class="kbd-ref">~/.ssh</span> folder.</p></div>
      <div class="flex shrink-0 gap-2.5"><button type="button" class="btn-primary btn-md" data-do="add">${icon('plus')}Add account</button></div>
    </div>
    ${accountsSection()}
    ${detectedSection()}`);
}

/* ------------------------------------------------------------------ mount */
export function mount(el) {
  host = el; render();
  host.addEventListener('click', onClick);
  offs = [bus.on('acct', () => { if (host) render(); })];
  if (!ui.detecting && (!ui.detect || Date.now() - ui.detectAt > 15000)) runDetect();
}
export function unmount() { offs.forEach((f) => f()); offs = []; host = null; }

async function onClick(e) {
  const b = e.target.closest('[data-do]');
  if (!b) return;
  const act = b.dataset.do;
  const holder = b.closest('[data-acct]');
  const id = holder ? holder.dataset.acct : null;
  if (act === 'add') return openWizard();
  if (act === 'refresh') return runDetect();
  if (act === 'check') return checkAccount(id);
  if (act === 'edit') return openEdit(id);
  if (act === 'remove') return removeAccount(id);
  if (act === 'pubkey') return showPublicKey(id);
  if (act === 'trust') { const a = acctById(id); if (a && await trustHostDialog({ host: a.host, port: a.ssh && a.ssh.port, provider: a.provider })) checkAccount(id); return; }
  const sug = b.closest('[data-sug]');
  if (act === 'sug-add' && sug) return addSuggestion(sug.dataset.sug);
  if (act === 'sug-all') return addAllSuggestions();
}

/* ------------------------------------------------------------------ cek koneksi */
async function checkAccount(id) {
  const a = acctById(id);
  if (!a) return;
  ui.checks[id] = { busy: true }; render();
  const res = await call('acct:check', { id }, { silent: true });
  ui.checks[id] = { res };
  // login yang belum tersimpan diisi dari jawaban server
  if (res.ok && res.login && !a.login) {
    const s = await call('acct:save', { account: { ...acctPayload(a), login: res.login } }, { silent: true });
    if (s.ok) await loadAcct();
  }
  render();
}

async function showPublicKey(id) {
  const a = acctById(id);
  const file = a && a.ssh && a.ssh.identityFile;
  if (!file) return;
  const r = await call('ssh:publicKey', { file: `${file}.pub` });
  if (!r.ok) return;
  const d = dialog({ title: `Public key · ${a.label}`, description: `${file}.pub`, size: 'modal-lg',
    body: html`<p class="mb-3 text-sm text-slate-600">This is the public half of the key. It is safe to share: add it to your account on ${a.host}. The private key stays in your ssh folder and is never read by this app.</p>${keyPanel({ ...r, provider: a.provider, host: a.host })}`,
    footer: html`<button type="button" class="btn-primary btn-md" data-dialog-close>Close</button>` });
  bindKeyPanel(d.body());
}

// konfirmasi sederhana dengan tombol merah (confirmDialog bawaan menambah catatan "mengubah repo di luar komputer")
async function confirmRemove(a) {
  const d = dialog({ title: `Remove "${a.label}" from the list?`, size: 'modal-md',
    body: html`<p class="text-sm text-slate-600">This only removes the entry from this app.${a.repoCount ? ` The ${plural(a.repoCount, 'remote')} assigned to it will become unassigned.` : ''} <b>Your repos, folders, SSH keys and ssh config are not touched.</b></p>`,
    footer: html`<button type="button" class="btn-outline btn-md" data-dialog-close>Cancel</button><button type="button" class="btn-danger btn-md" data-confirm>${icon('trash')}Remove from list</button>` });
  d.$('[data-confirm]').addEventListener('click', () => d.close(true));
  return (await d.closed) === true;
}

async function removeAccount(id) {
  const a = acctById(id);
  if (!a || !(await confirmRemove(a))) return;
  const res = await call('acct:remove', { id });
  if (!res.ok) return;
  delete ui.checks[id];
  notify('success', `"${a.label}" removed from the list.`);
  afterChange();
}

/* ------------------------------------------------------------------ saran terdeteksi */
const sugPayload = (s) => ({ label: s.label, provider: s.provider, host: s.host, login: s.login || '', owners: s.owners || [], ssh: s.ssh || null });

async function addSuggestion(key) {
  const s = ((ui.detect && ui.detect.suggestions) || []).find((x) => x.key === key);
  if (!s) return;
  const res = await call('acct:save', { account: sugPayload(s) });
  if (!res.ok) return;
  notify('success', `Added "${res.account.label}"${res.assigned ? `; ${plural(res.assigned, 'remote')} assigned` : ''}.`);
  afterChange();
}

async function addAllSuggestions() {
  const list = (ui.detect && ui.detect.suggestions) || [];
  if (!list.length) return;
  const d = dialog({ title: `Add ${plural(list.length, 'account')}?`, size: 'modal-lg',
    body: html`<p class="mb-3 text-sm text-slate-600">These accounts will be added to this app. Nothing is written to your ssh folder, and your repos are not changed apart from being grouped by account.</p><ul class="space-y-1.5 text-sm">${list.map((s) => html`<li class="flex items-center gap-2">${icon(providerIcon(s.provider), 'h-4 w-4 text-slate-400')}<span class="font-medium text-slate-800">${s.label}</span><span class="text-xs text-slate-500">${s.host}${s.owners.length ? ` · ${s.owners.join(', ')}` : ''}</span></li>`)}</ul>`,
    footer: html`<button type="button" class="btn-outline btn-md" data-dialog-close>Cancel</button><button type="button" class="btn-primary btn-md" data-confirm>${icon('plus')}Add all</button>` });
  d.$('[data-confirm]').addEventListener('click', () => d.close(true));
  if ((await d.closed) !== true) return;
  let n = 0, assigned = 0; const errs = [];
  for (const s of list) {
    const r = await call('acct:save', { account: sugPayload(s) }, { silent: true });
    if (r.ok) { n++; assigned += r.assigned || 0; } else errs.push(`${s.label}: ${r.error}`);
  }
  notify(errs.length ? 'warning' : 'success', errs.length ? `${plural(n, 'account')} added, ${errs.length} failed: ${errs[0]}` : `${plural(n, 'account')} added${assigned ? `; ${plural(assigned, 'remote')} assigned` : ''}.`);
  afterChange();
}

/* ------------------------------------------------------------------ ubah akun */
function openEdit(id) {
  const a = acctById(id);
  if (!a) return;
  const found = ((ui.detect && ui.detect.keys) || []).filter((k) => k.hasPrivate).map((k) => privFile(k.file));
  const cur = (a.ssh && a.ssh.identityFile) || '';
  const options = [...new Set([...(cur ? [cur] : []), ...found])];
  const d = dialog({ title: `Edit ${a.label}`, description: `${PROVIDER_LABEL[a.provider]} · ${a.host}`, size: 'modal-lg',
    body: html`<form class="space-y-4" data-form autocomplete="off">
      <div class="grid gap-4 sm:grid-cols-2">
        <div><label class="form-label" for="e-label">Label</label><input id="e-label" name="label" class="input" value="${a.label}" /></div>
        <div><label class="form-label" for="e-host">Host</label><input id="e-host" name="host" class="input font-mono text-xs" value="${a.host}" disabled /><p class="form-hint">The host cannot be changed. Remove the account and add it again to use another host.</p></div>
        <div class="sm:col-span-2"><label class="form-label" for="e-owners">Owners (optional)</label><input id="e-owners" name="owners" class="input font-mono text-xs" value="${(a.owners || []).join(', ')}" placeholder="foxtrot-sevima, my-org" /><p class="form-hint">Names of the users or organizations this account covers, comma separated. Leave empty to cover all owners on this host. Remotes that are already assigned keep their account.</p></div>
        <div><label class="form-label" for="e-login">Login (optional)</label><input id="e-login" name="login" class="input" value="${a.login || ''}" /></div>
        <div></div>
        <div><label class="form-label" for="e-alias">SSH alias</label><input id="e-alias" name="alias" class="input font-mono text-xs" value="${(a.ssh && a.ssh.alias) || ''}" placeholder="${a.host}" /><p class="form-hint">The Host name in your ssh config. This only changes what the app remembers; your ssh config is not edited.</p></div>
        <div><label class="form-label" for="e-key">Key file</label><select id="e-key" name="identityFile" class="input"><option value="">No key file</option>${options.map((f) => html`<option value="${f}" ${f === cur ? 'selected' : ''}>${f}${found.includes(f) ? '' : ' (not found in the ssh folder)'}</option>`)}</select><p class="form-hint">Private key file name inside your ssh folder.</p></div>
      </div>
      <p class="hidden rounded-lg bg-danger-50 p-3 text-sm text-danger-700" data-error></p>
    </form>`,
    footer: html`<button type="button" class="btn-outline btn-md" data-dialog-close>Cancel</button><button type="button" class="btn-primary btn-md" data-save>${icon('check')}Save changes</button>` });
  const form = d.$('[data-form]');
  form.addEventListener('submit', (e) => e.preventDefault());
  const val = (n) => form.elements[n].value.trim();
  d.$('[data-save]').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const err = d.$('[data-error]'); err.classList.add('hidden');
    const alias = val('alias'), identityFile = val('identityFile');
    const account = { ...acctPayload(a), label: val('label'), login: val('login'), owners: val('owners').split(/[,\s]+/).map((x) => x.trim()).filter(Boolean), ssh: alias || identityFile ? { alias, identityFile, ...(a.ssh && a.ssh.port ? { port: a.ssh.port } : {}) } : null };
    btn.disabled = true;
    const res = await call('acct:save', { account }, { silent: true });
    if (!res.ok) { err.textContent = res.error; err.classList.remove('hidden'); btn.disabled = false; return; }
    d.close(true);
    notify('success', `"${res.account.label}" saved${res.assigned ? `; ${plural(res.assigned, 'remote')} assigned` : ''}.`);
    afterChange();
  });
}

/* ------------------------------------------------------------------ wizard tambah akun */
async function openWizard() {
  if (!ui.detect && !ui.detecting) await runDetect();
  const det = ui.detect || { keys: [], hosts: [], sshDir: '~/.ssh' };
  const hosts = det.hosts || [];
  const keys = (det.keys || []).filter((k) => k.hasPrivate);
  const aliasEntry = (a) => hosts.find((h) => h.alias.toLowerCase() === String(a).toLowerCase()) || null;

  const w = { v: null, touched: {}, plan: null, created: null, hostDone: false, backup: null, wrote: false, tested: null, saving: false };

  /* ---- nilai bawaan yang mengikuti isian (sampai pengguna mengetiknya sendiri) ---- */
  const defaultLabel = (v) => {
    const owner = String(v.owners).split(/[,\s]+/).filter(Boolean)[0];
    return `${PROVIDER_LABEL[v.provider]} · ${owner || v.host || 'account'}`;
  };
  const suggestAlias = (v) => {
    if (v.mode === 'existing' && v.keyFile) {
      const h = hosts.find((x) => x.hostName.toLowerCase() === v.host && x.identityFile === v.keyFile);
      if (h) return h.alias;
    }
    const base = v.host || 'host';
    if (!aliasEntry(base)) return base;
    const s = slug(v.label) || 'account';
    let alias = `${base}-${s}`.slice(0, 90), n = 2;
    while (aliasEntry(alias)) alias = `${base}-${s}-${n++}`;
    return alias;
  };
  w.v = { provider: 'github', host: 'github.com', label: '', owners: '', login: '', mode: 'none', keyFile: keys[0] ? privFile(keys[0].file) : '', keyName: '', alias: '', port: '' };
  w.v.label = defaultLabel(w.v); w.v.keyName = slug(w.v.label); w.v.alias = suggestAlias(w.v);

  const d = dialog({ title: 'Add account', description: 'An account groups your repos by provider, host and owner. An SSH identity is optional.', size: 'modal-xl', body: '', footer: '' });
  d.closed.then(() => { if (w.wrote) runDetect(); }); // kunci/alias baru ikut tampil di daftar deteksi
  const on = (sel, fn) => { const el = d.$(sel); if (el) el.addEventListener('click', fn); return el; };
  const footEl = () => d.el.querySelector('[data-dialog-footer]');
  const inDir = (f) => `${det.sshDir}${det.sshDir.includes('\\') ? '\\' : '/'}${f}`; // nama berkas di dalam folder ssh

  /* ---- langkah 1: formulir ---- */
  const radio = (value, title, hint, extra, disabled) => html`<label class="flex items-start gap-3 rounded-xl border border-border p-3.5 has-[>input:checked]:border-primary-300 has-[>input:checked]:bg-primary-50/40 ${disabled ? 'opacity-60' : 'cursor-pointer'}"><input type="radio" name="mode" value="${value}" class="form-radio mt-0.5" ${w.v.mode === value ? 'checked' : ''} ${disabled ? 'disabled' : ''} /><span class="min-w-0 flex-1"><span class="block font-medium text-slate-800">${title}</span><span class="block text-xs text-slate-500">${hint}</span>${extra || ''}</span></label>`;

  function showForm(error) {
    const v = w.v;
    d.setTitle('Add account');
    d.setBody(html`<form class="space-y-6" data-form autocomplete="off">
      <section class="grid gap-4 sm:grid-cols-2">
        <div><label class="form-label" for="w-provider">Provider</label><select id="w-provider" name="provider" class="input"><option value="github" ${v.provider === 'github' ? 'selected' : ''}>GitHub</option><option value="gitlab" ${v.provider === 'gitlab' ? 'selected' : ''}>GitLab</option><option value="other" ${v.provider === 'other' ? 'selected' : ''}>Other git host</option></select></div>
        <div><label class="form-label" for="w-host">Host</label><input id="w-host" name="host" class="input font-mono text-xs" value="${v.host}" placeholder="git.example.com" /></div>
        <div><label class="form-label" for="w-label">Label</label><input id="w-label" name="label" class="input" value="${v.label}" /></div>
        <div><label class="form-label" for="w-login">Login (optional)</label><input id="w-login" name="login" class="input" value="${v.login}" placeholder="your username on this host" /></div>
        <div class="sm:col-span-2"><label class="form-label" for="w-owners">Owners (optional)</label><input id="w-owners" name="owners" class="input font-mono text-xs" value="${v.owners}" placeholder="foxtrot-sevima, my-org" /><p class="form-hint">Names of the users or organizations this account covers, comma separated, for example <span class="kbd-ref">foxtrot-sevima</span>. Leave empty to cover all owners on that host.</p></div>
      </section>
      <section><p class="mb-2.5 text-sm font-semibold text-slate-800">SSH identity</p>
        <div class="space-y-2.5">
          ${radio('none', 'No SSH identity', 'Keep using HTTPS with your existing git login. Nothing is written to your ssh folder.')}
          ${radio('existing', 'Use an existing key', keys.length ? 'Pick a key that is already in your ssh folder.' : 'No key with a private file was found in your ssh folder.', keys.length ? html`<span class="mt-2 block ${v.mode === 'existing' ? '' : 'hidden'}" data-extra="existing"><select name="keyFile" class="input h-9" aria-label="Existing key">${keys.map((k) => html`<option value="${privFile(k.file)}" ${privFile(k.file) === v.keyFile ? 'selected' : ''}>${privFile(k.file)} · ${k.type} · ${shortFp(k.fingerprint)}</option>`)}</select></span>` : '', !keys.length)}
          ${radio('new', 'Create a new key', 'Creates a new ed25519 key pair in your ssh folder. Existing keys are never overwritten.', html`<span class="mt-2 block ${v.mode === 'new' ? '' : 'hidden'}" data-extra="new"><label class="form-label" for="w-keyname">Key name</label><span class="flex items-center gap-2"><span class="font-mono text-xs text-slate-500">id_ed25519_</span><input id="w-keyname" name="keyName" class="input h-9 flex-1 font-mono text-xs" value="${v.keyName}" /></span></span>`)}
        </div>
        <div class="mt-4 grid gap-4 sm:grid-cols-2 ${v.mode === 'none' ? 'hidden' : ''}" data-ssh-fields>
          <div><label class="form-label" for="w-alias">SSH alias</label><input id="w-alias" name="alias" class="input font-mono text-xs" value="${v.alias}" /><p class="form-hint" data-alias-note></p></div>
          <div><label class="form-label" for="w-port">SSH port (optional)</label><input id="w-port" name="port" class="input font-mono text-xs" value="${v.port}" placeholder="22" inputmode="numeric" /><p class="form-hint">Only for servers that do not listen on port 22.</p></div>
        </div>
      </section>
      <p class="${error ? '' : 'hidden'} rounded-lg bg-danger-50 p-3 text-sm text-danger-700" data-error>${error || ''}</p>
    </form>`);
    d.setFooter(html`<button type="button" class="btn-outline btn-md" data-dialog-close>Cancel</button><button type="button" class="btn-primary btn-md" data-next>${icon('arrow-right')}<span data-next-label>${v.mode === 'none' ? 'Save account' : 'Continue'}</span></button>`);
    bindForm();
  }

  const form = () => d.$('[data-form]');
  const read = () => {
    const f = form().elements;
    return { provider: f.provider.value, host: f.host.value.trim().toLowerCase(), label: f.label.value.trim(), owners: f.owners.value.trim(), login: f.login.value.trim(), mode: f.mode.value, keyFile: f.keyFile ? f.keyFile.value : '', keyName: f.keyName.value.trim(), alias: f.alias.value.trim(), port: f.port.value.trim() };
  };

  function bindForm() {
    const f = form();
    f.addEventListener('submit', (e) => e.preventDefault());
    const t = w.touched;
    const refresh = () => {
      const v = read();
      f.querySelectorAll('[data-extra]').forEach((x) => x.classList.toggle('hidden', x.dataset.extra !== v.mode));
      d.$('[data-ssh-fields]').classList.toggle('hidden', v.mode === 'none');
      d.$('[data-next-label]').textContent = v.mode === 'none' ? 'Save account' : 'Continue';
      const e = aliasEntry(v.alias);
      const note = d.$('[data-alias-note]');
      note.className = `form-hint ${e && v.mode === 'new' ? 'text-danger-600' : ''}`;
      note.textContent = !v.alias ? 'Used in git URLs, for example git@alias:owner/repo.git.'
        : e ? (v.mode === 'new' ? 'This alias already exists in your ssh config. Choose another one.' : `Already in your ssh config (${e.hostName}${e.identityFile ? `, key ${e.identityFile}` : ''}). It is used as it is; nothing is added.`)
          : 'A new Host entry with this alias will be added to your ssh config.';
    };
    const auto = () => {
      const v = read();
      if (!t.label) f.elements.label.value = defaultLabel(v);
      const lab = f.elements.label.value;
      if (!t.keyName) f.elements.keyName.value = slug(lab);
      if (!t.alias) f.elements.alias.value = suggestAlias({ ...v, label: lab });
      refresh();
    };
    f.addEventListener('input', (e) => {
      const n = e.target.name;
      if (n === 'label' || n === 'keyName' || n === 'alias') t[n] = true;
      if (n === 'host' || n === 'owners' || n === 'label' || n === 'keyName') auto(); else refresh();
    });
    f.addEventListener('change', (e) => {
      const n = e.target.name;
      if (n === 'provider') {
        const prev = w.v.provider, v = read();
        if (!v.host || v.host === defaultHost(prev)) f.elements.host.value = defaultHost(v.provider);
        w.v.provider = v.provider;
      }
      auto();
    });
    auto();
    on('[data-next]', next);
  }

  /* ---- validasi + rencana ---- */
  function validate(v) {
    if (!v.label) return 'Give the account a label.';
    if (!HOST_RE.test(v.host)) return 'Enter the host, for example github.com.';
    const owners = v.owners.split(/[,\s]+/).filter(Boolean).map((o) => o.toLowerCase());
    if (owners.some((o) => !OWNER_RE.test(o))) return 'Owners may only use letters, digits, dot, dash and underscore.';
    const ownerSig = [...new Set(owners)].sort().join(',');
    const clash = state.acct.list.find((a) => a.label.toLowerCase() === v.label.toLowerCase());
    if (clash) return `An account named "${clash.label}" already exists. Choose another label.`;
    const sig = state.acct.list.find((a) => a.host === v.host && [...(a.owners || [])].sort().join(',') === ownerSig);
    if (sig) return `The account "${sig.label}" already covers this host and these owners.`;
    if (v.login && !/^[\w.@-]+$/.test(v.login)) return 'Login contains characters that are not allowed.';
    if (v.mode === 'none') return null;
    if (v.port && !(Number.isInteger(Number(v.port)) && Number(v.port) >= 1 && Number(v.port) <= 65535)) return 'The SSH port must be a number between 1 and 65535.';
    if (!ALIAS_RE.test(v.alias)) return 'The SSH alias may only use letters, digits, dot, dash and underscore, and must start with a letter or digit.';
    const e = aliasEntry(v.alias);
    if (v.mode === 'existing') {
      if (!v.keyFile) return 'Pick an existing key.';
      if (e && e.hostName.toLowerCase() !== v.host) return `The alias "${v.alias}" already points to ${e.hostName}, not ${v.host}. Choose another alias.`;
      if (e && e.identityFile && e.identityFile !== v.keyFile) return `The alias "${v.alias}" already uses the key ${e.identityFile} in your ssh config. Pick that key or choose another alias.`;
    } else {
      if (!NAME_RE.test(v.keyName) || v.keyName.length > 50) return 'Key name may only use letters, digits, dot, dash and underscore (up to 50 characters).';
      if (e) return `The ssh config already has a Host named "${v.alias}". Choose another alias; existing entries are never changed.`;
      if ((det.keys || []).some((k) => privFile(k.file) === `id_ed25519_${v.keyName}`)) return `A key named id_ed25519_${v.keyName} already exists. Choose another name; existing keys are never overwritten.`;
    }
    return null;
  }

  const planOf = (v) => {
    const identityFile = v.mode === 'new' ? `id_ed25519_${v.keyName}` : v.keyFile;
    return { identityFile, createKey: v.mode === 'new', addHost: v.mode !== 'none' && !aliasEntry(v.alias), comment: `${v.keyName}@repo-hub`, port: v.port ? Number(v.port) : undefined };
  };

  function accountPayload() {
    const v = w.v;
    const login = v.login || (w.tested && w.tested.ok && w.tested.login) || '';
    return { label: v.label, provider: v.provider, host: v.host, login, owners: v.owners.split(/[,\s]+/).filter(Boolean).map((o) => o.toLowerCase()), ssh: v.mode === 'none' ? null : { alias: v.alias, identityFile: w.plan.identityFile, ...(w.plan.port && w.plan.port !== 22 ? { port: w.plan.port } : {}) } };
  }

  async function save(btn, errSel) {
    if (w.saving) return;
    w.saving = true; if (btn) btn.disabled = true; d.lock(true);
    const res = await call('acct:save', { account: accountPayload() }, { silent: true });
    d.lock(false); w.saving = false;
    if (!res.ok) {
      const err = d.$(errSel); if (err) { err.textContent = res.error; err.classList.remove('hidden'); }
      if (btn) btn.disabled = false;
      return;
    }
    w.wrote = false; d.close(true);
    notify('success', `Account "${res.account.label}" added${res.assigned ? `; ${plural(res.assigned, 'remote')} assigned` : ''}.`);
    afterChange();
  }

  async function next() {
    const v = read();
    w.v = v;
    const problem = validate(v);
    if (problem) { const err = d.$('[data-error]'); err.textContent = problem; err.classList.remove('hidden'); return; }
    w.plan = planOf(v);
    if (v.mode === 'none') return save(d.$('[data-next]'), '[data-error]');
    if (!w.plan.createKey && !w.plan.addHost) return showConnect(); // nada yang ditulis: tidak perlu pratinjau
    showReview();
  }

  /* ---- langkah 2: pratinjau (wajib sebelum menulis) ---- */
  function showReview(error) {
    const v = w.v, p = w.plan;
    const block = hostBlock({ alias: v.alias, host: v.host, port: p.port, identityFile: p.identityFile, label: v.label });
    const pendingKey = p.createKey && !w.created, pendingHost = p.addHost && !w.hostDone;
    const label = pendingKey && pendingHost ? 'Create key and add to ssh config' : pendingHost ? 'Add to ssh config' : 'Create key';
    d.setTitle('Review what will be written');
    d.setBody(html`<div class="space-y-4" data-review>
      <p class="text-sm text-slate-600">${w.created || w.hostDone ? 'Part of this is already done. Confirm to finish the rest.' : 'Nothing has been written yet. When you confirm, Repo Hub does exactly the following and nothing else.'}</p>
      ${p.createKey ? html`<div class="rounded-xl border border-border p-4" data-step-key>
        <p class="flex items-center gap-2 font-medium text-slate-800">${icon('key', 'h-4 w-4 text-slate-500')}Create a new SSH key pair${w.created ? badge('success', 'Done', 'check') : ''}</p>
        <ul class="mt-2 space-y-1 text-xs text-slate-600"><li>Private key: <span class="font-mono text-slate-800" data-file="private">${inDir(`id_ed25519_${v.keyName}`)}</span></li><li>Public key: <span class="font-mono text-slate-800" data-file="public">${inDir(`id_ed25519_${v.keyName}.pub`)}</span></li><li>Type ed25519, comment <span class="font-mono">${p.comment}</span>. No existing key is overwritten; if a file with that name exists, nothing is written.</li><li>The private key is created without a passphrase and stays in your ssh folder. This app never reads or shows it.</li></ul></div>` : ''}
      ${p.addHost ? html`<div class="rounded-xl border border-border p-4" data-step-host>
        <p class="flex items-center gap-2 font-medium text-slate-800">${icon('terminal-window', 'h-4 w-4 text-slate-500')}Add this Host entry to your ssh config${w.hostDone ? badge('success', 'Done', 'check') : ''}</p>
        <pre class="hub-console mt-2.5" style="max-height:12rem" data-block>${block}</pre>
        <ul class="mt-2 space-y-1 text-xs text-slate-600"><li>File: <span class="font-mono text-slate-800">${inDir('config')}</span>. The entry is appended at the end; existing lines are not changed.</li><li>The current <span class="font-mono">config</span> is backed up first as <span class="font-mono">config.bak-&lt;date&gt;</span>${w.backup ? html` (<span class="font-mono">${w.backup}</span>)` : ''}. If there is no config file yet, it is created.</li></ul></div>` : html`<div class="rounded-xl border border-border p-4 text-xs text-slate-600"><p class="flex items-center gap-2 text-sm font-medium text-slate-800">${icon('terminal-window', 'h-4 w-4 text-slate-500')}ssh config stays as it is</p><p class="mt-1">The alias <span class="font-mono">${v.alias}</span> already exists, so it is used as it is.</p></div>`}
      <p class="text-xs text-slate-500">Not touched: your other keys, your known_hosts file (it only changes if you review and trust a host later) and your repos.</p>
      <p class="${error ? '' : 'hidden'} rounded-lg bg-danger-50 p-3 text-sm text-danger-700" data-error>${error || ''}</p>
    </div>`);
    // setelah kunci dibuat, isian tidak boleh diubah lagi (nama kunci sudah tertulis), jadi hanya bisa mencoba lagi
    d.setFooter(html`${w.created ? '' : html`<button type="button" class="btn-outline btn-md" data-back>${icon('arrow-left')}Back</button>`}<button type="button" class="btn-primary btn-md" data-write>${icon('check')}${label}</button>`);
    on('[data-back]', () => showForm());
    on('[data-write]', writePlan);
  }

  async function writePlan(e) {
    const btn = e.currentTarget, v = w.v, p = w.plan;
    btn.disabled = true; d.lock(true); const back = d.$('[data-back]'); if (back) back.disabled = true;
    const fail = (msg) => { d.lock(false); showReview(msg); };
    if (p.createKey && !w.created) {
      const r = await call('ssh:createKey', { name: v.keyName, comment: p.comment, provider: v.provider, host: v.host, confirmed: true }, { silent: true });
      if (!r.ok) return fail(r.error);
      w.created = r; w.wrote = true;
    }
    if (p.addHost && !w.hostDone) {
      const r = await call('ssh:addHost', { alias: v.alias, hostName: v.host, port: p.port, identityFile: p.identityFile, label: v.label, confirmed: true }, { silent: true });
      if (!r.ok) return fail(`${r.error}${w.created ? ' The key was created; fix the alias and try again.' : ''}`);
      w.hostDone = true; w.backup = r.backup; w.wrote = true;
    }
    d.lock(false);
    showConnect();
  }

  /* ---- langkah 3: tes koneksi + simpan ---- */
  function connectFooter() {
    const ok = !!(w.tested && w.tested.ok);
    d.setFooter(html`<button type="button" class="${ok ? 'btn-outline' : 'btn-primary'} btn-md" data-test>${icon('plug')}${w.tested ? 'Test again' : 'Test connection'}</button><span class="ml-auto"></span>${ok ? '' : html`<button type="button" class="btn-outline btn-md" data-save-untested>Save without testing</button>`}<button type="button" class="${ok ? 'btn-primary' : 'btn-outline'} btn-md" data-save ${ok ? '' : 'disabled'}>${icon('check')}Save account</button>`);
    on('[data-test]', runTest);
    on('[data-save-untested]', (e) => save(e.currentTarget, '[data-save-error]'));
    on('[data-save]', (e) => save(e.currentTarget, '[data-save-error]'));
  }

  function testOut() {
    const t = w.tested;
    if (!t) return '';
    if (t.busy) return html`<p class="flex items-center gap-2 text-sm text-slate-500">${icon('circle-notch', 'h-4 w-4 animate-spin')}Testing the connection…</p>`;
    if (t.ok) return html`<p class="flex items-start gap-2 rounded-lg bg-success-50 px-3 py-2 text-sm text-success-700" data-test-ok>${icon('check-circle', 'mt-0.5 h-4 w-4 shrink-0')}<span>${t.login ? html`Connected as <b>${t.login}</b>` : 'Connected (the server did not say which account this is)'}</span></p>`;
    return html`<div class="rounded-lg bg-danger-50 px-3 py-2.5 text-sm text-danger-700" data-test-fail><p class="flex items-start gap-2">${icon('warning-circle', 'mt-0.5 h-4 w-4 shrink-0')}<span>${t.error}</span></p>${t.code === 'HOST_KEY' ? html`<button type="button" class="btn-outline btn-sm mt-2.5" data-trust>${icon('shield-check', 'h-3.5 w-3.5')}Review host key</button>` : ''}${t.code === 'AUTH' ? html`<p class="mt-2 text-xs">Add the public key ${w.created ? 'above' : 'of this key'} to your ${PROVIDER_LABEL[w.v.provider] === 'Git' ? w.v.host : PROVIDER_LABEL[w.v.provider]} account, then test again.</p>${w.created ? '' : html`<button type="button" class="btn-outline btn-sm mt-2.5" data-show-key>${icon('key', 'h-3.5 w-3.5')}Show public key</button>`}` : ''}</div><div class="mt-3" data-test-key></div>`;
  }

  function showConnect() {
    const v = w.v, p = w.plan;
    d.setTitle('Test the connection and save');
    const keyBlock = w.created
      ? html`<section class="space-y-2"><p class="text-sm font-semibold text-slate-800">Your new public key</p><p class="text-sm text-slate-600">Add it to your ${v.provider === 'other' ? v.host : PROVIDER_LABEL[v.provider]} account so the server accepts this key. It is public and safe to share.</p>${keyPanel({ ...w.created, provider: v.provider, host: v.host })}</section>`
      : html`<p class="text-sm text-slate-600">Using the existing key <span class="font-mono text-slate-800">${p.identityFile}</span>. Test the connection to confirm your account accepts it.</p>`;
    d.setBody(html`<div class="space-y-5" data-connect>
      ${keyBlock}
      ${w.hostDone ? html`<p class="flex items-start gap-2 text-xs text-slate-500" data-host-done>${icon('check-circle', 'mt-0.5 h-3.5 w-3.5 shrink-0 text-success-600')}<span>Added <span class="font-mono">Host ${v.alias}</span> to your ssh config${w.backup ? html`; the previous config was saved as <span class="font-mono">${w.backup}</span>` : ''}.</span></p>` : ''}
      <dl class="grid gap-x-6 gap-y-1.5 rounded-xl border border-border p-4 text-sm sm:grid-cols-[auto_1fr]"><dt class="text-slate-500">Account</dt><dd class="font-medium text-slate-800">${v.label}</dd><dt class="text-slate-500">Host</dt><dd class="font-mono text-xs text-slate-700">${v.host}</dd><dt class="text-slate-500">Owners</dt><dd>${ownersChips(v.owners.split(/[,\s]+/).filter(Boolean))}</dd><dt class="text-slate-500">SSH</dt><dd>${sshLabel({ alias: v.alias, identityFile: p.identityFile, port: p.port })}</dd></dl>
      <div data-test-out>${testOut()}</div>
      <p class="hidden rounded-lg bg-danger-50 p-3 text-sm text-danger-700" data-save-error></p>
    </div>`);
    bindKeyPanel(d.body());
    connectFooter();
    bindTestOut();
  }

  function bindTestOut() {
    const out = d.$('[data-test-out]'); if (!out) return;
    setHtml(out, testOut());
    const sk = out.querySelector('[data-show-key]');
    if (sk) sk.addEventListener('click', async () => {
      const r = await call('ssh:publicKey', { file: `${w.plan.identityFile}.pub` });
      const box = out.querySelector('[data-test-key]');
      if (!r.ok || !box) return;
      setHtml(box, keyPanel({ ...r, provider: w.v.provider, host: w.v.host })); bindKeyPanel(box); sk.remove();
    });
    const tr = out.querySelector('[data-trust]');
    if (tr) tr.addEventListener('click', async () => {
      d.setTitle('Review host key');
      const trusted = await mountTrust(d.body(), footEl(), { host: w.v.host, port: w.plan.port, provider: w.v.provider });
      showConnect();
      if (trusted) runTest();
    });
  }

  async function runTest() {
    const p = w.plan;
    w.tested = { busy: true };
    const t = d.$('[data-test]'); if (t) t.disabled = true;
    const out = d.$('[data-test-out]'); if (out) setHtml(out, testOut());
    const res = await call('acct:check', { host: w.v.host, alias: w.v.alias, identityFile: p.identityFile, port: p.port }, { silent: true });
    w.tested = res;
    connectFooter();
    bindTestOut();
  }

  showForm();
  return d;
}
