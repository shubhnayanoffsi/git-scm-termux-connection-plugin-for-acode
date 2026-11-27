# AGENTS.md

Guidance for working in `~/termux-git-scm` (`git-scm-termux-connection-plugin-for-acode`).

## Workspace Layout

- `bridge/` — Zero-dependency ESM HTTP bridge (`server.mjs`), AXS + bridge launcher (`start-all.sh`), and Termux:Boot helper (`start-git-bridge.sh`).
- `plugin/` — Patched fork of `dikidjatar/acode-plugin-version-control-gitpro` (`plugin.json` id `local.termux.gitscm`, name `Git SCM (Termux)`).
- Runtime state outside the repo: `~/.config/termux-git-bridge/` (`token`, `bridge.pid`, `bridge.lock`, `bridge.log`) and `~/.termux/boot/start-git-bridge.sh`.
- Upstream docs (`plugin/readme.md`, `plugin/docs/`) still describe Acode's stock Alpine/Executor architecture; treat `bridge/server.mjs` and `plugin/src/` as the source of truth.

## Setup & Exact Commands (Termux vs Acode)

1. **Termux — Install deps & build plugin** (`node` fails to link `libicui18n.so.78` against `libicu` 79.1 and `/usr/bin/env` does not exist in Termux, so use `bun`):
   ```bash
   cd ~/termux-git-scm/plugin
   bun install
   bun run build
   ```
   - `bun install` blocks `@parcel/watcher` postinstall by default (harmless).
   - `bun run build` runs `bun ./node_modules/typescript/bin/tsc --noEmit && bun esbuild.config.mjs`, invoking `pack-zip.js` via `process.execPath` to output `plugin/dist/main.js`, `plugin/dist/main.css`, and `plugin/plugin.zip` (note: `pack-zip.js` writes `plugin.zip`, not `dist.zip`).
   - Clean build outputs: `cd ~/termux-git-scm/plugin && bun run clean`.
2. **Termux — Start & verify bridge**:
   - Interactive with AXS: `~/termux-git-scm/bridge/start-all.sh` (prefers `node` only if `node -e ""` exits 0, else `bun`; deduplicates via `flock` + `bridge.pid`; then `exec axs`).
   - Standalone background: `bun ~/termux-git-scm/bridge/server.mjs &` or `~/.termux/boot/start-git-bridge.sh`.
   - Install Termux:Boot hook: `mkdir -p ~/.termux/boot && cp ~/termux-git-scm/bridge/start-git-bridge.sh ~/.termux/boot/ && chmod +x ~/.termux/boot/start-git-bridge.sh`.
   - Health check + token printout:
     ```bash
     curl -fsS -H "X-Bridge-Token: $(cat ~/.config/termux-git-bridge/token)" http://127.0.0.1:8768/health
     cat ~/.config/termux-git-bridge/token
     ```
3. **Termux → Acode — Install & configure**:
   - Copy zip to shared storage in Termux: `cp ~/termux-git-scm/plugin/plugin.zip ~/storage/shared/Download/git-scm-termux.zip`
   - In **Acode**: **Settings → Plugins** → uninstall store `Git SCM` → **+ → LOCAL** → pick `Download/git-scm-termux.zip` → open **Git SCM (Termux)** settings → keep **Termux Bridge URL** at `http://127.0.0.1:8768`, paste token into **Termux Bridge Token** → restart Acode.
   - Delete temporary zips in Termux once installed in Acode: `rm -f ~/storage/shared/Download/git-scm-termux.zip ~/termux-git-scm/plugin/plugin.zip`.
4. **Verification check after editing `plugin/src/`**:
   ```bash
   grep -rn "Executor\|BackgroundExecutor\|Terminal\.isInstalled\|ALPINE_HOME\|acode\.plugin\.version\.control\.gitpro" ~/termux-git-scm/plugin/src/
   ```
   Must return zero matches.

## Bridge Architecture (`bridge/server.mjs`)

- Binds strictly to `127.0.0.1:8768` (`8767` is reserved for `axs`).
- Auth: loads or generates 32-byte hex secret at `~/.config/termux-git-bridge/token` (`chmod 600`), verified via `crypto.timingSafeEqual` on `X-Bridge-Token` for `GET /health` and `POST /git`.
- CORS: `OPTIONS` skips auth (`204`); all responses include `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Methods: GET, POST, OPTIONS`, `Access-Control-Allow-Headers: Content-Type, X-Bridge-Token`, and `Access-Control-Allow-Private-Network: true` (required by Acode's `https://localhost` WebView origin).
- Execution boundary: `POST /git` spawns ONLY `/data/data/com.termux/files/usr/bin/git` with `shell: false` and `GIT_TERMINAL_PROMPT=0`, capturing raw `Buffer`s into `{ stdoutBase64, stderrBase64, exitCode }`. Never add an arbitrary shell execution endpoint.
- `cwd` normalization strips `file://`, safely calls `decodeURIComponent`, maps `/sdcard` and `/data/(data|user/0)/com.termux/files/home/storage/shared` → `/storage/emulated/0`, and maps `/home` → `os.homedir()`.

## Plugin Architecture & Gotchas (`plugin/src/`)

- **Execution layer (`src/base/executor.ts`)**: Replaces Acode's `Executor` / `BackgroundExecutor` with `fetch()` calls to `GET /health` and `POST /git`, preserving the `Process`, `spawn()`, and `exec()` interfaces consumed by `src/git/*`.
- **Single-chunk stdout & parsers**: `BridgeProcess` decodes `stdoutBase64` with `TextDecoder('utf-8', { fatal: false })` (preserving `\0` bytes for `git status -z`) and emits `stdout` as one `'data'` event. Because upstream `Repository.parseIgnoreCheck()` (`src/git/repository.ts`) assumed line-by-line chunks, it must split on `/[\0\r\n]+/`.
- **Process lifecycle**: `BridgeProcess.start()` defers execution via `queueMicrotask()` so callers can attach listeners synchronously after `spawn()`. Callers like `GitRepository.getStatus()` (`src/git/git.ts`) only attach `'close'` (not `'error'`), so `BridgeProcess` emits `'stderr'` + `'close'` when no `'error'` listener exists.
- **`shellAppend: '/dev/null'`**: `Repository.getEmptyTree()` passes `{ shellAppend: '/dev/null' }` for `git hash-object -t tree`; `buildBridgeArgs()` maps this to trailing `'/dev/null'` argument without a shell.
- **Android UID isolation (`fs('file://...')`)**: Acode cannot read `/data/data/com.termux/...` via `file://`.
  - `GitRepository.getRepositoryDotGit()` (`src/git/git.ts`) queries `--is-bare-repository` via `git rev-parse`, never `fs('file://.../.git/config')`.
  - `getWorktrees()`, `getSubmodules()`, `isMergeInProgress()`, and `findKnownHugeFolderPathsToIgnore()` guard/fallback on `fs` errors so Termux-home repositories do not abort `Model.openRepository()` or `Repository.updateModelState()`.
- **Path alignment**: `uriToPath()` (`src/base/uri.ts`) and `Model.toAndroidRealPath()` (`src/git/model.ts`) mirror bridge shared-storage normalization (`/sdcard` ↔ `/storage/emulated/0`). `Git.addSafeDirectory()` passes `''` as `cwd` instead of nonexistent `/home`.
- **Android WebView picker (`src/git/hints.ts`)**: `InputHint` must call `e.stopImmediatePropagation()` and defer `dispose()` by 250ms (`blurTimeout`, cleared in `onSelect`) on `<input>` `blur`; synchronous `dispose()` on `blur` destroys `#git-palette` before `click` reaches `#hints` items (breaking `Choose Folder...` and branch/repo pickers).
- **Disabled IPC/Askpass**: `askpass.ts`, `gitEditor.ts`, and `ipc/ipcServer.ts` keep stubbed methods for type compatibility with `Model` and `api1.ts`, without touching `ALPINE_HOME` or FIFO pipes.
- **Startup script `flock` trap**: Both `bridge/start-all.sh` and `bridge/start-git-bridge.sh` must close fd `9` (`9>&-`) on the backgrounded server process so subsequent runs do not deadlock waiting on `flock`. Non-daemon tool subshells kill backgrounded children on exit; run the bridge via daemon mode or directly in Termux.
