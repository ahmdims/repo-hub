// Membangun CSS (Tailwind + tema KarirKit) dan menyalin aset design system ke renderer/.
// Dipakai: node scripts/build-assets.mjs [--watch]
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ds = path.join(root, 'node_modules', '@foxtrot-sevima', 'karirkit');
const cli = path.join(root, 'node_modules', '@tailwindcss', 'cli', 'dist', 'index.mjs');
const watch = process.argv.includes('--watch');

if (!fs.existsSync(ds)) {
  console.error('Paket @foxtrot-sevima/karirkit tidak ditemukan. Jalankan "npm install" dulu.');
  process.exit(1);
}

const copy = (from, to) => {
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, { recursive: true });
};

// 1) aset runtime dari design system: skrip pembantu, font, logo
const vendorJs = path.join(root, 'renderer', 'vendor', 'karirkit');
fs.mkdirSync(vendorJs, { recursive: true });
for (const f of ['theme.js', 'toast.js', 'modal.js', 'ui.js', 'table.js']) fs.copyFileSync(path.join(ds, 'assets', 'js', f), path.join(vendorJs, f));
copy(path.join(ds, 'assets', 'fonts'), path.join(root, 'renderer', 'assets', 'fonts')); // CSS memakai ../assets/fonts/...
copy(path.join(ds, 'assets', 'logo'), path.join(root, 'renderer', 'assets', 'logo'));

// 2) CSS
const args = [cli, '-i', path.join(root, 'src', 'app.css'), '-o', path.join(root, 'renderer', 'vendor', 'app.css'), '--minify'];
if (watch) {
  console.log('Memantau perubahan CSS…');
  spawn(process.execPath, [...args, '--watch'], { stdio: 'inherit' });
} else {
  const r = spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status || 1);
  const kb = Math.round(fs.statSync(path.join(root, 'renderer', 'vendor', 'app.css')).size / 1024);
  console.log(`Aset siap (app.css ${kb} KB, design system ${JSON.parse(fs.readFileSync(path.join(ds, 'package.json'), 'utf8')).version}).`);
}
