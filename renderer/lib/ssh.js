// Pembantu bersama untuk akun + SSH: pengenalan URL, pratinjau blok ssh config, salin ke clipboard, dan dialog "trust host".
// Dipakai oleh halaman Accounts dan formulir repo. Semua teks dari backend/pengguna lewat html`` (di-escape).
import { html, icon, badge } from './h.js';
import { dialog, notify, call } from './ui.js';

export const PROVIDER_LABEL = { github: 'GitHub', gitlab: 'GitLab', other: 'Git' };
export const providerIcon = (p) => (p === 'github' ? 'github-logo' : p === 'gitlab' ? 'gitlab-logo' : 'git-branch');
export const defaultHost = (p) => (p === 'github' ? 'github.com' : p === 'gitlab' ? 'gitlab.com' : '');

/* ------------------------------------------------------------------ URL */
// URL yang diawali git@ atau ssh:// dianggap SSH
export const isSshUrl = (u) => /^(git@|ssh:\/\/)/i.test(String(u || '').trim());

// jangan tampilkan kata sandi / token yang menempel di URL (sama dengan git.redactUrl di proses utama)
export const redactUrl = (u) => String(u || '').replace(/^(\w+:\/\/)[^@/\s]+@/, '$1');

// Salinan ringan git.parseRemoteUrl di proses utama: { host, path, scp } (scp = bentuk git@alias:path)
export function parseRemote(raw) {
  const url = String(raw || '').trim();
  let m;
  if ((m = /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/i.exec(url))) return { host: m[1].toLowerCase(), path: m[2], scp: false };
  if ((m = /^[^@/\s]+@([^:/\s]+):(.+?)(?:\.git)?\/?$/.exec(url))) return { host: m[1].toLowerCase(), path: m[2], scp: true };
  return { host: '', path: url, scp: false };
}

// host asli remote; git@alias:path dipetakan lewat alias milik akun bila ada (known = host pasti, bukan tebakan)
export function resolveRemote(url, accounts = []) {
  const p = parseRemote(url);
  if (!p.scp) return { host: p.host, path: p.path, known: !!p.host };
  const a = accounts.find((x) => x.ssh && x.ssh.alias && x.ssh.alias.toLowerCase() === p.host);
  return a ? { host: a.host, path: p.path, known: true } : { host: p.host, path: p.path, known: false };
}

// akun yang boleh dipilih untuk satu remote: host yang sama bila pasti, jika tidak semua akun dengan penyedia yang sama
export function accountsForRemote(accounts, platform, url) {
  const r = resolveRemote(url, accounts);
  if (r.known && r.host) return accounts.filter((a) => a.host === r.host);
  return accounts.filter((a) => a.provider === platform || (r.host && a.host === r.host));
}

// URL SSH yang akan dipakai (sama dengan rumus di proses utama)
export function sshUrlFor(account, path) {
  const s = (account && account.ssh) || {};
  if (!s.alias && s.port && Number(s.port) !== 22) return `ssh://git@${account.host}:${Number(s.port)}/${path}.git`;
  return `git@${s.alias || account.host}:${path}.git`;
}

export const keysPageUrl = (provider, host) => (provider === 'github' ? 'https://github.com/settings/ssh/new' : provider === 'gitlab' ? `https://${host}/-/user_settings/ssh_keys` : null);

/* ------------------------------------------------------------------ nama + pratinjau */
export const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '').slice(0, 40);
export const shortFp = (fp) => (String(fp).length > 26 ? `${String(fp).slice(0, 17)}…${String(fp).slice(-6)}` : String(fp));

// Persis blok yang ditambahkan main/sshconfig.js#appendHostBlock (dipakai untuk pratinjau sebelum menulis)
export function hostBlock({ alias, host, port, identityFile, label }) {
  const tag = String(label || '').replace(/[^\w .@+-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const lines = [`# Added by Repo Hub${tag ? `: ${tag}` : ''}`, `Host ${alias}`, `    HostName ${host}`, '    User git'];
  if (port && Number(port) !== 22) lines.push(`    Port ${Number(port)}`);
  lines.push(`    IdentityFile ~/.ssh/${identityFile}`, '    IdentitiesOnly yes');
  return lines.join('\n');
}

/* ------------------------------------------------------------------ chip akun */
export const chip = (text, tone = 'primary') => html`<span class="inline-flex max-w-full items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${tone === 'primary' ? 'bg-primary-50 text-primary-700' : 'bg-neutral-100 text-slate-600'}"><span class="truncate">${text}</span></span>`;
export const sshBadge = (url) => (isSshUrl(url) ? badge('success', 'SSH', 'lock-key') : badge('neutral', 'HTTPS', 'globe'));

/* ------------------------------------------------------------------ clipboard */
// API clipboard dulu; bila ditolak, pilih isi textarea lalu document.execCommand('copy')
export async function copyText(text, el) {
  try { if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); return true; } } catch { /* pakai cadangan */ }
  try { if (el) { el.focus(); el.select(); return !!document.execCommand('copy'); } } catch { /* abaikan */ }
  return false;
}

export const openUrl = (url) => call('shell:openExternal', { url });

// Panel kunci publik (read-only) + Copy + tombol buka halaman SSH keys. bindKeyPanel(root) memasang tombolnya.
export function keyPanel({ publicKey, fingerprint, type, comment, provider, host, keysUrl }) {
  const url = keysUrl !== undefined ? keysUrl : keysPageUrl(provider, host);
  return html`<div class="space-y-3" data-key-panel>
    <div class="flex flex-wrap items-center gap-2 text-xs text-slate-500">${type ? badge('neutral', type, 'key') : ''}<span class="font-mono" title="${fingerprint}">${fingerprint}</span>${comment ? html`<span>· ${comment}</span>` : ''}</div>
    <textarea class="input h-auto min-h-[5.5rem] resize-none py-2 font-mono text-xs leading-5" rows="4" readonly spellcheck="false" aria-label="Public key" data-pubkey>${publicKey}</textarea>
    <div class="flex flex-wrap items-center gap-2">
      <button type="button" class="btn-outline btn-sm" data-copy-key>${icon('copy', 'h-3.5 w-3.5')}<span data-copy-label>Copy public key</span></button>
      ${url ? html`<button type="button" class="btn-outline btn-sm" data-open-url="${url}">${icon('arrow-square-out', 'h-3.5 w-3.5')}Open ${provider === 'other' ? host : PROVIDER_LABEL[provider]} SSH keys page</button>` : html`<span class="text-xs text-slate-500">Add this public key to your account on ${host}.</span>`}
    </div>
  </div>`;
}

export function bindKeyPanel(root) {
  const ta = root.querySelector('[data-pubkey]');
  const copy = root.querySelector('[data-copy-key]');
  if (copy && ta) copy.addEventListener('click', async () => {
    const ok = await copyText(ta.value, ta);
    const label = copy.querySelector('[data-copy-label]');
    if (label) label.textContent = ok ? 'Copied' : 'Press Ctrl+C to copy';
    if (!ok) { ta.focus(); ta.select(); }
    setTimeout(() => { if (label) label.textContent = 'Copy public key'; }, 2500);
  });
  root.querySelectorAll('[data-open-url]').forEach((b) => b.addEventListener('click', () => openUrl(b.dataset.openUrl)));
}

/* ------------------------------------------------------------------ trust host */
const FP_DOCS = {
  github: 'https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints',
  gitlab: 'https://docs.gitlab.com/user/gitlab_com/#ssh-known_hosts-entries',
};

// Menampilkan sidik jari host ke dalam bodyEl/footEl (dialog sendiri atau panel di dalam dialog lain).
// Resolve true bila host sudah dipercaya (atau baru saja dipercaya), false bila dibatalkan.
export function mountTrust(bodyEl, footEl, { host, port, provider }) {
  const who = provider === 'github' ? 'GitHub' : host;
  const docs = provider === 'github' ? FP_DOCS.github : provider === 'gitlab' && host === 'gitlab.com' ? FP_DOCS.gitlab : null;
  return new Promise((resolve) => {
    const cancelBtn = html`<button type="button" class="btn-outline btn-md" data-trust-cancel>Cancel</button>`;
    const bindCancel = () => footEl.querySelectorAll('[data-trust-cancel]').forEach((b) => b.addEventListener('click', () => resolve(false)));
    const load = async () => {
      bodyEl.innerHTML = html`<p class="flex items-center gap-2 text-sm text-slate-500">${icon('circle-notch', 'h-4 w-4 animate-spin')}Reading the host key from ${host}…</p>`.s;
      footEl.innerHTML = cancelBtn.s; bindCancel();
      const res = await call('ssh:hostKey', { host, port: port || undefined }, { silent: true });
      if (!res.ok) {
        bodyEl.innerHTML = html`<div class="callout-warning flex items-start gap-3">${icon('warning-circle', 'mt-0.5 h-4 w-4 shrink-0 text-warning-600')}<div class="min-w-0 text-sm"><p class="font-medium text-slate-800">Could not read the host key</p><p class="mt-1 text-slate-600" data-trust-error>${res.error}</p></div></div>`.s;
        footEl.innerHTML = html`${cancelBtn}<button type="button" class="btn-primary btn-md" data-trust-retry>${icon('arrows-clockwise')}Try again</button>`.s;
        bindCancel(); footEl.querySelector('[data-trust-retry]').addEventListener('click', load);
        return;
      }
      if (res.trusted) {
        bodyEl.innerHTML = html`<div class="callout-warning flex items-start gap-3">${icon('shield-warning', 'mt-0.5 h-4 w-4 shrink-0 text-warning-600')}<div class="min-w-0 space-y-2 text-sm text-slate-600"><p class="font-medium text-slate-800">${host} is already in your known_hosts</p><p>When a host that ssh already knows fails verification, its key has usually <b>changed</b>. That can mean the server was reinstalled, or that someone is intercepting the connection. Repo Hub never replaces an existing entry.</p><p>Ask the provider or your administrator whether the key changed. If you are sure, remove the old line for ${host} from your known_hosts file yourself and check again.</p></div></div>`.s;
        footEl.innerHTML = html`<button type="button" class="btn-primary btn-md" data-trust-cancel>Close</button>`.s; bindCancel();
        return;
      }
      const fps = res.fingerprints || [];
      const first = fps.find((f) => f.type === 'ED25519') || fps[0];
      bodyEl.innerHTML = html`<div class="space-y-4" data-trust-body>
        <p class="text-sm text-slate-600">ssh does not know <b>${host}</b> yet. These are the host keys the server presents right now. Trusting a host adds one line to your <span class="kbd-ref">known_hosts</span> file and nothing else.</p>
        <fieldset class="space-y-2"><legend class="sr-only">Host key fingerprints</legend>${fps.map((f) => html`<label class="flex items-start gap-3 rounded-xl border border-border p-3 ${fps.length > 1 ? 'cursor-pointer' : ''}"><input type="radio" name="trust-fp" class="form-radio mt-0.5 ${fps.length > 1 ? '' : 'hidden'}" value="${f.fingerprint}" ${f === first ? 'checked' : ''} /><span class="min-w-0"><span class="block text-xs font-medium text-slate-500">${f.type}</span><span class="block break-all font-mono text-xs text-slate-800" data-fp>${f.fingerprint}</span></span></label>`)}</fieldset>
        <div class="callout-info text-sm text-slate-600"><p><b>Compare before you trust.</b> Check that the fingerprint above is identical to the one ${provider === 'other' ? 'your administrator or the provider publishes for this host' : `${who} publishes`}. If it differs, cancel: you may be connecting to someone else.</p>${docs ? html`<button type="button" class="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-primary-600 hover:underline" data-trust-docs="${docs}">${icon('arrow-square-out', 'h-3.5 w-3.5')}Open the published fingerprints</button>` : ''}</div>
        <label class="flex items-start gap-2.5 text-sm text-slate-700"><input type="checkbox" class="form-check form-check-sm mt-0.5" data-trust-confirm /><span>I compared this fingerprint with the one published by ${who}</span></label>
        <p class="hidden rounded-lg bg-danger-50 p-3 text-sm text-danger-700" data-trust-error></p>
      </div>`.s;
      footEl.innerHTML = html`${cancelBtn}<button type="button" class="btn-primary btn-md" data-trust-go disabled>${icon('shield-check')}Trust this host</button>`.s;
      bindCancel();
      const go = footEl.querySelector('[data-trust-go]'), box = bodyEl.querySelector('[data-trust-confirm]'), err = bodyEl.querySelector('[data-trust-error]');
      box.addEventListener('change', () => { go.disabled = !box.checked; });
      const docBtn = bodyEl.querySelector('[data-trust-docs]'); if (docBtn) docBtn.addEventListener('click', () => openUrl(docBtn.dataset.trustDocs));
      go.addEventListener('click', async () => {
        const pick = bodyEl.querySelector('input[name="trust-fp"]:checked');
        if (!box.checked || !pick) return;
        go.disabled = true; err.classList.add('hidden');
        const r = await call('ssh:trustHost', { host, port: port || undefined, fingerprint: pick.value, confirmed: true }, { silent: true });
        if (!r.ok) { err.textContent = r.error; err.classList.remove('hidden'); go.disabled = !box.checked; return; }
        notify('success', r.alreadyTrusted ? `${host} was already trusted.` : `Host key added to known_hosts for ${host}.`);
        resolve(true);
      });
    };
    load();
  });
}

// Dialog mandiri untuk "Review host key": resolve true bila host dipercaya
export async function trustHostDialog({ host, port, provider }) {
  const d = dialog({ title: 'Review host key', description: host, size: 'modal-lg', body: '', footer: html`<span></span>` });
  const footEl = d.el.querySelector('[data-dialog-footer]');
  const closed = d.closed.then(() => false);
  const ok = await Promise.race([mountTrust(d.body(), footEl, { host, port, provider }), closed]);
  d.close(undefined);
  return ok === true;
}
