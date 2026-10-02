'use strict';
// Menyiapkan lingkungan UI: repo contoh + remote bare, gh palsu, GitLab palsu, dan meluncurkan aplikasi Electron.
const http = require('node:http');
const nodePath = require('node:path');
const { makeRig, fs, os, sh } = require('./rig.cjs');
const { Store } = require('../main/store');

const PW = 'C:/Users/SEVIMA-163/AppData/Local/npm-cache/_npx/6bcb61ec6d5aea22/node_modules/playwright';
const { _electron: electron } = require(PW);
const ROOT = nodePath.resolve(__dirname, '..');

function startGitlab() {
  const mrs = [
    { iid: 7, title: 'MR tujuh: perbaiki login', web_url: 'http://gl/mr/7', author: { username: 'sari', name: 'Sari' }, draft: false, state: 'opened', source_branch: 'feat-7', target_branch: 'master', created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-02T03:00:00Z', head_pipeline: { id: 55, status: 'success', web_url: 'http://gl/p/55' }, has_conflicts: false, detailed_merge_status: 'mergeable', labels: [], changes_count: '2' },
    { iid: 8, title: 'MR delapan: draf eksperimen', web_url: 'http://gl/mr/8', author: { username: 'dimas', name: 'Dimas' }, draft: true, state: 'opened', source_branch: 'feat-8', target_branch: 'master', created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T12:00:00Z', head_pipeline: { id: 56, status: 'running' }, has_conflicts: false, detailed_merge_status: 'draft_status', labels: [] },
  ];
  const approvals = { 7: { approved: false, approvals_required: 1, approvals_left: 1, approved_by: [] }, 8: { approved: true, approvals_required: 1, approvals_left: 0, approved_by: [{ user: { username: 'sari' } }] } };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x'); let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const send = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
      if (req.headers['private-token'] !== 'secret-token') return send(401, { message: '401 Unauthorized' });
      const p = url.pathname.replace('/api/v4', ''); let m;
      if (p === '/user') return send(200, { username: 'dimas', name: 'Dimas' });
      if (p === '/projects/grp%2Fdemo') return send(200, { path_with_namespace: 'grp/demo', default_branch: 'main', visibility: 'private', permissions: { project_access: { access_level: 30 } } });
      if (p === '/projects/grp%2Fdemo/merge_requests' && req.method === 'GET') return send(200, mrs.filter((x) => x.state === (url.searchParams.get('state') === 'opened' ? 'opened' : url.searchParams.get('state'))));
      if ((m = p.match(/^\/projects\/grp%2Fdemo\/merge_requests\/(\d+)(\/.*)?$/))) {
        const mr = mrs.find((x) => x.iid === Number(m[1])); const sub = m[2] || '';
        if (!mr) return send(404, { message: '404 Not found' });
        if (sub === '' && req.method === 'GET') return send(200, { ...mr, description: 'Memperbaiki alur login.', changes_count: '2' });
        if (sub === '/approvals') return send(200, approvals[mr.iid]);
        if (sub === '/approve') { approvals[mr.iid] = { approved: true, approvals_required: 1, approvals_left: 0, approved_by: [{ user: { username: 'dimas' } }] }; return send(201, {}); }
        if (sub === '/notes' && req.method === 'GET') return send(200, [{ author: { username: 'sari' }, body: 'Sudah saya cek.', created_at: '2026-10-02T00:00:00Z', system: false }]);
        if (sub === '/commits') return send(200, [{ short_id: 'abc1234', title: 'perbaiki login', author_name: 'Sari', created_at: '2026-10-01T00:00:00Z' }]);
        if (sub === '/diffs') return send(200, [{ old_path: 'login.js', new_path: 'login.js', diff: '@@ -1,2 +1,3 @@\n const a = 1;\n-const b = 2;\n+const b = 3;\n+const c = 4;\n', new_file: false, deleted_file: false }]);
        if (sub === '/merge' && req.method === 'PUT') { if (mr.draft) return send(405, { message: 'Method Not Allowed' }); mr.state = 'merged'; return send(200, mr); }
      }
      if (p === '/projects/grp%2Fdemo/pipelines/55/jobs') return send(200, [{ name: 'build', status: 'success', web_url: 'http://gl/j/1' }]);
      send(404, { message: `404 ${p}` });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ mrs, base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })));
}

function ghState(extra = {}) {
  const file = nodePath.join(fs.mkdtempSync(nodePath.join(os.tmpdir(), 'hub-gh-')), 'state.json');
  const state = {
    repo: 'org/demo', viewer: 'dimas', next: 10, permission: 'WRITE', deployments: [{ id: 1, environment: 'Production – karirkit', state: 'success', url: 'https://x.vercel.app' }],
    prs: [
      { number: 1, title: 'Tambah fitur A <script>alert(1)</script>', head: 'fitur-a', base: 'master', author: 'rina', state: 'open', checks: 'success', reviewDecision: 'REVIEW_REQUIRED', body: 'Deskripsi **A** dengan <img src=x onerror=alert(2)>', files: [{ path: 'README.md', additions: 2, deletions: 1 }] },
      { number: 2, title: 'Perbaikan B milik saya', head: 'fix-b', base: 'master', author: 'dimas', state: 'open', checks: 'pending' },
      { number: 3, title: 'Eksperimen C (konflik)', head: 'exp-c', base: 'master', author: 'budi', state: 'open', checks: 'failure', mergeState: 'DIRTY', mergeable: 'CONFLICTING', draft: true },
    ],
    ...extra,
  };
  fs.writeFileSync(file, JSON.stringify(state));
  return { file, read: () => JSON.parse(fs.readFileSync(file, 'utf8')), write: (fn) => { const s = JSON.parse(fs.readFileSync(file, 'utf8')); fn(s); fs.writeFileSync(file, JSON.stringify(s)); } };
}

async function launch(repos, { gh, extraEnv = {} } = {}) {
  const userData = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'hub-ud-'));
  const store = new Store(userData);
  for (const r of repos) { const res = store.addRepo(r); if (!res.ok) throw new Error(`seed repo gagal: ${res.error}`); }
  const env = { ...process.env, HUB_USER_DATA: userData, HUB_GH_BIN: nodePath.join(__dirname, 'fixtures-fake-gh.cjs'), FAKE_GH_STATE: gh.file, HUB_GITLAB_TOKEN: 'secret-token', HUB_POLL_MS: '60', ...extraEnv };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: require(nodePath.join(ROOT, 'node_modules', 'electron')), args: [ROOT], cwd: ROOT, env });
  const page = await app.firstWindow();
  const problems = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text().slice(0, 300)}`); });
  await page.setViewportSize({ width: 1440, height: 900 });
  return { app, page, problems, userData, store };
}

module.exports = { makeRig, sh, fs, os, nodePath, startGitlab, ghState, launch, ROOT };
