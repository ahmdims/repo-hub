'use strict';
// Pengganti `gh` untuk tes: menyimpan status PR di file JSON (FAKE_GH_STATE) dan meniru keluaran gh.
const fs = require('node:fs');
const file = process.env.FAKE_GH_STATE;
const st = JSON.parse(fs.readFileSync(file, 'utf8'));
const save = () => fs.writeFileSync(file, JSON.stringify(st, null, 2));
const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const has = (n) => args.includes(n);
const die = (msg) => { process.stderr.write(msg + '\n'); process.exit(1); };
const out = (v) => process.stdout.write(typeof v === 'string' ? v + '\n' : JSON.stringify(v) + '\n');
st.calls = st.calls || []; st.calls.push(args.join(' '));

const stateOf = (p) => p.state.toUpperCase();
const rollup = (p) => (p.checks === 'none' ? [] : [{ __typename: 'CheckRun', name: 'build', status: p.checks === 'pending' ? 'IN_PROGRESS' : 'COMPLETED', conclusion: p.checks === 'success' ? 'SUCCESS' : p.checks === 'failure' ? 'FAILURE' : '', detailsUrl: 'https://ci.example/1' }]);
const shape = (p) => ({
  number: p.number, title: p.title, url: `https://github.com/${st.repo}/pull/${p.number}`, author: { login: p.author, name: p.author }, isDraft: !!p.draft, state: stateOf(p),
  headRefName: p.head, baseRefName: p.base, createdAt: p.createdAt || '2026-10-01T00:00:00Z', updatedAt: p.updatedAt || '2026-10-02T00:00:00Z', statusCheckRollup: rollup(p), reviewDecision: p.reviewDecision || '',
  mergeStateStatus: p.mergeState || 'CLEAN', mergeable: p.mergeable || 'MERGEABLE', labels: (p.labels || []).map((name) => ({ name })), additions: 10, deletions: 2, changedFiles: (p.files || []).length,
  body: p.body || '', reviews: p.reviews || [], comments: p.comments || [], commits: [{ oid: 'abcdef1234567', messageHeadline: p.title, authors: [{ name: p.author }], committedDate: '2026-10-01T00:00:00Z' }],
  files: p.files || [{ path: 'README.md', additions: 10, deletions: 2 }], mergedAt: p.state === 'merged' ? '2026-10-02T01:00:00Z' : null, reviewRequests: [],
});
const find = (n) => { const p = st.prs.find((x) => x.number === Number(n)); if (!p) die('GraphQL: Could not resolve to a PullRequest'); return p; };
const [a, b] = args;
if (a === 'pr' && b === 'list' && flag('-R') && flag('-R') !== st.repo) { out([]); process.exit(0); } // repo lain: tidak punya PR

if (a === 'api' && b === 'user') { out(st.viewer); }
else if (a === 'api' && /\/deployments\?/.test(b)) { out((st.deployments || []).map((d) => ({ id: d.id, environment: d.environment }))); }
else if (a === 'api' && /\/deployments\/\d+\/statuses/.test(b)) { const id = Number(b.match(/deployments\/(\d+)/)[1]); const d = (st.deployments || []).find((x) => x.id === id); out(d ? [{ state: d.state, environment_url: d.url }] : []); }
else if (a === 'repo' && b === 'view') { out({ nameWithOwner: st.repo, defaultBranchRef: { name: 'master' }, viewerPermission: st.permission || 'ADMIN', isPrivate: true }); }
else if (a === 'pr' && b === 'list') { const want = (flag('--state') || 'open').toUpperCase(); out(st.prs.filter((p) => want === 'ALL' || stateOf(p) === want).map(shape)); }
else if (a === 'pr' && b === 'view') { out(shape(find(args[2]))); }
else if (a === 'pr' && b === 'diff') { out(find(args[2]).diff || 'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1,2 +1,3 @@\n # Demo\n-lama\n+baru\n+tambahan\n'); }
else if (a === 'pr' && b === 'review') {
  const p = find(args[2]);
  if (has('--approve')) { if (p.author === st.viewer) die('failed to create review: GraphQL: Can not approve your own pull request (addPullRequestReview)'); p.reviewDecision = 'APPROVED'; p.reviews = [...(p.reviews || []), { author: { login: st.viewer }, state: 'APPROVED', body: flag('-b') || '', submittedAt: '2026-10-02T02:00:00Z' }]; }
  else if (has('--request-changes')) { p.reviewDecision = 'CHANGES_REQUESTED'; p.reviews = [...(p.reviews || []), { author: { login: st.viewer }, state: 'CHANGES_REQUESTED', body: flag('-b') || '' }]; }
  else p.reviews = [...(p.reviews || []), { author: { login: st.viewer }, state: 'COMMENTED', body: flag('-b') || '' }];
  save(); out('ok');
}
else if (a === 'pr' && b === 'comment') { const p = find(args[2]); p.comments = [...(p.comments || []), { author: { login: st.viewer }, body: flag('-b') }]; save(); out('ok'); }
else if (a === 'pr' && b === 'merge') {
  const p = find(args[2]);
  if (p.state !== 'open') die('Pull request is not open');
  if (p.mergeState === 'BLOCKED') die('Pull request is not mergeable: the base branch policy prohibits the merge');
  p.state = 'merged'; p.mergedWith = ['--merge', '--squash', '--rebase'].find(has); save(); out('merged');
}
else if (a === 'pr' && b === 'close') { find(args[2]).state = 'closed'; save(); out('closed'); }
else if (a === 'pr' && b === 'create') {
  const head = flag('--head'), base = flag('--base');
  if (st.failCreate) die(st.failCreate);
  if (head === base) die('pull request create failed: No commits between ' + base + ' and ' + head);
  if (st.prs.some((p) => p.state === 'open' && p.head === head && p.base === base)) die(`a pull request for branch "${head}" into branch "${base}" already exists`);
  const number = st.next++;
  st.prs.push({ number, title: flag('--title'), body: flag('--body'), head, base, author: st.viewer, state: 'open', draft: has('--draft'), checks: st.defaultChecks || 'success' });
  save(); out(`https://github.com/${st.repo}/pull/${number}`);
}
else die(`fake gh: perintah tidak dikenal: ${args.join(' ')}`);
save();
