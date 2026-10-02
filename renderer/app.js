// Titik masuk UI: router berbasis hash + inisialisasi kerangka.
import { initShell, setActiveNav } from './lib/shell.js';
import { state, bus, loadRepos, refreshAll, loadAccounts } from './state.js';
import { call } from './lib/ui.js';
import { initials } from './lib/h.js';
import * as dashboard from './views/dashboard.js';
import * as pulls from './views/pulls.js';
import * as release from './views/release.js';
import * as repos from './views/repos.js';
import * as activity from './views/activity.js';
import * as settings from './views/settings.js';

const ROUTES = { dasbor: dashboard, 'pull-request': pulls, rilis: release, repositori: repos, aktivitas: activity, pengaturan: settings };
const view = document.getElementById('view');
let active = null;

function route() {
  const key = (location.hash.replace(/^#\/?/, '').split('?')[0]) || 'dasbor';
  const mod = ROUTES[key] || dashboard;
  const name = ROUTES[key] ? key : 'dasbor';
  if (active && active.unmount) active.unmount();
  active = mod;
  setActiveNav(name);
  document.getElementById('crumb').textContent = mod.title;
  document.title = `${mod.title} · Repo Hub`;
  const el = document.createElement('div'); // wadah baru per tampilan: pendengar lama ikut hilang
  el.className = 'space-y-6';
  view.replaceChildren(el);
  mod.mount(el);
  window.scrollTo(0, 0);
}

function renderAccount() {
  const a = state.accounts;
  const gh = a && a.github && a.github.ok ? a.github.login : null;
  const gl = a ? Object.values(a.gitlab || {}).find((x) => x.ok) : null;
  const name = document.getElementById('accountName'), sub = document.getElementById('accountSub'), av = document.getElementById('accountAvatar');
  if (!a) return;
  name.textContent = gh || (gl && gl.login) || 'Not connected';
  sub.textContent = [gh ? `GitHub: ${gh}` : 'GitHub: not logged in', Object.keys(a.gitlab || {}).length ? (gl ? `GitLab: ${gl.login}` : 'GitLab: token not set') : null].filter(Boolean).join(' · ');
  av.textContent = initials(gh || (gl && gl.login) || '?');
}

function renderRefreshState() {
  const icon = document.getElementById('refreshIcon');
  icon.classList.toggle('animate-spin', state.loadingAll);
  document.getElementById('refreshBtn').disabled = state.loadingAll;
  document.getElementById('footStatus').textContent = state.loadingAll ? 'Refreshing…' : state.lastRefresh ? `Updated ${new Date(state.lastRefresh).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}` : 'Ready';
}

function renderPrBadge() {
  const b = document.getElementById('navPrBadge');
  let n = 0, known = false;
  for (const c of Object.values(state.pulls)) { known = true; n += (c.github || 0) + (c.gitlab || 0); }
  b.textContent = String(n); b.classList.toggle('hidden', !known || n === 0);
}

async function boot() {
  initShell();
  const info = await call('app:info', {}, { silent: true });
  if (info.ok) document.getElementById('appVersion').textContent = `v${info.version}`;
  bus.on('accounts', renderAccount);
  bus.on('loading', renderRefreshState);
  bus.on('status', () => { renderPrBadge(); renderRefreshState(); });
  document.getElementById('refreshBtn').addEventListener('click', () => { refreshAll({ fetch: true }); loadAccounts(); });
  window.addEventListener('hashchange', route);
  bus.on('repos', route); // daftar repo berubah -> render ulang tampilan aktif
  await loadRepos(); // memicu 'repos' -> route()
  loadAccounts();
  refreshAll({ fetch: false }); // status cepat dulu; fetch penuh lewat tombol Segarkan
}

boot();
