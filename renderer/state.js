// State bersama + bus kecil. Data repo, status git, parity, jumlah PR, dan akun terhubung.
import { call } from './lib/ui.js';

const handlers = new Map();
export const bus = {
  on(evt, fn) { if (!handlers.has(evt)) handlers.set(evt, new Set()); handlers.get(evt).add(fn); return () => handlers.get(evt).delete(fn); },
  emit(evt, data) { (handlers.get(evt) || []).forEach((fn) => { try { fn(data); } catch (e) { console.error(e); } }); },
};

export const state = {
  repos: [], status: {}, parity: {}, pulls: {}, loading: new Set(), accounts: null,
  loadingAll: false, lastRefresh: null, openPrs: null,
};

export const repoById = (id) => state.repos.find((r) => r.id === id) || null;

export async function loadRepos() {
  const r = await call('repos:list');
  state.repos = r.repos || [];
  bus.emit('repos');
  return state.repos;
}

export async function refreshAll({ fetch = false, ids } = {}) {
  const targets = ids && ids.length ? ids : state.repos.map((r) => r.id);
  if (!targets.length) { bus.emit('status'); return; }
  targets.forEach((id) => state.loading.add(id));
  state.loadingAll = true; bus.emit('loading', true); bus.emit('status');
  const r = await call('status:refresh', { fetch, ids: targets }, { silent: true });
  targets.forEach((id) => state.loading.delete(id));
  state.loadingAll = false; state.lastRefresh = Date.now();
  if (r && r.ok === false) bus.emit('error', r.error);
  bus.emit('loading', false); bus.emit('status');
}

export async function loadAccounts({ fresh = false } = {}) {
  const r = await call('accounts', { fresh }, { silent: true });
  state.accounts = r.ok ? r : { github: { ok: false, error: r.error }, gitlab: {} };
  bus.emit('accounts');
  return state.accounts;
}

// pembaruan bertahap dari proses utama saat refresh berjalan
window.hub.on('status:update', (u) => {
  state.status[u.id] = u.status;
  if (u.parity) state.parity[u.id] = u.parity; else delete state.parity[u.id];
  if (u.pulls) state.pulls[u.id] = u.pulls;
  state.loading.delete(u.id);
  bus.emit('status', u.id);
});

export function summary() {
  const repos = state.repos;
  let needPush = 0, dirty = 0, parityDiff = 0, prs = 0, prKnown = false;
  for (const r of repos) {
    const s = state.status[r.id];
    if (s && s.ok) { if (s.ahead > 0) needPush++; if (s.dirty) dirty++; }
    const p = state.parity[r.id];
    if (p && p.ok && !p.identical) parityDiff++;
    const c = state.pulls[r.id];
    if (c) { prKnown = true; prs += (c.github || 0) + (c.gitlab || 0); }
  }
  return { repos: repos.length, needPush, dirty, parityDiff, prs: prKnown ? prs : null };
}
