# AGENTS.md

Guidance for coding agents (Claude Code, Codex, Grok and others) working in this repository. People should start with the [README](README.md) and the [developer guide](docs/developer-guide.md).

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
| `npm run typecheck` | `tsc --noEmit` over `src`, `test` and the config files |
| `npm test` | All Vitest tests (offline) |
| `npx vitest test/store.test.ts` | One test file |
| `npm run build` | Build the UI into `dist/web` |
| `npm start` | One process: API + built UI on :8787 |

Before you commit, run `npm run typecheck`, `npm test` and `npm run build`. CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs the same three on Node 22 and 24 for every pull request and every push to `main`.

## Where things are

- `src/shared/`: code shared by server and client. `types.ts` (all shared types, `PROVIDERS`), `mentions.ts` (the `@mention` rule), `ask.ts` (`[ASK_USER]`), `media.ts`.
- `src/server/app.ts`: routes, security middleware, SSE (`createApp()`, testable with `app.request()`).
- `src/server/orchestrator.ts`: team runs: speakers by mode, prompt delivery, streaming into messages, auto team, the message queue, pausing for the user's answer, retry and resend.
- `src/server/prompt.ts` and `planner.ts`: agent briefings and turn prompts; the auto-team lead agent's prompt and reply parsing.
- `src/server/agents/`: one adapter per CLI. `claude.ts` (stream-json), `codex.ts` (`codex app-server`), `grok.ts` (ACP), `acp.ts` (the JSON-RPC peer), `index.ts` (registry).
- `src/server/db.ts`, `store.ts`, `settings.ts`, `secrets.ts`: SQLite and migrations, persistence, provider settings and child-process env, API keys in the OS keyring.
- `src/server/workspace.ts`: git: auto init, snapshots, worktrees, diffs, apply.
- `src/server/process.ts`: spawning, streaming and killing child processes.
- `src/server/i18n.ts`, `presets.ts`: server-side messages and built-in team templates, both in two languages.
- `src/web/`: the React client. `components/`, `locales/` (`zh-TW.ts`, `en.ts`), `chat.ts` (ChatView's pure logic), `copy.ts`, `api.ts`.
- `test/`: Vitest tests, roughly one file per module.
- `data/`: runtime data (`relay.db`, worktrees). Git-ignored; never commit it.

## Rules

### Code

- Strict TypeScript, ES modules. Shared types live only in `src/shared/types.ts`.
- Spawn child processes only through `src/server/process.ts`, so they are tracked and killed on shutdown.
- Keep CLI output parsers pure (lines in, `AgentEvent`s out) so they can be tested with recorded output.
- Tests run in a Node environment without a DOM. Put client logic you want to test in plain modules (like `src/web/chat.ts` and `src/web/copy.ts`), not inside components.
- `node:sqlite` cannot bind `undefined`: pass optional values through `nul()`, and wrap multi-statement writes in `transaction(db, fn)` (it doesn't nest).

### Security

The server can start agents with write access, so keep its defences intact (see [Architecture → Security](docs/architecture.md#security)):

- New routes go under `/api/` so they get the middleware's Host/Origin checks, the JSON content-type check on writes and the request language. Don't weaken these checks.
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

- Docs come in pairs: `README.md` / `README.zh-TW.md` and `docs/<name>.md` / `docs/<name>.zh-TW.md`. When a change affects behaviour, the HTTP API, the schema, settings, environment variables or the test list, update both languages in the same commit.
- The developer guide lists the HTTP API and what each test file covers; keep those lists current.

### Tests

- Add or update tests with every behaviour change.
- Keep tests offline: no real CLI runs, no network, no real credential store. Follow the existing patterns: a fake runner swapped into `runners` (`test/orchestrator.test.ts`), recorded CLI messages for adapters, real temporary git repositories for `workspace.ts`, `app.request()` for the HTTP API, and a fake keyring passed to `SettingsStore`.

### Commits

- Write commit messages in English. The subject is an imperative sentence about what the user gets, for example `Let agents ask the user before answering, and wait for the answer`.
- In the body, use short bullet points, grouped under headings when a commit spans several areas: what changed and why, any schema version bump, and which docs and locales were updated.

## Gotchas

- `npm run dev` restarts the server on every server file change, and a restart aborts any running agent turn.
- You can run Harness Relay from inside a Claude Code session: the server strips Claude Code's nesting variables (`CLAUDECODE`, `CLAUDE_CODE_*`) before it spawns `claude` (`src/server/settings.ts`).
- The Vite proxy key is `/api/` with a trailing slash on purpose: a bare `/api` would also capture the client module `/api.ts`.
- Worktrees in parallel mode contain only what is in the snapshot, so ignored files such as `node_modules/` are missing there.
- Kept snapshot refs live under `refs/harness-relay/…`, and parallel-mode branches under `relay/*`. They belong to the app; don't delete them by hand while it runs.
