**English** | [繁體中文](README.zh-TW.md)

# Desktop app

The Harness Relay desktop app (Electron) for macOS, Windows and Linux: the same server `npm start` runs, started in the background, with the chat in a window of its own and a tray menu. People install it from the [website](https://agentic-system-lab.github.io/harness-relay/) or [Releases](https://github.com/Agentic-System-Lab/harness-relay/releases); how to use it is in the [user guide](../docs/user-guide.md#desktop-app).

This page is for working on it. The details are in the developer guide, [The desktop app](../docs/developer-guide.md#the-desktop-app), and the design in the architecture, [Desktop app](../docs/architecture.md#desktop-app).

## A package of its own

`desktop/` has its own `package.json` and lockfile, so a root `npm install` never downloads Electron (about 100 MB) for people who use `npm start`. It uses the root's `tsx` and `typescript`, so install the root first:

```bash
npm install                      # the root, once
npm install --prefix desktop     # Electron, electron-builder and esbuild, once
```

## Commands

Run them from the repository's root.

| Command | What it does |
| --- | --- |
| `npm run desktop` | Build the UI and the app (`desktop/build/`) and run it without installing it |
| `npm run desktop:dist` | The same, then make the installer for this system in `desktop/release/` (`.dmg`, `.exe`, `.AppImage`; not signed for distribution); `-- --output <folder>` puts it elsewhere |
| `npm run desktop:typecheck` | Typecheck the app (`desktop/tsconfig.json`) |
| `npx tsx desktop/scripts/smoke.ts` | Run the bundled server the way the app does, with plain Node standing in for Electron, and check what the app needs of it, a question answered by the e2e fake CLIs included |
| `npx tsx desktop/scripts/check-package.ts` | Check the packaged app in `desktop/release/` as a release is checked: its fuses, its resources, no `github_pat_` token in the server's files nor as text in the app's, the repository and the token (encoded) that `RELAY_UPDATES_REPO` and `RELAY_UPDATES_TOKEN` name in its own environment (give it the build's), and its own `--smoke-test`, in which the e2e fake CLIs answer a question (on Linux, under `xvfb-run`) |

`npm run desktop:dist` refuses to start while a Harness Relay runs from `desktop/release/`: quit it first, or build with `-- --output <folder>`. To try a build apart from your own data, see "To try it apart from your own data" in the [developer guide](../docs/developer-guide.md#the-desktop-app).

## What is where

```
src/main.ts          the window, the tray menu, updates, its own check (--smoke-test) and the app's life;
                     the only file that imports electron
src/supervisor.ts    starting, watching and stopping the server; sign-in links and how many conversations
                     have agents at work
src/env.ts           the login shell's environment (Windows': at a restart), and the server's
src/selftest.ts      what the app needs of the server over HTTP (smoke.ts and --smoke-test)
src/update.ts        updates to GitHub's newest release, switching once no conversation has agents at work
src/updateSource.ts  where the app downloads its updates from (RELAY_UPDATES_REPO, RELAY_UPDATES_TOKEN at build time),
                     and the Release workflow's checks that the installers were built with them and that an app
                     can download the copies
src/traymenu.ts      the tray menu while it is open
src/lifecycle.ts     its decisions without Electron, and the window's guards
src/tailscale.ts     sharing with the tailnet (tailscale serve)
src/autostart.ts     open at login on Linux
src/prefs.ts         desktop.json: the port, the window's size, the tailnet name
src/profile.ts       the window's browser folder, kept from agents
src/log.ts           the server's log
src/manifest.ts      the app folder's package.json
src/i18n.ts          the menu's and dialogs' words, in both languages
src/icons.ts         the tray icons
scripts/build.ts     bundles the server and the app into build/ (RELAY_VERSION for a release, else a -dev build;
                     RELAY_UPDATES_REPO and RELAY_UPDATES_TOKEN for where it downloads its updates; it writes
                     build/update-source.txt, their fingerprint, for the Release workflow)
scripts/dist.ts      npm run desktop:dist (electron-builder)
scripts/smoke.ts     the bundled server run as the app runs it; parent-port.mjs stands in for Electron's parentPort
scripts/check-package.ts, scripts/packaged.ts   the packaged app's checks
electron-builder.yml the installers; entitlements.mac.plist and macos/ (the microphone's reason in each language)
```

The server's side of the app is `src/server/parent.ts` (the messages over Electron's `parentPort`: listening, sign-in links, busy, shut down, updates) and `src/server/updates.ts` (updates in the chat).

## Tests and checks

- **Unit tests.** Everything here but `main.ts` runs without Electron and is tested from the root `test/` with the rest (`npm test`): `desktop-app.test.ts`, `desktop-env.test.ts`, `desktop-supervisor.test.ts`, `desktop-tailscale.test.ts`, `desktop-traymenu.test.ts`, `desktop-update.test.ts`, and `parent.test.ts` for the server's side. Keep `electron` imports in `main.ts` only, so they can be.
- **The bundled server** (`scripts/smoke.ts`) and **the packaged app** (`scripts/check-package.ts`, which runs the app's own `--smoke-test`). In both, a team of the end-to-end tests' fake `claude`, `codex` and `grok` ([`e2e/fake-cli/`](../e2e/fake-cli/)) answers a question, so the server finds each CLI, speaks its protocol and streams the reply; the real CLIs are never started. CI ([`ci.yml`](../.github/workflows/ci.yml)) typechecks the app, builds it, runs `smoke.ts`, and packages it for Linux and Windows, with a made-up token for its updates, and runs `check-package.ts`; the [Release workflow](../.github/workflows/release.yml) runs both on each system before it publishes. The Release workflow also checks the app's updates: first, in a job of its own, that the read token is not the write token, with a warning when both belong to one account or GitHub does not say whose they are; before anything is installed, the update source (the repository's name, a fine-grained read token, and that an app built with them could read the repository); before the copies are published, that every installer was built with this run's repository and token (their fingerprints); and after, that an app can download the copies. What each checks is in the [developer guide](../docs/developer-guide.md#the-desktop-app).
- Run `npm run desktop:typecheck` before you commit a change here (see [AGENTS.md](../AGENTS.md)).

## Releases and updates

Releases are made only by the Release workflow, run by hand: it builds the installers for macOS (Apple Silicon), Windows and Linux (x64 and Arm64), checks them and publishes them, and a copy of each for the app's updates in a repository of their own. See [Releasing](../docs/developer-guide.md#releasing). The app updates itself to the newest release ([user guide](../docs/user-guide.md#versions)), downloading its copy from `Agentic-System-Lab/harness-relay-updates`, or the repository `RELAY_UPDATES_REPO` names when it is built, with the token `RELAY_UPDATES_TOKEN` gives for a private one (it goes into the app, where anyone can read it), and the installer itself where the copy cannot be had; see [the desktop app](../docs/developer-guide.md#the-desktop-app) and, for the workflow's `UPDATES_REPO` variable and `UPDATES_READ_TOKEN` secret, [Releasing](../docs/developer-guide.md#releasing). The installers' names must stay in step with `site/assets/downloads.js` (`INSTALLERS`, `UPDATE_INSTALLERS`).

## Related docs

- [User guide → Desktop app](../docs/user-guide.md#desktop-app): installing it, the window, the tray menu, updates and troubleshooting.
- [Developer guide → The desktop app](../docs/developer-guide.md#the-desktop-app): how it runs, building, the checks, fuses, signing and the installers.
- [Architecture → Desktop app](../docs/architecture.md#desktop-app): the process, signing in, the environment, the tailnet, the window and updates.
- [Developer guide → Releasing](../docs/developer-guide.md#releasing): the Release workflow and the version rules.
- [Use it from your phone → With the desktop app](../docs/remote-access.md#with-the-desktop-app): sharing with the tailnet from the tray menu.
- [OS sandboxes by platform](../docs/sandboxing.md) and [Architecture → Security](../docs/architecture.md#security): what agents may not read, the window's sign-in included.
- [Contributing](../CONTRIBUTING.md) and [AGENTS.md](../AGENTS.md): the rules for every change.
