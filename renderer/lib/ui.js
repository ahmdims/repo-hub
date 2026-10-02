// Dialog, konfirmasi, toast, dan tombol sibuk di atas modal.js / toast.js milik KarirKit.
import { html, esc, mount, icon } from './h.js';

const modal = () => document.getElementById('hubModal');
const panel = () => document.getElementById('hubModalPanel');
let current = null;

export function notify(type, message, duration = 4500) {
  if (window.KKToast) window.KKToast.show({ type, message, duration });
}

// dialog({ title, description, body, footer, size }) -> kontrol dialog; resolve() lewat close(value)
export function dialog({ title, description, body, footer, size = 'modal-lg', closable = true }) {
  if (current) current.close(undefined);
  const p = panel();
  p.className = `modal-panel ${size}`;
  const state = { closable, resolve: null, pending: undefined };
  const promise = new Promise((res) => { state.resolve = res; });
  mount(p, html`
    <div class="modal-header">
      <div class="min-w-0"><h3 class="modal-title" id="hubModalTitle">${title}</h3>${description ? html`<p class="modal-description">${description}</p>` : ''}</div>
      <button type="button" class="modal-close" data-dialog-close aria-label="Tutup">${icon('x')}</button>
    </div>
    <div class="modal-body" data-dialog-body>${body || ''}</div>
    <div class="modal-footer" data-dialog-footer ${footer ? '' : 'hidden'}>${footer || ''}</div>`);
  modal().setAttribute('data-modal-backdrop', closable ? '' : 'static');
  const onClick = (e) => { if (e.target.closest('[data-dialog-close]') && state.closable) ctl.close(undefined); };
  p.addEventListener('click', onClick);
  const onHide = (e) => { if (e.target === modal() && current === ctl) ctl.finish(state.pending); };
  modal().addEventListener('modal:hide', onHide);

  const ctl = {
    el: p,
    $: (sel) => p.querySelector(sel),
    $$: (sel) => [...p.querySelectorAll(sel)],
    body: () => p.querySelector('[data-dialog-body]'),
    setBody(c) { mount(p.querySelector('[data-dialog-body]'), c); },
    setFooter(c) { const f = p.querySelector('[data-dialog-footer]'); mount(f, c); f.hidden = !c; },
    setTitle(t) { p.querySelector('.modal-title').textContent = t; },
    lock(on) { state.closable = !on; modal().setAttribute('data-modal-backdrop', on ? 'static' : ''); modal().setAttribute('data-modal-keyboard', on ? 'false' : 'true'); },
    finish(value) { if (current !== ctl) return; current = null; p.removeEventListener('click', onClick); modal().removeEventListener('modal:hide', onHide); state.resolve(value); },
    close(value) { if (current !== ctl) return; state.pending = value; window.KKModal.close('#hubModal'); ctl.finish(value); },
    closed: promise,
  };
  current = ctl;
  window.KKModal.open('#hubModal');
  return ctl;
}

export const closeDialog = () => { if (current) current.close(undefined); };

// confirmDialog -> Promise<boolean>
export function confirmDialog({ title, description, body, confirmLabel = 'Lanjutkan', cancelLabel = 'Batal', danger = false, iconName = 'warning-circle' }) {
  const ctl = dialog({
    title, description, size: 'modal-md',
    body: html`${danger ? html`<div class="callout-warning mb-4 flex items-start gap-3">${icon(iconName, 'h-4 w-4 shrink-0 text-warning-600')}<p class="text-sm">Aksi ini mengubah repo di luar komputer ini dan tidak bisa dibatalkan dari aplikasi.</p></div>` : ''}${body || ''}`,
    footer: html`<button type="button" class="btn-outline btn-md" data-dialog-close>${cancelLabel}</button><button type="button" class="${danger ? 'btn-danger' : 'btn-primary'} btn-md" data-confirm>${confirmLabel}</button>`,
  });
  return new Promise((resolve) => {
    ctl.$('[data-confirm]').addEventListener('click', () => ctl.close(true));
    ctl.closed.then((v) => resolve(v === true));
    ctl.$('[data-confirm]').focus();
  });
}

// jalankan fn sambil menonaktifkan tombol dan menampilkan spinner
export async function busy(btn, fn) {
  if (!btn) return fn();
  const old = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<i class="kk kk-circle-notch h-4 w-4 animate-spin"></i>${btn.dataset.busyLabel ? esc(btn.dataset.busyLabel) : ''}`;
  try { return await fn(); } finally { btn.disabled = false; btn.innerHTML = old; }
}

// API pembungkus IPC: kembalikan hasil, tampilkan toast bila gagal (kecuali silent)
export async function call(channel, payload, { silent = false } = {}) { // silent: jangan tampilkan toast galat
  let r;
  try { r = await window.hub.invoke(channel, payload); } catch (e) { r = { ok: false, error: e.message }; }
  if (!r || r.ok === false) { if (!silent) notify('danger', (r && r.error) || 'Terjadi kesalahan.'); }
  return r || { ok: false, error: 'Tidak ada respons.' };
}

