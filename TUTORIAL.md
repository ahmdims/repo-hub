# Tutorial: Running Repo Hub and Connecting GitLab

A short guide from zero to a working GitLab (and GitHub) connection.

## 1. Run the app

**Use the packaged .exe** (no Node or npm required):

```
D:\Program Files\Documents\Me\repo-hub\dist\Repo Hub-win32-x64\repo-hub.exe
```

Double-click it. Do not move `repo-hub.exe` on its own: the entire `Repo Hub-win32-x64` folder has to travel with it. For quick access, create a shortcut to the `.exe`.

The `dist/` folder is listed in `.gitignore`, so the `.exe` does not appear in the repository. If it is missing or out of date, rebuild it:

```powershell
npm run package
```

Close the app before rebuilding, otherwise the build cannot overwrite the running `.exe`.

**Dev mode** (for working on the app itself):

```powershell
npm start
```

## 2. Connect GitHub

The app uses your `gh` (GitHub CLI) login and never stores a GitHub token.

1. Install [GitHub CLI](https://cli.github.com/) if you do not have it.
2. Run this once in a terminal:
   ```powershell
   gh auth login
   ```
3. In the app, open **Settings**. If the status has not changed, click **Check again**. When it works, you will see a green **Connected** badge with your GitHub username.

## 3. Connect GitLab

> **A token is optional.** If you cannot create one (for example, your role does not allow it), skip this section. Push, fetch, and mirroring still work through git with your normal git login. Only GitLab merge requests (list, approve, merge, create) need a token; without one the app shows them as "off" instead of as an error.

> **Order matters.** The GitLab card in Settings has **no host field**. The list of hosts is built automatically from the repos you have already added. If no repo with a GitLab remote has been added yet, you will only see *"No repos with GitLab yet. Add a repo that has a GitLab remote on the Repositories page."* So add a repo first (step 3.1), then enter the token (step 3.3).

### 3.1 Add a repo

1. Open **Repositories**.
2. Choose one of:
   - **Add from folder**: pick a single repo folder.
   - **Scan parent folder**: pick a folder that contains many repos, for example `D:\Program Files\Documents\SEVIMA\Foxtrot`, then tick the ones you want to manage.
3. The GitHub/GitLab remotes, default branch, and deploy branch are detected automatically from `git remote`. Review them, correct anything that is wrong, and save.

Once a repo with a GitLab remote is saved, its host (for example `gitlab.sevima.com`) appears under **Settings → GitLab**.

### 3.2 Create a Personal Access Token in GitLab

1. Sign in to `https://gitlab.sevima.com`.
2. Click your avatar → **Edit profile** → **Access tokens**, or go directly to `https://gitlab.sevima.com/-/user_settings/personal_access_tokens`.
3. Click **Add new token** and fill in:
   - **Token name:** `repo-hub`
   - **Expiration date:** per your policy (GitLab usually requires one)
   - **Scopes:** tick **`api`**
4. Click **Create personal access token**, then **copy the token** (it starts with `glpat-`). It is shown only once.

### 3.3 Paste the token into Repo Hub

1. Open **Settings → GitLab**.
2. On the card for `gitlab.sevima.com`, paste the token into the field **"Paste new token (glpat-…)"**.
3. Click **Save**. You should see the notification *"Token saved (encrypted)."*

The token is encrypted with Windows DPAPI and stored in the app's user data folder. It is never written to the **Activity** log.

### 3.4 Confirm the connection

The host card shows one of these states:

| What you see | What it means |
| --- | --- |
| Green badge **Connected: `<username>`** and *"Token from: app"* | Success. |
| Yellow badge **Needs token** | No token is saved yet. Repeat step 3.3. |
| Yellow badge **Token not working** | The token was rejected (wrong, expired, or scope is not `api`). Create a new token and save it again. |

To remove the token, click **Delete token** on the same card.

## 4. Other ways to provide the GitLab token (optional)

The app looks for a token in this order and uses the first one it finds:

1. **Environment variable** `HUB_GITLAB_TOKEN` or `GITLAB_TOKEN`. Useful when secure OS storage is unavailable. Set it in PowerShell, then restart the app:
   ```powershell
   [Environment]::SetEnvironmentVariable('GITLAB_TOKEN', 'glpat-xxxx', 'User')
   ```
2. **Token saved in the app** (step 3.3).
3. **Stored git credentials** from Git Credential Manager. This only works if the stored password is actually a *personal access token*, not your account password. You can turn this off with the checkbox under **Settings → GitLab** ("Try the stored git credential as a token when no token is set.").

## 5. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| *"No repos with GitLab yet…"* in Settings | No repo with a GitLab remote has been added. Do step 3.1. |
| *"GitLab rejected the token (401). Check the token in Settings > GitLab."* | The token is wrong or expired. Create a new one (3.2) and save it again (3.3). |
| *"GitLab token for … is not set (Settings > GitLab)."* | No token exists for that host yet. Do step 3.3. |
| The token field and **Save** button are disabled, with the warning *"Secure OS storage is not available; use the GITLAB_TOKEN environment variable."* | Use the `GITLAB_TOKEN` environment variable (section 4). |
| GitHub is not connected | Run `gh auth login`, then click **Check again**. |
| The app will not start from `dist/` | Make sure the whole `Repo Hub-win32-x64` folder is intact, or rebuild with `npm run package`. |

## 6. Where the app stores its data

```
C:\Users\<your-username>\AppData\Roaming\Repo Hub\
```

It contains `config.json` (repo list, settings, encrypted token) and `activity.json` (activity log). The exact location is also shown under **Settings → About**. Removing a repo entry in the app only deletes its record here, never the repo folder itself.
