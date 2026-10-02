'use strict';
// Uji UI untuk akun + SSH: saran terdeteksi, "Add all", kolom/filter Account di dasbor, cek koneksi (ssh -T) + trust host,
// wizard "Create a new key" (pratinjau dulu, baru menulis), formulir repo (akun, Use SSH, Back to HTTPS).
// Tanpa jaringan: folder ssh sementara (HUB_SSH_DIR), ssh/ssh-keyscan/git-ssh palsu, dan remote lokal lewat url.<bare>.insteadOf.
const crypto = require('node:crypto');
const { makeRig, ghState, launch, fs, os, nodePath } = require('./e2e-lib.cjs');

// folder ssh sementara: ~/.ssh asli TIDAK PERNAH disentuh. Harus diatur sebelum sshconfig dipakai.
const SSH = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'hub-ssh-e2e-'));
process.env.HUB_SSH_DIR = SSH;
const sshc = require('../main/sshconfig');

const OUT = process.env.SHOTS || nodePath.join(os.tmpdir(), 'hub-shots');
fs.mkdirSync(OUT, { recursive: true });
let fails = 0;
const ok = (name, cond, extra) => { if (!cond) fails++; console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra !== undefined ? ` ${extra}` : ''}`); };
const norm = (p) => String(p).replace(/\\/g, '/').toLowerCase();
const fwd = (p) => String(p).replace(/\\/g, '/');
const flat = (s) => String(s).replace(/\s+/g, ' ').trim();

// kunci host ed25519 yang valid (blob OpenSSH) untuk known_hosts dan ssh-keyscan palsu
function ed25519Blob() {
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  const raw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
  return Buffer.concat([u32(11), Buffer.from('ssh-ed25519'), u32(32), raw]).toString('base64');
}

// repo kerja dengan origin HTTPS yang dialihkan ke remote bare lokal (satu platform per repo)
function mkRepo(name, kind, url) {
  const rig = makeRig(name);
  const bare = fwd(kind === 'github' ? rig.gh : rig.gl);
  rig.sh('config', `url.${bare}.insteadOf`, url);
  rig.sh('config', 'remote.origin.url', url);
  rig.sh('config', '--unset-all', 'remote.origin.pushurl');
  rig.sh('config', 'branch.master.remote', 'origin');
  rig.sh('config', 'branch.master.merge', 'refs/heads/master');
  rig.bare = kind === 'github' ? rig.gh : rig.gl;
  return rig;
}

(async () => {
  /* -------------------------------------------------- bahan uji */
  for (const n of ['github', 'gitlab', 'orphan']) { const r = await sshc.createKey({ name: n, comment: `${n}@example.com` }); if (!r.ok) throw new Error(`seed key: ${r.error}`); }
  fs.rmSync(nodePath.join(SSH, 'id_ed25519_orphan')); // tinggal .pub: harus ditandai "No private key"
  for (const [alias, key] of [['github.com', 'github'], ['gitlab.sevima.com', 'gitlab'], ['git.internal.example', 'gitlab']]) {
    const r = sshc.appendHostBlock({ alias, hostName: alias, identityFile: `id_ed25519_${key}`, label: alias }); if (!r.ok) throw new Error(`seed host: ${r.error}`);
  }
  const blobKnown = ed25519Blob(), blobNew = ed25519Blob();
  const knownFile = nodePath.join(SSH, 'known_hosts');
  fs.writeFileSync(knownFile, `github.com ssh-ed25519 ${blobKnown}\ngitlab.sevima.com ssh-ed25519 ${blobKnown}\ndenied.example ssh-ed25519 ${blobKnown}\n`);
  const fpNew = sshc.fingerprintOf(blobNew);
  const configBefore = fs.readFileSync(nodePath.join(SSH, 'config'), 'utf8');
  const bakList = () => fs.readdirSync(SSH).filter((f) => f.startsWith('config.bak-'));
  const bak0 = bakList();

  const gh = ghState({ viewer: 'ahmdims' });
  const H = { alpha: 'https://github.com/ahmdims/alpha.git', bravo: 'https://github.com/foxtrot-sevima/bravo.git', charlie: 'https://gitlab.sevima.com/maukuliah/charlie.git', delta: 'https://github.com/ahmdims/delta.git' };
  const A = mkRepo('alpha', 'github', H.alpha), B = mkRepo('bravo', 'github', H.bravo), C = mkRepo('charlie', 'gitlab', H.charlie), D = mkRepo('delta', 'github', H.delta);
  // repo kelima (ditambahkan lewat IPC di tengah uji) di host GitLab yang BELUM ada di known_hosts: "Use SSH" harus meminta trust host
  const H5 = 'https://gitlab.trust.example/team/echo.git';
  const E = mkRepo('echo', 'gitlab', H5);
  const blobTrust = ed25519Blob();
  // pembungkus git-ssh palsu: seperti ssh sungguhan, menolak host yang belum ada di known_hosts ("Host key verification failed"),
  // selain itu meneruskan ke transport palsu bawaan (fixtures-fake-git-ssh.cjs)
  const strictDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'hub-strict-'));
  const strictSsh = nodePath.join(strictDir, 'git-ssh-strict.cjs');
  fs.writeFileSync(strictSsh, `'use strict';
const fs = require('node:fs');
const args = process.argv.slice(2);
const i = args.findIndex((a) => a.startsWith('git@'));
const alias = i >= 0 ? args[i].slice(4) : '';
let known = ''; try { known = fs.readFileSync(process.env.FAKE_SSH_TRUST_FILE, 'utf8'); } catch { /* belum ada */ }
if (!known.split(/\\r?\\n/).some((l) => (l.trim().split(/\\s+/)[0] || '').split(',').includes(alias))) {
  process.stderr.write('Host key verification failed.\\nfatal: Could not read from remote repository.\\n\\nPlease make sure you have the correct access rights\\nand the repository exists.\\n');
  process.exit(255);
}
require(${JSON.stringify(fwd(nodePath.join(__dirname, 'fixtures-fake-git-ssh.cjs')))});
`);
  const gl = (path) => ({ baseUrl: 'https://gitlab.sevima.com', path, url: H.charlie });
  const repos = [
    { name: 'alpha', path: A.work, github: { repo: 'ahmdims/alpha', url: H.alpha } },
    { name: 'bravo', path: B.work, github: { repo: 'foxtrot-sevima/bravo', url: H.bravo } },
    { name: 'charlie', path: C.work, gitlab: gl('maukuliah/charlie') },
    { name: 'delta', path: D.work, github: { repo: 'ahmdims/delta', url: H.delta } },
  ];
  const sshLog = nodePath.join(fs.mkdtempSync(nodePath.join(os.tmpdir(), 'hub-sshlog-')), 'calls.log');
  const node = process.execPath.replace(/\\/g, '/');
  const extraEnv = {
    HUB_GITLAB_TOKEN: '', GITLAB_TOKEN: '', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '',
    HUB_SSH_DIR: SSH, HUB_SSH_BIN: nodePath.join(__dirname, 'fixtures-fake-ssh.cjs'), HUB_SSH_KEYSCAN_BIN: nodePath.join(__dirname, 'fixtures-fake-keyscan.cjs'),
    FAKE_SSH_LOG: sshLog, FAKE_SSH_TRUST_FILE: knownFile,
    FAKE_SSH_MAP: JSON.stringify({
      'github.com': { out: "Hi ahmdims! You've successfully authenticated, but GitHub does not provide shell access.", code: 1 },
      'gitlab.sevima.com': { out: 'Welcome to GitLab, @maukuliah!', code: 0 },
      'git.internal.example': { out: 'Welcome to GitLab, @budi!', code: 0 },
      'github.com-github-side-org': { out: "Hi side-user! You've successfully authenticated, but GitHub does not provide shell access.", code: 1 },
      'denied.example': { out: 'git@denied.example: Permission denied (publickey).', code: 255 },
    }),
    FAKE_KEYSCAN: JSON.stringify({ 'git.internal.example': `ssh-ed25519 ${blobNew}`, 'gitlab.trust.example': `ssh-ed25519 ${blobTrust}` }),
    GIT_SSH_COMMAND: `"${node}" "${fwd(strictSsh)}"`,
    FAKE_GIT_SSH_MAP: JSON.stringify({ 'github.com:ahmdims/delta.git': D.bare, 'gitlab.trust.example:team/echo.git': E.bare }),
  };
  const { app, page, problems, userData } = await launch(repos, { gh, extraEnv });
  const cfg = () => JSON.parse(fs.readFileSync(nodePath.join(userData, 'config.json'), 'utf8'));
  const repoCfg = (name) => cfg().repos.find((r) => r.name === name);
  const acctCfg = (label) => cfg().accounts.find((a) => a.label === label);
  const shot = async (n) => { await page.waitForTimeout(500); await page.screenshot({ path: nodePath.join(OUT, `${n}.png`) }); }; // tunggu animasi dialog selesai
  const go = async (hash, sel) => { await page.evaluate((h) => { location.hash = `#/${h}`; }, hash); await page.waitForSelector(sel, { timeout: 15000 }); };
  const modalClosed = () => page.waitForFunction(() => !document.getElementById('hubModal').classList.contains('is-open'), null, { timeout: 15000 });
  const panelText = async () => flat(await page.locator('#hubModalPanel').innerText());
  const card = (label) => page.locator('#view [data-acct]', { hasText: label });
  const gitCfg = (rig, key = 'remote.origin.url') => rig.sh('config', '--get', key);
  const snapshot = () => JSON.stringify(fs.readdirSync(SSH).sort().map((f) => [f, crypto.createHash('sha256').update(fs.readFileSync(nodePath.join(SSH, f))).digest('hex')]));

  try {
    // jangan membuka browser sungguhan saat tombol "Open ... SSH keys page" ditekan
    await app.evaluate(({ shell }) => { global.__opened = []; shell.openExternal = async (u) => { global.__opened.push(u); }; });

    /* -------------------------------------------------- 1. saran terdeteksi + Add all + dasbor */
    await page.waitForSelector('#repoBody tr[data-id]', { timeout: 20000 });
    ok('dasbor: kolom Account ada dan semua remote belum punya akun ("—")', /Account/.test(await page.locator('#repoTable thead').innerText()) && (await page.locator('#repoBody tr').first().locator('td').nth(3).innerText()).trim() === '—');
    ok('navigasi: item "Accounts" di grup Manage antara Repositories dan Activity', await page.evaluate(() => { const l = [...document.querySelectorAll('#sidebar [data-nav]')].map((a) => a.dataset.nav); return l.indexOf('accounts') === l.indexOf('repositori') + 1 && l.indexOf('aktivitas') === l.indexOf('accounts') + 1; }));

    await page.click('#sidebar [data-nav="accounts"]');
    await page.waitForSelector('#view [data-do="add"]', { timeout: 15000 });
    await page.waitForFunction(() => document.querySelectorAll('[data-sug]').length === 4, null, { timeout: 30000 });
    ok('halaman Accounts: judul halaman dan breadcrumb', /Accounts/.test(await page.locator('#crumb').innerText()) && /Accounts/.test(await page.locator('#view h2').innerText()));
    const sugText = flat(await page.locator('[data-suggestions]').innerText());
    ok('saran: GitHub · ahmdims (github.com, 2 repo, alias+kunci SSH), GitHub · foxtrot-sevima, GitLab · maukuliah, dan alias dari ssh config', /GitHub · ahmdims/.test(sugText) && /GitHub · foxtrot-sevima/.test(sugText) && /GitLab · maukuliah/.test(sugText) && /Git · git\.internal\.example/.test(sugText) && /2 repos: alpha, delta/.test(sugText) && /github\.com · id_ed25519_github/.test(sugText) && /gitlab\.sevima\.com · id_ed25519_gitlab/.test(sugText), sugText.slice(0, 220));
    const detText = flat(await page.locator('#view').innerText());
    ok('terdeteksi: folder ssh, kunci publik (tipe + sidik jari), kunci tanpa file privat ditandai, host ssh, login gh', norm(await page.locator('[data-ssh-dir]').innerText()) === norm(SSH) && /id_ed25519_github\.pub/.test(detText) && /ED25519/.test(detText) && /SHA256:/.test(detText) && /id_ed25519_orphan\.pub[^]*No private key/.test(detText) && /github\.com → git@github\.com/.test(detText) && /git\.internal\.example → git@git\.internal\.example/.test(detText) && (await page.locator('[data-hosts] li').count()) === 3 && /ahmdims/.test(await page.locator('[data-gh]').innerText()) && /Active/.test(await page.locator('[data-gh]').innerText()), detText.slice(detText.indexOf('Public keys found'), detText.indexOf('Public keys found') + 160));
    ok('terdeteksi: dua kunci dengan private + satu tanpa private (3 baris kunci)', (await page.locator('[data-keys] li').count()) === 3);
    await shot('30-accounts-detected');

    await page.click('[data-do="sug-all"]');
    await page.waitForSelector('#hubModalPanel [data-confirm]');
    ok('Add all: dialog konfirmasi menyebut ke mana akun ditulis (hanya di app, bukan folder ssh)', /Add 4 accounts\?/.test(await page.locator('#hubModalPanel .modal-title').innerText()) && /Nothing is written to your ssh folder/.test(await panelText()));
    const sshBeforeAll = snapshot();
    await page.click('#hubModalPanel [data-confirm]');
    await modalClosed();
    await page.waitForFunction(() => document.querySelectorAll('#view [data-acct]').length === 4 && document.querySelector('[data-no-suggestions]'), null, { timeout: 30000 });
    ok('Add all: 4 akun tersimpan di config.json, folder ssh tidak berubah', cfg().accounts.length === 4 && snapshot() === sshBeforeAll);
    const ahmdims = acctCfg('GitHub · ahmdims'), foxtrot = acctCfg('GitHub · foxtrot-sevima'), kantor = acctCfg('GitLab · maukuliah'), internal = acctCfg('Git · git.internal.example');
    ok('akun: pemilik, login, identitas SSH tersimpan benar', ahmdims && ahmdims.login === 'ahmdims' && ahmdims.owners[0] === 'ahmdims' && ahmdims.ssh.alias === 'github.com' && ahmdims.ssh.identityFile === 'id_ed25519_github' && foxtrot.login === '' && kantor.provider === 'gitlab' && internal.provider === 'other' && internal.owners.length === 0);
    const gitHubRepos = ['alpha', 'bravo', 'charlie', 'delta'].map((n) => repoCfg(n));
    ok('penetapan otomatis: remote tiap repo masuk ke akun yang benar', gitHubRepos[0].github.account === ahmdims.id && gitHubRepos[1].github.account === foxtrot.id && gitHubRepos[2].gitlab.account === kantor.id && gitHubRepos[3].github.account === ahmdims.id);
    const cardText = flat(await card('GitHub · ahmdims').innerText());
    ok('kartu akun: logo, label, host, login, pemilik, "alias · kunci", jumlah repo, tombol Check/Edit/Remove', /GitHub · ahmdims/.test(cardText) && /github\.com/.test(cardText) && /@ahmdims/.test(cardText) && /github\.com · id_ed25519_github/.test(cardText) && /2 remotes/.test(cardText) && await card('GitHub · ahmdims').locator('[data-do="check"], [data-do="edit"], [data-do="remove"]').count() === 3 && await card('GitHub · ahmdims').locator('.kk-github-logo').count() === 1, cardText.slice(0, 200));
    await shot('31-accounts-page');

    await go('dasbor', '#repoBody tr[data-id]');
    await page.waitForFunction(() => /ahmdims/.test(document.getElementById('repoBody').innerText), null, { timeout: 15000 });
    const acctCell = async (name) => flat(await page.locator('#repoBody tr', { hasText: name }).locator('td').nth(3).innerText());
    ok('dasbor: kolom Account menampilkan label akun yang benar per repo', await acctCell('alpha') === 'GitHub · ahmdims' && await acctCell('bravo') === 'GitHub · foxtrot-sevima' && await acctCell('charlie') === 'GitLab · maukuliah' && await acctCell('delta') === 'GitHub · ahmdims', `${await acctCell('alpha')} | ${await acctCell('bravo')} | ${await acctCell('charlie')} | ${await acctCell('delta')}`);
    ok('dasbor: judul chip = host akun', (await page.locator('#repoBody tr', { hasText: 'charlie' }).locator('[data-chip="gitlab"]').getAttribute('title')) === 'gitlab.sevima.com');
    const visibleRows = () => page.locator('#repoBody tr[data-id]:not([hidden])').count();
    const opts = (await page.locator('#acctFilter option').allInnerTexts()).map((t) => t.trim());
    ok('dasbor: filter akun berisi All accounts, setiap akun, dan Unassigned', opts[0] === 'All accounts' && opts[opts.length - 1] === 'Unassigned' && ['GitHub · ahmdims', 'GitHub · foxtrot-sevima', 'GitLab · maukuliah', 'Git · git.internal.example'].every((l) => opts.includes(l)), JSON.stringify(opts));
    // pilihan baris harus ikut bersih saat barisnya tersaring (aksi massal hanya untuk baris yang terlihat)
    await page.locator('#repoBody tr', { hasText: 'bravo' }).locator('[data-table-select]').check();
    ok('dasbor: memilih 1 baris memunculkan bilah aksi massal', await page.locator('#repoTable [data-table-bulk]').isVisible());
    await page.selectOption('#acctFilter', { label: 'GitHub · ahmdims' });
    ok('dasbor: filter "GitHub · ahmdims" hanya menyisakan alpha dan delta', await visibleRows() === 2 && /alpha/.test(await page.locator('#repoBody tr:not([hidden])').first().innerText()) && /delta/.test(await page.locator('#repoBody tr:not([hidden])').nth(1).innerText()));
    ok('dasbor: baris terpilih yang tersaring dilepas (bilah massal hilang), info tabel mengikuti', !(await page.locator('#repoTable [data-table-bulk]').isVisible()) && /of\s*2/.test(await page.locator('[data-table-info]').innerText()));
    await page.selectOption('#acctFilter', { label: 'GitLab · maukuliah' });
    ok('dasbor: filter GitLab hanya menyisakan charlie', await visibleRows() === 1 && /charlie/.test(await page.locator('#repoBody tr:not([hidden])').innerText()));
    await page.selectOption('#acctFilter', { label: 'Unassigned' });
    ok('dasbor: filter Unassigned: tidak ada baris, pesan kosong tampil', await visibleRows() === 0 && await page.locator('[data-table-empty]').isVisible());
    await page.selectOption('#acctFilter', { label: 'GitHub · ahmdims' });
    await page.locator('#repoTable [data-table-select-all]').check();
    ok('dasbor: pilih semua (filter aktif) hanya memilih baris yang terlihat', (await page.locator('[data-table-selected-count]').innerText()) === '2');
    await page.locator('#repoTable [data-table-select-all]').uncheck();
    await shot('32-dashboard-accounts');
    await page.selectOption('#acctFilter', { label: 'All accounts' });
    ok('dasbor: "All accounts" menampilkan kembali 4 repo; tombol Pull/Push/Sync tetap ada', await visibleRows() === 4 && await page.locator('#repoBody [data-act="pull"]').count() === 4 && await page.locator('#repoBody [data-act="push"]').count() === 4 && await page.locator('#repoBody [data-act="mirror"]').count() === 4);
    ok('dasbor: kolom Account bisa diurutkan (th data-sort=text)', (await page.locator('#repoTable th', { hasText: 'Account' }).getAttribute('data-sort')) === 'text');
    ok('dasbor 1440px: tabel muat di kartu tanpa scroll horizontal (kolom Account tidak mendorong Actions keluar)', await page.evaluate(() => { const w = document.querySelector('#repoTable .overflow-x-auto'); return w.scrollWidth <= w.clientWidth + 1; }));

    /* -------------------------------------------------- 2. cek koneksi + trust host */
    await go('accounts', '#view [data-acct]');
    await card('GitHub · ahmdims').locator('[data-do="check"]').click();
    await page.waitForFunction(() => /Connected as/.test(document.querySelector('#view').innerText), null, { timeout: 20000 });
    ok('Check GitHub: "Connected as ahmdims"', /Connected as ahmdims/.test(flat(await card('GitHub · ahmdims').innerText())));
    const calls = fs.readFileSync(sshLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    ok('Check: ssh dijalankan dengan StrictHostKeyChecking=yes, BatchMode, kunci akun, alias akun', calls.length >= 1 && calls[0].includes('StrictHostKeyChecking=yes') && calls[0].includes('BatchMode=yes') && calls[0].includes('-i') && norm(calls[0][calls[0].indexOf('-i') + 1]) === norm(nodePath.join(SSH, 'id_ed25519_github')) && calls[0].includes('git@github.com'));
    await card('GitHub · foxtrot-sevima').locator('[data-do="check"]').click();
    await page.waitForFunction(() => /@ahmdims/.test([...document.querySelectorAll('#view [data-acct]')].find((c) => /foxtrot-sevima/.test(c.innerText)).innerText), null, { timeout: 20000 });
    ok('Check: login yang belum tersimpan diisi dari jawaban server dan disimpan (acct:save)', acctCfg('GitHub · foxtrot-sevima').login === 'ahmdims');

    await card('Git · git.internal.example').locator('[data-do="check"]').click();
    await page.waitForSelector('#view [data-do="trust"]', { timeout: 20000 });
    ok('Check host baru: pesan "not trusted yet" dan tombol "Review host key"', /not trusted yet/.test(flat(await card('git.internal.example').innerText())));
    ok('belum ada baris known_hosts untuk host itu', !/git\.internal\.example/.test(fs.readFileSync(knownFile, 'utf8')));
    await card('git.internal.example').locator('[data-do="trust"]').click();
    await page.waitForSelector('#hubModalPanel [data-trust-confirm]', { timeout: 15000 });
    const trustText = await panelText();
    ok('trust: dialog menampilkan tipe + sidik jari dari ssh-keyscan dan petunjuk membandingkan', trustText.includes(fpNew) && /ED25519/.test(trustText) && /Compare before you trust/.test(trustText) && /published by/.test(trustText), trustText.slice(0, 200));
    ok('trust: kotak centang wajib; tombol "Trust this host" nonaktif sebelum dicentang', /I compared this fingerprint with the one published by git\.internal\.example/.test(trustText) && await page.locator('#hubModalPanel [data-trust-go]').isDisabled());
    await shot('33-trust-host');
    await page.locator('#hubModalPanel [data-trust-confirm]').check();
    ok('trust: setelah dicentang tombol aktif', await page.locator('#hubModalPanel [data-trust-go]').isEnabled());
    await page.click('#hubModalPanel [data-trust-go]');
    await modalClosed();
    await page.waitForFunction(() => /Connected as budi/.test(document.querySelector('#view').innerText), null, { timeout: 20000 });
    const known = fs.readFileSync(knownFile, 'utf8').trim().split(/\r?\n/);
    ok('trust: known_hosts menerima baris persis "host jenis-kunci blob" (sidik jari yang dilihat pengguna)', known[known.length - 1] === `git.internal.example ssh-ed25519 ${blobNew}` && known.length === 4, known[known.length - 1].slice(0, 70));
    ok('trust: pengecekan ulang otomatis berhasil ("Connected as budi")', /Connected as budi/.test(flat(await card('git.internal.example').innerText())));

    /* -------------------------------------------------- 3. wizard: Create a new key */
    await page.locator('#view [data-do="add"]').first().click();
    await page.waitForSelector('#hubModalPanel [data-form]');
    ok('wizard: bawaan GitHub / github.com, label otomatis, tanpa identitas SSH', (await page.inputValue('#hubModalPanel [name="provider"]')) === 'github' && (await page.inputValue('#hubModalPanel [name="host"]')) === 'github.com' && (await page.locator('#hubModalPanel [name="mode"]:checked').getAttribute('value')) === 'none');
    await page.selectOption('#hubModalPanel [name="provider"]', 'gitlab');
    ok('wizard: ganti penyedia mengisi host bawaan gitlab.com', (await page.inputValue('#hubModalPanel [name="host"]')) === 'gitlab.com');
    await page.selectOption('#hubModalPanel [name="provider"]', 'github');
    ok('wizard: kembali ke GitHub mengisi github.com', (await page.inputValue('#hubModalPanel [name="host"]')) === 'github.com');
    await page.fill('#hubModalPanel [name="owners"]', 'side-org');
    ok('wizard: label mengikuti pemilik ("GitHub · side-org")', (await page.inputValue('#hubModalPanel [name="label"]')) === 'GitHub · side-org');
    await page.check('#hubModalPanel input[name="mode"][value="new"]');
    ok('wizard: nama kunci = slug label; alias = github.com-<slug> karena alias github.com sudah ada', (await page.inputValue('#hubModalPanel [name="keyName"]')) === 'github-side-org' && (await page.inputValue('#hubModalPanel [name="alias"]')) === 'github.com-github-side-org');
    ok('wizard: label akun yang sama ditolak sebelum menulis apa pun', await (async () => {
      await page.fill('#hubModalPanel [name="label"]', 'GitHub · ahmdims'); await page.click('#hubModalPanel [data-next]');
      const t = flat(await page.locator('#hubModalPanel [data-error]').innerText());
      await page.fill('#hubModalPanel [name="label"]', 'GitHub · side-org');
      return /already exists/.test(t);
    })());
    const before = snapshot();
    await page.click('#hubModalPanel [data-next]');
    await page.waitForSelector('#hubModalPanel [data-review]');
    const review = await panelText();
    const block = (await page.locator('#hubModalPanel [data-block]').innerText()).replace(/\r/g, '');
    ok('pratinjau: menyebut berkas kunci privat/publik yang akan dibuat', /id_ed25519_github-side-org/.test(await page.locator('#hubModalPanel [data-file="private"]').innerText()) && /id_ed25519_github-side-org\.pub/.test(await page.locator('#hubModalPanel [data-file="public"]').innerText()) && /No existing key is overwritten/.test(review));
    // label dibersihkan seperti di backend (karakter di luar [\w .@+-] dibuang), jadi titik tengah hilang
    const expectedBlock = ['# Added by Repo Hub: GitHub side-org', 'Host github.com-github-side-org', '    HostName github.com', '    User git', '    IdentityFile ~/.ssh/id_ed25519_github-side-org', '    IdentitiesOnly yes'].join('\n');
    ok('pratinjau: blok ssh config persis (Host, HostName, User, IdentityFile, IdentitiesOnly) + backup config dulu', block === expectedBlock && /backed up first/.test(review), JSON.stringify(block));
    ok('pratinjau: belum ada yang ditulis (isi folder ssh identik, tidak ada kunci/backup baru)', snapshot() === before && !fs.existsSync(nodePath.join(SSH, 'id_ed25519_github-side-org')) && bakList().length === bak0.length);
    ok('pratinjau: tombol konfirmasi eksplisit "Create key and add to ssh config"', /Create key and add to ssh config/.test(await page.locator('#hubModalPanel [data-write]').innerText()));
    await shot('34-wizard-preview');
    // kembali ke formulir lalu lanjut lagi: tetap belum menulis apa pun
    await page.click('#hubModalPanel [data-back]');
    await page.waitForSelector('#hubModalPanel [data-form]');
    ok('Back: isian formulir dipertahankan dan tetap belum ada yang ditulis', (await page.inputValue('#hubModalPanel [name="owners"]')) === 'side-org' && (await page.locator('#hubModalPanel [name="mode"]:checked').getAttribute('value')) === 'new' && snapshot() === before);
    await page.click('#hubModalPanel [data-next]');
    await page.waitForSelector('#hubModalPanel [data-write]');
    await page.click('#hubModalPanel [data-write]');
    await page.waitForSelector('#hubModalPanel [data-key-panel]', { timeout: 60000 });
    const privFile = nodePath.join(SSH, 'id_ed25519_github-side-org');
    ok('setelah konfirmasi: pasangan kunci ed25519 dibuat di folder ssh', fs.existsSync(privFile) && fs.existsSync(`${privFile}.pub`));
    const cfgAfter = fs.readFileSync(nodePath.join(SSH, 'config'), 'utf8');
    const newBaks = bakList().filter((f) => !bak0.includes(f));
    ok('config: blok Host ditambahkan di akhir persis seperti pratinjau, isi lama utuh', cfgAfter.startsWith(configBefore) && cfgAfter.slice(configBefore.length).includes(expectedBlock) && /HostName github\.com/.test(cfgAfter));
    ok('config: satu backup config.bak-* baru berisi isi lama persis', newBaks.length === 1 && fs.readFileSync(nodePath.join(SSH, newBaks[0]), 'utf8') === configBefore, newBaks.join(','));
    const pubText = fs.readFileSync(`${privFile}.pub`, 'utf8').trim();
    ok('kunci publik ditampilkan (textarea read-only, sama dengan berkas .pub), tanpa kunci privat di layar', (await page.locator('#hubModalPanel [data-pubkey]').inputValue()).trim() === pubText && (await page.locator('#hubModalPanel [data-pubkey]').getAttribute('readonly')) !== null && !/PRIVATE KEY/.test(await page.locator('#hubModalPanel').innerHTML()));
    ok('tombol "Open GitHub SSH keys page" dan Copy tersedia', /Open GitHub SSH keys page/.test(await panelText()) && /Copy public key/.test(await panelText()));
    await page.click('#hubModalPanel [data-copy-key]');
    await page.waitForFunction(() => /Copied|Ctrl\+C/.test(document.querySelector('#hubModalPanel [data-copy-label]').textContent), null, { timeout: 5000 });
    ok('Copy: umpan balik "Copied" (atau petunjuk Ctrl+C bila clipboard ditolak)', /Copied|Ctrl\+C/.test(await page.locator('#hubModalPanel [data-copy-label]').innerText()));
    await page.click('#hubModalPanel [data-open-url]');
    ok('tombol buka halaman kunci memakai keysUrl dari backend lewat shell:openExternal', (await app.evaluate(() => global.__opened)).includes('https://github.com/settings/ssh/new'));
    await shot('35-wizard-key');
    ok('Save account tidak aktif sebelum tes; "Save without testing" tersedia', await page.locator('#hubModalPanel [data-save]').isDisabled() && await page.locator('#hubModalPanel [data-save-untested]').isVisible());
    await page.click('#hubModalPanel [data-test]');
    await page.waitForSelector('#hubModalPanel [data-test-ok]', { timeout: 20000 });
    ok('tes koneksi lewat alias baru: "Connected as side-user"', /Connected as side-user/.test(await panelText()));
    ok('wizard: tidak ada teks "undefined" yang bocor ke layar', !/undefined|\[object/.test(await panelText()));
    const lastCall = fs.readFileSync(sshLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).pop();
    ok('tes koneksi: ssh -T dijalankan ke git@alias baru dengan kunci baru', lastCall.includes('git@github.com-github-side-org') && norm(lastCall[lastCall.indexOf('-i') + 1]) === norm(privFile));
    await page.click('#hubModalPanel [data-save]');
    await modalClosed();
    await page.waitForFunction(() => [...document.querySelectorAll('#view [data-acct]')].some((c) => /side-org/.test(c.innerText)), null, { timeout: 20000 });
    const side = acctCfg('GitHub · side-org');
    ok('akun tersimpan: owner side-org, login dari tes, alias + berkas kunci baru', side && side.owners[0] === 'side-org' && side.login === 'side-user' && side.ssh.alias === 'github.com-github-side-org' && side.ssh.identityFile === 'id_ed25519_github-side-org');
    ok('akun baru tampil sebagai kartu dengan "alias · kunci"', /github\.com-github-side-org · id_ed25519_github-side-org/.test(flat(await card('side-org').innerText())) && /@side-user/.test(flat(await card('side-org').innerText())));
    await page.waitForFunction(() => /id_ed25519_github-side-org\.pub/.test(document.querySelector('[data-keys]').innerText), null, { timeout: 15000 });
    ok('deteksi diperbarui: kunci baru muncul di daftar kunci publik', (await page.locator('[data-keys] li').count()) === 4);
    // tombol "Public key" pada kartu
    await card('side-org').locator('[data-do="pubkey"]').first().click();
    await page.waitForSelector('#hubModalPanel [data-pubkey]');
    ok('kartu: "Public key" menampilkan kunci publik yang sama', (await page.locator('#hubModalPanel [data-pubkey]').inputValue()).trim() === pubText);
    await page.locator('#hubModalPanel [data-dialog-close]').last().click();
    await modalClosed();

    // Edit akun
    await card('side-org').locator('[data-do="edit"]').click();
    await page.waitForSelector('#hubModalPanel [data-form]');
    ok('Edit: host hanya-baca, kolom label/owners/login/alias/kunci terisi', await page.locator('#hubModalPanel [name="host"]').isDisabled() && (await page.inputValue('#hubModalPanel [name="owners"]')) === 'side-org' && (await page.inputValue('#hubModalPanel [name="alias"]')) === 'github.com-github-side-org' && (await page.inputValue('#hubModalPanel [name="identityFile"]')) === 'id_ed25519_github-side-org');
    await page.fill('#hubModalPanel [name="label"]', 'GitHub · side projects');
    await page.click('#hubModalPanel [data-save]');
    await modalClosed();
    await page.waitForFunction(() => [...document.querySelectorAll('#view [data-acct]')].some((c) => /side projects/.test(c.innerText)), null, { timeout: 15000 });
    ok('Edit: label baru tersimpan', !!acctCfg('GitHub · side projects') && !acctCfg('GitHub · side-org'));

    // Remove from list
    await card('side projects').locator('[data-do="remove"]').click();
    await page.waitForSelector('#hubModalPanel [data-confirm]');
    ok('Remove: teks menjelaskan hanya entri daftar yang dihapus (repo, folder, kunci, ssh config tidak disentuh)', /only removes the entry from this app/i.test(await panelText()) && /not touched/.test(await panelText()));
    const sshBeforeRemove = snapshot();
    await page.click('#hubModalPanel [data-confirm]');
    await modalClosed();
    await page.waitForFunction(() => document.querySelectorAll('#view [data-acct]').length === 4, null, { timeout: 15000 });
    ok('Remove: akun hilang dari daftar, berkas kunci dan ssh config tetap', !acctCfg('GitHub · side projects') && snapshot() === sshBeforeRemove && fs.existsSync(privFile));

    // wizard: kunci yang sudah ada + alias baru, galat AUTH, "Show public key", "Save without testing"
    await page.locator('#view [data-do="add"]').first().click();
    await page.waitForSelector('#hubModalPanel [data-form]');
    await page.selectOption('#hubModalPanel [name="provider"]', 'other');
    await page.fill('#hubModalPanel [name="host"]', 'denied.example');
    await page.fill('#hubModalPanel [name="label"]', 'Denied host');
    await page.check('#hubModalPanel input[name="mode"][value="existing"]');
    const keyOpts = (await page.locator('#hubModalPanel [name="keyFile"] option').allInnerTexts()).map((t) => t.split(' · ')[0]);
    ok('wizard (kunci yang ada): select hanya berisi kunci yang punya file privat; alias bawaan = host', keyOpts.sort().join(',') === 'id_ed25519_github,id_ed25519_github-side-org,id_ed25519_gitlab' && (await page.inputValue('#hubModalPanel [name="alias"]')) === 'denied.example', keyOpts.join(','));
    await page.selectOption('#hubModalPanel [name="keyFile"]', 'id_ed25519_github');
    const before2 = snapshot();
    await page.click('#hubModalPanel [data-next]');
    await page.waitForSelector('#hubModalPanel [data-review]');
    ok('pratinjau (kunci yang ada): hanya blok config, tanpa pembuatan kunci; tombol "Add to ssh config"', await page.locator('#hubModalPanel [data-step-key]').count() === 0 && /Host denied\.example/.test(await page.locator('#hubModalPanel [data-block]').innerText()) && /IdentityFile ~\/\.ssh\/id_ed25519_github\b/.test(await page.locator('#hubModalPanel [data-block]').innerText()) && (await page.locator('#hubModalPanel [data-write]').innerText()).trim() === 'Add to ssh config' && snapshot() === before2);
    await page.click('#hubModalPanel [data-write]');
    await page.waitForSelector('#hubModalPanel [data-connect]', { timeout: 30000 });
    ok('alias ditambahkan ke config; kunci yang ada tidak diubah dan tidak ada kunci baru', /Host denied\.example/.test(fs.readFileSync(nodePath.join(SSH, 'config'), 'utf8')) && !fs.existsSync(nodePath.join(SSH, 'id_ed25519_denied-host')) && await page.locator('#hubModalPanel [data-key-panel]').count() === 0 && /Using the existing key id_ed25519_github/.test(await panelText()));
    await page.click('#hubModalPanel [data-test]');
    await page.waitForSelector('#hubModalPanel [data-test-fail]', { timeout: 20000 });
    ok('tes koneksi ditolak (AUTH): pesan jelas, tombol "Show public key", Save account tetap nonaktif', /rejected this SSH key/.test(await panelText()) && await page.locator('#hubModalPanel [data-show-key]').isVisible() && await page.locator('#hubModalPanel [data-save]').isDisabled());
    await page.click('#hubModalPanel [data-show-key]');
    await page.waitForSelector('#hubModalPanel [data-pubkey]');
    ok('Show public key: menampilkan kunci publik kunci yang dipakai (bukan kunci privat)', (await page.locator('#hubModalPanel [data-pubkey]').inputValue()).trim() === fs.readFileSync(nodePath.join(SSH, 'id_ed25519_github.pub'), 'utf8').trim() && !/PRIVATE KEY/.test(await page.locator('#hubModalPanel').innerHTML()));
    await page.click('#hubModalPanel [data-save-untested]');
    await modalClosed();
    await page.waitForFunction(() => [...document.querySelectorAll('#view [data-acct]')].some((c) => /Denied host/.test(c.innerText)), null, { timeout: 20000 });
    const denied = acctCfg('Denied host');
    ok('Save without testing: akun tersimpan dengan alias + kunci yang ada, login kosong', denied && denied.provider === 'other' && denied.ssh.alias === 'denied.example' && denied.ssh.identityFile === 'id_ed25519_github' && denied.login === '');

    // wizard: tanpa identitas SSH (tidak menulis apa pun di folder ssh)
    await page.locator('#view [data-do="add"]').first().click();
    await page.waitForSelector('#hubModalPanel [data-form]');
    await page.selectOption('#hubModalPanel [name="provider"]', 'gitlab');
    const before3 = snapshot();
    ok('wizard (tanpa SSH): tombol langsung "Save account"', (await page.locator('#hubModalPanel [data-next-label]').innerText()) === 'Save account' && (await page.inputValue('#hubModalPanel [name="label"]')) === 'GitLab · gitlab.com');
    await page.click('#hubModalPanel [data-next]');
    await modalClosed();
    await page.waitForFunction(() => [...document.querySelectorAll('#view [data-acct]')].some((c) => /gitlab\.com/.test(c.innerText) && /No SSH identity/.test(c.innerText)), null, { timeout: 20000 });
    ok('tanpa SSH: akun tersimpan (ssh null) dan folder ssh tidak berubah', acctCfg('GitLab · gitlab.com') && acctCfg('GitLab · gitlab.com').ssh === null && snapshot() === before3);

    /* -------------------------------------------------- 4. formulir repo: akun + Use SSH */
    await go('repositori', '[data-add="folder"]');
    const rowOf = (n) => page.locator('#view tbody tr', { hasText: n });
    const tableMeta = flat(await rowOf('alpha').innerText());
    ok('tabel Repositories: akun dan badge HTTPS di kolom remote', /GitHub · ahmdims/.test(tableMeta) && /HTTPS/.test(tableMeta), tableMeta.slice(0, 160));
    await rowOf('delta').locator('[data-act="edit"]').click();
    await page.waitForSelector('#hubModalPanel [data-conn] [data-remote="github"]');
    const sel = '#hubModalPanel select[name="acct-github"]';
    const optTexts = (await page.locator(`${sel} option`).allInnerTexts()).map((t) => t.trim());
    ok('formulir: select Account berisi Unassigned + akun github.com ("label · host") dan memilih akun saat ini', optTexts[0] === 'Unassigned' && optTexts.includes('GitHub · ahmdims · github.com') && optTexts.includes('GitHub · foxtrot-sevima · github.com') && !optTexts.some((t) => /gitlab/i.test(t)) && (await page.inputValue(sel)) === ahmdims.id, JSON.stringify(optTexts));
    ok('formulir: badge HTTPS dan tombol "Use SSH" aktif; tidak ada "Back to HTTPS"', /HTTPS/.test(await page.locator('#hubModalPanel [data-remote="github"] [data-proto]').innerText()) && await page.locator('#hubModalPanel [data-use-ssh="github"]').isEnabled() && await page.locator('#hubModalPanel [data-back-https]').count() === 0);
    await shot('36-repo-form');
    await page.selectOption(sel, foxtrot.id);
    await page.click('#hubModalPanel [data-save]');
    await modalClosed();
    ok('akun per remote: pilihan dipertahankan setelah Save (config.json)', repoCfg('delta').github.account === foxtrot.id);
    await rowOf('delta').locator('[data-act="edit"]').click();
    await page.waitForSelector(sel);
    ok('akun per remote: dibuka ulang, select menunjukkan akun yang tersimpan', (await page.inputValue(sel)) === foxtrot.id);
    await page.selectOption(sel, '');
    await page.click('#hubModalPanel [data-save]');
    await modalClosed();
    ok('Unassigned: akun dilepas dari remote (kunci account hilang)', repoCfg('delta').github.account === undefined);
    await rowOf('delta').locator('[data-act="edit"]').click();
    await page.waitForSelector(sel);
    ok('tanpa akun, "Use SSH" nonaktif (perlu akun)', await page.locator('#hubModalPanel [data-use-ssh="github"]').isDisabled());
    await page.selectOption(sel, ahmdims.id);
    ok('memilih akun mengaktifkan "Use SSH"', await page.locator('#hubModalPanel [data-use-ssh="github"]').isEnabled());
    await page.click('#hubModalPanel [data-save]');
    await modalClosed();
    ok('akun dikembalikan ke ahmdims', repoCfg('delta').github.account === ahmdims.id);

    await rowOf('delta').locator('[data-act="edit"]').click();
    await page.waitForSelector('#hubModalPanel [data-use-ssh="github"]');
    await page.fill('#hubModalPanel [name="deployBranch"]', 'karirkit/vercel'); // isian yang belum disimpan harus selamat dari panel SSH
    await page.click('#hubModalPanel [data-use-ssh="github"]');
    await page.waitForSelector('#hubModalPanel [data-plan-to]');
    ok('Use SSH: konfirmasi menampilkan from → to (URL SSH git@alias:owner/repo.git)', (await page.locator('#hubModalPanel [data-plan-from]').innerText()) === H.delta && (await page.locator('#hubModalPanel [data-plan-to]').innerText()) === 'git@github.com:ahmdims/delta.git' && /git ls-remote/.test(await panelText()));
    ok('Use SSH: sebelum konfirmasi tidak ada yang berubah (.git/config masih HTTPS)', gitCfg(D) === H.delta && repoCfg('delta').github.url === H.delta);
    await shot('37-use-ssh-confirm');
    await page.click('#hubModalPanel [data-panel-go]');
    await page.waitForSelector('#hubModalPanel [data-panel-ok]', { timeout: 60000 });
    ok('Use SSH: origin url di .git/config repo berubah ke SSH', gitCfg(D) === 'git@github.com:ahmdims/delta.git', gitCfg(D));
    ok('Use SSH: URL tersimpan di app berubah dan URL lama disimpan sebagai prevUrl', repoCfg('delta').github.url === 'git@github.com:ahmdims/delta.git' && repoCfg('delta').github.prevUrl === H.delta && repoCfg('delta').github.account === ahmdims.id);
    ok('Use SSH: hasil menampilkan from → to dan jumlah entri', /1 entry updated/.test(await panelText()) && (await page.locator('#hubModalPanel [data-res-to]').innerText()) === 'git@github.com:ahmdims/delta.git');
    await page.click('#hubModalPanel [data-panel-done]');
    await page.waitForSelector('#hubModalPanel [data-form]:not(.hidden)');
    ok('formulir kembali: isian yang belum disimpan tetap ada, badge jadi SSH, tombol "Back to HTTPS" muncul, "Use SSH" hilang', (await page.inputValue('#hubModalPanel [name="deployBranch"]')) === 'karirkit/vercel' && /SSH/.test(await page.locator('#hubModalPanel [data-remote="github"] [data-proto]').innerText()) && !/HTTPS/.test(await page.locator('#hubModalPanel [data-remote="github"] [data-proto]').innerText()) && await page.locator('#hubModalPanel [data-back-https="github"]').isVisible() && await page.locator('#hubModalPanel [data-use-ssh]').count() === 0 && (await page.inputValue('#hubModalPanel [name="ghUrl"]')) === 'git@github.com:ahmdims/delta.git');
    await shot('38-repo-form-ssh');
    await page.click('#hubModalPanel [data-save]');
    await modalClosed();
    const g = repoCfg('delta').github;
    ok('REGRESI: menyimpan formulir mempertahankan account dan prevUrl (repos:update mengganti objek github)', g.account === ahmdims.id && g.prevUrl === H.delta && g.url === 'git@github.com:ahmdims/delta.git' && repoCfg('delta').deployBranch === 'karirkit/vercel', JSON.stringify(g));
    const afterTable = flat(await rowOf('delta').innerText());
    ok('tabel Repositories: badge SSH untuk remote delta', /SSH/.test(afterTable) && !/HTTPS/.test(afterTable.replace('SSH', '')), afterTable.slice(0, 160));

    await rowOf('delta').locator('[data-act="edit"]').click();
    await page.waitForSelector('#hubModalPanel [data-back-https="github"]');
    await page.click('#hubModalPanel [data-back-https="github"]');
    await page.waitForSelector('#hubModalPanel [data-plan-to]');
    ok('Back to HTTPS: konfirmasi menampilkan URL SSH → URL HTTPS sebelumnya', (await page.locator('#hubModalPanel [data-plan-from]').innerText()) === 'git@github.com:ahmdims/delta.git' && (await page.locator('#hubModalPanel [data-plan-to]').innerText()) === H.delta);
    await page.click('#hubModalPanel [data-panel-go]');
    await page.waitForSelector('#hubModalPanel [data-panel-ok]', { timeout: 60000 });
    ok('Back to HTTPS: .git/config dan URL tersimpan kembali HTTPS, prevUrl hilang, akun tetap', gitCfg(D) === H.delta && repoCfg('delta').github.url === H.delta && repoCfg('delta').github.prevUrl === undefined && repoCfg('delta').github.account === ahmdims.id, gitCfg(D));
    await page.click('#hubModalPanel [data-panel-done]');
    await page.waitForSelector('#hubModalPanel [data-form]:not(.hidden)');
    ok('formulir: badge kembali HTTPS, tombol "Use SSH" ada, "Back to HTTPS" hilang', /HTTPS/.test(await page.locator('#hubModalPanel [data-remote="github"] [data-proto]').innerText()) && await page.locator('#hubModalPanel [data-use-ssh="github"]').isEnabled() && await page.locator('#hubModalPanel [data-back-https]').count() === 0);
    await page.keyboard.press('Escape'); await modalClosed();

    // gagal membaca lewat SSH: tidak ada yang berubah, galat jelas ditampilkan di panel
    await rowOf('bravo').locator('[data-act="edit"]').click();
    await page.waitForSelector('#hubModalPanel [data-use-ssh="github"]');
    await page.click('#hubModalPanel [data-use-ssh="github"]');
    await page.waitForSelector('#hubModalPanel [data-panel-go]');
    await page.click('#hubModalPanel [data-panel-go]');
    await page.waitForFunction(() => { const e = document.querySelector('#hubModalPanel [data-panel-error]'); return e && !e.classList.contains('hidden') && e.textContent.length > 5; }, null, { timeout: 60000 });
    ok('Use SSH gagal (host tanpa akses): galat "nothing was changed" tampil, .git/config dan data app tidak berubah', /nothing was changed/.test(await page.locator('#hubModalPanel [data-panel-error]').innerText()) && gitCfg(B) === H.bravo && repoCfg('bravo').github.url === H.bravo && repoCfg('bravo').github.prevUrl === undefined);
    await shot('39-use-ssh-error');
    await page.click('#hubModalPanel [data-panel-cancel]');
    await page.waitForSelector('#hubModalPanel [data-form]:not(.hidden)');
    await page.keyboard.press('Escape'); await modalClosed();

    // Use SSH ke host yang belum dipercaya: HOST_KEY -> tinjau sidik jari -> trust -> dicoba lagi otomatis
    const added = await page.evaluate(async (p) => {
      const r = await window.hub.invoke('repos:add', { repo: { name: 'echo', path: p.path, gitlab: { baseUrl: 'https://gitlab.trust.example', path: 'team/echo', url: p.url } } });
      const a = await window.hub.invoke('acct:save', { account: { label: 'Trust host', provider: 'gitlab', host: 'gitlab.trust.example', ssh: { alias: 'gitlab.trust.example', identityFile: 'id_ed25519_gitlab' } } });
      return { r: r.ok, a: a.ok, assigned: a.assigned, err: r.error || a.error };
    }, { path: E.work, url: H5 });
    ok('repo kelima + akun "Trust host" ditambahkan (IPC); remote otomatis masuk ke akun itu', added.r && added.a && added.assigned === 1 && repoCfg('echo').gitlab.account === acctCfg('Trust host').id, JSON.stringify(added));
    await page.reload();
    await page.waitForSelector('#view tbody tr', { timeout: 20000 });
    await page.waitForFunction(() => document.querySelectorAll('#view tbody tr').length === 5, null, { timeout: 15000 });
    await rowOf('echo').locator('[data-act="edit"]').click();
    await page.waitForSelector('#hubModalPanel [data-use-ssh="gitlab"]');
    ok('formulir GitLab: select Account memilih "Trust host"', (await page.inputValue('#hubModalPanel select[name="acct-gitlab"]')) === acctCfg('Trust host').id);
    await page.click('#hubModalPanel [data-use-ssh="gitlab"]');
    await page.waitForSelector('#hubModalPanel [data-plan-to]');
    ok('Use SSH (GitLab tanpa port): URL rencana git@host:path.git memakai alias akun', (await page.locator('#hubModalPanel [data-plan-to]').innerText()) === 'git@gitlab.trust.example:team/echo.git');
    await page.click('#hubModalPanel [data-panel-go]');
    await page.waitForSelector('#hubModalPanel [data-panel-review]', { timeout: 60000 });
    ok('host belum dipercaya: panel menjelaskan, "nothing was changed", tombol "Review host key"; .git/config tetap HTTPS', /not trusted yet/.test(await panelText()) && /Nothing was changed/.test(await panelText()) && gitCfg(E) === H5 && repoCfg('echo').gitlab.url === H5);
    await page.click('#hubModalPanel [data-panel-review]');
    await page.waitForSelector('#hubModalPanel [data-trust-confirm]', { timeout: 15000 });
    const trustText2 = await panelText();
    ok('trust (dari formulir repo): sidik jari dari ssh-keyscan tampil; tombol Trust nonaktif sampai dicentang', trustText2.includes(sshc.fingerprintOf(blobTrust)) && await page.locator('#hubModalPanel [data-trust-go]').isDisabled() && /published by gitlab\.trust\.example/.test(trustText2));
    await shot('41-repo-form-trust-host');
    await page.locator('#hubModalPanel [data-trust-confirm]').check();
    await page.click('#hubModalPanel [data-trust-go]');
    await page.waitForSelector('#hubModalPanel [data-panel-ok]', { timeout: 60000 });
    const known2 = fs.readFileSync(knownFile, 'utf8').trim().split(/\r?\n/);
    ok('setelah trust: known_hosts menerima baris host dan Use SSH dicoba lagi otomatis (berhasil)', known2[known2.length - 1] === `gitlab.trust.example ssh-ed25519 ${blobTrust}` && gitCfg(E) === 'git@gitlab.trust.example:team/echo.git' && repoCfg('echo').gitlab.url === 'git@gitlab.trust.example:team/echo.git' && repoCfg('echo').gitlab.prevUrl === H5, gitCfg(E));
    await page.click('#hubModalPanel [data-panel-done]');
    await page.waitForSelector('#hubModalPanel [data-form]:not(.hidden)');
    ok('formulir: setelah trust + Use SSH badge SSH dan tombol "Back to HTTPS"', /SSH/.test(await page.locator('#hubModalPanel [data-remote="gitlab"] [data-proto]').innerText()) && await page.locator('#hubModalPanel [data-back-https="gitlab"]').isVisible());
    await page.keyboard.press('Escape'); await modalClosed();

    /* -------------------------------------------------- 5. Settings, layar sempit, galat console */
    await go('pengaturan', '[data-save-buffer]');
    ok('Settings: kartu GitLab menaut ke halaman Accounts', (await page.locator('#view a[href="#/accounts"]').count()) >= 1 && /Manage accounts and SSH keys on the Accounts page\./.test(await page.locator('#view').innerText()));
    await page.setViewportSize({ width: 1000, height: 760 });
    for (const [h, sel] of [['accounts', '#view [data-acct]'], ['dasbor', '#repoBody tr[data-id]'], ['repositori', '#view tbody tr']]) {
      await go(h, sel);
      ok(`layar 1000px: halaman ${h} tidak melebar (tanpa scroll horizontal halaman)`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
    await go('accounts', '#view [data-acct]');
    await page.locator('#view [data-do="add"]').first().click();
    await page.waitForSelector('#hubModalPanel [data-form]');
    await page.check('#hubModalPanel input[name="mode"][value="new"]');
    ok('layar 1000px: wizard tidak melebar', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.getElementById('hubModalPanel').scrollWidth <= document.getElementById('hubModalPanel').clientWidth + 1));
    await shot('40-wizard-1000px');
    await page.keyboard.press('Escape'); await modalClosed();
    await page.setViewportSize({ width: 1440, height: 900 });

    ok('semua tulisan ssh terjadi di HUB_SSH_DIR sementara (dua kali menambah config = dua backup baru; known_hosts hanya lewat trust)', bakList().length === bak0.length + 2 && fs.existsSync(privFile));
    ok('tidak ada galat console / pageerror / pelanggaran CSP selama uji', problems.length === 0, JSON.stringify(problems.slice(0, 4)));
    console.log(fails ? `\n${fails} GAGAL` : '\nSEMUA UJI UI (AKUN + SSH) LULUS');
  } catch (e) {
    fails++;
    console.error('UJI BERHENTI:', e.message.split('\n').slice(0, 3).join(' | '));
    try { await shot('zz-accounts-gagal'); } catch { /* abaikan */ }
    console.error('Masalah halaman:', JSON.stringify(problems.slice(0, 5)));
  } finally {
    await app.close();
    for (const r of [A, B, C, D, E]) r.cleanup();
    try { fs.rmSync(strictDir, { recursive: true, force: true }); } catch { /* abaikan */ }
    try { fs.rmSync(SSH, { recursive: true, force: true }); } catch { /* windows kadang menahan file */ }
  }
  process.exit(fails ? 1 : 0);
})();
