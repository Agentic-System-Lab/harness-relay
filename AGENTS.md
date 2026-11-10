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
| `npm run dev` | API server on :8787 (`tsx watch`) + Vite on :5173 (proxies `/api/`) |
| `npm run typecheck` | `tsc --noEmit` over `src`, `test`, `scripts` and the config files |
| `npm test` | All Vitest tests (offline) |
| `npx vitest test/store.test.ts` | One test file |
| `npm run build` | Build the UI into `dist/web` |
| `npm start` | One process: API + built UI on :8787; prints a one-time sign-in link |
| `npm run login` | Print another one-time sign-in link (`scripts/login.ts`) |
| `npm run site:preview` | Serve the landing page (`site/`) on 127.0.0.1:4180, as GitHub Pages will |
| `npm run icons` | Redraw the home-screen icons and the web app manifest in `src/web/public/` (`scripts/app-icons.ts`) |
| `npm run demo` | Record the README and landing-page demo again with the real CLIs, then update the videos, stills and chapter rails (`scripts/demo/`; see the developer guide, "Recording the demo") |

Before you commit, run `npm run typecheck`, `npm test` and `npm run build`. CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs the same three on Node 22 and 24 for every pull request and every push to `main`.

## Where things are

- `src/shared/`: code shared by server and client. `types.ts` (all shared types, `PROVIDERS`), `mentions.ts` (the `@mention` rule, and `unknownMentions`), `links.ts` (where a bare URL ends, also before Chinese text written right after it), `ask.ts` (`[ASK_USER]`), `media.ts`, `schedule.ts` (a schedule's next times), `search.ts`, `family.ts` (families of branched conversations: each one's parent and top, for the sidebar's tree and for moving a family between groups as one), `share.ts` (a shared page's placeholder links to the files that go along, in their own gist).
- `src/server/app.ts`: routes, security middleware, SSE (`createApp()`, testable with `app.request()`).
- `src/server/orchestrator.ts`: team runs: speakers by mode, prompt delivery, streaming into messages, auto team, the message queue, pausing for the user's answer, retry and resend.
- `src/server/prompt.ts` and `planner.ts`: agent briefings and turn prompts; the auto-team lead agent's prompt and reply parsing.
- `src/server/scheduler.ts`: sends each schedule's message when it comes due (missed times, busy retries), through `Orchestrator.sendScheduled()` (`sendInNewChat()` for a new chat each time; `designForSchedule()` has the lead agent design a schedule's team).
- `src/server/grouping.ts`: the lead agent sorts a new conversation into the user's sidebar groups.
- `src/server/agents/`: one adapter per CLI. `claude.ts` (stream-json), `codex.ts` (`codex app-server`), `grok.ts` (ACP), `acp.ts` (the JSON-RPC peer), `index.ts` (registry).
- `src/server/db.ts`, `store.ts`, `settings.ts`, `secrets.ts`: SQLite and migrations, persistence, provider settings and child-process env (including the CLIs' own homes), API keys in the OS keyring.
- `src/server/agentsview.ts`: sends each conversation to AgentsView as one thread and links the agents' own sessions under it.
- `src/server/workspace.ts`: git: auto init, snapshots, worktrees, diffs, apply.
- `src/server/process.ts`: spawning, streaming and killing child processes.
- `src/server/tools.ts`: the tool library: MCP servers (their secret values in the OS keyring, by server id), skills and memory, and what each agent gets from it.
- `src/server/native.ts`, `grokTrust.ts`: what each CLI loads by itself (asked without a prompt); recording Grok's trust in a project root.
- `src/server/files.ts`: browsing a chat's working directory and agents' worktrees (inside the folder only, never `.git`), and what a folder's ZIP download holds; `zip.ts` writes that ZIP file as it is sent.
- `src/server/auth.ts`: signed-in browsers (one-time codes, sessions of a cookie and a key, hashes only); `src/shared/auth.ts` and `src/web/auth.ts` hold the parts the UI shares.
- `src/server/share.ts`: a shared conversation as a secret gist through the user's own `gh` (create, delete; read on gistpreview.github.io), and the files its replies link to, of any kind, pushed with git into a second one. The page itself is made in the browser from the chat on screen (`src/web/sharePage.tsx`; its DOM-free parts in `src/web/share.ts`).
- `src/server/i18n.ts`, `presets.ts`: server-side messages and built-in team templates, both in two languages.
- `src/web/`: the React client. `components/`, `locales/` (`zh-TW.ts`, `en.ts`), `chat.ts` (ChatView's pure logic), `copy.ts`, `api.ts`, `public/` (the web app manifest and home-screen icons, written by `npm run icons`; don't edit them by hand).
- `test/`: Vitest tests, roughly one file per module.
- `data/`: runtime data (`relay.db`, worktrees). Git-ignored; never commit it.
- `site/`: the landing page on GitHub Pages (static HTML, `index.html` and `zh-TW/index.html`), published by `.github/workflows/pages.yml`. Follow `site/DESIGN-GUIDELINES.md` when you change it, and change both languages together.

## Rules

### Code

- Strict TypeScript, ES modules. Shared types live only in `src/shared/types.ts`.
- Spawn child processes only through `src/server/process.ts`, so they are tracked and killed on shutdown.
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

- Docs come in pairs: `README.md` / `README.zh-TW.md`, `CONTRIBUTING.md` / `CONTRIBUTING.zh-TW.md` and `docs/<name>.md` / `docs/<name>.zh-TW.md`. When a change affects behaviour, the HTTP API, the schema, settings, environment variables or the test list, update both languages in the same commit.
- The developer guide lists the HTTP API and what each test file covers; keep those lists current.
- `CONTRIBUTING.md` restates the rules in this file for people. When you change a rule here that applies to everyone, change it there too, in both languages.

### Tests

- Add or update tests with every behaviour change.
- Keep tests offline: no real CLI runs, no network, no real credential store. Follow the existing patterns: a fake runner swapped into `runners` (`test/orchestrator.test.ts`), recorded CLI messages for adapters, real temporary git repositories for `workspace.ts`, `app.request()` for the HTTP API, and a fake keyring passed to `SettingsStore`.

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
- You can run Harness Relay from inside a Claude Code session: the server strips Claude Code's nesting variables (`CLAUDECODE`, `CLAUDE_CODE_*`) before it spawns `claude` (`src/server/settings.ts`).
- The Vite proxy key is `/api/` with a trailing slash on purpose: a bare `/api` would also capture the client module `/api.ts`.
- Worktrees in parallel mode contain only what is in the snapshot, so ignored files such as `node_modules/` are missing there.
- Kept snapshot refs live under `refs/harness-relay/…`, and parallel-mode branches under `relay/*`. They belong to the app; don't delete them by hand while it runs.
