'use strict';
const { makeRig, startGitlab, ghState, launch } = require('./e2e-lib.cjs');
(async () => {
  const gl = await startGitlab(); const gh = ghState(); const A = makeRig('proyek-alfa');
  const { app, page, problems } = await launch([{ name: 'Proyek Alfa', path: A.work, github: { repo: 'org/demo', url: A.gh } }], { gh });
  try {
    await page.waitForSelector('#repoBody tr', { timeout: 20000 });
    for (const h of ['pull-request', 'rilis', 'repositori', 'repositori', 'aktivitas']) {
      await page.evaluate((x) => { location.hash = `#/${x}`; }, h);
      await page.waitForTimeout(1500);
      console.log(h, '=> hash:', await page.evaluate(() => location.hash), '| crumb:', await page.textContent('#crumb'), '| h2:', await page.textContent('#view h2'));
    }
    console.log('PROBLEMS:', JSON.stringify(problems));
  } finally { await app.close(); gl.close(); A.cleanup(); }
})().catch((e) => { console.error('DEBUG FAILED', e); process.exit(1); });
