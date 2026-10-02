'use strict';
// Uji UI untuk repo dengan GitLab tetapi TANPA token: MR GitLab nonaktif (catatan netral, bukan peringatan),
// sementara GitHub dan seluruh fitur berbasis git tetap berjalan.
const { makeRig, ghState, launch, fs, nodePath } = require('./e2e-lib.cjs');

const OUT = process.env.SHOTS || nodePath.join(require('node:os').tmpdir(), 'hub-shots');
fs.mkdirSync(OUT, { recursive: true });
let fails = 0;
const ok = (name, cond, extra) => { if (!cond) fails++; console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra !== undefined ? ` ${extra}` : ''}`); };

(async () => {
  const gh = ghState();
  const A = makeRig('proyek-alfa');
  A.sh('branch', '--set-upstream-to=origin/master');
  const repos = [{ name: 'Proyek Alfa', path: A.work, github: { repo: 'org/demo', url: A.gh }, gitlab: { baseUrl: 'https://notoken.invalid', path: 'grp/demo', url: A.gl } }];
  // tanpa token: kosongkan variabel token dan helper kredensial git milik mesin ini (helper kosong = reset daftar helper)
  const { app, page, problems } = await launch(repos, { gh, extraEnv: { HUB_GITLAB_TOKEN: '', GITLAB_TOKEN: '', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '' } });
  const shot = (n) => page.screenshot({ path: nodePath.join(OUT, `${n}.png`) });
  const go = async (hash, sel) => { await page.evaluate((h) => { location.hash = `#/${h}`; }, hash); await page.waitForSelector(sel, { timeout: 15000 }); };
  const closeModal = async () => { await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.getElementById('hubModal').classList.contains('is-open')); };

  try {
    await page.waitForSelector('#repoBody tr[data-id]', { timeout: 20000 });
    await page.waitForFunction(() => !document.querySelector('#repoBody tr.repo-row-loading') && /GH \d/.test(document.getElementById('repoBody').innerText), null, { timeout: 25000 });
    const row = (await page.locator('#repoBody tr').first().innerText()).replace(/\s+/g, ' ');
    ok('dasbor: kolom PR/MR menampilkan "GH 3 · GL off" tanpa tanda peringatan', /GH 3 · GL off/.test(row) && !/⚠/.test(row), row.slice(0, 140));
    ok('dasbor: tooltip menjelaskan GitLab MR nonaktif karena tanpa token', /no GitLab token is set/.test(await page.locator('#repoBody a[href="#/pull-request"]').first().getAttribute('title')));
    ok('dasbor: tombol Push tetap aktif tanpa token', await page.locator('#repoBody [data-act="push"]').first().isEnabled());
    await shot('20-notoken-dasbor');

    await go('pull-request', '#prBody tr[data-key]');
    await page.waitForFunction(() => /GitLab MRs are off/.test(document.getElementById('prErrors').innerText), null, { timeout: 15000 });
    ok('PR/MR: catatan netral "GitLab MRs are off" (callout-info), bukan peringatan', (await page.locator('#prErrors .callout-info').count()) === 1 && (await page.locator('#prErrors .callout-warning').count()) === 0);
    ok('PR/MR: PR GitHub tetap tampil (3 baris)', (await page.locator('#prBody tr[data-key]').count()) === 3);
    await shot('21-notoken-pr');

    await go('pengaturan', '[data-save-buffer]');
    await page.waitForFunction(() => /Needs token/.test(document.getElementById('view').innerText), null, { timeout: 15000 });
    const settings = await page.locator('#view').innerText();
    ok('pengaturan: status "Needs token" dan keterangan bahwa token opsional', /Needs token/.test(settings) && /work without it/.test(settings));

    await go('repositori', '[data-add="folder"]');
    await page.locator('#view tbody tr').first().locator('[data-act="test"]').click();
    await page.waitForFunction(() => /still work through git/.test(document.getElementById('hubModalPanel').innerText), null, { timeout: 15000 });
    ok('uji koneksi: GitLab tanpa token ditampilkan sebagai catatan netral (ikon info)', (await page.locator('#hubModalPanel .text-info-600').count()) >= 1 && (await page.locator('#hubModalPanel .text-danger-700').count()) === 0);
    await closeModal();

    ok('tidak ada galat console / pageerror selama uji', problems.length === 0, JSON.stringify(problems.slice(0, 4)));
    console.log(fails ? `\n${fails} GAGAL` : '\nSEMUA UJI UI (TANPA TOKEN) LULUS');
  } catch (e) {
    fails++;
    console.error('UJI BERHENTI:', e.message.split('\n')[0]);
    try { await shot('zz-notoken-gagal'); } catch { /* abaikan */ }
    console.error('Masalah halaman:', JSON.stringify(problems.slice(0, 5)));
  } finally { await app.close(); A.cleanup(); }
  process.exit(fails ? 1 : 0);
})();
