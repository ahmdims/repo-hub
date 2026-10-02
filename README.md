# Repo Hub

A desktop app (Electron) to **push, sync, review, merge, and release across many repos at once**, on both GitHub and GitLab. It looks and feels like KarirKit because it is built directly on the KarirKit design system.

Think of the GitHub/GitLab pages you already know, but one screen for all of your repos.

## Features

| Page | What it does |
| --- | --- |
| **Dashboard** | Status of every repo (branch, local changes, ahead/behind, GitHub ↔ GitLab parity). Select several repos, then **Push** or **Sync GitLab** in one go. |
| **Pull Requests** | GitHub PRs and GitLab MRs from all repos in one table. Filter, search, open details (checks, commits, diff, discussion), **Approve**, **Request changes**, comment, **Merge**, close, and **Create PR/MR**. Bulk approve and merge. |
| **Release** | A one-click flow, for example `karirkit/<version>` → `master` → `karirkit/vercel`: create or reuse the PR, wait for green checks, merge, mirror to GitLab, and watch the deployment. Stops at the first failure and can be cancelled. |
| **Repositories** | The repos you manage, **fully editable by you**: add from a folder, scan a parent folder, edit, or remove from the list. Each repo has its own release flow. |
| **Activity** | A log of every action (push, merge, review, release…). Tokens are never logged. |
| **Settings** | GitHub connection (through `gh`), GitLab token per host, and the git buffer size. |

## Running

Prerequisites: Node.js 20+, Git, and the [GitHub CLI](https://cli.github.com/) (`gh`).

```bash
npm install
npm start          # builds assets, then opens the app
npm test           # backend tests
npm run test:ui    # Electron UI tests (Playwright)
npm run package    # standalone app at dist/Repo Hub-win32-x64/repo-hub.exe
```

For a step-by-step walkthrough (running the app and connecting GitHub and GitLab), see [TUTORIAL.md](TUTORIAL.md).

### Signing in

- **GitHub**: run `gh auth login` once. The app uses that `gh` login and does not store a GitHub token.
- **GitLab**: create a *personal access token* (scope `api`) and paste it under **Settings → GitLab**. The token is stored encrypted by the operating system (Electron `safeStorage`). Alternatives: the `GITLAB_TOKEN` / `HUB_GITLAB_TOKEN` environment variable, or (optionally) a password already saved in the git credential manager, if it is actually a token.

The GitLab card in Settings has two rows. **Git access** (push, fetch, mirroring) works through your git login, the same way GitHub works through `gh`, and shows **Connected via git** when git can read the remote. **Merge requests** need a personal access token, which is optional: without it they show as **Off** instead of as an error. A password stored in git is only used as a token if it looks like a GitLab token, so an account password is never sent to the API.

### Adding repos

**Repositories → Add from folder** (or **Scan parent folder** to find many repos at once). The GitHub/GitLab remotes, default branch, and deploy branch are detected automatically from `git remote` (including multiple `pushurl`s) and can be corrected in the form.

### Release flow per repo

In the repo form, the **Release flow** section lists `from → to` steps. `$BRANCH` is replaced by the release branch you pick on the Release page. The default is:

1. `$BRANCH` → `master`
2. `master` → `karirkit/vercel`

Options: merge method (`merge`/`squash`/`rebase`), wait for green checks, mirror to GitLab after the release, and monitor the deployment.

## Safety guarantees

- **No force-push**, **no branch or tag deletion**, **no folder deletion**. Removing a repo from the list only removes the entry in the app.
- Every action that changes something needs confirmation in the UI **and** is rejected by the main process if it arrives without `confirmed: true`.
- GitLab mirroring only creates new refs or fast-forwards; an existing tag is never moved.
- `git`/`gh` commands run without a shell (`execFile`); all ref names are validated.
- The renderer is isolated: `contextIsolation`, `sandbox`, no `nodeIntegration`, and a CSP with no inline scripts. There is a single IPC channel with an allowlist, and all external text (PR titles, branch names, commit messages) is escaped.
- GitHub's rules still apply: you cannot approve your own PR (the button is disabled).

## Structure

```
main/       main process: git, GitHub (gh), GitLab (REST), release flow, storage, IPC
preload/    a narrow bridge to the renderer
renderer/   UI (HTML + ES modules), styled by the KarirKit design system
src/        app.css, built by Tailwind into renderer/vendor/
scripts/    build-assets.mjs (CSS + assets), package.mjs (standalone app)
test/       backend tests (temp repos + two bare remotes) and Electron UI tests (Playwright)
```

App data (repo list, settings, activity log, encrypted token) lives in Electron's user data folder; its location is shown under **Settings → About**.

## Note: design system dependency

`package.json` uses `"@foxtrot-sevima/karirkit": "file:../../SEVIMA/Foxtrot/design-system"`, a local link to the design system repo on this computer. Before cloning this repo on another machine (or using it in CI), replace it with a version from the package registry (for example `"^1.3.4"`, plus an `.npmrc` for the registry). The app produced by `npm run package` no longer needs this dependency, because the CSS, fonts, logo, and JS helpers are already copied into `renderer/`.

The design system's own UI text is still Indonesian in a few places (table pagination, toast close button). `scripts/build-assets.mjs` translates those strings in the copied files under `renderer/vendor/`, and prints a warning if the source text changes after a design system upgrade.

## Environment variables (for tests and debugging)

`HUB_USER_DATA` (data folder), `HUB_GH_BIN` (replace `gh`), `HUB_POLL_MS` (check polling interval), `HUB_GITLAB_TOKEN`, `HUB_PICK_FOLDER` (skip the folder picker dialog).
