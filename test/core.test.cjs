'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeRig, sh, fs, path } = require('./rig.cjs');
const git = require('../main/git');
const { Store } = require('../main/store');
const { createServices } = require('../main/services');

test('parseRemoteUrl / kindOfUrl / redactUrl / isSafeRef', () => {
  assert.deepEqual(git.parseRemoteUrl('https://github.com/foxtrot-sevima/KarirKit.git'), { host: 'github.com', path: 'foxtrot-sevima/KarirKit' });
  assert.deepEqual(git.parseRemoteUrl('git@github.com:a/b.git'), { host: 'github.com', path: 'a/b' });
  assert.deepEqual(git.parseRemoteUrl('ssh://git@gitlab.example.com:2222/foxtrot/karirkit.git'), { host: 'gitlab.example.com', path: 'foxtrot/karirkit' });
  assert.equal(git.kindOfUrl('https://gitlab.example.com/foxtrot/karirkit.git'), 'gitlab');
  assert.equal(git.kindOfUrl('https://github.com/a/b'), 'github');
  assert.equal(git.kindOfUrl('/tmp/x.git'), 'other');
  assert.equal(git.redactUrl('https://user:secret@gitlab.com/a/b.git'), 'https://gitlab.com/a/b.git');
  for (const ok of ['master', 'karirkit/1.3.4', 'feat/x_y-1.2']) assert.ok(git.isSafeRef(ok), ok);
  for (const bad of ['', '-rf', '../x', 'a b', 'a;rm', 'a..b', 'x/', '$(id)', 'a\nb']) assert.ok(!git.isSafeRef(bad), JSON.stringify(bad));
});

test('detect membaca remote GitHub + GitLab (termasuk pushurl) dan branch default', async () => {
  const rig = makeRig('proj');
  try {
    rig.sh('remote', 'set-url', 'origin', 'https://github.com/org/proj.git');
    rig.sh('config', '--unset-all', 'remote.origin.pushurl');
    rig.sh('config', '--add', 'remote.origin.pushurl', 'https://github.com/org/proj.git');
    rig.sh('config', '--add', 'remote.origin.pushurl', 'https://gitlab.example.com/grp/proj.git');
    const d = await git.detect(rig.work);
    assert.equal(d.ok, true);
    assert.equal(d.name, 'proj');
    assert.deepEqual(d.github.repo, 'org/proj');
    assert.deepEqual([d.gitlab.baseUrl, d.gitlab.path], ['https://gitlab.example.com', 'grp/proj']);
    assert.equal(d.branch, 'master');
    assert.equal((await git.detect(rig.root)).ok, false);
  } finally { rig.cleanup(); }
});

test('status: bersih, kotor (tracked/untracked) dan ahead', async () => {
  const rig = makeRig();
  try {
    let s = await git.status(rig.work);
    assert.deepEqual([s.branch, s.dirty, s.ahead, s.behind], ['master', false, null, null]); // belum ada upstream
    rig.sh('branch', '--set-upstream-to=origin/master');
    s = await git.status(rig.work);
    assert.deepEqual([s.ahead, s.behind], [0, 0]);
    rig.commit('lokal 1', 'a.txt');
    fs.writeFileSync(path.join(rig.work, 'baru.txt'), 'x');
    fs.appendFileSync(path.join(rig.work, 'README.md'), 'ubah\n');
    s = await git.status(rig.work);
    assert.equal(s.dirty, true); assert.equal(s.untracked, 1); assert.equal(s.ahead, 1);
    assert.match(s.last.subject, /lokal 1/);
  } finally { rig.cleanup(); }
});

test('push ke GitHub + GitLab sekaligus, tolak branch tidak aman, tolak non-FF, dan parity', async () => {
  const rig = makeRig();
  try {
    rig.sh('checkout', '-b', 'fitur/satu');
    const sha = rig.commit('fitur satu', 'f.txt');
    const res = await git.push(rig.work, { branch: 'fitur/satu', targets: [{ platform: 'github', url: rig.gh }, { platform: 'gitlab', url: rig.gl }] });
    assert.deepEqual(res.map((r) => r.ok), [true, true]);
    assert.equal(rig.head(rig.gh, 'fitur/satu'), sha);
    assert.equal(rig.head(rig.gl, 'fitur/satu'), sha);
    const again = await git.push(rig.work, { branch: 'fitur/satu', targets: [{ platform: 'github', url: rig.gh }] });
    assert.equal(again[0].upToDate, true);
    const bad = await git.push(rig.work, { branch: '--force', targets: [{ platform: 'github', url: rig.gh }] });
    assert.equal(bad[0].ok, false);
    const p = await git.parity(rig.work, { githubUrl: rig.gh, gitlabUrl: rig.gl });
    assert.equal(p.identical, true);
    // satu sisi maju -> beda
    rig.commit('hanya github', 'g.txt');
    await git.pushTo(rig.work, rig.gh, 'fitur/satu');
    const p2 = await git.parity(rig.work, { githubUrl: rig.gh, gitlabUrl: rig.gl });
    assert.equal(p2.identical, false);
    assert.equal(p2.different[0].ref, 'refs/heads/fitur/satu');
    // push non-fast-forward harus ditolak (tanpa force)
    rig.sh('reset', '--hard', 'HEAD~2');
    rig.commit('menyimpang', 'h.txt');
    const rej = await git.pushTo(rig.work, rig.gh, 'fitur/satu');
    assert.equal(rej.ok, false);
  } finally { rig.cleanup(); }
});

test('mirror: ref baru + fast-forward disalin, non-FF dan tag berbeda dilewati, tidak pernah menghapus', async () => {
  const rig = makeRig();
  try {
    rig.sh('checkout', '-b', 'dev'); rig.commit('dev 1', 'd.txt');
    await git.pushTo(rig.work, rig.gh, 'dev');
    rig.sh('checkout', 'master'); const m2 = rig.commit('master maju', 'm.txt');
    await git.pushTo(rig.work, rig.gh, 'master');
    rig.sh('tag', '-a', 'v1.0.0', '-m', 'v1.0.0'); rig.sh('push', rig.gh, 'v1.0.0');
    // GitLab punya branch ekstra (mis. main milik orang lain) -> harus tetap ada
    rig.sh('checkout', '-b', 'main-orang-lain', 'master~1'); rig.commit('punya orang lain', 'o.txt'); rig.sh('push', rig.gl, 'main-orang-lain');
    rig.sh('checkout', 'master');

    const dry = await git.mirror(rig.work, { fromUrl: rig.gh, toUrl: rig.gl, dryRun: true });
    assert.equal(dry.ok, true);
    assert.deepEqual(dry.plan.map((p) => `${p.ref}:${p.kind}`).sort(), ['refs/heads/dev:branch baru', 'refs/heads/master:fast-forward', 'refs/tags/v1.0.0:tag baru']);
    assert.notEqual(rig.head(rig.gl, 'master'), m2); // dry-run tidak mengubah apa pun

    const res = await git.mirror(rig.work, { fromUrl: rig.gh, toUrl: rig.gl });
    await git.cleanupHubRefs(rig.work);
    assert.equal(res.ok, true);
    assert.equal(res.pushed.length, 3);
    assert.equal(rig.head(rig.gl, 'master'), m2);
    assert.match(sh(rig.gl, 'tag', '-l'), /v1\.0\.0/);
    assert.match(sh(rig.gl, 'branch', '--list', 'main-orang-lain'), /main-orang-lain/); // tidak dihapus
    assert.equal(sh(rig.work, 'for-each-ref', 'refs/hub'), ''); // ref privat dibersihkan

    const again = await git.mirror(rig.work, { fromUrl: rig.gh, toUrl: rig.gl, ignoreRefs: ['refs/heads/main-orang-lain'] });
    assert.equal(again.upToDate, true);

    // GitLab menyimpang (non-FF) + tag digeser di GitHub -> keduanya dilewati
    const other = path.join(rig.root, 'other'); sh(rig.root, 'clone', rig.gl, other);
    fs.writeFileSync(path.join(other, 'x.txt'), 'x'); sh(other, 'add', '-A'); sh(other, 'commit', '-m', 'menyimpang di gitlab'); sh(other, 'push', 'origin', 'master');
    rig.commit('github maju lagi', 'n.txt'); await git.pushTo(rig.work, rig.gh, 'master');
    rig.sh('tag', '-f', '-a', 'v1.0.0', '-m', 'digeser'); rig.sh('push', '-f', rig.gh, 'v1.0.0');
    const conflict = await git.mirror(rig.work, { fromUrl: rig.gh, toUrl: rig.gl });
    await git.cleanupHubRefs(rig.work);
    assert.equal(conflict.pushed.length, 0);
    assert.deepEqual(conflict.skipped.map((s) => s.ref).sort(), ['refs/heads/master', 'refs/tags/v1.0.0']);
    assert.match(conflict.skipped.find((s) => s.ref === 'refs/heads/master').reason, /non-fast-forward/);
  } finally { rig.cleanup(); }
});

test('store: normalisasi, validasi, duplikat, dan batas log', () => {
  const rig = makeRig();
  const dir = fs.mkdtempSync(path.join(rig.root, 'data-'));
  try {
    const store = new Store(dir);
    assert.equal(store.addRepo({ name: '', path: 'relatif' }).ok, false);
    assert.match(store.addRepo({ name: 'x', path: rig.work, github: { repo: 'salah' } }).error, /owner\/repo/);
    assert.match(store.addRepo({ name: 'x', path: rig.work }).error, /GitHub or GitLab/);
    const ok = store.addRepo({ name: 'Demo', path: rig.work, github: { repo: 'org/demo' }, gitlab: { baseUrl: 'https://gitlab.x.com', path: 'g/demo' }, warnBranches: ['release', '../jahat'], ignoreRefs: ['refs/heads/main', 'bukan-ref'] });
    assert.equal(ok.ok, true);
    assert.equal(ok.repo.github.url, 'https://github.com/org/demo.git');
    assert.equal(ok.repo.gitlab.url, 'https://gitlab.x.com/g/demo.git');
    assert.deepEqual(ok.repo.warnBranches, ['release']);
    assert.deepEqual(ok.repo.ignoreRefs, ['refs/heads/main']);
    assert.equal(ok.repo.flow.steps[0].from, '$BRANCH');
    assert.match(store.addRepo({ name: 'Lagi', path: rig.work, github: { repo: 'org/demo' } }).error, /already registered/);
    assert.equal(store.updateRepo(ok.repo.id, { name: 'Ganti' }).repo.name, 'Ganti');
    for (let i = 0; i < 520; i++) store.addActivity({ action: 't', ok: true, summary: String(i) });
    assert.equal(store.log.length, 500);
    assert.equal(new Store(dir).repos().length, 1); // tersimpan di disk
    assert.equal(store.setSettings({ postBuffer: 10 }).postBuffer, 1048576); // di luar batas -> diabaikan
  } finally { rig.cleanup(); }
});

test('services: aksi yang mengubah wajib confirmed, push ganda berjalan, aktivitas tercatat', async () => {
  const rig = makeRig();
  const dir = fs.mkdtempSync(path.join(rig.root, 'data-'));
  try {
    const events = [];
    const { handlers, store } = createServices({ store: new Store(dir), emit: (c, d) => events.push([c, d]) });
    const repo = store.addRepo({ name: 'Demo', path: rig.work, github: { repo: 'org/demo', url: rig.gh }, gitlab: { baseUrl: 'https://gitlab.x.com', path: 'g/demo', url: rig.gl } }).repo;
    assert.match((await handlers['git:push']({ repoId: repo.id, branch: 'master' })).error, /confirmation/);
    assert.match((await handlers['pulls:merge']({ repoId: repo.id, platform: 'github', id: 1 })).error, /confirmation/);
    assert.match((await handlers['git:mirror']({ repoId: repo.id })).error, /confirmation/);
    rig.commit('lokal baru', 'z.txt');
    const pushed = await handlers['git:push']({ repoId: repo.id, branch: 'master', confirmed: true });
    assert.equal(pushed.ok, true);
    const st = await handlers['status:refresh']({ ids: [repo.id], pulls: false });
    assert.equal(st.results[0].parity.identical, true);
    assert.equal(events.filter(([c]) => c === 'status:update').length, 1);
    const log = (await handlers['activity:list']()).items;
    assert.equal(log[0].action, 'git.push');
    assert.equal(log[0].ok, true);
    assert.equal((await handlers['repos:remove']({ id: repo.id })).ok, true);
    assert.equal(fs.existsSync(rig.work), true); // folder tidak pernah dihapus
  } finally { rig.cleanup(); }
});
