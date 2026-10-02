'use strict';
// Alur rilis berurutan, mis. "branch versi > master > vercel": untuk tiap langkah cari/buat PR,
// tunggu check, merge; lalu (opsional) samakan GitLab dan pantau deployment. Berhenti di kegagalan pertama.
const git = require('./git');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const POLL = () => Number(process.env.HUB_POLL_MS) || 5000; // jeda polling (tes memakai nilai kecil)

function planFor(repo, branch) {
  const steps = repo.flow.steps.map((s) => ({ from: s.from === '$BRANCH' ? branch : s.from, to: s.to }));
  return { steps, mirror: repo.flow.mirror && !!repo.github && !!repo.gitlab, method: repo.flow.method, waitChecks: repo.flow.waitChecks, checkDeployments: repo.flow.checkDeployments && !!repo.github, platform: repo.primary };
}

function createRelease({ store, providers }) {
  const cancelled = new Set();

  async function waitReady(repo, platform, id, { waitChecks, emit, runId, timeoutMs = 180000, intervalMs = POLL() }) {
    const started = Date.now();
    let last = '';
    while (Date.now() - started < timeoutMs) {
      if (cancelled.has(runId)) return { ok: false, error: 'Dibatalkan.' };
      const d = await providers.detail({ repoId: repo.id, platform, id });
      if (!d.ok) return { ok: false, error: d.error };
      const it = d.item;
      if (it.state === 'merged') return { ok: true, merged: true, item: it };
      if (it.state === 'closed') return { ok: false, error: 'PR sudah ditutup.' };
      if (it.isDraft) return { ok: false, error: 'PR masih berstatus draft.' };
      if (it.mergeable === 'conflict') return { ok: false, error: 'PR punya konflik; selesaikan dulu.' };
      if (it.review.state === 'changes_requested') return { ok: false, error: 'Ada permintaan perubahan pada PR ini.' };
      const checksPending = waitChecks && it.checks.state === 'pending';
      if (it.checks.state === 'failure' && waitChecks) return { ok: false, error: 'Check gagal: ' + it.checks.items.filter((c) => c.state === 'failure').map((c) => c.name).join(', ') };
      if (!checksPending && (it.mergeable === 'clean')) return { ok: true, item: it };
      if (!checksPending && it.mergeable === 'blocked') return { ok: false, error: 'Merge diblokir (butuh approval atau aturan branch).' };
      if (!checksPending && it.mergeable === 'behind') return { ok: false, error: 'Branch tertinggal dari target; perbarui dulu.' };
      const msg = checksPending ? `Menunggu check (${it.checks.items.filter((c) => c.state === 'pending').map((c) => c.name).join(', ') || '…'})` : 'Menunggu status merge dihitung…';
      if (msg !== last) { emit({ phase: 'wait', level: 'info', message: msg }); last = msg; }
      await sleep(intervalMs);
    }
    return { ok: false, error: 'Waktu tunggu habis sebelum PR siap di-merge.' };
  }

  async function run({ repoId, branch, runId, emit, overrides = {} }) {
    const repo = store.repo(repoId);
    if (!repo) return { ok: false, error: 'Repo tidak ditemukan.' };
    if (!git.isSafeRef(branch)) return { ok: false, error: 'Nama branch tidak valid.' };
    const plan = { ...planFor(repo, branch), ...overrides };
    const platform = plan.platform;
    const out = { ok: true, steps: [], mirror: null, deployments: null };
    const send = (i, extra) => emit({ runId, step: i, total: plan.steps.length, ...extra });

    for (let i = 0; i < plan.steps.length; i++) {
      const s = plan.steps[i];
      const label = `${s.from} → ${s.to}`;
      const rec = { from: s.from, to: s.to, status: 'running', note: '' };
      out.steps.push(rec);
      send(i, { phase: 'start', level: 'info', message: `Langkah ${i + 1}/${plan.steps.length}: ${label}` });
      if (cancelled.has(runId)) { rec.status = 'cancelled'; out.ok = false; break; }

      const found = await providers.findOpen(repo, platform, s.from, s.to);
      if (!found.ok) { rec.status = 'failed'; rec.note = found.error; out.ok = false; break; }
      let pr = found.item;
      if (pr) send(i, { phase: 'pr', level: 'info', message: `Memakai PR terbuka #${pr.id}` });
      else {
        send(i, { phase: 'pr', level: 'info', message: 'Membuat PR…' });
        const created = await providers.create({ repoId, platform, base: s.to, head: s.from, title: `Rilis: ${s.from} → ${s.to}`, body: 'Dibuat otomatis oleh Repo Hub (alur rilis).', draft: false });
        if (!created.ok) {
          if (/no commits between|tidak ada perbedaan|nothing to merge|already exists/i.test(created.error || '')) { rec.status = 'skipped'; rec.note = 'Tidak ada perubahan untuk digabung.'; send(i, { phase: 'skip', level: 'warn', message: rec.note }); continue; }
          rec.status = 'failed'; rec.note = created.error; out.ok = false; break;
        }
        pr = { id: created.number };
        send(i, { phase: 'pr', level: 'info', message: `PR #${created.number} dibuat` });
      }
      rec.pr = pr.id;

      const ready = await waitReady(repo, platform, pr.id, { waitChecks: plan.waitChecks, emit: (e) => send(i, e), runId });
      if (!ready.ok) { rec.status = 'failed'; rec.note = ready.error; out.ok = false; break; }
      if (ready.merged) { rec.status = 'done'; rec.note = 'Sudah ter-merge.'; continue; }

      send(i, { phase: 'merge', level: 'info', message: `Merge PR #${pr.id} (${plan.method})…` });
      const merged = await providers.merge({ repoId, platform, id: pr.id, method: plan.method, deleteBranch: false });
      if (!merged.ok) { rec.status = 'failed'; rec.note = merged.error; out.ok = false; break; }
      rec.status = 'done'; rec.note = `PR #${pr.id} ter-merge`;
      send(i, { phase: 'done', level: 'ok', message: rec.note });
    }

    if (out.ok && plan.mirror && repo.github && repo.gitlab) {
      emit({ runId, phase: 'mirror', level: 'info', message: 'Menyamakan GitLab dengan GitHub…' });
      const m = await git.mirror(repo.path, { fromUrl: repo.github.url, toUrl: repo.gitlab.url, ignoreRefs: repo.ignoreRefs });
      await git.cleanupHubRefs(repo.path);
      out.mirror = m;
      emit({ runId, phase: 'mirror', level: m.ok ? 'ok' : 'warn', message: m.ok ? (m.upToDate ? 'GitLab sudah identik.' : `${m.pushed.length} ref disalin ke GitLab.`) : `Mirror bermasalah: ${m.error || m.failed.map((f) => f.note).join('; ')}` });
    }

    if (out.ok && plan.checkDeployments && repo.github) {
      const last = plan.steps[plan.steps.length - 1];
      const refs = await git.lsRemote(repo.path, repo.github.url);
      const sha = refs.ok && refs.refs[`refs/heads/${last.to}`];
      if (sha) {
        emit({ runId, phase: 'deploy', level: 'info', message: `Memantau deployment ${sha.slice(0, 7)}…` });
        const started = Date.now(); let items = [];
        while (Date.now() - started < 150000) {
          if (cancelled.has(runId)) break;
          const d = await providers.deployments(repo, sha);
          items = d.ok ? d.items : [];
          if (items.length && items.every((x) => ['success', 'failure', 'error', 'inactive'].includes(x.state))) break;
          if (Date.now() - started > (process.env.HUB_POLL_MS ? 400 : 30000) && !items.length) break; // repo tanpa deployment
          await sleep(POLL());
        }
        out.deployments = items;
        emit({ runId, phase: 'deploy', level: items.length && items.every((x) => x.state === 'success') ? 'ok' : 'warn', message: items.length ? items.map((x) => `${x.environment}: ${x.state}`).join(' · ') : 'Tidak ada deployment terdeteksi.' });
      }
    }
    cancelled.delete(runId);
    return out;
  }

  return { plan: (repoId, branch) => { const r = store.repo(repoId); return r ? planFor(r, branch) : null; }, run, cancel: (runId) => cancelled.add(runId) };
}

module.exports = { createRelease, planFor };
