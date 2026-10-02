// Templating aman: semua nilai disisipkan lewat esc() kecuali yang dibungkus raw()/html``.
// Judul PR, nama branch, dan pesan commit berasal dari luar, jadi tidak boleh pernah masuk mentah ke DOM.
const MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => MAP[c]);

class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = (s) => new Raw(String(s));

const part = (v) => (v instanceof Raw ? v.s : Array.isArray(v) ? v.map(part).join('') : v === false || v == null ? '' : esc(v));
export function html(strings, ...vals) {
  let out = strings[0];
  vals.forEach((v, i) => { out += part(v) + strings[i + 1]; });
  return new Raw(out);
}
export const mount = (el, content) => { el.innerHTML = part(content); }; // Raw, array, atau teks biasa (di-escape)

export const icon = (name, cls = 'h-4 w-4') => raw(`<i class="kk kk-${esc(name)} ${esc(cls)}"></i>`);

const BADGE = { success: 'badge-success', warning: 'badge-warning', danger: 'badge-danger', info: 'badge-info', primary: 'badge-primary', neutral: 'badge-neutral' };
export const badge = (kind, text, iconName) => html`<span class="${BADGE[kind] || 'badge-neutral'} whitespace-nowrap">${iconName ? icon(iconName, 'h-3 w-3') : ''}${text}</span>`;

export function timeAgo(iso) {
  if (!iso) return '—';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'baru saja';
  if (s < 3600) return `${Math.floor(s / 60)} menit lalu`;
  if (s < 86400) return `${Math.floor(s / 3600)} jam lalu`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} hari lalu`;
  return new Date(iso).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
}
export const fmtTime = (iso) => new Date(iso).toLocaleString('id-ID', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });
export const initials = (s) => String(s || '?').split(/[\s._-]+/).filter(Boolean).slice(0, 2).map((x) => x[0].toUpperCase()).join('') || '?';
export const platformName = (p) => (p === 'github' ? 'GitHub' : p === 'gitlab' ? 'GitLab' : p);
export const prWord = (p) => (p === 'gitlab' ? 'MR' : 'PR');
