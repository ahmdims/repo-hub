// Rilis: jalankan alur berurutan per repo (mis. branch versi → master → deploy), dengan PR otomatis,
// tunggu check, merge, sinkron GitLab, dan pemantauan deployment. Berhenti di kegagalan pertama.
import { html, esc, icon, badge, fmtTime, raw, mount as setHtml } from '../lib/h.js';
import { dialog, confirmDialog, notify, call, busy } from '../lib/ui.js';
import { state, bus, repoById, refreshAll } from '../state.js';

// Plural helper (local): plural(2, 'step') -> "2 steps"; plural(1, 'step') -> "1 step"
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export const title = 'Release';
let host = null, offs = [], offProgress = null;
let sel = { repoId: '', branch: '' };
let ui = { branches: [], plan: null, running: false, runId: null, steps: [], log: [], result: null, hint: '' };

const STATE_ICON = { pending: 'clock-counter-clockwise', running: 'circle-notch', done: 'check', failed: 'x', skipped: 'arrow-right', cancelled: 'stop' };
const STATE_TEXT = { pending: 'Pending', running: 'Running', done: 'Done', failed: 'Failed', skipped: 'Skipped', cancelled: 'Cancelled' };

const versionLike = (b) => /\d+\.\d+/.test(b);

function stepCard(s, i) {
  return html`<div class="step-card" data-state="${s.state}" data-step="${i}">
    <span class="step-dot">${s.state === 'pending' ? i + 1 : icon(STATE_ICON[s.state], `h-4 w-4 ${s.state === 'running' ? 'animate-spin' : ''}`)}</span>
    <div class="min-w-0 flex-1"><p class="font-medium text-slate-800"><span class="font-mono text-sm">${s.from}</span> <span class="mx-1 text-slate-400">→</span> <span class="font-mono text-sm">${s.to}</span></p>
      <p class="mt-0.5 text-sm text-slate-500" data-note>${s.note || 'Create or reuse the PR, wait for checks, then merge.'}</p></div>
    <span class="shrink-0 text-xs font-medium ${s.state === 'failed' ? 'text-danger-700' : s.state === 'done' ? 'text-success-700' : 'text-slate-400'}">${STATE_TEXT[s.state]}</span></div>`;
}

function logHtml() {
  return ui.log.map((l) => `<div><span class="t">${esc(l.t)}</span> <span class="${{ ok: 'ok', warn: 'warn', error: 'err' }[l.level] || ''}">${esc(l.message)}</span></div>`).join('');
}

function render() {
  if (!host) return;
  const repos = state.repos;
  const repo = repoById(sel.repoId);
  const needsBranch = repo && repo.flow.steps.some((s) => s.from === '$BRANCH');
  const body = !repos.length
    ? html`<div class="card px-6 py-14 text-center"><p class="text-sm text-slate-500">Add a repo on the <a href="#/repositori" class="font-medium text-primary-600 hover:underline">Repositories</a> page first (including its release flow).</p></div>`
    : html`
    <div class="card p-5 sm:p-6">
      <div class="grid gap-4 md:grid-cols-[1fr_1fr_auto] md:items-end">
        <div><label class="form-label" for="rl-repo">Repo</label><select id="rl-repo" class="input" data-repo ${ui.running ? 'disabled' : ''}>${repos.map((r) => html`<option value="${r.id}" ${r.id === sel.repoId ? 'selected' : ''}>${r.name}</option>`)}</select></div>
        <div><label class="form-label" for="rl-branch">Release branch</label>${needsBranch ? html`<select id="rl-branch" class="input font-mono text-xs" data-branch ${ui.running ? 'disabled' : ''}>${ui.branches.map((b) => html`<option ${b === sel.branch ? 'selected' : ''}>${b}</option>`)}</select>` : html`<input class="input" value="Not used in this flow" disabled />`}</div>
        <button type="button" class="btn-outline btn-md" data-fetch ${ui.running ? 'disabled' : ''} title="Fetch from GitHub to refresh the branch list">${icon('arrows-clockwise')}Refresh branches</button>
      </div>
      ${ui.plan ? html`<div class="mt-4 flex flex-wrap gap-2 text-xs">${badge('neutral', `Platform: ${ui.plan.platform === 'github' ? 'GitHub' : 'GitLab'}`)}${badge('neutral', `Merge: ${ui.plan.method}`)}${badge(ui.plan.waitChecks ? 'info' : 'neutral', ui.plan.waitChecks ? 'Wait for green checks' : 'No waiting for checks')}${badge(ui.plan.mirror ? 'info' : 'neutral', ui.plan.mirror ? 'Mirror to GitLab afterwards' : 'No GitLab mirror')}${badge(ui.plan.checkDeployments ? 'info' : 'neutral', ui.plan.checkDeployments ? 'Monitor deployment' : 'No deployment monitoring')}<a href="#/repositori" class="ml-1 self-center text-primary-600 hover:underline">edit flow</a></div>` : ''}
    </div>
    <div class="card p-5 sm:p-6">
      <div class="mb-4 flex flex-wrap items-center justify-between gap-3"><h3 class="text-base font-semibold text-slate-800">Steps</h3>
        <div class="flex gap-2.5">${ui.running ? html`<button type="button" class="btn-outline btn-md text-danger-600" data-cancel>${icon('stop')}Cancel run</button>` : ''}<button type="button" class="btn-primary btn-md" data-run ${ui.running || !ui.plan || (needsBranch && !sel.branch) ? 'disabled' : ''}>${ui.running ? icon('circle-notch', 'h-4 w-4 animate-spin') : icon('rocket-launch')}${ui.running ? 'Running…' : 'Run release flow'}</button></div></div>
      ${ui.hint ? html`<div class="callout-info mb-4 flex items-start gap-3">${icon('info', 'h-4 w-4 shrink-0 text-info-600')}<p class="text-sm text-slate-600">${ui.hint}</p></div>` : ''}
      <div class="space-y-3" data-steps>${ui.steps.length ? ui.steps.map(stepCard) : html`<p class="text-sm text-slate-400">Select a repo and branch to see the steps.</p>`}</div>
      ${ui.result ? resultHtml() : ''}
    </div>
    ${ui.log.length ? html`<div class="card p-5 sm:p-6"><h3 class="mb-3 text-base font-semibold text-slate-800">Log</h3><div class="hub-console" data-console>${raw(logHtml())}</div></div>` : ''}`;
  setHtml(host, html`
    <div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"><div class="min-w-0"><h2 class="font-display text-2xl font-bold text-slate-900 sm:text-3xl">Release</h2><p class="mt-1 text-sm text-slate-500">One click to merge branches in sequence (e.g. version branch → master → deploy). Stops automatically at the first failure; no force-push and no branch deletion.</p></div></div>
    ${body}`);
  const c = host.querySelector('[data-console]'); if (c) c.scrollTop = c.scrollHeight;
}

function resultHtml() {
  const r = ui.result;
  const okSteps = r.steps.filter((s) => s.status === 'done').length;
  const dep = r.deployments && r.deployments.length ? r.deployments.map((x) => `${x.environment}: ${x.state}`).join(' · ') : null;
  return html`<div class="mt-5 rounded-xl p-4 ${r.ok ? 'bg-success-50' : 'bg-danger-50'}"><div class="flex items-start gap-3">${icon(r.ok ? 'check-circle' : 'warning-circle', `mt-0.5 h-5 w-5 shrink-0 ${r.ok ? 'text-success-600' : 'text-danger-600'}`)}<div class="text-sm"><p class="font-semibold ${r.ok ? 'text-success-800' : 'text-danger-800'}">${r.ok ? 'Release complete' : 'Release stopped'}: ${okSteps} of ${plural(r.steps.length, 'step')} completed</p>
    ${r.error ? html`<p class="mt-1 text-danger-700">${r.error}</p>` : ''}
    ${r.mirror ? html`<p class="mt-1 text-slate-600">GitLab mirror: ${r.mirror.ok ? (r.mirror.upToDate ? 'already identical' : `${plural(r.mirror.pushed.length, 'ref')} copied`) : `had problems (${r.mirror.error || (r.mirror.failed || []).map((f) => f.note).join('; ')})`}${r.mirror.skipped && r.mirror.skipped.length ? `, ${r.mirror.skipped.length} skipped` : ''}</p>` : ''}
    ${dep ? html`<p class="mt-1 text-slate-600">Deployment: ${dep}</p>` : ''}</div></div></div>`;
}

async function loadBranches() {
  const r = repoById(sel.repoId); if (!r) return;
  const b = await call('repos:branches', { id: r.id }, { silent: true });
  const remote = (b.ok ? b.remote : []).filter((x) => x !== r.defaultBranch);
  ui.branches = [...remote.filter(versionLike).sort().reverse(), ...remote.filter((x) => !versionLike(x))];
  if (!ui.branches.includes(sel.branch)) sel.branch = ui.branches[0] || '';
  await loadPlan();
}

async function loadPlan() {
  const r = repoById(sel.repoId); if (!r) return;
  const needs = r.flow.steps.some((s) => s.from === '$BRANCH');
  ui.hint = '';
  if (needs && !sel.branch) {
    ui.plan = null; ui.hint = `No release branch on the remote other than ${r.defaultBranch}. Push a version branch (e.g. karirkit/1.3.5), then click "Refresh branches".`;
    if (!ui.running) { ui.steps = r.flow.steps.map((s) => ({ from: s.from === '$BRANCH' ? '(select a release branch)' : s.from, to: s.to, state: 'pending', note: '' })); ui.result = null; ui.log = []; }
    return render();
  }
  const p = await call('release:plan', { repoId: r.id, branch: needs ? sel.branch : (r.defaultBranch || 'master') }, { silent: true });
  ui.plan = p.ok ? p.plan : null;
  if (!ui.running) { ui.steps = ui.plan ? ui.plan.steps.map((s) => ({ ...s, state: 'pending', note: '' })) : []; ui.result = null; ui.log = []; }
  render();
}

function addLog(level, message) { ui.log.push({ t: fmtTime(new Date().toISOString()).split(', ').pop(), level, message }); }

function onProgress(e) {
  if (!e || e.runId !== ui.runId) return;
  const lvl = e.level === 'ok' ? 'ok' : e.level === 'warn' ? 'warn' : e.level === 'error' ? 'error' : 'info';
  addLog(lvl, e.message);
  if (e.step != null && ui.steps[e.step]) {
    const s = ui.steps[e.step];
    if (e.phase === 'start' || e.phase === 'pr' || e.phase === 'wait' || e.phase === 'merge') { s.state = 'running'; s.note = e.message; }
    else if (e.phase === 'done') { s.state = 'done'; s.note = e.message; }
    else if (e.phase === 'skip') { s.state = 'skipped'; s.note = e.message; }
  }
  render();
}

async function run() {
  const repo = repoById(sel.repoId);
  const plan = ui.plan;
  const ok = await confirmDialog({
    title: `Release ${repo.name}`, description: 'This sequence runs now and stops at the first failure.', danger: true, iconName: 'rocket-launch', confirmLabel: 'Run release',
    body: html`<ol class="space-y-2">${plan.steps.map((s, i) => html`<li class="flex items-center gap-3 rounded-lg border border-border px-3 py-2 text-sm"><span class="step-dot !h-6 !w-6 !text-xs">${i + 1}</span><span class="font-mono">${s.from}</span><span class="text-slate-400">→</span><span class="font-mono">${s.to}</span></li>`)}</ol>
      <ul class="mt-4 space-y-1 text-xs text-slate-500"><li>• A PR is created automatically if none exists, then merged using the <b>${plan.method}</b> method.</li>${plan.waitChecks ? html`<li>• Waits for green checks before merging (max. 3 minutes per step).</li>` : ''}${plan.mirror ? html`<li>• Afterwards GitLab is mirrored from GitHub (only adds refs or fast-forwards).</li>` : ''}${plan.checkDeployments ? html`<li>• Deployment status is monitored after the last merge.</li>` : ''}</ul>`,
  });
  if (!ok) return;
  ui.running = true; ui.result = null; ui.log = []; ui.runId = `run-${Date.now()}`;
  ui.steps = plan.steps.map((s) => ({ ...s, state: 'pending', note: '' }));
  addLog('info', `Starting release of ${repo.name}…`); render();
  const res = await call('release:run', { repoId: repo.id, branch: sel.branch || repo.defaultBranch, runId: ui.runId, confirmed: true }, { silent: true });
  ui.running = false;
  if (res.steps) res.steps.forEach((s, i) => { if (ui.steps[i]) { ui.steps[i].state = s.status === 'running' ? 'failed' : s.status; ui.steps[i].note = s.note || ui.steps[i].note; } });
  ui.result = res.steps ? res : { ok: false, steps: [], error: res.error };
  addLog(res.ok ? 'ok' : 'error', res.ok ? 'Release complete.' : `Release stopped: ${(res.steps || []).find((s) => s.status === 'failed')?.note || res.error || ''}`);
  render();
  notify(res.ok ? 'success' : 'danger', res.ok ? `Release of ${repo.name} complete.` : `Release of ${repo.name} stopped after a failure.`);
  refreshAll({ fetch: true, ids: [repo.id] });
}

export function mount(el) {
  host = el;
  if (!repoById(sel.repoId)) sel.repoId = state.repos[0] ? state.repos[0].id : '';
  ui = { ...ui, running: false, result: null, log: [], steps: [] };
  render();
  host.addEventListener('change', async (e) => {
    if (e.target.matches('[data-repo]')) { sel.repoId = e.target.value; sel.branch = ''; await loadBranches(); }
    if (e.target.matches('[data-branch]')) { sel.branch = e.target.value; await loadPlan(); }
  });
  host.addEventListener('click', (e) => {
    const f = e.target.closest('[data-fetch]');
    if (f) return busy(f, async () => { const r = await call('git:fetch', { repoId: sel.repoId }); if (r.ok) { notify('success', 'Branch list refreshed.'); await loadBranches(); } });
    if (e.target.closest('[data-run]')) return run();
    if (e.target.closest('[data-cancel]')) { call('release:cancel', { runId: ui.runId }); addLog('warn', 'Cancellation requested; stopping at the next safe point…'); render(); }
  });
  offProgress = window.hub.on('release:progress', onProgress);
  offs = [];
  if (sel.repoId) loadBranches();
}
export function unmount() { offs.forEach((f) => f()); offs = []; if (offProgress) offProgress(); offProgress = null; host = null; }
