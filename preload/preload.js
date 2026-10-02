'use strict';
// Jembatan sempit antara UI dan proses utama: hanya channel yang terdaftar yang bisa dipanggil,
// UI tidak punya akses Node/Electron langsung.
const { contextBridge, ipcRenderer } = require('electron');

const INVOKE = new Set([
  'app:info', 'accounts', 'settings:get', 'settings:set', 'gitlab:saveToken', 'gitlab:clearToken',
  'repos:list', 'repos:detect', 'repos:scan', 'repos:add', 'repos:update', 'repos:remove', 'repos:branches', 'repos:test',
  'status:refresh', 'git:push', 'git:mirror', 'git:fetch',
  'pulls:list', 'pulls:detail', 'pulls:diff', 'pulls:review', 'pulls:comment', 'pulls:merge', 'pulls:close', 'pulls:create',
  'release:plan', 'release:run', 'release:cancel',
  'activity:list', 'activity:clear',
  'dialog:pickFolder', 'shell:openFolder', 'shell:openExternal',
]);
const EVENTS = new Set(['status:update', 'release:progress']);

contextBridge.exposeInMainWorld('hub', {
  platform: process.platform,
  invoke(channel, payload) {
    if (!INVOKE.has(channel)) return Promise.resolve({ ok: false, error: `Channel tidak diizinkan: ${channel}` });
    return ipcRenderer.invoke('hub:invoke', channel, payload == null ? {} : payload);
  },
  on(channel, cb) {
    if (!EVENTS.has(channel)) return () => {};
    const listener = (_e, msg) => { if (msg && msg.channel === channel) cb(msg.data); };
    ipcRenderer.on('hub:event', listener);
    return () => ipcRenderer.removeListener('hub:event', listener);
  },
});
