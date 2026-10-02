// Membuat aplikasi mandiri (tanpa perlu Node/npm di komputer tujuan) ke dist/Repo Hub-win32-x64/.
// Aplikasi tidak punya dependensi runtime: main/ hanya memakai Electron + modul bawaan Node, dan
// aset renderer (CSS, font, logo, helper design system) sudah disalin ke renderer/ oleh build-assets.mjs.
import { packager } from '@electron/packager';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

// Hanya folder ini yang ikut dibundel; semuanya (termasuk node_modules, test, src) dibuang.
const KEEP = ['main', 'preload', 'renderer', 'package.json'];
const ignore = (file) => {
  if (!file) return false; // akar proyek
  const top = file.replace(/\\/g, '/').split('/').filter(Boolean)[0];
  return !KEEP.includes(top);
};

const icon = ['build/icon.ico'].map((p) => path.join(root, p)).find((p) => fs.existsSync(p));

const out = await packager({
  dir: root,
  out: path.join(root, 'dist'),
  name: 'Repo Hub',
  executableName: 'repo-hub',
  platform: 'win32',
  arch: 'x64',
  overwrite: true,
  prune: false, // node_modules sudah dibuang lewat ignore
  ignore,
  asar: true,
  appVersion: pkg.version,
  appCopyright: 'Ahmad Dimas',
  ...(icon ? { icon } : {}),
});
console.log('Selesai:', out.join('\n'));
