'use strict';
// Peluncuran cepat: buka aplikasi dengan dua repo contoh, tangkap galat, ambil tangkapan layar tiap halaman.
const { makeRig, startGitlab, ghState, launch, fs, nodePath } = require('./e2e-lib.cjs');

(async () => {
  const OUT = process.env.SHOTS || nodePath.join(require('node:os').tmpdir(), 'hub-shots');
  fs.mkdirSync(OUT, { recursive: true });
  const gl = await startGitlab();
  const gh = ghState();
  const A = makeRig('proyek-alfa'), B = makeRig('proyek-beta');
  A.sh('branch', '--set-upstream-to=origin/master'); A.commit('commit lokal belum di-push', 'a.txt'); fs.writeFileSync(nodePath.join(A.work, 'kotor.txt'), 'x');
  B.sh('branch', '--set-upstream-to=origin/master');
  const repos = [
    { name: 'Proyek Alfa', path: A.work, github: { repo: 'org/demo', url: A.gh }, gitlab: { baseUrl: gl.base, path: 'grp/demo', url: A.gl }, warnBranches: ['release'] },
    { name: 'Proyek Beta', path: B.work, github: { repo: 'org/other', url: B.gh } },
  ];
  const { app, page, problems } = await launch(repos, { gh });
  try {
    await page.waitForSelector('#repoBody tr', { timeout: 20000 });
    await page.waitForTimeout(3000);
    for (const [hash, name] of [['dasbor', 'dasbor'], ['pull-request', 'pull-request'], ['rilis', 'rilis'], ['repositori', 'repositori'], ['aktivitas', 'aktivitas'], ['pengaturan', 'pengaturan']]) {
      await page.evaluate((h) => { location.hash = `#/${h}`; }, hash);
      await page.waitForTimeout(1800);
      await page.screenshot({ path: nodePath.join(OUT, `${name}.png`) });
      console.log(`${name}: ok | h2="${await page.textContent('#view h2')}"`);
    }
    console.log('PROBLEMS:', JSON.stringify(problems, null, 1));
  } finally { await app.close(); gl.close(); A.cleanup(); B.cleanup(); }
})().catch((e) => { console.error('SMOKE FAILED', e); process.exit(1); });
