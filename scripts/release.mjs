// Builds the standalone app and creates the release tag for it: v<version from package.json>.
//   node scripts/release.mjs [--dry-run] [--push]
// Rule: every .exe build gets its own release tag. The checks below make the tag point at the exact commit the .exe
// was built from: you must be on master, with a clean tree, at the same commit as origin/master, and the tag must be new.
// Tags are never moved, replaced or deleted. --push pushes only that one tag. --dry-run runs the checks and shows the plan.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const flags = new Set(process.argv.slice(2));
const dry = flags.has('--dry-run');
const push = flags.has('--push');
for (const f of flags) if (!['--dry-run', '--push'].includes(f)) { console.error(`Unknown option ${f}. Usage: node scripts/release.mjs [--dry-run] [--push]`); process.exit(2); }

const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
const text = (r) => (r.stdout || '').trim();
const fail = (msg) => { console.error(`Release stopped: ${msg}`); process.exit(1); };

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) fail(`the version in package.json ("${pkg.version}") must look like 1.2.3.`);
const tag = `v${pkg.version}`;

const branch = text(git('rev-parse', '--abbrev-ref', 'HEAD'));
if (branch !== 'master') fail(`releases are built from master, but you are on "${branch}".`);
if (text(git('status', '--porcelain'))) fail('the working tree has uncommitted changes.');
const fetched = git('fetch', '--quiet', 'origin', 'master', '--tags');
if (fetched.status !== 0) fail(`could not fetch origin (${(fetched.stderr || '').trim().split('\n')[0]}).`);
const head = text(git('rev-parse', 'HEAD'));
if (head !== text(git('rev-parse', 'origin/master'))) fail('local master is not at the same commit as origin/master. Pull (or push) first.');
if (text(git('tag', '-l', tag))) fail(`tag ${tag} already exists. Raise "version" in package.json (on a branch, through a PR) before building a new release.`);
if (text(git('ls-remote', '--tags', 'origin', `refs/tags/${tag}`))) fail(`tag ${tag} already exists on origin.`);

const prev = text(git('describe', '--tags', '--abbrev=0'));
const range = prev ? [`${prev}..HEAD`] : ['-n', '30'];
const changes = text(git('log', '--first-parent', '--format=- %s', ...range));
console.log(`Release ${tag} from master ${head.slice(0, 7)}${prev ? ` (previous: ${prev})` : ' (first release)'}${push ? ', will push the tag' : ''}.`);
if (dry) { console.log('Dry run: all checks passed. Nothing was built or tagged.'); process.exit(0); }

for (const script of ['build-assets.mjs', 'package.mjs']) {
  const r = spawnSync(process.execPath, [path.join(root, 'scripts', script)], { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) fail(`${script} failed, so no tag was created.`);
}
const exe = path.join(root, 'dist', 'Repo Hub-win32-x64', 'repo-hub.exe');
if (!fs.existsSync(exe)) fail('the build finished but repo-hub.exe was not found, so no tag was created.');
const mb = (fs.statSync(exe).size / 1048576).toFixed(0);

const message = `Repo Hub ${pkg.version}\n\nBuilt: ${new Date().toISOString()}\nCommit: ${head}\nExecutable: dist/Repo Hub-win32-x64/repo-hub.exe (${mb} MB)\n\nChanges since ${prev || 'the start'}:\n${changes || '- (none)'}\n`;
const tagged = spawnSync('git', ['tag', '-a', tag, '-F', '-'], { cwd: root, input: message, encoding: 'utf8' });
if (tagged.status !== 0) fail(`could not create the tag (${(tagged.stderr || '').trim()}).`);
console.log(`Created tag ${tag} on ${head.slice(0, 7)}.`);

if (push) {
  const p = git('push', 'origin', `refs/tags/${tag}`);
  if (p.status !== 0) fail(`the tag ${tag} exists locally but could not be pushed (${(p.stderr || '').trim().split('\n').pop()}). Push it with: git push origin ${tag}`);
  console.log(`Pushed tag ${tag} to origin.`);
} else console.log(`Not pushed. Push it with: git push origin ${tag}`);
