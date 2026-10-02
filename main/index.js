'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeTheme } = require('electron');

if (process.env.HUB_USER_DATA) app.setPath('userData', process.env.HUB_USER_DATA); // tes / profil terpisah
app.setName('Repo Hub');

const { Store } = require('./store');
const { createServices } = require('./services');

let win = null;
let services = null;

const emit = (channel, data) => { if (win && !win.isDestroyed()) win.webContents.send('hub:event', { channel, data }); };

function special() {
  return {
    async 'app:info'() {
      return { ok: true, version: app.getVersion(), electron: process.versions.electron, platform: process.platform, dataDir: app.getPath('userData') };
    },
    async 'dialog:pickFolder'() {
      if (process.env.HUB_PICK_FOLDER) return { ok: true, path: process.env.HUB_PICK_FOLDER }; // untuk tes otomatis
      const r = await dialog.showOpenDialog(win, { title: 'Pilih folder', properties: ['openDirectory'] });
      return r.canceled || !r.filePaths[0] ? { ok: false, canceled: true } : { ok: true, path: r.filePaths[0] };
    },
    async 'shell:openFolder'(p) {
      const repo = services.store.repo(String(p.id));
      if (!repo || !fs.existsSync(repo.path)) return { ok: false, error: 'Folder tidak ditemukan.' };
      const err = await shell.openPath(repo.path);
      return err ? { ok: false, error: err } : { ok: true };
    },
    async 'shell:openExternal'(p) {
      let u; try { u = new URL(String(p.url)); } catch { return { ok: false, error: 'URL tidak valid.' }; }
      if (u.protocol !== 'https:') return { ok: false, error: 'Hanya tautan https yang boleh dibuka.' };
      await shell.openExternal(u.toString());
      return { ok: true };
    },
  };
}

function registerIpc() {
  const sp = special();
  ipcMain.handle('hub:invoke', async (event, channel, payload) => {
    if (!win || event.sender !== win.webContents) return { ok: false, error: 'Pengirim tidak dikenal.' };
    const fn = sp[channel] || services.handlers[channel];
    if (!fn) return { ok: false, error: `Channel tidak dikenal: ${channel}` };
    try { return await fn(payload || {}); } catch (e) { return { ok: false, error: e && e.message ? e.message : String(e) }; }
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400, height: 880, minWidth: 980, minHeight: 640, show: false, autoHideMenuBar: true,
    backgroundColor: '#f6f8fc', title: 'Repo Hub',
    icon: fs.existsSync(path.join(__dirname, '..', 'build', 'icon.png')) ? path.join(__dirname, '..', 'build', 'icon.png') : undefined,
    webPreferences: { preload: path.join(__dirname, '..', 'preload', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
  });
  win.once('ready-to-show', () => win.show());
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('before-input-event', (e, input) => { if (input.type === 'keyDown' && (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) && !app.isPackaged) win.webContents.toggleDevTools(); });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.on('closed', () => { win = null; });
}

if (!app.requestSingleInstanceLock()) { app.quit(); } else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(() => {
    nativeTheme.themeSource = 'system';
    Menu.setApplicationMenu(null);
    services = createServices({ store: new Store(app.getPath('userData')), emit });
    registerIpc();
    createWindow();
    app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
