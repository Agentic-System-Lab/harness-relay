# AGENTS.md

Guidance for coding agents (Claude Code, Codex, Grok and others) working in this repository. People should start with the [README](README.md), [CONTRIBUTING.md](CONTRIBUTING.md) and the [developer guide](docs/developer-guide.md).

## What this is

Harness Relay is a local web app: a group chat where the real `claude`, `codex` and `grok` CLIs work with the user and with each other.

- **Server**: Node.js ≥ 22.13, TypeScript, [Hono](https://hono.dev), run with `tsx` (no build step). It owns conversations, decides who speaks next, spawns the agent CLIs and stores everything in SQLite (`node:sqlite`). It never calls model APIs itself.
- **Client**: React 19 + Vite. It renders the chat and gets live updates over Server-Sent Events.

Read these before a larger change; they are kept up to date and go deeper than this file:

- [docs/architecture.md](docs/architecture.md): components, conversation model, turn scheduling, CLI adapters, approvals, workspaces, security, known limitations.
- [docs/developer-guide.md](docs/developer-guide.md): project layout, request flow, HTTP API, adding a CLI, database changes, prompts, translations, tests.

## Commands

| Command | What it does |
| --- | --- |
| `npm install` | Install dependencies |
| `npm run dev` | API server on :8789 (`tsx watch`) + Vite on :5173 (proxies `/api/`), off `npm start`'s and the desktop app's 8787 (`src/server/ports.ts`); not beside an `npm start` of the same checkout, which holds its `data/` |
| `npm run typecheck` | `tsc --noEmit` over `src`, `test`, `scripts`, `e2e` and the config files |
| `npm test` | All Vitest tests (offline) |
| `npx vitest test/store.test.ts` | One test file |
| `npm run test:e2e` | End-to-end tests (Playwright): the built UI in Chromium against the real server, with fake CLIs (`e2e/`); builds the UI first when it is out of date, also a development build of it (`dist/web-dev`, where React's StrictMode runs each effect twice) |
| `npm run test:e2e:install` | Once: the Chromium they drive (on Linux `npx playwright install --with-deps chromium`) |
| `npx playwright test e2e/specs/chat.spec.ts` | One end-to-end spec (`--ui` to watch them, `npx playwright show-report` for the last run) |
| `npm run build` | Build the UI into `dist/web` |
| `npm start` | One process: API + built UI on :8787; prints a one-time sign-in link |
| `npm run login` | Print another one-time sign-in link (`scripts/login.ts`) |
| `npm run site:preview` | Serve the landing page (`site/`) on 127.0.0.1:4180, as GitHub Pages will |
| `npm run icons` | Redraw the home-screen icons and the web app manifest in `src/web/public/` (`scripts/app-icons.ts`) |
| `npm install --prefix desktop` | Once, for the desktop app only: Electron and electron-builder (`desktop/` is a package of its own) |
| `npm run desktop` | Build the UI and the desktop app (`desktop/build/`) and run it without installing it |
| `npm run desktop:dist` | The same, then make the installer for this system in `desktop/release/` (`.dmg`, `.exe`, `.AppImage`; not signed); `npm run desktop:dist -- --output <folder>` puts it elsewhere |
| `npx tsx desktop/scripts/check-package.ts` | Check the packaged app in `desktop/release/` as a release is checked: its fuses, its resources and its own `--smoke-test` (on Linux, under `xvfb-run`) |
| `npm run desktop:typecheck` | Typecheck the desktop app (`desktop/tsconfig.json`) |
| `npm run release:next` | Today's next release and release candidate versions (from GitHub's tags) |
| `npm run release:check -- <version>` | Check a release version against the rules (`scripts/release.ts`), as the Release workflow does (add `--remote` after the version for GitHub's tags) |
| `npm run demo` | Record the README and landing-page demo again with the real CLIs, then update the videos, stills and chapter rails (`scripts/demo/`; see the developer guide, "Recording the demo") |

Before you commit, run `npm run typecheck`, `npm test` and `npm run build` (and `npm run desktop:typecheck` when you changed `desktop/`, and `npm run test:e2e` when you changed the UI, the HTTP API, the orchestrator or an adapter). CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs the same three on Node 22 and 24 (and on Windows with Node 24) for every pull request and every push to `main`, and also typechecks the desktop app, builds it and runs its bundled server as the app does (`desktop/scripts/smoke.ts`). [`.github/workflows/e2e.yml`](.github/workflows/e2e.yml) runs the end-to-end tests on Linux, macOS and Windows for the same events. Releases are made only by the Release workflow ([`.github/workflows/release.yml`](.github/workflows/release.yml)), run by hand: see the developer guide, "Releasing". Never make a release or a version tag any other way.

## Where things are

- `src/shared/`: code shared by server and client. `types.ts` (all shared types, `PROVIDERS`), `mentions.ts` (the `@mention` rule, and `unknownMentions`), `links.ts` (where a bare URL ends, also before Chinese text written right after it), `ask.ts` (`[ASK_USER]`), `media.ts`, `schedule.ts` (a schedule's next times), `search.ts`, `family.ts` (families of branched conversations: each one's parent and top, for the sidebar's tree and for moving a family between groups as one), `share.ts` (a shared page's placeholder links to the files that go along, in their own gist).
- `src/server/app.ts`: routes, security middleware, SSE (`createApp()`, testable with `app.request()`).
- `src/server/orchestrator.ts`: team runs: speakers by mode, prompt delivery, streaming into messages, auto team, the message queue, pausing for the user's answer, retry and resend.
- `src/server/prompt.ts` and `planner.ts`: agent briefings and turn prompts; the auto-team lead agent's prompt and reply parsing.
- `src/server/scheduler.ts`: sends each schedule's message when it comes due (missed times, busy retries), through `Orchestrator.sendScheduled()` (`sendInNewChat()` for a new chat each time; `designForSchedule()` has the lead agent design a schedule's team).
- `src/server/grouping.ts`: the lead agent sorts a new conversation into the user's sidebar groups.
- `src/server/agents/`: one adapter per CLI. `claude.ts` (stream-json), `codex.ts` (`codex app-server`), `grok.ts` (ACP), `acp.ts` (the JSON-RPC peer), `index.ts` (registry).
- `src/server/db.ts`, `store.ts`, `settings.ts`, `secrets.ts`: SQLite and migrations (and the lock one server holds its data folder with, `lockDataDir`), persistence, provider settings, each CLI's accounts (a home and an API key of their own; agents and the lead agent name theirs) and child-process env (including the CLIs' own homes), API keys in the OS keyring.
- `src/server/config.ts`: what the environment sets at startup besides the port, host and data folder (accounts per CLI, team size, the turn timeout, voice input's download folders and folder), checked once; the server refuses to start on a value that is not valid. The UI gets the limits from `GET /api/limits` (`src/web/limits.ts`, `useLimits()`), never from constants of its own.
- `src/server/agentsview.ts`: sends each conversation to AgentsView as one thread and links the agents' own sessions under it.
- `src/server/workspace.ts`: git: auto init, snapshots, worktrees, diffs, apply.
- `src/server/process.ts`: spawning, streaming and killing child processes.
- `src/server/parent.ts`: the desktop app that started the server, if any (Electron's `parentPort`): the server says when it listens, the app asks it for sign-in links, how many conversations have agents at work (`Orchestrator.busy()`, which an update waits on), and to shut down, and tells it its updates. `updates.ts` keeps those for the chat (`GET /api/update`) and passes the chat's asks (check now, update) back to the app.
- `desktop/`: the desktop app (Electron), a package of its own. `src/main.ts` (the chat's window, the tray menu, updates, its own check `--smoke-test`, and the app's life; the only file that imports `electron`), `supervisor.ts` (starting, watching and stopping the server, and asking it for sign-in links and how many conversations have agents at work), `env.ts` (the login shell's environment, Windows' at a restart, the server's), `tailscale.ts`, `autostart.ts` (open at login on Linux), `prefs.ts`, `profile.ts` (the window's browser folder, kept from agents), `log.ts` (the server's log), `update.ts` (updates to GitHub's newest release, a release candidate only for an app that is one, for this system's processor, switching once no conversation has agents at work), `traymenu.ts` (the tray menu while it is open: changed in place and opened again to show what changed, and a moment after it closed), `selftest.ts` (what the app needs of the server over HTTP), `manifest.ts` (the app folder's `package.json`), `i18n.ts`, `icons.ts`, `lifecycle.ts` (its decisions without Electron, the window's guards); `scripts/build.ts` bundles the server and the app into `desktop/build/` (as `RELAY_VERSION` for a release, else a `-dev` build of the day); `scripts/smoke.ts` runs the bundled server as the app does, with `scripts/parent-port.mjs` standing in for Electron's `parentPort`; `scripts/dist.ts` is `npm run desktop:dist`; `scripts/check-package.ts` (with `scripts/packaged.ts`) checks the packaged app; `electron-builder.yml` makes the installers, with `entitlements.mac.plist` and `macos/` (the microphone's reason in each language).
- `scripts/release.ts`: the release version rules (dates: `YYYY-MM-DD`, `.N` patches, `-rc` after either for a release candidate of it and `-rc.N` for its patches; today in Taiwan; the next one only), used by `npm run release:next`, `npm run release:check` and the Release workflow.
- `src/server/tools.ts`: the tool library: MCP servers (their secret values in the OS keyring, by server id), skills and memory, and what each agent gets from it.
- `src/server/native.ts`, `grokTrust.ts`: what each CLI loads by itself (asked without a prompt); recording Grok's trust in a project root.
- `src/server/files.ts`: browsing a chat's working directory and agents' worktrees (inside the folder only, never `.git`), and what a folder's ZIP download holds; `zip.ts` writes that ZIP file as it is sent.
- `src/server/protect.ts`: what agents below full access may not reach (the browsers' folders, the database; Harness Relay's own folder in edit mode), handed to each CLI's sandbox by its adapter.
- `src/server/auth.ts`: signed-in browsers (one-time codes, sessions of a cookie and a key, hashes only); `src/shared/auth.ts` and `src/web/auth.ts` hold the parts the UI shares.
- `src/server/folderPicker.ts`: the system's own folder dialog for the working directories box (`POST /api/cwds/pick`): which one this computer has (AppleScript, zenity / kdialog, Windows PowerShell), its command and its answer.
- `src/server/share.ts`: a shared conversation as a secret gist through the user's own `gh` (create, delete; read on gistpreview.github.io), and the files its replies link to, of any kind, pushed with git into a second one. The page itself is made in the browser from the chat on screen (`src/web/sharePage.tsx`; its DOM-free parts in `src/web/share.ts`).
- `src/server/about.ts`: which Harness Relay this is and on what, for a problem report (`GET /api/about`; the desktop app's server bundle sets `__RELAY_VERSION__`). `screenshots.ts`: a problem report's screenshots, checked to be images and uploaded as a secret gist through the user's `gh` (`filesToGist()` in `share.ts`), for the mail to link to.
- `src/server/i18n.ts`, `presets.ts`: server-side messages and built-in team templates, both in two languages.
- `src/web/`: the React client. `components/`, `locales/` (`zh-TW.ts`, `en.ts`), `chat.ts` (ChatView's pure logic), `copy.ts`, `signin.ts` (signing in with a link: the page's first check, shared by both runs of App's effect in development; following another tab's sign-in; where the sign-in page points), `report.ts` (a problem report by email: the mail, its mailto and Gmail links, the screenshots it may link to), `update.ts` (the desktop app's updates in the chat: Settings' Version card, the dialog offering a new version once; and reloading a page open across an update), `dialogs.ts` (the dialogs open on the page: only the top one takes keys), `api.ts`, `public/` (the web app manifest and home-screen icons, written by `npm run icons`; don't edit them by hand).
- `test/`: Vitest tests, roughly one file per module.
- `e2e/`: end-to-end tests (Playwright, `playwright.config.ts`). `fake-cli/fake-cli.cjs` is a fake `claude`, `codex` and `grok` in one file, speaking each CLI's protocol and steered by `e2e:` directives in the user's message (scripts on macOS and Linux, Node single executables on Windows: `support/fake-cli.ts`); `support/relay.ts` starts a server of its own for each test (temporary data, homes and working directory, the fakes first on PATH, keyring off); `support/app.ts` holds the UI steps; `global-setup.ts` builds the UI and a development build of it (`DEV_WEB_DIR` in `support/paths.ts`, for a spec to serve); `specs/` the tests.
- `data/`: runtime data (`relay.db`, worktrees). Git-ignored; never commit it.
- `.github/`: the workflows, the issue forms (`ISSUE_TEMPLATE/`) and the pull request template, each form and the template in both languages. The bug form's CLI, mode and permission options follow `PROVIDER_LABEL` and the locales' labels (`test/community.test.ts`).
- `CODE_OF_CONDUCT.md`, `SECURITY.md`: the code of conduct (reports by email, to `REPORT_EMAIL` in `src/web/report.ts`), and where to report a vulnerability and what counts as one; each with its `.zh-TW.md`.
- `site/`: the landing page on GitHub Pages (static HTML, `index.html` and `zh-TW/index.html`), published by `.github/workflows/pages.yml`. Follow `site/DESIGN-GUIDELINES.md` when you change it, and change both languages together. `site/assets/downloads.js` points the download buttons at the newest release's installers, never a release candidate's (tested in `test/site-downloads.test.ts`); keep its file name endings (`INSTALLERS`, which the app's updates and the Release workflow's installer check also read) in step with the Release workflow's installer names. `UPDATE_INSTALLERS` names the copies the workflow publishes beside them (`updateCopyName()`), which the app downloads to update itself, so that GitHub's download counts tell updates from new installs.

## Rules

### Code

- Strict TypeScript, ES modules. Shared types live only in `src/shared/types.ts`.
- Spawn child processes only through `src/server/process.ts`, so they are tracked and killed on shutdown. Start programs directly, never through a shell; a shell script (`runShellScript()`, or `sh -c` given to `spawnDetached()`) is fixed text, and the values it needs (paths, names, settings) go in its environment, never in its text or its arguments.
- Keep CLI output parsers pure (lines in, `AgentEvent`s out) so they can be tested with recorded output.
- Tests run in a Node environment without a DOM. Put client logic you want to test in plain modules (like `src/web/chat.ts` and `src/web/copy.ts`), not inside components.
- `node:sqlite` cannot bind `undefined`: pass optional values through `nul()`, and wrap multi-statement writes in `transaction(db, fn)` (it doesn't nest).

### Security

The server can start agents with write access, so keep its defences intact (see [Architecture → Security](docs/architecture.md#security)):

- New routes go under `/api/` so they get the middleware's Host/Origin checks, the JSON content-type check on writes, sign-in and the request language. Don't weaken these checks. Only a read-only route the browser loads by itself (an `<img>`, a download link) may join `BROWSER_LOADS` in `app.ts`, which takes the cookie without the key.
- Never send secrets to the client (`SettingsView` returns masked keys only). API keys belong in the OS credential store (`secrets.ts`), not in the database.
- The server binds to `127.0.0.1`. Agent replies cannot make the browser load remote content (images are links; local media goes through the media endpoint's path checks). Keep it that way.

### Database

- To change the schema, append a new SQL string to `MIGRATIONS` in `src/server/db.ts`. Never edit a migration that has been released.
- Update the row types and queries in `store.ts` / `settings.ts`, and the tests in `test/store.test.ts`.

### Prompts and languages

- Prompts to agents (briefings, turn prompts, the planner prompt) stay in English; agents answer in the user's language.
- Every user-facing string exists in Traditional Chinese (`zh-TW`) and English (`en`):
  - **UI**: add the key to `src/web/locales/zh-TW.ts` first (it defines the `Messages` shape), then to `en.ts`. `test/i18n.test.ts` checks that both have the same shape.
  - **Server**: add both translations in `src/server/i18n.ts` and call `t()` where the text is produced. Don't cache translated text in long-lived objects; the language follows the request.
  - **Built-in templates**: `src/server/presets.ts`, in both languages.

### Documentation

- Docs come in pairs: `README.md` / `README.zh-TW.md`, `CONTRIBUTING.md` / `CONTRIBUTING.zh-TW.md`, `CODE_OF_CONDUCT.md` / `CODE_OF_CONDUCT.zh-TW.md`, `SECURITY.md` / `SECURITY.zh-TW.md` and `docs/<name>.md` / `docs/<name>.zh-TW.md`. When a change affects behaviour, the HTTP API, the schema, settings, environment variables or the test list, update both languages in the same commit.
- The developer guide lists the HTTP API and what each test file covers; keep those lists current.
- `CONTRIBUTING.md` restates the rules in this file for people. When you change a rule here that applies to everyone, change it there too, in both languages.

### Tests

- Add or update tests with every behaviour change.
- Keep tests offline: no real CLI runs, no network, no real credential store. Follow the existing patterns: a fake runner swapped into `runners` (`test/orchestrator.test.ts`), recorded CLI messages for adapters, real temporary git repositories for `workspace.ts`, `app.request()` for the HTTP API, and a fake keyring passed to `SettingsStore`. End-to-end tests use the fake CLIs (`e2e/fake-cli/`): something new an agent should do there is a new `e2e:` directive in the fake, not a real CLI.
- Keep tests passing on Windows too (CI runs them there): paths built with `join()` / `resolve()`, not POSIX literals; what only macOS or Linux have (permission bits, signals, `/bin/sh`, stand-in CLIs started by their `#!` line) skipped with `skipIf(process.platform === 'win32')`; time limits from `test/timeouts.ts`. See the developer guide, "Testing".

### Worktrees

- If you work in a separate git worktree, put it inside this repository, in your own CLI's folder at the root: Claude Code in `.claude/worktrees/<name>`, Codex in `.codex/worktrees/<name>`, Grok in `.grok/worktrees/<name>`. Any other agent uses `.<agent>/worktrees/<name>` the same way. For example: `git worktree add .codex/worktrees/fix-links -b fix-links`.
- Don't create worktrees next to the repository (such as `../harness-relay-<branch>`) or anywhere else outside it. Remove one with `git worktree remove` when you are done.
- `.gitignore` ignores these folders. If you add a folder for another agent, add it to `.gitignore` in the same commit.
- A new worktree has no `node_modules/`; run `npm install` in it before the commands above.
- These are your own worktrees for changing this code. They are separate from the worktrees the app makes for parallel mode under `data/`.

### Commits

- Write commit messages in English. The subject is an imperative sentence about what the user gets, for example `Let agents ask the user before answering, and wait for the answer`.
- In the body, use short bullet points, grouped under headings when a commit spans several areas: what changed and why, any schema version bump, and which docs and locales were updated.

## Gotchas

- `npm run dev` restarts the server on every server file change, and a restart aborts any running agent turn.
- One server per data folder (`data/server.lock`, `lockDataDir()` in `src/server/db.ts`): a second one on the same folder (`npm run dev` beside an `npm start` of the same checkout, say) refuses to start. Give it another with `RELAY_DATA_DIR`.
- Harness Relay refuses edit mode in a working directory that holds itself (`src/server/protect.ts`). To work on this repository with Harness Relay, run the copy you use from another checkout.
- `desktop/` has its own `package.json` and lockfile, so a root `npm install` never downloads Electron. Its pure modules are tested from the root `test/` (`desktop-*.test.ts`); keep `electron` imports in `desktop/src/main.ts` only.
- `npm run desktop:dist` refuses to start while a Harness Relay runs from `desktop/release/` (it would replace the files under it): quit it first, or build with `-- --output <folder>`. Opening a new build while another Harness Relay runs only brings the running one forward.
- electron-builder leaves out a `node_modules` folder at the top of an `extraResources` folder, so the keyring module the server needs is listed as an entry of its own in `desktop/electron-builder.yml`.
- The desktop app passes the server its own environment (`desktop/src/env.ts`): `PORT` and `HOST` from the user's shell are ignored, and `RELAY_WEB_DIR` points at the app's copy of the UI.
- You can run Harness Relay from inside a Claude Code session: the server strips Claude Code's nesting variables (`CLAUDECODE`, `CLAUDE_CODE_*`) before it spawns `claude` (`src/server/settings.ts`).
- The Vite proxy key is `/api/` with a trailing slash on purpose: a bare `/api` would also capture the client module `/api.ts`.
- Worktrees in parallel mode contain only what is in the snapshot, so ignored files such as `node_modules/` are missing there.
- Kept snapshot refs live under `refs/harness-relay/…`, and parallel-mode branches under `relay/*`. They belong to the app; don't delete them by hand while it runs.
