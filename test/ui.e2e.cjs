'use strict';
// Uji ujung-ke-ujung aplikasi desktop (Electron + Playwright): dasbor, push/mirror massal, PR/MR, review/approve,
// merge massal, buat PR, alur rilis, kelola repo, aktivitas, pengaturan, tema gelap, dan keamanan XSS/CSP.
const { makeRig, sh, startGitlab, ghState, launch, fs, nodePath } = require('./e2e-lib.cjs');

const OUT = process.env.SHOTS || nodePath.join(require('node:os').tmpdir(), 'hub-shots');
fs.mkdirSync(OUT, { recursive: true });
let fails = 0;
const ok = (name, cond, extra) => { if (!cond) fails++; console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra !== undefined ? ` ${extra}` : ''}`); };

(async () => {
  const gl = await startGitlab();
  const gh = ghState();
  const A = makeRig('proyek-alfa'), B = makeRig('proyek-beta'), C = makeRig('proyek-gamma');
  // Alfa: ada commit lokal belum di-push, file kotor, branch rilis hanya di GitHub
  A.sh('branch', '--set-upstream-to=origin/master');
  A.sh('checkout', '-b', 'karirkit/9.9.9'); A.commit('rilis 9.9.9', 'v.txt'); A.sh('push', A.gh, 'karirkit/9.9.9');
  A.sh('checkout', 'master'); A.sh('branch', 'karirkit/vercel'); A.sh('push', A.gh, 'karirkit/vercel'); A.sh('push', A.gl, 'karirkit/vercel');
  A.commit('commit lokal belum di-push', 'a.txt'); fs.writeFileSync(nodePath.join(A.work, 'kotor.txt'), 'x');
  A.sh('fetch', 'origin');
  B.sh('branch', '--set-upstream-to=origin/master');
  const repos = [
    { name: 'Proyek Alfa', path: A.work, github: { repo: 'org/demo', url: A.gh }, gitlab: { baseUrl: gl.base, path: 'grp/demo', url: A.gl }, warnBranches: ['release'] },
    { name: 'Proyek Beta', path: B.work, github: { repo: 'org/other', url: B.gh } },
  ];
  const { app, page, problems, userData } = await launch(repos, { gh, extraEnv: { HUB_PICK_FOLDER: C.work } });
  const shot = (n) => page.screenshot({ path: nodePath.join(OUT, `${n}.png`) });
  const modalOpen = () => page.evaluate(() => document.getElementById('hubModal').classList.contains('is-open'));
  const toastText = () => page.locator('#kkToastRegion').innerText().catch(() => '');
  const go = async (hash, sel) => { await page.evaluate((h) => { location.hash = `#/${h}`; }, hash); await page.waitForSelector(sel, { timeout: 15000 }); };
  const rowText = (id) => page.locator(`#repoBody tr[data-id="${id}"]`).innerText();

  try {
    /* -------------------------------------------------- 1. dasbor */
    await page.waitForSelector('#repoBody tr[data-id]', { timeout: 20000 });
    await page.waitForFunction(() => !document.querySelector('#repoBody tr.repo-row-loading') && /Identik|ref beda/.test(document.getElementById('repoBody').innerText), null, { timeout: 25000 });
    const idA = (await page.locator('#repoBody tr').first().getAttribute('data-id'));
    const idB = (await page.locator('#repoBody tr').nth(1).getAttribute('data-id'));
    const kpi = (await page.locator('#dashKpi').innerText()).replace(/\s+/g, ' ');
    ok('dasbor: 2 repo, 1 perlu push, 1 perubahan lokal, 5 PR/MR, 1 mirror beda', /2 Repo dikelola/.test(kpi) && /1 Perlu push/.test(kpi) && /1 Ada perubahan lokal/.test(kpi) && /5 PR\/MR terbuka/.test(kpi) && /1 Mirror belum identik/.test(kpi), kpi);
    const ta = await rowText(idA);
    ok('dasbor: baris Alfa menampilkan branch, perubahan, perlu push, ref beda, GH 3 · GL 2', /master/.test(ta) && /1 perubahan/.test(ta) && /1 perlu push/.test(ta) && /ref beda/.test(ta) && /GH 3/.test(ta) && /GL 2/.test(ta), ta.replace(/\s+/g, ' ').slice(0, 160));
    ok('dasbor: baris Beta sinkron, mirror "—"', /Sinkron/.test(await rowText(idB)));
    ok('dasbor: tidak ada scroll horizontal halaman, aksi terlihat', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth) && await page.locator(`#repoBody tr[data-id="${idA}"] [data-act="push"]`).isVisible());
    await shot('01-dasbor');

    /* -------------------------------------------------- 2. push massal */
    await page.locator('#repoTable [data-table-select-all]').check();
    ok('dasbor: bilah aksi massal muncul (2 dipilih)', await page.locator('#repoTable [data-table-bulk]').isVisible() && (await page.locator('[data-table-selected-count]').innerText()) === '2');
    await page.click('[data-bulk="push"]');
    await page.waitForSelector('#hubModalPanel [data-push]');
    const pushText = await page.locator('#hubModalPanel').innerText();
    ok('push: dialog memuat 2 repo, peringatan perubahan belum commit, dan opsi GitHub/GitLab', (await page.locator('[data-push]').count()) === 2 && /belum di-commit/.test(pushText) && (await page.locator('[data-push] [data-target]').count()) === 3, pushText.replace(/\s+/g, ' ').slice(0, 140));
    await shot('02-push-dialog');
    await page.click('#hubModalPanel [data-run]');
    await page.waitForFunction(() => [...document.querySelectorAll('[data-push] [data-result]')].every((r) => /[✓✕]|Dilewati/.test(r.innerText)), null, { timeout: 30000 });
    const res = (await page.locator('#hubModalPanel').innerText()).replace(/\s+/g, ' ');
    ok('push: Alfa terkirim ke GitHub dan GitLab, Beta sudah terbaru', /✓ GitHub/.test(res) && /✓ GitLab/.test(res) && /sudah terbaru/.test(res) && !/✕/.test(res), res.slice(-200));
    ok('push: GitLab benar-benar menerima commit (SHA sama dengan lokal)', sh(A.gl, 'rev-parse', 'refs/heads/master') === A.sh('rev-parse', 'HEAD'));
    await page.click('#hubModalPanel [data-dialog-close]');
    await page.waitForFunction(() => !document.getElementById('hubModal').classList.contains('is-open'));
    ok('push: toast sukses muncul', /Push selesai/.test(await toastText()));

    /* -------------------------------------------------- 3. mirror */
    await page.waitForFunction(() => /Sinkron/.test(document.getElementById('repoBody').innerText) && !/perlu push/.test(document.getElementById('repoBody').innerText), null, { timeout: 25000 });
    ok('dasbor: setelah push, posisi Alfa "Sinkron" (tidak ada "perlu push")', !/perlu push/.test(await rowText(idA)));
    ok('dasbor: mirror Alfa masih beda (branch rilis hanya di GitHub)', /ref beda/.test(await rowText(idA)));
    await page.locator('#repoTable [data-table-select-all]').uncheck();
    await page.click(`#repoBody tr[data-id="${idA}"] [data-act="mirror"]`);
    await page.waitForSelector('#hubModalPanel [data-mirror]');
    await page.waitForFunction(() => /branch baru/.test(document.getElementById('hubModalPanel').innerText), null, { timeout: 20000 });
    ok('mirror: rencana menyebut 1 branch baru (karirkit/9.9.9)', /1 branch baru:\s*karirkit\/9\.9\.9/.test((await page.locator('#hubModalPanel').innerText()).replace(/\s+/g, ' ')));
    await shot('03-mirror-dialog');
    await page.click('#hubModalPanel [data-run]');
    await page.waitForFunction(() => /✓ 1 ref disalin/.test(document.getElementById('hubModalPanel').innerText), null, { timeout: 30000 });
    ok('mirror: GitLab menerima branch rilis', /karirkit\/9\.9\.9/.test(sh(A.gl, 'branch', '--list', 'karirkit/9.9.9')));
    await page.click('#hubModalPanel [data-dialog-close]');
    await page.waitForFunction(() => /Identik/.test(document.getElementById('repoBody').innerText), null, { timeout: 25000 });
    ok('dasbor: mirror Alfa kini "Identik"', /Identik/.test(await rowText(idA)));

    /* -------------------------------------------------- 4. PR / MR */
    await go('pull-request', '#prBody tr[data-key]');
    await page.waitForFunction(() => document.querySelectorAll('#prBody tr[data-key]').length === 5, null, { timeout: 20000 });
    ok('PR/MR: 5 item (3 PR GitHub + 2 MR GitLab) dan statistik', (await page.locator('#prStats').innerText()).replace(/\s+/g, ' ').includes('5 terbuka'));
    ok('PR/MR: judul berisi <script> tampil sebagai teks (aman XSS), bukan elemen', await page.evaluate(() => document.querySelectorAll('#view script, #view img[src="x"]').length === 0) && /<script>alert\(1\)<\/script>/.test(await page.locator('#prBody').innerText()));
    await page.selectOption('[data-filter="platform"]', 'gitlab');
    await page.waitForFunction(() => document.querySelectorAll('#prBody tr[data-key]').length === 2, null, { timeout: 15000 });
    ok('PR/MR: filter platform GitLab -> 2 MR', true);
    await page.selectOption('[data-filter="platform"]', '');
    await page.waitForFunction(() => document.querySelectorAll('#prBody tr[data-key]').length === 5, null, { timeout: 15000 });
    await page.fill('[data-table-search]', 'login');
    await page.waitForFunction(() => [...document.querySelectorAll('#prBody tr[data-key]')].filter((r) => !r.hidden).length === 1, null, { timeout: 5000 });
    ok('PR/MR: pencarian "login" -> 1 baris (MR 7)', /MR tujuh/.test(await page.locator('#prBody tr:not([hidden])').first().innerText()));
    await page.fill('[data-table-search]', '');
    await page.waitForTimeout(300);
    await shot('04-pull-request');

    // detail PR GitHub #1
    await page.locator('#prBody tr[data-key$="|github|1"] [data-act="detail"]').first().click();
    await page.waitForSelector('#hubModalPanel [data-tab]', { timeout: 15000 });
    const det = await page.locator('#hubModalPanel').innerText();
    ok('detail: judul, deskripsi (di-escape), check, dan commit tampil', /Tambah fitur A/.test(det) && /<img src=x onerror=alert\(2\)>/.test(det) && /build/.test(det) && await page.evaluate(() => document.querySelectorAll('#hubModalPanel img, #hubModalPanel script').length === 0));
    await page.click('#hubModalPanel [data-tab="file"]');
    await page.click('#hubModalPanel [data-load-diff]');
    await page.waitForSelector('#hubModalPanel .diff-add', { timeout: 15000 });
    ok('detail: diff dirender (baris tambah hijau, hapus merah)', (await page.locator('#hubModalPanel .diff-add').count()) >= 1 && (await page.locator('#hubModalPanel .diff-del').count()) >= 1);
    await shot('05-detail-diff');
    ok('detail: Approve aktif untuk PR orang lain', !(await page.locator('#hubModalPanel [data-approve]').isDisabled()));
    await page.click('#hubModalPanel [data-approve]');
    await page.waitForSelector('#hubModalPanel [data-go]');
    await page.click('#hubModalPanel [data-go]');
    await page.waitForFunction(() => /✓ disetujui/.test(document.getElementById('hubModalPanel').innerText), null, { timeout: 15000 });
    ok('approve: PR #1 disetujui (status di GitHub palsu = APPROVED)', gh.read().prs[0].reviewDecision === 'APPROVED');
    await page.click('#hubModalPanel [data-dialog-close]');
    await page.waitForFunction(() => !document.getElementById('hubModal').classList.contains('is-open'));

    // PR milik sendiri: approve dinonaktifkan di detail
    await page.locator('#prBody tr[data-key$="|github|2"] [data-act="detail"]').first().click();
    await page.waitForSelector('#hubModalPanel [data-approve]', { timeout: 15000 });
    ok('detail: Approve dinonaktifkan untuk PR milik sendiri (aturan GitHub)', await page.locator('#hubModalPanel [data-approve]').isDisabled());
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('hubModal').classList.contains('is-open'));

    // merge massal: PR GitHub #1 + MR GitLab #7
    await page.locator('#prBody tr[data-key$="|github|1"] [data-table-select]').check();
    await page.locator('#prBody tr[data-key$="|gitlab|7"] [data-table-select]').check();
    ok('PR/MR: bilah massal "2 dipilih"', (await page.locator('[data-table-selected-count]').innerText()) === '2');
    await page.click('[data-bulk="merge"]');
    await page.waitForSelector('#hubModalPanel [data-method]');
    await page.selectOption('#hubModalPanel [data-method]', 'squash');
    await shot('06-merge-dialog');
    await page.click('#hubModalPanel [data-go]');
    await page.waitForFunction(() => (document.getElementById('hubModalPanel').innerText.match(/✓ ter-merge/g) || []).length === 2, null, { timeout: 20000 });
    ok('merge massal: PR GitHub (squash) dan MR GitLab ter-merge', gh.read().prs[0].state === 'merged' && gh.read().prs[0].mergedWith === '--squash' && gl.mrs[0].state === 'merged');
    await page.click('#hubModalPanel [data-dialog-close]');
    await page.waitForFunction(() => document.querySelectorAll('#prBody tr[data-key]').length === 3, null, { timeout: 20000 });
    ok('PR/MR: daftar menyusut jadi 3 terbuka setelah merge', true);

    // buat PR dari branch rilis (dipakai ulang oleh alur rilis nanti)
    await page.click('#refreshBtn'); await page.waitForTimeout(2500);
    await page.click('[data-top="create"]');
    await page.waitForSelector('#hubModalPanel [data-head]', { timeout: 15000 });
    await page.selectOption('#hubModalPanel [data-head]', 'karirkit/9.9.9');
    await page.waitForFunction(() => document.querySelector('#hubModalPanel [data-title]').value.length > 0, null, { timeout: 8000 });
    ok('buat PR: judul terisi otomatis dari commit terakhir branch', /rilis 9\.9\.9/.test(await page.inputValue('#hubModalPanel [data-title]')), await page.inputValue('#hubModalPanel [data-title]'));
    await page.selectOption('#hubModalPanel [data-base]', 'master');
    await page.locator('#hubModalPanel [data-plat="gitlab"]').uncheck();
    await shot('07-buat-pr');
    await page.click('#hubModalPanel [data-create]');
    await page.waitForFunction(() => !document.getElementById('hubModal').classList.contains('is-open'), null, { timeout: 20000 });
    ok('buat PR: PR baru tercatat di GitHub (head karirkit/9.9.9 -> master)', gh.read().prs.some((p) => p.number === 10 && p.head === 'karirkit/9.9.9' && p.base === 'master'));

    /* -------------------------------------------------- 5. rilis */
    await go('rilis', '[data-repo]');
    await page.click('[data-fetch]');
    await page.waitForFunction(() => /karirkit\/9\.9\.9/.test(document.querySelector('[data-branch]') ? document.querySelector('[data-branch]').innerText : ''), null, { timeout: 20000 });
    ok('rilis: daftar branch memuat karirkit/9.9.9 dan rencana 2 langkah', (await page.locator('[data-step]').count()) === 2 && /karirkit\/9\.9\.9/.test(await page.locator('[data-steps]').innerText()));
    await shot('08-rilis-rencana');
    await page.click('[data-run]');
    await page.waitForSelector('#hubModalPanel [data-confirm]');
    ok('rilis: dialog konfirmasi menampilkan urutan dan peringatan', /karirkit\/9\.9\.9/.test(await page.locator('#hubModalPanel').innerText()) && /master/.test(await page.locator('#hubModalPanel').innerText()));
    await page.click('#hubModalPanel [data-confirm]');
    await page.waitForFunction(() => /Rilis selesai/.test(document.getElementById('view').innerText), null, { timeout: 45000 });
    const rel = (await page.locator('#view').innerText()).replace(/\s+/g, ' ');
    ok('rilis: 2 dari 2 langkah selesai, PR terbuka dipakai ulang, mirror + deployment dilaporkan', /2 dari 2 langkah selesai/.test(rel) && /Memakai PR terbuka #10/.test(rel) && /Mirror GitLab/.test(rel) && /success/.test(rel), rel.slice(rel.indexOf('Rilis selesai'), rel.indexOf('Rilis selesai') + 220));
    const prs = gh.read().prs.filter((p) => p.number >= 10);
    ok('rilis: kedua PR ter-merge (branch -> master, master -> karirkit/vercel)', prs.length === 2 && prs.every((p) => p.state === 'merged') && prs[1].head === 'master' && prs[1].base === 'karirkit/vercel', JSON.stringify(prs.map((p) => [p.number, p.head, p.base, p.state])));
    await shot('09-rilis-selesai');

    /* -------------------------------------------------- 6. repositori */
    await go('repositori', '[data-add="folder"]');
    await page.click('[data-add="folder"]');
    await page.waitForSelector('#hubModalPanel [data-form]', { timeout: 15000 });
    ok('tambah repo: folder dipilih, nama terdeteksi dari folder', (await page.inputValue('#hubModalPanel [name="name"]')) === 'proyek-gamma');
    await page.fill('#hubModalPanel [name="github"]', 'org/gamma');
    await page.click('#hubModalPanel details summary'); // bagian Lanjutan: URL git eksplisit
    await page.fill('#hubModalPanel [name="ghUrl"]', C.gh);
    await shot('10-form-repo');
    await page.click('#hubModalPanel [data-save]');
    await page.waitForFunction(() => !document.getElementById('hubModal').classList.contains('is-open'), null, { timeout: 15000 });
    await page.waitForFunction(() => document.querySelectorAll('#view tbody tr').length === 3, null, { timeout: 10000 });
    ok('tambah repo: baris ke-3 muncul di daftar', /proyek-gamma|org\/gamma/.test(await page.locator('#view tbody').innerText()));
    // validasi form: nama kosong ditolak dengan pesan
    await page.locator('#view tbody tr').nth(2).locator('[data-act="edit"]').click();
    await page.waitForSelector('#hubModalPanel [data-form]');
    await page.fill('#hubModalPanel [name="name"]', '');
    await page.click('#hubModalPanel [data-save]');
    await page.waitForSelector('#hubModalPanel [data-error]:not(.hidden)', { timeout: 5000 });
    ok('ubah repo: nama kosong ditolak dengan pesan galat', /Nama repo wajib/.test(await page.locator('#hubModalPanel [data-error]').innerText()));
    await page.fill('#hubModalPanel [name="name"]', 'Proyek Gamma');
    await page.click('#hubModalPanel [data-save]');
    await page.waitForFunction(() => !document.getElementById('hubModal').classList.contains('is-open'), null, { timeout: 15000 });
    await page.waitForFunction(() => /Proyek Gamma/.test(document.getElementById('view').innerText), null, { timeout: 10000 });
    ok('ubah repo: nama baru tersimpan', true);
    // uji koneksi
    await page.locator('#view tbody tr').first().locator('[data-act="test"]').click();
    await page.waitForSelector('#hubModalPanel :text("GitHub")', { timeout: 15000 });
    await page.waitForFunction(() => /Level akses: 30/.test(document.getElementById('hubModalPanel').innerText), null, { timeout: 15000 });
    ok('uji koneksi: GitHub (WRITE) dan GitLab (level 30) terbaca', /Akses: WRITE/.test(await page.locator('#hubModalPanel').innerText()));
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('hubModal').classList.contains('is-open'));
    // hapus dari daftar: folder tidak disentuh
    await page.locator('#view tbody tr').nth(2).locator('[data-act="remove"]').click();
    await page.waitForSelector('#hubModalPanel [data-confirm]');
    ok('hapus repo: konfirmasi menegaskan folder tidak disentuh', /tidak disentuh/.test(await page.locator('#hubModalPanel').innerText()));
    await page.click('#hubModalPanel [data-confirm]');
    await page.waitForFunction(() => document.querySelectorAll('#view tbody tr').length === 2, null, { timeout: 10000 });
    ok('hapus repo: kembali 2 baris, folder masih ada di disk', fs.existsSync(C.work));
    // pindai folder induk
    await app.evaluate(({}, p) => { process.env.HUB_PICK_FOLDER = p; }, C.root);
    await page.click('[data-add="scan"]');
    await page.waitForSelector('#hubModalPanel [data-add-selected]', { timeout: 15000 });
    ok('pindai folder: menemukan repo di dalam folder induk', /proyek-gamma/.test(await page.locator('#hubModalPanel').innerText()));
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('hubModal').classList.contains('is-open'));

    /* -------------------------------------------------- 7. aktivitas + pengaturan */
    await go('aktivitas', '#actTable');
    const act = await page.locator('#actTable tbody').innerText();
    ok('aktivitas: push, mirror, review, merge, buat PR, rilis, dan repo tercatat', ['Push', 'Mirror', 'Review', 'Merge', 'Buat PR/MR', 'Rilis', 'Tambah repo', 'Hapus repo'].every((w) => act.includes(w)), act.replace(/\s+/g, ' ').slice(0, 100));
    ok('aktivitas: token tidak pernah tercatat (di layar maupun di berkas)', !/secret-token/.test(act) && !/secret-token/.test(fs.readFileSync(nodePath.join(userData, 'activity.json'), 'utf8')) && !/secret-token/.test(fs.readFileSync(nodePath.join(userData, 'config.json'), 'utf8')));
    await shot('11-aktivitas');
    await go('pengaturan', '[data-save-buffer]');
    await page.waitForFunction(() => /Terhubung: dimas/.test(document.getElementById('view').innerText), null, { timeout: 15000 });
    ok('pengaturan: GitHub terhubung sebagai dimas, token GitLab dari env, tidak ada token di DOM', /sebagai\s+dimas/.test(await page.locator('#view').innerText()) && /Token dari: env/.test(await page.locator('#view').innerText()) && !/secret-token/.test(await page.content()));
    await page.fill('[data-buffer]', '2097152');
    await page.click('[data-save-buffer]');
    await page.waitForFunction(() => /2\.0 MB/.test(document.getElementById('view').innerText), null, { timeout: 8000 });
    ok('pengaturan: buffer git tersimpan (2.0 MB)', true);

    /* -------------------------------------------------- 8. tema gelap + layar sempit + keamanan */
    await page.click('[data-theme-option="dark"]');
    ok('tema: mode gelap diterapkan ke <html>', (await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark');
    await go('dasbor', '#repoBody tr[data-id]');
    await page.waitForTimeout(800);
    await shot('12-dasbor-gelap');
    await go('pull-request', '#prBody tr');
    await page.waitForTimeout(1500);
    await page.locator('#prBody tr[data-key] [data-act="detail"]').first().click();
    await page.waitForSelector('#hubModalPanel [data-tab]', { timeout: 15000 });
    await shot('13-detail-gelap');
    await page.keyboard.press('Escape');
    await page.click('[data-theme-option="light"]');
    await page.setViewportSize({ width: 1000, height: 760 });
    await go('dasbor', '#repoBody tr[data-id]');
    await page.waitForTimeout(800);
    ok('layar sempit (1000px): halaman tidak melebar, tabel menggulir di dalam kartu', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await shot('14-dasbor-1000');
    // CSP & isolasi: UI tidak punya akses Node, dan skrip inline diblokir
    const iso = await page.evaluate(() => ({ require: typeof require, process: typeof process, hubKeys: Object.keys(window.hub).sort().join(',') }));
    ok('keamanan: tanpa require/process di UI; jembatan hanya platform/invoke/on', iso.require === 'undefined' && iso.process === 'undefined' && iso.hubKeys === 'invoke,on,platform', JSON.stringify(iso));
    const bad = await page.evaluate(() => window.hub.invoke('shell:exec', { cmd: 'calc' }));
    ok('keamanan: channel di luar daftar ditolak', bad.ok === false && /tidak diizinkan/i.test(bad.error));
    ok('keamanan: push tanpa konfirmasi ditolak oleh proses utama', (await page.evaluate((id) => window.hub.invoke('git:push', { repoId: id, branch: 'master' }), idA)).error.includes('konfirmasi'));
    const ext = await page.evaluate(() => window.hub.invoke('shell:openExternal', { url: 'file:///C:/Windows/System32/calc.exe' }));
    ok('keamanan: openExternal menolak selain https', ext.ok === false);

    ok('tidak ada galat console / pageerror / pelanggaran CSP selama seluruh uji', problems.length === 0, JSON.stringify(problems.slice(0, 4)));
    console.log(fails ? `\n${fails} GAGAL` : '\nSEMUA UJI UI LULUS');
  } catch (e) {
    fails++;
    console.error('UJI BERHENTI:', e.message.split('\n')[0]);
    try { await shot('zz-gagal'); console.error('Dialog:', (await page.locator('#hubModalPanel').innerText()).slice(0, 400)); } catch { /* abaikan */ }
    console.error('Masalah halaman:', JSON.stringify(problems.slice(0, 5)));
  } finally { await app.close(); gl.close(); [A, B, C].forEach((r) => r.cleanup()); }
  process.exit(fails ? 1 : 0);
})();
