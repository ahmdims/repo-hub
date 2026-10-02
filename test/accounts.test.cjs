'use strict';
// Akun + ~/.ssh: deteksi, pengelompokan repo, cek "ssh -T", trust host, membuat kunci/alias, dan HTTPS <-> SSH.
// Semua tes memakai folder ssh sementara (HUB_SSH_DIR) dan program palsu, jadi ~/.ssh asli tidak pernah tersentuh.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { makeRig, sh, fs, path, os } = require('./rig.cjs');
const { Store } = require('../main/store');
const { createServices } = require('../main/services');
const sshc = require('../main/sshconfig');
const { parseWhoami } = require('../main/accounts');

const FAKE = (n) => path.join(__dirname, n);
process.env.HUB_GH_BIN = FAKE('fixtures-fake-gh.cjs');
process.env.HUB_SSH_BIN = FAKE('fixtures-fake-ssh.cjs');
process.env.HUB_SSH_KEYSCAN_BIN = FAKE('fixtures-fake-keyscan.cjs');
// jaring pengaman: kalau ada tes yang lupa mengatur folder ssh, tetap bukan ~/.ssh asli
process.env.HUB_SSH_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-ssh-default-'));

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
function mkSsh() { const d = tmp('hub-ssh-'); process.env.HUB_SSH_DIR = d; return d; }
function fakeGh(viewer = 'ahmdims') {
  const file = path.join(tmp('hub-gh-'), 'state.json');
  fs.writeFileSync(file, JSON.stringify({ repo: 'org/demo', viewer, next: 10, prs: [] }));
  process.env.FAKE_GH_STATE = file;
}
function services() {
  const dir = tmp('hub-data-');
  const svc = createServices({ store: new Store(dir), emit: () => {} });
  return svc;
}
const addRepo = (store, name, extra) => { const p = tmp(`hub-repo-${name}-`); return store.addRepo({ name, path: p, ...extra }).repo; };
const gh = (repo) => ({ github: { repo, url: `https://github.com/${repo}.git` } });
const gl = (p) => ({ gitlab: { baseUrl: 'https://gitlab.sevima.com', path: p, url: `https://gitlab.sevima.com/${p}.git` } });
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const GL_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl';

/* ------------------------------------------------------------------ config + kunci */
test('ssh config: parseConfig, alias sederhana, identityName menolak traversal', () => {
  const text = '# komentar\nHost github.com\n    HostName github.com\n        User git\n        IdentityFile ~/.ssh/id_ed25519_github\n\nHost gitlab-kantor kantor\n  HostName=gitlab.sevima.com\n  Port 2222\n  IdentityFile "~/.ssh/id_k"\nHost *\n  ServerAliveInterval 30\nInclude extra.conf\nMatch host x\n  User y\n';
  const p = sshc.parseConfig(text);
  assert.deepEqual(p.blocks.map((b) => b.patterns), [['github.com'], ['gitlab-kantor', 'kantor'], ['*']]);
  assert.equal(p.blocks[1].hostName, 'gitlab.sevima.com'); assert.equal(p.blocks[1].port, 2222);
  assert.equal(p.hasInclude, true); assert.equal(p.hasMatch, true);
  const dir = mkSsh(); fs.writeFileSync(path.join(dir, 'config'), text);
  const aliases = sshc.hostAliases(dir).aliases;
  assert.deepEqual(aliases.map((a) => [a.alias, a.hostName, a.identityFile]), [['github.com', 'github.com', 'id_ed25519_github'], ['gitlab-kantor', 'gitlab.sevima.com', 'id_k'], ['kantor', 'gitlab.sevima.com', 'id_k']]); // wildcard dilewati
  assert.equal(sshc.identityName('~/.ssh/id_x', dir), 'id_x');
  assert.equal(sshc.identityName('~/.ssh/../x', dir), null);
  assert.equal(sshc.identityName('/etc/passwd', dir), null);
});

test('ssh: createKey membuat pasangan ed25519, tidak pernah menimpa, memvalidasi nama, dan tidak membuka kunci privat', async () => {
  const dir = mkSsh();
  const r = await sshc.createKey({ name: 'work', comment: 'dev@example.com' }, dir);
  assert.equal(r.ok, true, r.error);
  const priv = path.join(dir, 'id_ed25519_work');
  assert.equal(fs.existsSync(priv) && fs.existsSync(`${priv}.pub`), true);
  assert.doesNotMatch(JSON.stringify(r), /PRIVATE KEY/); // hasil tidak pernah memuat kunci privat
  assert.equal(r.comment, 'dev@example.com');
  // sidik jari hitungan sendiri = keluaran ssh-keygen
  const lf = execFileSync('ssh-keygen', ['-lf', `${priv}.pub`], { encoding: 'utf8' });
  assert.ok(lf.includes(r.fingerprint), `${lf} vs ${r.fingerprint}`);
  const before = sha(priv);
  const again = await sshc.createKey({ name: 'work' }, dir);
  assert.equal(again.ok, false); assert.match(again.error, /already exists/);
  assert.equal(sha(priv), before); // kunci lama utuh
  for (const bad of ['../x', 'a b', 'x.pub', '', '-x', 'a/b', 'a\\b']) assert.equal((await sshc.createKey({ name: bad }, dir)).ok, false, `nama "${bad}" harus ditolak`);
  assert.equal((await sshc.createKey({ name: 'ok2', comment: 'bad\ncomment' }, dir)).ok, false);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['id_ed25519_work', 'id_ed25519_work.pub']); // tidak ada file lain
});

test('ssh: appendHostBlock backup dulu, hanya menambah di akhir, menjaga EOL, dan menolak duplikat/masukan buruk', async () => {
  const dir = mkSsh();
  assert.equal((await sshc.createKey({ name: 'a' }, dir)).ok, true);
  const cfg = path.join(dir, 'config');
  const old = 'Host github.com\r\n    HostName github.com\r\n';
  fs.writeFileSync(cfg, old);
  const r = sshc.appendHostBlock({ alias: 'github-work', hostName: 'github.com', identityFile: 'id_ed25519_a', label: 'Work <b> · side  org' }, dir);
  assert.equal(r.ok, true, r.error);
  const after = fs.readFileSync(cfg, 'utf8');
  assert.ok(after.startsWith(old), 'isi lama tidak berubah satu byte pun');
  assert.equal(fs.readFileSync(path.join(dir, r.backup), 'utf8'), old); // backup = isi lama
  const added = after.slice(old.length);
  assert.match(added, /Host github-work/); assert.match(added, /IdentityFile ~\/\.ssh\/id_ed25519_a/); assert.match(added, /IdentitiesOnly yes/);
  assert.doesNotMatch(added, /(^|[^\r])\n/, 'EOL CRLF dipertahankan');
  assert.doesNotMatch(added, /<b>/); // label dibersihkan
  assert.match(added, /# Added by Repo Hub: Work b side org\r\n/); // tanpa spasi ganda
  assert.deepEqual(sshc.hostAliases(dir).aliases.map((a) => a.alias), ['github.com', 'github-work']);

  const snapshot = fs.readFileSync(cfg, 'utf8');
  const bad = [
    { alias: 'github-work', hostName: 'github.com', identityFile: 'id_ed25519_a' }, // duplikat
    { alias: 'x1', hostName: 'github.com', identityFile: 'id_tidak_ada' },
    { alias: 'x2', hostName: 'github.com', identityFile: '../etc/passwd' },
    { alias: 'x3', hostName: 'github.com', identityFile: 'id_ed25519_a.pub' },
    { alias: '-oProxyCommand=x', hostName: 'github.com', identityFile: 'id_ed25519_a' },
    { alias: 'x4', hostName: 'a b', identityFile: 'id_ed25519_a' },
    { alias: 'x5', hostName: 'github.com', identityFile: 'id_ed25519_a', port: 70000 },
    { alias: 'x6', hostName: 'github.com', identityFile: 'id_ed25519_a', user: 'a b' },
  ];
  for (const b of bad) assert.equal(sshc.appendHostBlock(b, dir).ok, false, JSON.stringify(b));
  assert.equal(fs.readFileSync(cfg, 'utf8'), snapshot, 'penolakan tidak mengubah config');
  assert.equal(fs.readdirSync(dir).filter((n) => n.startsWith('config.bak-')).length, 1, 'tidak ada backup untuk penolakan');

  // tanpa config sama sekali: dibuat, tanpa backup
  const dir2 = mkSsh(); await sshc.createKey({ name: 'b' }, dir2);
  const r2 = sshc.appendHostBlock({ alias: 'gitlab-sevima', hostName: 'gitlab.sevima.com', port: 2222, identityFile: 'id_ed25519_b' }, dir2);
  assert.equal(r2.ok, true); assert.equal(r2.backup, null);
  assert.match(fs.readFileSync(path.join(dir2, 'config'), 'utf8'), /Port 2222/);
});

/* ------------------------------------------------------------------ ssh -T */
test('parseWhoami: banner GitHub/GitLab/Gitea/Bitbucket menjadi login; galat menjadi kode yang jelas', () => {
  assert.deepEqual(parseWhoami("Hi dimas! You've successfully authenticated, but GitHub does not provide shell access.", 1).login, 'dimas');
  assert.equal(parseWhoami('Welcome to GitLab, @ahmad.dimas!', 0).login, 'ahmad.dimas');
  assert.equal(parseWhoami("Hi there, budi! You've successfully authenticated with the key named x", 1).login, 'budi');
  assert.equal(parseWhoami('authenticated via ssh key.\nYou can use git to connect to Bitbucket. Shell access is disabled. logged in as sari.', 0).login, 'sari');
  assert.equal(parseWhoami('git@x: Permission denied (publickey).', 255).code, 'AUTH');
  assert.equal(parseWhoami('No ED25519 host key is known for x and you have requested strict checking.\nHost key verification failed.', 255).code, 'HOST_KEY');
  assert.equal(parseWhoami('ssh: connect to host x port 22: Connection timed out', 255).code, 'NETWORK');
  assert.equal(parseWhoami('ssh: Could not resolve hostname x: No such host is known.', 255).code, 'NETWORK');
  assert.equal(parseWhoami('something odd', 0).ok, true);
  assert.equal(parseWhoami('something odd', 3).code, 'UNKNOWN');
});

test('acct:check: memakai opsi ssh yang aman dan melaporkan nama akun tanpa token', async () => {
  const dir = mkSsh(); await sshc.createKey({ name: 'k' }, dir);
  const log = path.join(tmp('hub-sshlog-'), 'calls.log');
  process.env.FAKE_SSH_LOG = log;
  process.env.FAKE_SSH_MAP = JSON.stringify({
    'github.com': { out: "Hi dimas! You've successfully authenticated, but GitHub does not provide shell access.", code: 1 },
    'gitlab-kantor': { out: 'Welcome to GitLab, @ahmad.dimas!', code: 0 },
    'denied.example': { out: 'git@denied.example: Permission denied (publickey).', code: 255 },
    'new.example': { out: 'No ED25519 host key is known for new.example and you have requested strict checking.\nHost key verification failed.', code: 255 },
    'slow.example': { out: 'ssh: connect to host slow.example port 22: Connection timed out', code: 255 },
  });
  try {
    const { handlers, store } = services();
    let r = await handlers['acct:check']({ host: 'github.com' });
    assert.deepEqual([r.ok, r.login], [true, 'dimas']);
    r = await handlers['acct:check']({ host: 'gitlab.sevima.com', alias: 'gitlab-kantor', identityFile: 'id_ed25519_k', port: 2222 });
    assert.deepEqual([r.ok, r.login], [true, 'ahmad.dimas']);
    assert.equal((await handlers['acct:check']({ host: 'denied.example' })).code, 'AUTH');
    assert.equal((await handlers['acct:check']({ host: 'new.example' })).code, 'HOST_KEY');
    assert.equal((await handlers['acct:check']({ host: 'slow.example' })).code, 'NETWORK');
    assert.equal((await handlers['acct:check']({ host: 'unknown.example' })).code, 'NETWORK');
    assert.equal((await handlers['acct:check']({ host: '-oProxyCommand=calc' })).ok, false);
    assert.equal((await handlers['acct:check']({ host: 'github.com', identityFile: '../../x' })).code, 'NO_KEY');
    assert.equal((await handlers['acct:check']({ id: 'tidak-ada' })).ok, false);

    const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(calls.length, 6, 'masukan tidak valid tidak pernah sampai ke ssh');
    const flat = (a) => a.join(' ');
    assert.match(flat(calls[0]), /-T .*BatchMode=yes .*StrictHostKeyChecking=yes .*git@github\.com$/); // host baru tidak dipercaya otomatis
    assert.doesNotMatch(flat(calls[0]), /-i /);
    assert.match(flat(calls[1]), new RegExp(`IdentitiesOnly=yes -i ${path.join(dir, 'id_ed25519_k').replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}`));
    assert.match(flat(calls[1]), /-p 2222 git@gitlab-kantor$/);

    // akun tersimpan dicek lewat id
    const acct = store.addAccount({ label: 'Kantor', provider: 'gitlab', host: 'gitlab.sevima.com', ssh: { alias: 'gitlab-kantor', identityFile: 'id_ed25519_k' } }).account;
    assert.equal((await handlers['acct:check']({ id: acct.id })).login, 'ahmad.dimas');
  } finally { delete process.env.FAKE_SSH_LOG; delete process.env.FAKE_SSH_MAP; }
});

/* ------------------------------------------------------------------ trust host (TOFU) */
test('ssh:trustHost hanya menulis sidik jari yang sudah dilihat dan dikonfirmasi pengguna', async () => {
  const dir = mkSsh();
  process.env.FAKE_KEYSCAN = JSON.stringify({ 'git.example.com': GL_KEY });
  try {
    const { handlers } = services();
    const blob = GL_KEY.split(' ')[1];
    const want = sshc.fingerprintOf(blob);
    const hk = await handlers['ssh:hostKey']({ host: 'git.example.com' });
    assert.equal(hk.ok, true); assert.equal(hk.trusted, false);
    assert.deepEqual(hk.fingerprints, [{ type: 'ED25519', fingerprint: want }]);
    assert.equal((await handlers['ssh:hostKey']({ host: '-x' })).ok, false);
    assert.equal((await handlers['ssh:hostKey']({ host: 'tidak-ada.example' })).ok, false);

    assert.match((await handlers['ssh:trustHost']({ host: 'git.example.com', fingerprint: want })).error, /confirmation/);
    assert.equal(fs.existsSync(path.join(dir, 'known_hosts')), false);
    const wrong = await handlers['ssh:trustHost']({ host: 'git.example.com', fingerprint: `SHA256:${'A'.repeat(43)}`, confirmed: true });
    assert.equal(wrong.ok, false); assert.match(wrong.error, /different key/);
    assert.equal((await handlers['ssh:trustHost']({ host: 'git.example.com', fingerprint: 'bukan-sidik-jari', confirmed: true })).ok, false);
    assert.equal(fs.existsSync(path.join(dir, 'known_hosts')), false, 'penolakan tidak menulis apa pun');

    const ok = await handlers['ssh:trustHost']({ host: 'git.example.com', fingerprint: want, confirmed: true });
    assert.equal(ok.ok, true); assert.equal(ok.added, true);
    assert.equal(fs.readFileSync(path.join(dir, 'known_hosts'), 'utf8').trim(), `git.example.com ${GL_KEY}`);
    const again = await handlers['ssh:trustHost']({ host: 'git.example.com', fingerprint: want, confirmed: true });
    assert.equal(again.alreadyTrusted, true);
    assert.equal(fs.readFileSync(path.join(dir, 'known_hosts'), 'utf8').trim().split('\n').length, 1, 'tidak digandakan');
    assert.equal((await handlers['ssh:hostKey']({ host: 'git.example.com' })).trusted, true);
    assert.equal((await handlers['activity:list']()).items[0].action, 'ssh.trust');
  } finally { delete process.env.FAKE_KEYSCAN; }
});

/* ------------------------------------------------------------------ akun + penetapan repo */
test('akun: penetapan otomatis per host + pemilik; ambigu tidak ditebak; hapus akun hanya melepas kaitan', async () => {
  mkSsh();
  const { handlers, store } = services();
  const r1 = addRepo(store, 'pribadi', gh('ahmdims/x'));
  const r2 = addRepo(store, 'kerja', gh('foxtrot-sevima/y'));
  const r3 = addRepo(store, 'kantor', gl('maukuliah/z'));
  const r4 = addRepo(store, 'dua', { ...gh('foxtrot-sevima/w'), ...gl('foxtrot/w') });
  const save = (account) => handlers['acct:save']({ account });
  const personal = (await save({ label: 'Personal', provider: 'github', host: 'github.com', owners: ['ahmdims'] })).account;
  assert.equal((await save({ label: 'personal', provider: 'github', host: 'github.com', owners: ['x'] })).ok, false); // label unik
  assert.equal((await save({ label: 'Copy', provider: 'github', host: 'github.com', owners: ['ahmdims'] })).ok, false); // host + pemilik unik
  assert.equal((await save({ label: 'Bad', provider: 'github', host: 'bad host!' })).ok, false);
  const work = (await save({ label: 'Work', provider: 'github', host: 'github.com', owners: ['Foxtrot-Sevima'] })).account;
  assert.deepEqual(work.owners, ['foxtrot-sevima']); // dinormalkan
  const kantor = await save({ label: 'Kantor', provider: 'gitlab', host: 'gitlab.sevima.com' });
  const acc = (r, p) => (store.repo(r.id)[p] || {}).account;
  assert.deepEqual([acc(r1, 'github'), acc(r2, 'github'), acc(r3, 'gitlab'), acc(r4, 'github'), acc(r4, 'gitlab')], [personal.id, work.id, kantor.account.id, work.id, kantor.account.id]);
  assert.equal((await handlers['acct:list']()).accounts.find((a) => a.id === work.id).repoCount, 2);

  // repo baru langsung dikelompokkan
  const added = await handlers['repos:add']({ repo: { name: 'baru', path: tmp('hub-repo-baru-'), ...gh('ahmdims/baru') } });
  assert.equal(added.repo.github.account, personal.id);

  // ambigu: dua akun yang sama-sama memuat pemilik "x" -> tidak ditebak
  await save({ label: 'A', provider: 'github', host: 'github.com', owners: ['x'] });
  await save({ label: 'B', provider: 'github', host: 'github.com', owners: ['x', 'y'] });
  const amb = addRepo(store, 'ambigu', gh('x/zzz')); await handlers['acct:assign']();
  assert.equal(acc(amb, 'github'), undefined);

  // penetapan manual: akun harus di host yang sama; null = lepas
  assert.equal((await handlers['acct:setRepo']({ repoId: amb.id, platform: 'github', accountId: kantor.account.id })).ok, false);
  assert.equal((await handlers['acct:setRepo']({ repoId: amb.id, platform: 'github', accountId: work.id })).ok, true);
  assert.equal(acc(amb, 'github'), work.id);
  assert.equal((await handlers['acct:setRepo']({ repoId: amb.id, platform: 'github', accountId: null })).ok, true);
  assert.equal(acc(amb, 'github'), undefined);

  // hapus akun: kaitan lepas, repo dan foldernya tetap
  assert.equal((await handlers['acct:remove']({ id: work.id })).ok, true);
  assert.deepEqual([acc(r2, 'github'), acc(r4, 'github')], [undefined, undefined]);
  assert.ok(store.repo(r2.id) && fs.existsSync(store.repo(r2.id).path));
  assert.equal(acc(r4, 'gitlab'), kantor.account.id); // yang lain tidak ikut berubah
});

test('acct:detect: saran dari ssh config + repo + gh, tanpa mengulang akun yang sudah ada dan tanpa kunci privat', async () => {
  const dir = mkSsh(); fakeGh('ahmdims');
  for (const n of ['github', 'gitlab']) assert.equal((await sshc.createKey({ name: n, comment: `${n}@example.com` }, dir)).ok, true);
  assert.equal(sshc.appendHostBlock({ alias: 'github.com', hostName: 'github.com', identityFile: 'id_ed25519_github' }, dir).ok, true);
  assert.equal(sshc.appendHostBlock({ alias: 'gitlab.sevima.com', hostName: 'gitlab.sevima.com', identityFile: 'id_ed25519_gitlab' }, dir).ok, true);
  assert.equal(sshc.appendHostBlock({ alias: 'git.lain.example', hostName: 'git.lain.example', identityFile: 'id_ed25519_gitlab' }, dir).ok, true);
  const { handlers, store } = services();
  addRepo(store, 'a', gh('ahmdims/a')); addRepo(store, 'b', gh('foxtrot-sevima/b')); addRepo(store, 'c', gl('maukuliah/c'));

  const d = await handlers['acct:detect']();
  assert.equal(d.ok, true); assert.equal(d.sshDir, dir);
  assert.deepEqual(d.keys.map((k) => [k.file, k.type, k.hasPrivate]), [['id_ed25519_github.pub', 'ED25519', true], ['id_ed25519_gitlab.pub', 'ED25519', true]]);
  assert.deepEqual(d.hosts.map((h) => h.alias), ['github.com', 'gitlab.sevima.com', 'git.lain.example']);
  assert.deepEqual(d.gh, [{ host: 'github.com', login: 'ahmdims', active: true }]);
  const by = Object.fromEntries(d.suggestions.map((s) => [s.key, s]));
  assert.deepEqual(Object.keys(by).sort(), ['repos:github.com|ahmdims', 'repos:github.com|foxtrot-sevima', 'repos:gitlab.sevima.com|maukuliah', 'ssh:git.lain.example']);
  assert.equal(by['repos:github.com|ahmdims'].login, 'ahmdims');            // pemilik = login gh
  assert.equal(by['repos:github.com|foxtrot-sevima'].login, '');            // org: login tidak ditebak
  assert.deepEqual(by['repos:github.com|ahmdims'].ssh, { alias: 'github.com', identityFile: 'id_ed25519_github' });
  assert.deepEqual(by['repos:gitlab.sevima.com|maukuliah'].ssh, { alias: 'gitlab.sevima.com', identityFile: 'id_ed25519_gitlab' });
  assert.equal(by['ssh:git.lain.example'].repoCount, 0);
  assert.doesNotMatch(JSON.stringify(d), /PRIVATE KEY/);

  const s = by['repos:github.com|ahmdims'];
  assert.equal((await handlers['acct:save']({ account: { label: s.label, provider: s.provider, host: s.host, owners: s.owners, login: s.login, ssh: s.ssh } })).ok, true);
  const d2 = await handlers['acct:detect']();
  assert.equal(d2.suggestions.some((x) => x.key === 'repos:github.com|ahmdims'), false);
  assert.equal(d2.suggestions.length, 3);
});

/* ------------------------------------------------------------------ konfirmasi + folder ssh utuh */
test('aksi yang menulis ke .ssh / git config wajib confirmed dan menolak tanpa menyentuh apa pun', async () => {
  const dir = mkSsh();
  const { handlers, store } = services();
  const repo = addRepo(store, 'r', gh('org/r'));
  const calls = [
    ['ssh:createKey', { name: 'x' }], ['ssh:addHost', { alias: 'a', hostName: 'github.com', identityFile: 'id_x' }],
    ['ssh:trustHost', { host: 'github.com', fingerprint: `SHA256:${'A'.repeat(43)}` }], ['repos:useSsh', { repoId: repo.id, platform: 'github' }],
  ];
  for (const [ch, p] of calls) assert.match((await handlers[ch](p)).error, /confirmation/, ch);
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.equal((await handlers['activity:list']()).items.length, 0);

  const made = await handlers['ssh:createKey']({ name: 'x', comment: 'a@b.c', provider: 'gitlab', host: 'gitlab.sevima.com', confirmed: true });
  assert.equal(made.ok, true); assert.equal(made.keysUrl, 'https://gitlab.sevima.com/-/user_settings/ssh_keys');
  assert.equal((await handlers['ssh:publicKey']({ file: made.privateFile + '.pub' })).publicKey, made.publicKey);
  for (const bad of ['id_ed25519_x', '../x.pub', 'config', '']) assert.equal((await handlers['ssh:publicKey']({ file: bad })).ok, false, `"${bad}" bukan nama kunci publik`);
  const host = await handlers['ssh:addHost']({ alias: 'gitlab-sevima', hostName: 'gitlab.sevima.com', identityFile: made.privateFile, label: 'Kantor', confirmed: true });
  assert.equal(host.ok, true);
  const acts = (await handlers['activity:list']()).items.map((a) => a.action);
  assert.deepEqual(acts.slice(0, 2), ['ssh.host', 'ssh.key']);
  assert.doesNotMatch(JSON.stringify((await handlers['activity:list']()).items), /PRIVATE KEY/);
});

/* ------------------------------------------------------------------ HTTPS <-> SSH */
test('repos:useSsh: membuktikan baca lewat SSH lebih dulu, hanya menulis ulang entri yang cocok, dan bisa kembali ke HTTPS', async () => {
  const rig = makeRig(); const dir = mkSsh(); fakeGh('dimas');
  const node = process.execPath.replace(/\\/g, '/');
  const prevCmd = process.env.GIT_SSH_COMMAND;
  process.env.GIT_SSH_COMMAND = `"${node}" "${FAKE('fixtures-fake-git-ssh.cjs').replace(/\\/g, '/')}"`;
  const httpsGh = 'https://github.com/org/demo.git', httpsGl = 'https://gitlab.sevima.com/grp/demo.git';
  try {
    // origin terlihat seperti HTTPS sungguhan, tetapi dialihkan ke bare lokal (tanpa jaringan)
    rig.sh('config', `url.${rig.gh.replace(/\\/g, '/')}.insteadOf`, httpsGh);
    rig.sh('config', `url.${rig.gl.replace(/\\/g, '/')}.insteadOf`, httpsGl);
    rig.sh('config', 'remote.origin.url', httpsGh);
    rig.sh('config', '--unset-all', 'remote.origin.pushurl');
    rig.sh('config', '--add', 'remote.origin.pushurl', httpsGh);
    rig.sh('config', '--add', 'remote.origin.pushurl', httpsGl);
    const { handlers, store } = services();
    const repo = store.addRepo({ name: 'Demo', path: rig.work, github: { repo: 'org/demo', url: httpsGh }, gitlab: { baseUrl: 'https://gitlab.sevima.com', path: 'grp/demo', url: httpsGl } }).repo;
    const work = (await handlers['acct:save']({ account: { label: 'Work', provider: 'github', host: 'github.com', owners: ['org'], ssh: { alias: 'github-work', identityFile: 'id_k' } } })).account;
    const kantor = (await handlers['acct:save']({ account: { label: 'Kantor', provider: 'gitlab', host: 'gitlab.sevima.com' } })).account;
    const urls = (k) => rig.sh('config', '--get-all', k).split('\n');
    const base = { repoId: repo.id, platform: 'github', accountId: work.id };

    // tanpa transport yang bisa membaca: ditolak dan tidak ada yang berubah
    process.env.FAKE_GIT_SSH_MAP = '{}';
    const fail = await handlers['repos:useSsh']({ ...base, confirmed: true });
    assert.equal(fail.ok, false); assert.match(fail.error, /nothing was changed/);
    assert.match(fail.error, /Permission denied|no repo/i); assert.doesNotMatch(fail.error, /and the repository exists/); // mengutip penyebab, bukan penutup baku git
    assert.equal(rig.sh('config', '--get', 'remote.origin.url'), httpsGh);
    assert.equal(store.repo(repo.id).github.url, httpsGh);

    // akun di host lain ditolak
    process.env.FAKE_GIT_SSH_MAP = JSON.stringify({ 'github-work:org/demo.git': rig.gh, 'gitlab.sevima.com:grp/demo.git': rig.gl });
    assert.match((await handlers['repos:useSsh']({ ...base, accountId: kantor.id, confirmed: true })).error, /account is for gitlab\.sevima\.com/);

    // berhasil: hanya entri GitHub yang diganti, entri GitLab di pushurl tidak disentuh
    const ok = await handlers['repos:useSsh']({ ...base, confirmed: true });
    assert.equal(ok.ok, true, ok.error);
    assert.equal(ok.to, 'git@github-work:org/demo.git'); assert.equal(ok.replaced, 2);
    assert.equal(rig.sh('config', '--get', 'remote.origin.url'), 'git@github-work:org/demo.git');
    assert.deepEqual(urls('remote.origin.pushurl'), ['git@github-work:org/demo.git', httpsGl]);
    const gh1 = store.repo(repo.id).github;
    assert.deepEqual([gh1.url, gh1.prevUrl, gh1.account], ['git@github-work:org/demo.git', httpsGh, work.id]);
    assert.equal((await handlers['activity:list']()).items[0].action, 'repo.remote');
    assert.equal((await handlers['repos:useSsh']({ ...base, confirmed: true })).unchanged, true); // idempoten

    // GitLab tanpa alias: git@host:path
    const gok = await handlers['repos:useSsh']({ repoId: repo.id, platform: 'gitlab', accountId: kantor.id, confirmed: true });
    assert.equal(gok.ok, true, gok.error);
    assert.deepEqual(urls('remote.origin.pushurl'), ['git@github-work:org/demo.git', 'git@gitlab.sevima.com:grp/demo.git']);

    // kembali ke HTTPS memakai URL sebelumnya
    const back = await handlers['repos:useSsh']({ repoId: repo.id, platform: 'github', revert: true, confirmed: true });
    assert.equal(back.ok, true, back.error); assert.equal(back.to, httpsGh);
    assert.equal(rig.sh('config', '--get', 'remote.origin.url'), httpsGh);
    assert.deepEqual(urls('remote.origin.pushurl'), [httpsGh, 'git@gitlab.sevima.com:grp/demo.git']);
    const gh2 = store.repo(repo.id).github;
    assert.deepEqual([gh2.url, gh2.prevUrl], [httpsGh, undefined]);
    assert.equal(gh2.account, work.id); // akun tetap
  } finally { if (prevCmd === undefined) delete process.env.GIT_SSH_COMMAND; else process.env.GIT_SSH_COMMAND = prevCmd; delete process.env.FAKE_GIT_SSH_MAP; rig.cleanup(); }
});
