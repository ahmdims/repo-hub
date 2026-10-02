'use strict';
// Akun (GitHub / GitLab / penyedia git lain) dan kaitannya dengan ~/.ssh. Mengelompokkan repo per akun, mengecek nama akun
// lewat "ssh -T" (tanpa token/API), membuat kunci + alias baru, dan mengalihkan remote repo dari HTTPS ke SSH.
// Semua yang menulis (kunci, config, known_hosts, .git/config) dipanggil dari services dengan confirmed:true.
const fs = require('node:fs');
const path = require('node:path');
const git = require('./git');
const ssh = require('./sshconfig');
const { run } = require('./exec');

const PLATFORMS = ['github', 'gitlab'];
const PATH_RE = /^[A-Za-z0-9._\/-]+$/;
const norm = (u) => String(u || '').trim().replace(/\/+$/, '').replace(/\.git$/i, '').toLowerCase();
const err = (error, extra = {}) => ({ ok: false, error, ...extra });
const PROVIDER_NAME = { github: 'GitHub', gitlab: 'GitLab', other: 'Git' };
const keysPage = (provider, host) => (provider === 'github' ? 'https://github.com/settings/ssh/new' : provider === 'gitlab' ? `https://${host}/-/user_settings/ssh_keys` : null);

/* ------------------------------------------------------------------ cek akun lewat ssh -T */
const lastLine = (t) => String(t || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() || '';

function parseWhoami(text, exit) {
  const t = String(text || '');
  const banners = [
    /Hi ([\w.-]+)! You've successfully authenticated/, // GitHub
    /Welcome to GitLab, @([\w.-]+)!/, // GitLab
    /Hi there, ([\w.-]+)! You've successfully authenticated/, // Gitea / Forgejo
    /logged in as ([\w.-]+)\./i, // Bitbucket
  ];
  for (const re of banners) {
    const m = re.exec(t);
    if (m) return { ok: true, login: m[1], banner: t.split(/\r?\n/).find((l) => re.test(l)).trim() };
  }
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|No .* host key is known/i.test(t)) return err('This host is not trusted yet, or its key has changed. Review its fingerprint and trust it first.', { code: 'HOST_KEY' });
  if (/Permission denied|publickey/i.test(t)) return err('The server rejected this SSH key. Add the public key to your account on the provider, then check again.', { code: 'AUTH' });
  if (/ENOENT|not found|not recognized/i.test(t)) return err('The ssh program was not found. Install the OpenSSH client.', { code: 'NO_SSH' });
  if (/Could not resolve hostname|timed out|Connection refused|No route to host|Network is unreachable|Connection closed|Connection reset|kex_exchange/i.test(t)) return err(`Could not reach the host over SSH (${lastLine(t)}). Check your network or VPN.`, { code: 'NETWORK' });
  if (exit === 0) return { ok: true, login: null, banner: lastLine(t) };
  return err(lastLine(t) || 'SSH did not respond.', { code: 'UNKNOWN' });
}

async function whoami({ host, alias, identityFile, port }) {
  const target = alias || host;
  if (!ssh.ALIAS_RE.test(String(target || ''))) return err('Host is not valid.', { code: 'INVALID' });
  const dir = ssh.sshDir();
  const args = ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=12', '-o', 'StrictHostKeyChecking=yes'];
  if (process.env.HUB_SSH_DIR && fs.existsSync(path.join(dir, 'config'))) args.push('-F', path.join(dir, 'config'));
  if (identityFile) {
    if (!ssh.NAME_RE.test(identityFile) || !fs.existsSync(path.join(dir, identityFile))) return err(`The SSH key "${identityFile}" was not found in the ssh folder.`, { code: 'NO_KEY' });
    args.push('-o', 'IdentitiesOnly=yes', '-i', path.join(dir, identityFile));
  }
  if (port && Number(port) !== 22) args.push('-p', String(Number(port)));
  args.push(`git@${target}`);
  const r = await run('ssh', args, { timeout: 25000 });
  if (r.timedOut) return err('SSH timed out. Check your network or VPN.', { code: 'NETWORK' });
  return parseWhoami(`${r.stdout}\n${r.stderr}`, r.code);
}

/* ------------------------------------------------------------------ gh */
async function ghLogins() {
  const r = await run('gh', ['auth', 'status'], { timeout: 20000 });
  const logins = []; let last = null;
  for (const line of `${r.stdout}\n${r.stderr}`.split(/\r?\n/)) {
    const m = /Logged in to (\S+) account (\S+)/.exec(line);
    if (m) { last = { host: m[1].toLowerCase(), login: m[2], active: false }; logins.push(last); continue; }
    if (last && /Active account:\s*true/i.test(line)) last.active = true;
  }
  return logins;
}

/* ------------------------------------------------------------------ remote -> host / pemilik */
// git@alias:path memakai alias dari ssh config; host sebenarnya = HostName milik alias itu
function makeResolver(accounts = []) {
  const fromAccounts = accounts.filter((a) => a.ssh && a.ssh.alias).map((a) => ({ alias: a.ssh.alias, hostName: a.host }));
  const aliases = [...ssh.hostAliases().aliases, ...fromAccounts];
  return (url) => {
    const p = git.parseRemoteUrl(url);
    const a = aliases.find((x) => x.alias.toLowerCase() === p.host);
    const host = (a ? a.hostName : p.host).toLowerCase();
    return { host, rawHost: p.host, owner: (p.path.split('/')[0] || '').toLowerCase(), path: p.path };
  };
}

// akun dengan pemilik yang cocok lebih diutamakan daripada akun "semua pemilik" di host yang sama; ambigu = tidak ada
function matchAccount(accounts, { host, owner }) {
  const cands = accounts.filter((a) => a.host === host);
  const specific = cands.filter((a) => a.owners.length && a.owners.includes(owner));
  if (specific.length === 1) return specific[0];
  if (specific.length > 1) return null;
  const generic = cands.filter((a) => !a.owners.length);
  return generic.length === 1 ? generic[0] : null;
}

function createAccounts({ store }) {
  /* ---------------------------------------------------------------- daftar + penetapan otomatis */
  function remotesOf(repo) { return PLATFORMS.filter((p) => repo[p]).map((p) => ({ platform: p, remote: repo[p] })); }

  function list() {
    const counts = {};
    for (const r of store.repos()) for (const { remote } of remotesOf(r)) if (remote.account) counts[remote.account] = (counts[remote.account] || 0) + 1;
    return store.accounts().map((a) => ({ ...a, repoCount: counts[a.id] || 0 }));
  }

  function autoAssign() {
    const resolve = makeResolver(store.accounts()); let n = 0;
    for (const repo of store.repos()) {
      for (const { platform, remote } of remotesOf(repo)) {
        if (remote.account && store.account(remote.account)) continue;
        const acct = matchAccount(store.accounts(), resolve(remote.url));
        if (!acct) continue;
        const res = store.updateRepo(repo.id, { [platform]: { ...remote, account: acct.id } });
        if (res.ok) n++;
      }
    }
    return n;
  }

  function setRepoAccount({ repoId, platform, accountId }) {
    const repo = store.repo(repoId);
    if (!repo || !PLATFORMS.includes(platform) || !repo[platform]) return err('This repo has no remote for that platform.');
    const remote = { ...repo[platform] };
    if (!accountId) { delete remote.account; }
    else {
      const acct = store.account(accountId);
      if (!acct) return err('Account not found.');
      const info = makeResolver(store.accounts())(remote.url);
      if (acct.host !== info.host) return err(`This account is for ${acct.host}, but the remote is on ${info.host}.`);
      remote.account = acct.id;
    }
    const res = store.updateRepo(repoId, { [platform]: remote }); // objek remote diganti utuh: kunci yang tidak ikut = terhapus
    return res.ok ? { ok: true, repo: res.repo } : res;
  }

  /* ---------------------------------------------------------------- deteksi */
  async function detect() {
    const dir = ssh.sshDir();
    const cfg = ssh.hostAliases(dir);
    const keys = ssh.listPublicKeys(dir);
    const gh = await ghLogins();
    const resolve = makeResolver(store.accounts());
    const accounts = store.accounts();

    // (host, pemilik) yang dipakai repo terdaftar
    const groups = new Map();
    for (const repo of store.repos()) for (const { platform, remote } of remotesOf(repo)) {
      const info = resolve(remote.url);
      if (!info.host) continue;
      const k = `${info.host}|${info.owner}`;
      if (!groups.has(k)) groups.set(k, { host: info.host, owner: info.owner, provider: git.kindOfUrl(`https://${info.host}/x/y`), repos: [], platforms: new Set() });
      const g = groups.get(k); g.repos.push(repo.name); g.platforms.add(platform);
    }
    const sshFor = (host) => {
      const cands = cfg.aliases.filter((a) => a.hostName.toLowerCase() === host);
      const pick = cands.length === 1 ? cands[0] : cands.find((a) => a.alias.toLowerCase() === host) || null;
      return pick ? { alias: pick.alias, identityFile: pick.identityFile || '', ...(pick.port ? { port: pick.port } : {}) } : null;
    };
    const covered = (host, owner) => accounts.some((a) => a.host === host && (!a.owners.length || a.owners.includes(owner)));

    const suggestions = [];
    for (const g of groups.values()) {
      if (covered(g.host, g.owner)) continue;
      const guess = g.provider === 'github' && gh.some((x) => x.login.toLowerCase() === g.owner) ? gh.find((x) => x.login.toLowerCase() === g.owner).login : '';
      suggestions.push({ key: `repos:${g.host}|${g.owner}`, source: 'repos', provider: g.provider, host: g.host, owners: g.owner ? [g.owner] : [], login: guess, label: `${PROVIDER_NAME[g.provider]} · ${g.owner || g.host}`, ssh: sshFor(g.host), repoCount: g.repos.length, repos: [...new Set(g.repos)].slice(0, 6) });
    }
    const usedHosts = new Set([...groups.values()].map((g) => g.host));
    for (const a of cfg.aliases) {
      const host = a.hostName.toLowerCase();
      if (usedHosts.has(host) || accounts.some((x) => x.host === host)) continue;
      if (suggestions.some((s) => s.key === `ssh:${a.alias}`)) continue;
      const provider = git.kindOfUrl(`https://${host}/x/y`);
      suggestions.push({ key: `ssh:${a.alias}`, source: 'ssh-config', provider, host, owners: [], login: '', label: a.alias === host ? `${PROVIDER_NAME[provider]} · ${host}` : a.alias, ssh: { alias: a.alias, identityFile: a.identityFile || '', ...(a.port ? { port: a.port } : {}) }, repoCount: 0, repos: [] });
    }
    suggestions.sort((x, y) => `${x.host}|${x.label}`.localeCompare(`${y.host}|${y.label}`));

    return { ok: true, sshDir: dir, sshDirExists: fs.existsSync(dir), hasInclude: !!cfg.hasInclude, hosts: cfg.aliases.map(({ alias, hostName, user, port, identityFile }) => ({ alias, hostName, user, port, identityFile })), keys, gh, suggestions };
  }

  /* ---------------------------------------------------------------- cek + trust host */
  async function check(p = {}) {
    let target;
    if (p.id) {
      const a = store.account(p.id);
      if (!a) return err('Account not found.');
      target = { host: a.host, alias: a.ssh && a.ssh.alias, identityFile: a.ssh && a.ssh.identityFile, port: a.ssh && a.ssh.port };
    } else target = { host: p.host, alias: p.alias, identityFile: p.identityFile, port: p.port };
    if (target.host && !ssh.HOST_RE.test(target.host)) return err('Host is not valid.');
    return whoami(target);
  }

  async function hostKey({ host, port }) {
    const r = await ssh.scanHostKeys(host, port);
    if (!r.ok) return r;
    return { ok: true, host, port: Number(port) || 22, trusted: await ssh.knownHostsHas(host, port), fingerprints: r.keys.map(({ type, fingerprint }) => ({ type, fingerprint })) };
  }

  // hanya menambahkan kunci host yang sidik jarinya persis sama dengan yang sudah dilihat dan dikonfirmasi pengguna
  async function trustHost({ host, port, fingerprint }) {
    if (!/^SHA256:[A-Za-z0-9+/]{43}$/.test(String(fingerprint || ''))) return err('Fingerprint is not valid.');
    if (await ssh.knownHostsHas(host, port)) return { ok: true, alreadyTrusted: true };
    const r = await ssh.scanHostKeys(host, port);
    if (!r.ok) return r;
    const k = r.keys.find((x) => x.fingerprint === fingerprint);
    if (!k) return err('The host presented a different key than the one you reviewed, so nothing was added.');
    ssh.appendKnownHost(k.line);
    return { ok: true, added: true, type: k.type, fingerprint };
  }

  /* ---------------------------------------------------------------- tulis (kunci + alias) */
  async function createKey({ name, comment, provider, host }) {
    const r = await ssh.createKey({ name, comment });
    return r.ok ? { ...r, keysUrl: keysPage(provider, host) } : r;
  }
  const addHost = (p) => ssh.appendHostBlock(p);
  const publicKey = ({ file }) => ssh.readPublicKey(file);

  /* ---------------------------------------------------------------- remote repo: HTTPS <-> SSH */
  async function probeRemote(dir, url) {
    const env = { GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || 'ssh -o BatchMode=yes -o ConnectTimeout=15' };
    const r = await run('git', ['ls-remote', '--heads', url, 'HEAD'], { cwd: dir, timeout: 45000, env });
    if (r.ok) return { ok: true };
    const text = r.stderr || '';
    return { ok: false, hostKey: /Host key verification failed/i.test(text), error: git.redactUrl(lastLine(text)).slice(0, 300) || 'git ls-remote failed.' };
  }

  // ganti tiap entri remote.*.url / remote.*.pushurl yang sama dengan oldUrl; entri lain tidak disentuh
  async function rewriteRemoteUrls(dir, oldUrl, newUrl) {
    const r = await run('git', ['config', '--get-regexp', '^remote\\..*\\.(url|pushurl)$'], { cwd: dir, timeout: 15000 });
    let count = 0;
    for (const line of r.stdout.split(/\r?\n/).filter(Boolean)) {
      const i = line.indexOf(' ');
      const key = line.slice(0, i), val = line.slice(i + 1);
      if (!/^remote\.\S+\.(url|pushurl)$/.test(key) || norm(val) !== norm(oldUrl)) continue;
      const w = await run('git', ['config', '--replace-all', '--fixed-value', key, newUrl, val], { cwd: dir, timeout: 15000 });
      if (!w.ok) return err(`Could not update ${key} in the repo's git config: ${(w.stderr || 'git config failed').split('\n')[0]}`);
      count++;
    }
    return { ok: true, count };
  }

  async function useSsh({ repoId, platform, accountId, revert = false }) {
    const repo = store.repo(repoId);
    if (!repo) return err('Repo not found.');
    if (!PLATFORMS.includes(platform) || !repo[platform]) return err('This repo has no remote for that platform.');
    if (!fs.existsSync(repo.path)) return err('The repo folder was not found.');
    const remote = repo[platform];
    const info = makeResolver(store.accounts())(remote.url);
    let account = null, to;
    if (revert) {
      account = store.account(accountId || remote.account);
      to = remote.prevUrl || `https://${(account && account.host) || info.host}/${info.path}.git`;
      if (!/^https:\/\//i.test(to) || !PATH_RE.test(info.path)) return err('There is no valid HTTPS URL to go back to.');
    } else {
      account = store.account(accountId || remote.account);
      if (!account) return err('Pick an account first.');
      if (account.host !== info.host) return err(`This account is for ${account.host}, but the remote is on ${info.host}.`);
      if (!PATH_RE.test(info.path)) return err('The repo path contains characters that cannot be used in an SSH URL.');
      const sshCfg = account.ssh || {};
      to = !sshCfg.alias && sshCfg.port && Number(sshCfg.port) !== 22 ? `ssh://git@${account.host}:${Number(sshCfg.port)}/${info.path}.git` : `git@${sshCfg.alias || account.host}:${info.path}.git`;
    }
    if (norm(to) === norm(remote.url)) return { ok: true, unchanged: true, to, from: git.redactUrl(remote.url) };

    if (!revert) {
      const probe = await probeRemote(repo.path, to);
      if (!probe.ok) return err(`Could not read ${to} over SSH, so nothing was changed. ${probe.error}`, probe.hostKey ? { code: 'HOST_KEY' } : {});
    }
    const rw = await rewriteRemoteUrls(repo.path, remote.url, to);
    if (!rw.ok) return rw;

    const patch = { ...remote, url: to };
    if (revert) delete patch.prevUrl;
    else { const prev = /^https?:\/\//i.test(remote.url) ? remote.url : remote.prevUrl; if (prev) patch.prevUrl = prev; else delete patch.prevUrl; }
    if (account) patch.account = account.id;
    const res = store.updateRepo(repoId, { [platform]: patch });
    if (!res.ok) return res;
    return { ok: true, from: git.redactUrl(remote.url), to, replaced: rw.count, note: rw.count ? null : "The repo's own git config did not contain this URL, so only the app's URL was updated (push and mirror use it)." };
  }

  return { list, autoAssign, setRepoAccount, detect, check, hostKey, trustHost, createKey, addHost, publicKey, useSsh, matchAccount };
}

module.exports = { createAccounts, matchAccount, parseWhoami, makeResolver, keysPage };
