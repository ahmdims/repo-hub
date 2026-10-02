// Pengaturan: akun GitHub (lewat gh), token GitLab (disimpan terenkripsi oleh OS), jaringan git, dan info aplikasi.
import { html, icon, badge, mount as setHtml } from '../lib/h.js';
import { notify, call, busy } from '../lib/ui.js';
import { state, loadAccounts } from '../state.js';

export const title = 'Settings';
let host = null, settings = { postBuffer: 1048576, useGitCredential: true }, canEncrypt = false, info = {};

const mb = (b) => `${(b / 1048576).toFixed(b >= 10485760 ? 0 : 1)} MB`;
const SOURCE_LABEL = { aplikasi: 'app', 'kredensial git': 'git credential' }; // sumber token dari main/auth.js; hanya tampilan

function render() {
  if (!host) return;
  const a = state.accounts;
  const gh = a && a.github;
  const hosts = a ? Object.entries(a.gitlab || {}) : [];
  setHtml(host, html`
    <div class="min-w-0"><h2 class="font-display text-2xl font-bold text-slate-900 sm:text-3xl">Settings</h2><p class="mt-1 text-sm text-slate-500">Account connections and git options. This app does not store a GitHub token; the GitLab token is stored encrypted by the operating system.</p></div>

    <div class="card p-5 sm:p-6">
      <div class="flex flex-wrap items-center justify-between gap-3"><div class="flex items-center gap-3"><span class="flex h-10 w-10 items-center justify-center rounded-xl bg-neutral-100 text-slate-700">${icon('github-logo', 'h-5 w-5')}</span><div><h3 class="text-base font-semibold text-slate-800">GitHub</h3><p class="text-sm text-slate-500">Uses the GitHub CLI (<span class="kbd-ref">gh</span>) login on this computer.</p></div></div>
        <button type="button" class="btn-outline btn-sm" data-recheck>${icon('arrows-clockwise', 'h-3.5 w-3.5')}Check again</button></div>
      <div class="mt-4">${!a ? html`<p class="text-sm text-slate-400">Checking…</p>` : gh.ok ? html`<div class="flex items-center gap-2">${badge('success', 'Connected', 'check-circle')}<span class="text-sm text-slate-700">as <b>${gh.login}</b></span></div>` : html`<div class="callout-warning flex items-start gap-3">${icon('warning', 'h-4 w-4 shrink-0 text-warning-600')}<div class="text-sm"><p>${gh.error || 'Not logged in to GitHub.'}</p><p class="mt-1 text-slate-500">Run <span class="kbd-ref">gh auth login</span> in a terminal, then click "Check again".</p></div></div>`}</div>
    </div>

    <div class="card p-5 sm:p-6">
      <div class="flex items-center gap-3"><span class="flex h-10 w-10 items-center justify-center rounded-xl bg-neutral-100 text-slate-700">${icon('gitlab-logo', 'h-5 w-5')}</span><div><h3 class="text-base font-semibold text-slate-800">GitLab</h3><p class="text-sm text-slate-500">Personal access token (scope <span class="kbd-ref">api</span>) to read and manage MRs. Optional: push, fetch and sync use your git login and work without it.</p></div></div>
      ${!canEncrypt ? html`<div class="callout-warning mt-4 flex gap-3">${icon('warning', 'h-4 w-4 shrink-0 text-warning-600')}<p class="text-sm">Secure OS storage is not available; use the <span class="kbd-ref">GITLAB_TOKEN</span> environment variable.</p></div>` : ''}
      <div class="mt-4 space-y-4">${hosts.length ? hosts.map(([h, x]) => html`<div class="rounded-xl border border-border p-4" data-host="${h}">
        <div class="flex flex-wrap items-center justify-between gap-2"><div><p class="font-medium text-slate-800">${h}</p><p class="text-xs text-slate-500">${x.token.has ? `Token from: ${SOURCE_LABEL[x.token.source] || x.token.source}` : 'No token yet'}</p></div>${x.ok ? badge('success', `Connected: ${x.login}`, 'check-circle') : badge('warning', x.token.has ? 'Token not working' : 'Needs token', 'warning')}</div>
        ${x.ok ? '' : html`<p class="mt-2 text-xs text-danger-700">${x.error}</p>`}
        <div class="mt-3 flex flex-wrap gap-2"><input type="password" class="input h-9 min-w-[16rem] flex-1 font-mono text-xs" placeholder="Paste new token (glpat-…)" autocomplete="off" data-token ${canEncrypt ? '' : 'disabled'} /><button type="button" class="btn-primary btn-sm" data-save-token ${canEncrypt ? '' : 'disabled'}>${icon('lock-key', 'h-3.5 w-3.5')}Save</button>${x.token.source === 'aplikasi' ? html`<button type="button" class="btn-outline btn-sm text-danger-600" data-clear-token>${icon('trash', 'h-3.5 w-3.5')}Delete token</button>` : ''}</div></div>`) : html`<p class="text-sm text-slate-500">No repos with GitLab yet. Add a repo that has a GitLab remote on the Repositories page.</p>`}</div>
      <label class="mt-5 flex items-start gap-2.5 text-sm text-slate-700"><input type="checkbox" class="form-check form-check-sm mt-0.5" data-use-cred ${settings.useGitCredential ? 'checked' : ''} /><span>Try the stored git credential as a token when no token is set.<br /><span class="text-xs text-slate-500">Only used if the stored password looks like a GitLab token; account passwords are ignored.</span></span></label>
    </div>

    <div class="card p-5 sm:p-6">
      <div class="flex items-center gap-3"><span class="flex h-10 w-10 items-center justify-center rounded-xl bg-neutral-100 text-slate-700">${icon('git-branch', 'h-5 w-5')}</span><div><h3 class="text-base font-semibold text-slate-800">Git</h3><p class="text-sm text-slate-500">HTTP buffer size for push/fetch (<span class="kbd-ref">http.postBuffer</span>).</p></div></div>
      <div class="mt-4 flex flex-wrap items-end gap-3"><div><label class="form-label" for="pb">Buffer (bytes)</label><input id="pb" type="number" min="65536" max="1073741824" step="65536" class="input w-56" value="${settings.postBuffer}" data-buffer /></div><button type="button" class="btn-outline btn-md" data-save-buffer>${icon('check')}Save</button><p class="pb-2 text-xs text-slate-500">Currently ${mb(settings.postBuffer)}. Large values (e.g. 500 MB) can make git run out of memory; 1 MB is safe.</p></div>
    </div>

    <div class="card p-5 sm:p-6"><h3 class="text-base font-semibold text-slate-800">About</h3>
      <dl class="mt-3 grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2"><div class="flex justify-between gap-3"><dt class="text-slate-500">App version</dt><dd class="font-medium text-slate-800">${info.version || '—'}</dd></div><div class="flex justify-between gap-3"><dt class="text-slate-500">Electron</dt><dd class="font-medium text-slate-800">${info.electron || '—'}</dd></div><div class="flex justify-between gap-3 sm:col-span-2"><dt class="shrink-0 text-slate-500">Data folder</dt><dd class="truncate font-mono text-xs text-slate-700" title="${info.dataDir}">${info.dataDir || '—'}</dd></div></dl>
      <p class="mt-4 text-xs text-slate-500">Security: all git/gh commands run without a shell; this app never force-pushes, deletes branches, or deletes folders.</p></div>`);
}

export async function mount(el) {
  host = el;
  host.addEventListener('click', async (e) => {
    if (e.target.closest('[data-recheck]')) return busy(e.target.closest('[data-recheck]'), async () => { await loadAccounts(); render(); });
    const save = e.target.closest('[data-save-token]');
    if (save) {
      const box = save.closest('[data-host]'); const token = box.querySelector('[data-token]').value.trim();
      if (!token) return notify('warning', 'Paste a token first.');
      return busy(save, async () => { const r = await call('gitlab:saveToken', { host: box.dataset.host, token }); if (r.ok) { notify('success', 'Token saved (encrypted).'); await loadAccounts(); render(); } });
    }
    const clr = e.target.closest('[data-clear-token]');
    if (clr) { const r = await call('gitlab:clearToken', { host: clr.closest('[data-host]').dataset.host }); if (r.ok) { notify('success', 'Token deleted.'); await loadAccounts(); render(); } return; }
    const sb = e.target.closest('[data-save-buffer]');
    if (sb) return busy(sb, async () => { const r = await call('settings:set', { postBuffer: Number(host.querySelector('[data-buffer]').value) }); if (r.ok) { settings = r.settings; notify('success', `Buffer set to ${mb(settings.postBuffer)}.`); render(); } });
  });
  host.addEventListener('change', async (e) => {
    if (e.target.matches('[data-use-cred]')) { const r = await call('settings:set', { useGitCredential: e.target.checked }); if (r.ok) { settings = r.settings; await loadAccounts(); render(); } }
  });
  render();
  const [s, i] = await Promise.all([call('settings:get', {}, { silent: true }), call('app:info', {}, { silent: true })]);
  if (s.ok) { settings = s.settings; canEncrypt = s.canEncrypt; }
  if (i.ok) info = i;
  if (host === el) { render(); if (!state.accounts) { await loadAccounts(); if (host === el) render(); } }
}
export function unmount() { host = null; }
