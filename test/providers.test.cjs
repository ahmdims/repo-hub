'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { makeRig, fs, path, os } = require('./rig.cjs');
const { Store } = require('../main/store');
const { createServices } = require('../main/services');

process.env.HUB_GH_BIN = path.join(__dirname, 'fixtures-fake-gh.cjs');
process.env.HUB_POLL_MS = '60';
process.env.HUB_GITLAB_TOKEN = 'secret-token';

/* ------------------------------------------------------------------ fake gh state */
function ghState(extra = {}) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-gh-')), 'state.json');
  const state = {
    repo: 'org/demo', viewer: 'dimas', next: 10, permission: 'ADMIN', deployments: [],
    prs: [
      { number: 1, title: 'Tambah fitur A', head: 'fitur-a', base: 'master', author: 'rina', state: 'open', checks: 'success', reviewDecision: 'REVIEW_REQUIRED', body: 'Deskripsi A' },
      { number: 2, title: 'Perbaikan B', head: 'fix-b', base: 'master', author: 'dimas', state: 'open', checks: 'pending', draft: false },
      { number: 3, title: 'Eksperimen C', head: 'exp-c', base: 'master', author: 'budi', state: 'open', checks: 'failure', mergeState: 'DIRTY', mergeable: 'CONFLICTING', draft: true },
      { number: 4, title: 'Sudah lama', head: 'old', base: 'master', author: 'rina', state: 'merged', checks: 'success' },
    ],
    ...extra,
  };
  fs.writeFileSync(file, JSON.stringify(state));
  process.env.FAKE_GH_STATE = file;
  return { file, read: () => JSON.parse(fs.readFileSync(file, 'utf8')), write: (fn) => { const s = JSON.parse(fs.readFileSync(file, 'utf8')); fn(s); fs.writeFileSync(file, JSON.stringify(s)); } };
}

/* ------------------------------------------------------------------ fake gitlab */
function startGitlab() {
  const mrs = [
    { iid: 7, title: 'MR tujuh', web_url: 'http://gl/mr/7', author: { username: 'sari', name: 'Sari' }, draft: false, state: 'opened', source_branch: 'feat-7', target_branch: 'master', created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-02T00:00:00Z', head_pipeline: { id: 55, status: 'success', web_url: 'http://gl/p/55' }, has_conflicts: false, detailed_merge_status: 'mergeable', labels: ['x'], changes_count: '2' },
    { iid: 8, title: 'MR delapan', web_url: 'http://gl/mr/8', author: { username: 'dimas', name: 'Dimas' }, draft: true, state: 'opened', source_branch: 'feat-8', target_branch: 'master', created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T12:00:00Z', head_pipeline: { id: 56, status: 'running' }, has_conflicts: false, detailed_merge_status: 'draft_status', labels: [] },
  ];
  const approvals = { 7: { approved: false, approvals_required: 1, approvals_left: 1, approved_by: [] }, 8: { approved: true, approvals_required: 1, approvals_left: 0, approved_by: [{ user: { username: 'sari' } }] } };
  const calls = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const send = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
      if (req.headers['private-token'] !== 'secret-token') return send(401, { message: '401 Unauthorized' });
      calls.push(`${req.method} ${url.pathname}${url.search}`);
      const p = url.pathname.replace('/api/v4', '');
      let m;
      if (p === '/user') return send(200, { username: 'dimas', name: 'Dimas' });
      if (p === '/projects/grp%2Fdemo') return send(200, { path_with_namespace: 'grp/demo', default_branch: 'main', visibility: 'private', permissions: { project_access: { access_level: 30 } } });
      if (p === '/projects/grp%2Fdemo/merge_requests' && req.method === 'GET') return send(200, mrs.filter((x) => url.searchParams.get('state') === 'all' || x.state === url.searchParams.get('state')));
      if (p === '/projects/grp%2Fdemo/merge_requests' && req.method === 'POST') { const b = JSON.parse(body); const mr = { iid: 9, web_url: 'http://gl/mr/9', ...b }; mrs.push({ ...mrs[0], iid: 9, title: b.title, source_branch: b.source_branch, target_branch: b.target_branch }); return send(201, mr); }
      if ((m = p.match(/^\/projects\/grp%2Fdemo\/merge_requests\/(\d+)(\/.*)?$/))) {
        const mr = mrs.find((x) => x.iid === Number(m[1])); const sub = m[2] || '';
        if (!mr) return send(404, { message: '404 Not found' });
        if (sub === '' && req.method === 'GET') return send(200, { ...mr, description: 'Isi MR', changes_count: '2' });
        if (sub === '' && req.method === 'PUT') { if (JSON.parse(body).state_event === 'close') mr.state = 'closed'; return send(200, mr); }
        if (sub === '/approvals') return send(200, approvals[mr.iid]);
        if (sub === '/approve') { approvals[mr.iid] = { approved: true, approvals_required: 1, approvals_left: 0, approved_by: [{ user: { username: 'dimas' } }] }; return send(201, {}); }
        if (sub === '/unapprove') { approvals[mr.iid] = { approved: false, approvals_required: 1, approvals_left: 1, approved_by: [] }; return send(201, {}); }
        if (sub === '/notes' && req.method === 'GET') return send(200, [{ author: { username: 'sari' }, body: 'Bagus', created_at: '2026-10-02T00:00:00Z', system: false }, { author: { username: 'sys' }, body: 'added 1 commit', system: true }]);
        if (sub === '/notes' && req.method === 'POST') return send(201, {});
        if (sub === '/commits') return send(200, [{ short_id: 'abc1234', title: 'komit', author_name: 'Sari', created_at: '2026-10-01T00:00:00Z' }]);
        if (sub === '/diffs') return send(200, [{ old_path: 'a.txt', new_path: 'a.txt', diff: '@@ -1 +1,2 @@\n lama\n+baru\n', new_file: false, deleted_file: false }, { old_path: 'b.txt', new_path: 'b.txt', diff: '@@ -0,0 +1 @@\n+file baru\n', new_file: true, deleted_file: false }]);
        if (sub === '/merge' && req.method === 'PUT') { const b = JSON.parse(body); if (mr.draft) return send(405, { message: 'Method Not Allowed' }); mr.state = 'merged'; mr.mergedWith = b; return send(200, mr); }
      }
      if (p === '/projects/grp%2Fdemo/pipelines/55/jobs') return send(200, [{ name: 'build', status: 'success', web_url: 'http://gl/j/1' }, { name: 'lint', status: 'failed', web_url: 'http://gl/j/2' }]);
      send(404, { message: `404 ${p}` });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, calls, mrs, base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })));
}

function setup(rig, { gitlabBase } = {}) {
  const dir = fs.mkdtempSync(path.join(rig.root, 'data-'));
  const svc = createServices({ store: new Store(dir), emit: () => {} });
  const repo = svc.store.addRepo({
    name: 'Demo', path: rig.work, github: { repo: 'org/demo', url: rig.gh },
    gitlab: gitlabBase ? { baseUrl: gitlabBase, path: 'grp/demo', url: rig.gl } : { baseUrl: 'https://gitlab.invalid', path: 'grp/demo', url: rig.gl },
  }).repo;
  return { ...svc, repo };
}

/* ------------------------------------------------------------------ GitHub */
test('GitHub: daftar PR dinormalisasi (check, review, mergeable, draft) dan filter state', async () => {
  const rig = makeRig(); ghState();
  try {
    const { handlers, repo } = setup(rig);
    const open = await handlers['pulls:list']({ repoIds: [repo.id], platforms: ['github'], state: 'open' });
    assert.equal(open.ok, true);
    assert.deepEqual(open.items.map((p) => p.id).sort(), [1, 2, 3]);
    const by = Object.fromEntries(open.items.map((p) => [p.id, p]));
    assert.deepEqual([by[1].checks.state, by[2].checks.state, by[3].checks.state], ['success', 'pending', 'failure']);
    assert.equal(by[1].review.state, 'review_required');
    assert.equal(by[3].mergeable, 'conflict'); assert.equal(by[3].isDraft, true);
    assert.equal(by[1].mergeable, 'clean'); assert.equal(by[1].platform, 'github'); assert.equal(by[1].repoName, 'Demo');
    const merged = await handlers['pulls:list']({ repoIds: [repo.id], platforms: ['github'], state: 'merged' });
    assert.deepEqual(merged.items.map((p) => [p.id, p.state]), [[4, 'merged']]);
  } finally { rig.cleanup(); }
});

test('GitHub: detail, diff, review (approve, tolak approve PR sendiri, request changes wajib komentar), merge, close, create', async () => {
  const rig = makeRig(); const gh = ghState();
  try {
    const { handlers, repo } = setup(rig);
    const d = await handlers['pulls:detail']({ repoId: repo.id, platform: 'github', id: 1 });
    assert.equal(d.item.body, 'Deskripsi A'); assert.equal(d.item.viewer, 'dimas'); assert.equal(d.item.isOwn, false);
    assert.equal(d.item.files[0].path, 'README.md'); assert.equal(d.item.checks.items[0].name, 'build');
    assert.equal((await handlers['pulls:detail']({ repoId: repo.id, platform: 'github', id: 2 })).item.isOwn, true);
    const diff = await handlers['pulls:diff']({ repoId: repo.id, platform: 'github', id: 1 });
    assert.match(diff.patch, /\+baru/);

    assert.match((await handlers['pulls:review']({ repoId: repo.id, platform: 'github', id: 1, action: 'approve' })).error, /confirmation/);
    assert.equal((await handlers['pulls:review']({ repoId: repo.id, platform: 'github', id: 1, action: 'approve', confirmed: true })).ok, true);
    assert.equal(gh.read().prs[0].reviewDecision, 'APPROVED');
    const own = await handlers['pulls:review']({ repoId: repo.id, platform: 'github', id: 2, action: 'approve', confirmed: true });
    assert.equal(own.ok, false); assert.match(own.error, /own pull request/i);
    assert.match((await handlers['pulls:review']({ repoId: repo.id, platform: 'github', id: 1, action: 'changes', body: '  ', confirmed: true })).error, /required/);
    assert.equal((await handlers['pulls:review']({ repoId: repo.id, platform: 'github', id: 1, action: 'changes', body: 'Tolong perbaiki', confirmed: true })).ok, true);
    assert.equal(gh.read().prs[0].reviewDecision, 'CHANGES_REQUESTED');
    assert.equal((await handlers['pulls:comment']({ repoId: repo.id, platform: 'github', id: 1, body: 'Halo' })).ok, true);

    const m = await handlers['pulls:merge']({ repoId: repo.id, platform: 'github', id: 1, method: 'squash', confirmed: true });
    assert.equal(m.ok, true);
    assert.equal(gh.read().prs[0].state, 'merged'); assert.equal(gh.read().prs[0].mergedWith, '--squash');
    assert.equal((await handlers['pulls:merge']({ repoId: repo.id, platform: 'github', id: 1, method: 'telan', confirmed: true })).ok, false);
    assert.equal((await handlers['pulls:close']({ repoId: repo.id, platform: 'github', id: 3, confirmed: true })).ok, true);
    assert.equal(gh.read().prs[2].state, 'closed');

    const c = await handlers['pulls:create']({ repoId: repo.id, platforms: ['github'], head: 'fitur-z', base: 'master', title: 'Fitur Z', body: 'isi', draft: true, confirmed: true });
    assert.equal(c.ok, true); assert.equal(c.results[0].number, 10);
    assert.equal(gh.read().prs.at(-1).draft, true);
    assert.equal((await handlers['pulls:create']({ repoId: repo.id, head: '--x', base: 'master', title: 't', confirmed: true })).ok, false);
    assert.match((await handlers['pulls:create']({ repoId: repo.id, head: 'a', base: 'b', title: ' ', confirmed: true })).error, /Title/);
    const log = (await handlers['activity:list']()).items.map((x) => x.action);
    assert.ok(log.includes('pulls.merge') && log.includes('pulls.review') && log.includes('pulls.create'));
  } finally { rig.cleanup(); }
});

/* ------------------------------------------------------------------ GitLab */
test('GitLab: daftar MR + approval, detail (diff, job, komentar), approve/unapprove, merge, close, create', async () => {
  const rig = makeRig(); ghState();
  const gl = await startGitlab();
  try {
    const { handlers, repo, providers } = setup(rig, { gitlabBase: gl.base });
    const list = await handlers['pulls:list']({ repoIds: [repo.id], platforms: ['gitlab'], state: 'open' });
    assert.equal(list.ok, true); assert.deepEqual(list.errors, []);
    const by = Object.fromEntries(list.items.map((p) => [p.id, p]));
    assert.deepEqual([by[7].checks.state, by[8].checks.state], ['success', 'pending']);
    assert.deepEqual([by[7].review.state, by[8].review.state], ['review_required', 'approved']);
    assert.equal(by[7].mergeable, 'clean'); assert.equal(by[8].mergeable, 'draft'); assert.equal(by[8].isDraft, true);

    const d = await handlers['pulls:detail']({ repoId: repo.id, platform: 'gitlab', id: 7 });
    assert.equal(d.item.body, 'Isi MR'); assert.equal(d.item.comments.length, 1); assert.equal(d.item.commits[0].sha, 'abc1234');
    assert.deepEqual(d.item.files.map((f) => [f.path, f.additions]), [['a.txt', 1], ['b.txt', 1]]);
    assert.deepEqual(d.item.checks.items.map((c) => [c.name, c.state]), [['build', 'success'], ['lint', 'failure']]);
    assert.equal(d.item.viewer, 'dimas'); assert.equal(d.item.isOwn, false);
    const diff = await handlers['pulls:diff']({ repoId: repo.id, platform: 'gitlab', id: 7 });
    assert.match(diff.patch, /diff --git a\/a\.txt b\/a\.txt/); assert.match(diff.patch, /--- \/dev\/null/); assert.match(diff.patch, /\+file baru/);

    assert.equal((await handlers['pulls:review']({ repoId: repo.id, platform: 'gitlab', id: 7, action: 'approve', confirmed: true })).ok, true);
    assert.equal((await handlers['pulls:detail']({ repoId: repo.id, platform: 'gitlab', id: 7 })).item.review.state, 'approved');
    assert.equal((await handlers['pulls:review']({ repoId: repo.id, platform: 'gitlab', id: 7, action: 'unapprove', confirmed: true })).ok, true);
    assert.match((await handlers['pulls:review']({ repoId: repo.id, platform: 'gitlab', id: 7, action: 'changes', body: 'x', confirmed: true })).error, /not supported/);
    assert.equal((await handlers['pulls:comment']({ repoId: repo.id, platform: 'gitlab', id: 7, body: 'Mantap' })).ok, true);

    const draftMerge = await handlers['pulls:merge']({ repoId: repo.id, platform: 'gitlab', id: 8, confirmed: true });
    assert.equal(draftMerge.ok, false);
    assert.equal((await handlers['pulls:merge']({ repoId: repo.id, platform: 'gitlab', id: 7, method: 'squash', confirmed: true })).ok, true);
    assert.deepEqual([gl.mrs[0].state, gl.mrs[0].mergedWith.squash], ['merged', true]);
    assert.match((await handlers['pulls:merge']({ repoId: repo.id, platform: 'gitlab', id: 7, method: 'rebase', confirmed: true })).error, /Rebase/);
    assert.equal((await handlers['pulls:close']({ repoId: repo.id, platform: 'gitlab', id: 8, confirmed: true })).ok, true);
    assert.equal(gl.mrs[1].state, 'closed');
    const cr = await handlers['pulls:create']({ repoId: repo.id, platforms: ['gitlab'], head: 'feat-9', base: 'master', title: 'MR sembilan', draft: true, confirmed: true });
    assert.equal(cr.ok, true); assert.equal(cr.results[0].number, 9);
    assert.equal(gl.mrs.at(-1).title, 'Draft: MR sembilan'); // draf di GitLab = awalan "Draft:"

    const info = await handlers['repos:test']({ id: repo.id });
    assert.equal(info.github.ok, true); assert.equal(info.github.permission, 'ADMIN');
    assert.deepEqual([info.gitlab.ok, info.gitlab.accessLevel], [true, 30]);
    const acc = await handlers['accounts']();
    assert.equal(acc.github.login, 'dimas');
    assert.equal(Object.values(acc.gitlab)[0].login, 'dimas');
    assert.equal(JSON.stringify(acc).includes('secret-token'), false); // token tidak pernah keluar dari proses utama
    void providers;
  } finally { gl.close(); rig.cleanup(); }
});

test('GitLab: token salah ditolak dengan pesan jelas; tanpa token diberi petunjuk', async () => {
  const rig = makeRig(); ghState();
  const gl = await startGitlab();
  const keep = process.env.HUB_GITLAB_TOKEN;
  try {
    const { handlers, repo } = setup(rig, { gitlabBase: gl.base });
    process.env.HUB_GITLAB_TOKEN = 'salah';
    const r = await handlers['pulls:list']({ repoIds: [repo.id], platforms: ['gitlab'] });
    assert.match(r.errors[0].error, /401|rejected/);
  } finally { process.env.HUB_GITLAB_TOKEN = keep; gl.close(); rig.cleanup(); }
});

test('GitLab: tanpa token = MR nonaktif (bukan galat), GitHub tetap jalan, dashboard diberi tanda gitlabOff', async () => {
  const rig = makeRig(); ghState();
  const keep = process.env.HUB_GITLAB_TOKEN;
  try {
    delete process.env.HUB_GITLAB_TOKEN;
    const { handlers, repo, store } = setup(rig, { gitlabBase: 'https://notoken.invalid' });
    store.setSettings({ useGitCredential: false }); // jangan bergantung pada kredensial git mesin ini
    const r = await handlers['pulls:list']({ repoIds: [repo.id] });
    assert.deepEqual(r.errors, [], 'tanpa token bukan galat');
    assert.deepEqual(r.disabled.map((d) => [d.platform, d.reason, d.host]), [['gitlab', 'no-token', 'notoken.invalid']]);
    assert.ok(r.items.length > 0 && r.items.every((i) => i.platform === 'github'), 'PR GitHub tetap tampil');
    const st = await handlers['status:refresh']({ ids: [repo.id], parity: false });
    assert.equal(st.results[0].pulls.gitlabOff, true);
    assert.deepEqual(st.results[0].pulls.errors, []);
    const t = await handlers['repos:test']({ id: repo.id });
    assert.equal(t.gitlab.ok, false); assert.equal(t.gitlab.code, 'NO_TOKEN');
  } finally { if (keep !== undefined) process.env.HUB_GITLAB_TOKEN = keep; rig.cleanup(); }
});

test('auth: kredensial git hanya dipakai bila berbentuk token GitLab (kata sandi akun diabaikan)', async () => {
  const { looksLikeToken, createAuth } = require('../main/auth');
  for (const yes of ['glpat-abcdefghijklmnopqrst', 'gloas-0123456789abcdef', 'abcdefghij0123456789']) assert.equal(looksLikeToken(yes), true, yes);
  for (const no of ['hunter2', 'my account password', 'short-pw', '']) assert.equal(looksLikeToken(no), false, no);

  // end-to-end lewat `git credential fill` dengan helper palsu (helper kosong lebih dulu = abaikan helper mesin ini)
  const keep = { ...process.env };
  const helper = (pw) => `!f() { echo username=u; echo password=${pw}; }; f`;
  const auth = createAuth(new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-auth-'))));
  try {
    delete process.env.HUB_GITLAB_TOKEN; delete process.env.GITLAB_TOKEN;
    Object.assign(process.env, { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '', GIT_CONFIG_KEY_1: 'credential.helper' });
    process.env.GIT_CONFIG_VALUE_1 = helper('hunter2');
    assert.deepEqual(await auth.describe('pw.invalid'), { has: false, source: null }, 'kata sandi akun tidak dipakai sebagai token');
    process.env.GIT_CONFIG_VALUE_1 = helper('glpat-abcdefghijklmnopqrst');
    assert.deepEqual(await auth.describe('tok.invalid'), { has: true, source: 'git credentials' });
  } finally { for (const k of Object.keys(process.env)) if (!(k in keep)) delete process.env[k]; Object.assign(process.env, keep); }
});

/* ------------------------------------------------------------------ release flow */
test('Alur rilis: branch versi > master > vercel (PR dibuat, tunggu check, merge, mirror, deployment)', async () => {
  const rig = makeRig(); const gh = ghState({ defaultChecks: 'pending' });
  try {
    rig.sh('checkout', '-b', 'karirkit/9.9.9'); rig.commit('rilis 9.9.9', 'v.txt'); rig.sh('push', rig.gh, 'karirkit/9.9.9');
    rig.sh('checkout', 'master'); rig.sh('branch', 'karirkit/vercel'); rig.sh('push', rig.gh, 'karirkit/vercel');
    const { handlers, repo } = setup(rig);
    gh.write((s) => { s.deployments = [{ id: 1, environment: 'Production – karirkit', state: 'success', url: 'https://x.vercel.app' }]; });

    const plan = await handlers['release:plan']({ repoId: repo.id, branch: 'karirkit/9.9.9' });
    assert.deepEqual(plan.plan.steps, [{ from: 'karirkit/9.9.9', to: 'master' }, { from: 'master', to: 'karirkit/vercel' }]);
    assert.equal(plan.plan.mirror, true);
    assert.match((await handlers['release:run']({ repoId: repo.id, branch: 'karirkit/9.9.9' })).error, /confirmation/);

    const events = [];
    // check awalnya "pending"; baru lulus setelah progres "menunggu check" muncul (tanpa timer, agar tidak bergantung kecepatan mesin)
    const passChecks = () => gh.write((s) => { s.prs.forEach((p) => { if (p.state === 'open') p.checks = 'success'; }); s.defaultChecks = 'success'; });
    const svc2 = createServices({ store: new Store(fs.mkdtempSync(path.join(rig.root, 'data-'))), emit: (c, d) => { events.push(d); if (d.phase === 'wait' && /check/i.test(d.message)) passChecks(); } });
    const repo2 = svc2.store.addRepo({ name: 'Demo', path: rig.work, github: { repo: 'org/demo', url: rig.gh }, gitlab: { baseUrl: 'https://gitlab.invalid', path: 'grp/demo', url: rig.gl } }).repo;
    const res = await svc2.handlers['release:run']({ repoId: repo2.id, branch: 'karirkit/9.9.9', runId: 'r1', confirmed: true });
    assert.equal(res.ok, true);
    assert.deepEqual(res.steps.map((s) => s.status), ['done', 'done']);
    const prs = gh.read().prs.filter((p) => p.number >= 10);
    assert.deepEqual(prs.map((p) => [p.head, p.base, p.state]), [['karirkit/9.9.9', 'master', 'merged'], ['master', 'karirkit/vercel', 'merged']]);
    assert.ok(events.some((e) => e.phase === 'wait' && /check/i.test(e.message)), 'menunggu check terlihat di progres');
    assert.equal(res.mirror.ok, true);
    assert.match(require('./rig.cjs').sh(rig.gl, 'branch', '--list', 'karirkit/9.9.9'), /karirkit\/9\.9\.9/); // GitLab ikut disamakan
    assert.deepEqual(res.deployments.map((d) => d.state), ['success']);
    const act = (await svc2.handlers['activity:list']()).items[0];
    assert.equal(act.action, 'release'); assert.equal(act.ok, true);
  } finally { rig.cleanup(); }
});

test('Alur rilis: berhenti di check gagal / PR draft / tanpa perubahan dilewati / bisa dibatalkan', async () => {
  const rig = makeRig();
  try {
    rig.sh('checkout', '-b', 'karirkit/8.8.8'); rig.commit('rilis 8.8.8', 'v.txt'); rig.sh('push', rig.gh, 'karirkit/8.8.8'); rig.sh('checkout', 'master');
    const mk = () => { const s = createServices({ store: new Store(fs.mkdtempSync(path.join(rig.root, 'data-'))), emit: () => {} }); const repo = s.store.addRepo({ name: 'Demo', path: rig.work, github: { repo: 'org/demo', url: rig.gh }, flow: { steps: [{ from: '$BRANCH', to: 'master' }], mirror: false, checkDeployments: false } }).repo; return { ...s, repo }; };

    let gh = ghState({ defaultChecks: 'failure' });
    let { handlers, repo } = mk();
    let r = await handlers['release:run']({ repoId: repo.id, branch: 'karirkit/8.8.8', runId: 'a', confirmed: true });
    assert.equal(r.ok, false); assert.equal(r.steps[0].status, 'failed'); assert.match(r.steps[0].note, /Checks failed: build/);
    assert.equal(gh.read().prs.find((p) => p.number === 10).state, 'open'); // tidak di-merge

    gh = ghState({ prs: [{ number: 5, title: 'Draf', head: 'karirkit/8.8.8', base: 'master', author: 'dimas', state: 'open', checks: 'success', draft: true }] });
    ({ handlers, repo } = mk());
    r = await handlers['release:run']({ repoId: repo.id, branch: 'karirkit/8.8.8', runId: 'b', confirmed: true });
    assert.match(r.steps[0].note, /draft/);

    gh = ghState({ prs: [], failCreate: 'pull request create failed: No commits between master and karirkit/8.8.8' });
    ({ handlers, repo } = mk());
    r = await handlers['release:run']({ repoId: repo.id, branch: 'karirkit/8.8.8', runId: 'c', confirmed: true });
    assert.equal(r.ok, true); assert.equal(r.steps[0].status, 'skipped');

    gh = ghState({ prs: [], defaultChecks: 'pending' });
    ({ handlers, repo } = mk());
    const p = handlers['release:run']({ repoId: repo.id, branch: 'karirkit/8.8.8', runId: 'd', confirmed: true });
    setTimeout(() => handlers['release:cancel']({ runId: 'd' }), 250);
    r = await p;
    assert.equal(r.ok, false); assert.match(r.steps[0].note, /Cancelled/);
    void gh;
  } finally { rig.cleanup(); }
});
