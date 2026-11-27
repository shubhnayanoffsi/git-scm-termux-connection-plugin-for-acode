# Git SCM Termux Connection Plugin for Acode

Bridges Acode's Git SCM plugin directly to Termux's native `git` binary over an authenticated local HTTP bridge (`127.0.0.1:8768`), removing all dependency on Acode's built-in Alpine terminal and `Executor` API while running cleanly alongside `axs` on port `8767`.

## Architecture

```text
Acode WebView (https://localhost)
  └─ Git SCM (Termux) plugin [local.termux.gitscm]
       └─ fetch() + X-Bridge-Token ──▶ http://127.0.0.1:8768
                                         └─ Termux Git Bridge (bridge/server.mjs)
                                              └─ spawn(/data/data/com.termux/files/usr/bin/git, shell: false)
```

- **`./bridge/`**: Zero-dependency HTTP bridge (`server.mjs`), launcher with PID lock (`start-all.sh`), and Termux:Boot hook (`start-git-bridge.sh`).
- **`./plugin/`**: Patched fork of [acode-plugin-version-control-gitpro](https://github.com/dikidjatar/acode-plugin-version-control-gitpro) (`id`: `local.termux.gitscm`, `name`: `Git SCM (Termux)`).

## Prerequisites

Run in **Termux**:

- Termux `git` installed (`/data/data/com.termux/files/usr/bin/git`):
  ```bash
  pkg install git
  ```
- **Bun** (`bun`) or a working **Node.js** runtime (`bun` is used when `node` cannot link).
- Shared storage permission granted in Termux (if copying build `.zip` to `Download`):
  ```bash
  termux-setup-storage
  ```
- **Acode** editor on Android (and **AXS** on `127.0.0.1:8767` if used).

## Step-by-Step Setup

### 1. Clone & Build the Plugin (Run in Termux)

```bash
git clone https://github.com/shubhnayanoffsi/git-scm-termux-connection-plugin-for-acode.git ~/termux-git-scm
cd ~/termux-git-scm/plugin
bun install
bun run build
```

This typechecks (`tsc --noEmit`), bundles `dist/main.js` and `dist/main.css` with `esbuild`, and creates `~/termux-git-scm/plugin/plugin.zip`.

Copy the zip to Android shared storage so Acode's file picker can select it:

```bash
cp ~/termux-git-scm/plugin/plugin.zip ~/storage/shared/Download/git-scm-termux.zip
```

### 2. Start the Termux Git Bridge (Run in Termux)

Start the bridge and launch AXS together (uses an `flock` + PID lock so the bridge never duplicates):

```bash
chmod +x ~/termux-git-scm/bridge/start-all.sh ~/termux-git-scm/bridge/start-git-bridge.sh
~/termux-git-scm/bridge/start-all.sh
```

Or run the bridge alone in the background:

```bash
bun ~/termux-git-scm/bridge/server.mjs &
```

**(Optional) Auto-start on device boot with Termux:Boot (Run in Termux):**

```bash
mkdir -p ~/.termux/boot
cp ~/termux-git-scm/bridge/start-git-bridge.sh ~/.termux/boot/start-git-bridge.sh
chmod +x ~/.termux/boot/start-git-bridge.sh
```

Verify the bridge is live and read your auth token (auto-generated with `chmod 600` at `~/.config/termux-git-bridge/token`):

```bash
curl -fsS -H "X-Bridge-Token: $(cat ~/.config/termux-git-bridge/token)" http://127.0.0.1:8768/health
cat ~/.config/termux-git-bridge/token
```

Expected `/health` output includes `"ok":true` and `"git":"git version ..."`.

### 3. Install & Configure the Plugin (Do in Acode)

1. Open **Acode** → **Settings** → **Plugins**.
2. Uninstall the Play/Plugin Store **Git SCM** plugin if installed (prevents conflicts).
3. Tap **+** → **LOCAL** and select `Download/git-scm-termux.zip`.
4. Open **Settings** → **Plugins** → **Git SCM (Termux)** (tap the plugin card to open its settings).
5. Verify **Termux Bridge URL** is `http://127.0.0.1:8768`.
6. Tap **Termux Bridge Token**, paste the 64-character hex token printed by `cat ~/.config/termux-git-bridge/token`, and tap **OK**.
7. Restart **Acode** completely.

### 4. Clean Up Temporary `.zip` Files (Run in Termux)

Once **Git SCM (Termux)** is installed in Acode (Acode extracts plugins internally), the `.zip` files are no longer needed:

```bash
rm -f ~/storage/shared/Download/git-scm-termux.zip ~/termux-git-scm/plugin/plugin.zip
```

### 5. Post-Setup: Shared Storage & Remotes (Acode + Termux)

- **Shared storage `safe.directory`**: Repositories in `/storage/emulated/0/...` (`/sdcard/...`) trigger Git's `dubious ownership` check. Tap **Manage Unsafe Repositories** in Acode's Source Control sidebar, or trust the repo in **Termux**:
  ```bash
  git config --global --add safe.directory /storage/emulated/0/path/to/repo
  ```
- **GitHub / Remote authentication**: Alpine's askpass/IPC named-pipe scripts are disabled. Configure SSH keys (`~/.ssh`) or Git credential helpers (`gh auth login` / `git config --global credential.helper store`) directly in **Termux**.

## Bridge HTTP API

All non-`OPTIONS` requests require the `X-Bridge-Token` header. CORS headers (including `Access-Control-Allow-Private-Network: true` for Acode's `https://localhost` WebView origin) are sent on every response.

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/health` | `GET` | Runs `git --version` and returns `{ ok, git, version, gitPath, home }`. |
| `/git` | `POST` | Accepts `{ args, cwd?, stdinBase64?, env? }`; spawns `/data/data/com.termux/files/usr/bin/git` with `shell: false` and returns `{ stdoutBase64, stderrBase64, exitCode }`, preserving null bytes (`git status -z`) and binary diffs. |

## Credits

Patched from [acode-plugin-version-control-gitpro](https://github.com/dikidjatar/acode-plugin-version-control-gitpro) by Diki Djatar (MIT License).
