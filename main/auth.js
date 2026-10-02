'use strict';
// Token GitLab. Urutan: variabel lingkungan -> token yang disimpan terenkripsi (Electron safeStorage,
// DPAPI di Windows) -> kredensial git yang sudah tersimpan (dicoba sebagai token). Token tidak pernah
// ditulis ke log, ke aktivitas, ataupun dikirim ke jendela UI.
const { run } = require('./exec');

let safeStorage = null;
try { const e = require('electron'); safeStorage = e && typeof e === 'object' ? e.safeStorage : null; } catch { /* dijalankan di luar Electron (tes) */ }

const canEncrypt = () => !!(safeStorage && safeStorage.isEncryptionAvailable && safeStorage.isEncryptionAvailable());
const encrypt = (text) => (canEncrypt() ? safeStorage.encryptString(text).toString('base64') : null);
const decrypt = (b64) => { try { return canEncrypt() ? safeStorage.decryptString(Buffer.from(b64, 'base64')) : null; } catch { return null; } };

const cache = new Map(); // host -> { token, source, at }
const TTL = 5 * 60 * 1000;

function createAuth(store) {
  async function fromGitCredential(host) {
    const r = await run('git', ['credential', 'fill'], { input: `protocol=https\nhost=${host}\n\n`, timeout: 15000 });
    if (!r.ok) return null;
    const m = /^password=(.+)$/m.exec(r.stdout);
    return m ? m[1].trim() : null;
  }

  async function resolve(host) {
    const hit = cache.get(host);
    if (hit && Date.now() - hit.at < TTL) return hit;
    let found = null;
    const env = process.env.HUB_GITLAB_TOKEN || process.env.GITLAB_TOKEN;
    if (env) found = { token: env, source: 'env' };
    if (!found) {
      const saved = store.getSecret(`gitlab:${host}`);
      const t = saved && decrypt(saved);
      if (t) found = { token: t, source: 'aplikasi' };
    }
    if (!found && store.settings().useGitCredential !== false) {
      const t = await fromGitCredential(host);
      if (t) found = { token: t, source: 'kredensial git' };
    }
    if (found) cache.set(host, { ...found, at: Date.now() });
    return found;
  }

  return {
    async getToken(host) { const f = await resolve(host); return f ? f.token : null; },
    async describe(host) { const f = await resolve(host); return f ? { has: true, source: f.source } : { has: false, source: null }; },
    canEncrypt,
    saveToken(host, token) {
      if (!canEncrypt()) return { ok: false, error: 'Penyimpanan aman OS tidak tersedia. Gunakan variabel lingkungan GITLAB_TOKEN.' };
      store.setSecret(`gitlab:${host}`, encrypt(String(token).trim()));
      cache.delete(host);
      return { ok: true };
    },
    clearToken(host) { store.setSecret(`gitlab:${host}`, null); cache.delete(host); return { ok: true }; },
    forget(host) { cache.delete(host); },
  };
}

module.exports = { createAuth };
