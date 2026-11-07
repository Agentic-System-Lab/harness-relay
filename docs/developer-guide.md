**English** | [繁體中文](developer-guide.zh-TW.md)

# Developer guide

How the code is organized, how to run and test it, and how to extend it. Read [Architecture](architecture.md) first for the big picture.

## Stack

| Layer | Tech |
| --- | --- |
| Language | TypeScript (strict), ES modules |
| Server | Node.js ≥ 22.13, [Hono](https://hono.dev) on `@hono/node-server`, run with `tsx` (no build step) |
| Database | SQLite via the built-in `node:sqlite` (`DatabaseSync`) |
| Client | React 19, Vite, `react-markdown` + `remark-gfm` + `rehype-highlight` |
| Tests | Vitest |

## Project layout

```text
src/
  shared/types.ts          types shared by server and client (+ PROVIDERS, effortsFor…)
  server/
    index.ts               routes, security middleware, SSE, static files, startup
    orchestrator.ts        team turns: scheduling, prompt delivery, streaming into messages
    prompt.ts              role briefing, turn prompt, @mention parsing, [PASS]
    agents/
      types.ts             AgentRunner interface, AgentEvent, helpers
      claude.ts codex.ts grok.ts   one adapter per CLI (parser + run)
      index.ts             runner registry
    process.ts             spawn/kill helpers (process groups, line streaming, timeouts)
    providers.ts           CLI status, login sessions, logout, model cache
    models.ts              model / effort discovery per CLI
    db.ts                  open SQLite, migrations, transaction()
    store.ts               conversations, messages, agent sessions, presets
    settings.ts            provider settings, default cwd, child-process env
    presets.ts             built-in team templates
    validate.ts            input validation for agents and settings
    workspace.ts           git: auto init, snapshots, worktrees, diffs, apply
    errors.ts              HttpError (user-facing errors with a status)
    hub.ts                 SSE fan-out
  web/
    main.tsx App.tsx api.ts util.ts styles.css index.html
    components/            Sidebar, NewChat, TeamEditor, ModelPicker, ChatView,
                           MessageItem, ChangesCard, Composer, Markdown, SettingsPage
test/                      Vitest tests
docs/                      documentation (English + 繁體中文)
data/                      runtime data (relay.db) — git-ignored
```

## Running

```bash
npm install
npm run dev        # tsx watch (API :8787) + vite (UI :5173, proxies /api/ to the API)
npm run typecheck
npm test
npm run build      # UI → dist/web
npm start          # one process: API + built UI on :8787
```

`npm run dev` restarts the server on every file change. A restart aborts any running agent turn (its message is marked aborted), so avoid editing server files while a long turn is running.

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8787` | API port (the Vite proxy uses it too) |
| `HOST` | `127.0.0.1` | Bind address |
| `RELAY_DATA_DIR` | `./data` | Where `relay.db` lives |
| `RELAY_DEFAULT_CWD` | process cwd | Initial default working directory (until changed in Settings) |
| `RELAY_ALLOWED_HOSTS` | — | Extra comma-separated host names accepted by the Host/Origin check |

The server passes its own environment to the CLIs, minus Claude Code's nesting variables, plus stored API keys (`SettingsStore.env()`).

## Request flow

1. The client posts `POST /api/conversations/:id/messages` → `Orchestrator.send()` prepares the workspace (for edit / full access: `git init` if needed, and the directory lock unless the mode is parallel), appends the user message and starts `execute()` in the background (the request returns `202`).
2. `execute()` chooses speakers by mode (creating per-agent worktrees first in parallel mode) and calls `turn()` for each.
3. `turn()` creates a streaming agent message, records the starting state (worktree `HEAD` or a snapshot), computes the messages the agent hasn't seen, builds the prompt (`prompt.ts`), and calls `runners[provider].run()` in the right directory.
4. The adapter spawns the CLI (`process.ts`), parses each stdout line and emits `AgentEvent`s.
5. `turn()` applies events to the message, emits SSE events through the `Hub`, and saves through the `Store`. When the CLI exits it records the files changed (commit in the worktree, or a second snapshot) on the message.

## HTTP API

All write requests must send `Content-Type: application/json` (CSRF guard). Errors are `{ "error": string }` with status 400/404/409/415/500.

| Method & path | Body → response |
| --- | --- |
| `GET /api/conversations` | → `ConversationSummary[]` |
| `POST /api/conversations` | `{ title?, agents, settings }` → `Conversation` |
| `GET /api/conversations/:id` | → `Conversation` |
| `PATCH /api/conversations/:id` | `{ title?, agents?, settings? }` → `Conversation` (409 while running) |
| `DELETE /api/conversations/:id` | stops a run and deletes |
| `POST /api/conversations/:id/messages` | `{ text }` (empty = continue) → `202` |
| `PUT /api/conversations/:id/messages/:messageId` | `{ text }` → `202`: edit a user message — it and everything after it are deleted, every agent starts a fresh session, and the team answers again (`Orchestrator.resend()`) |
| `POST /api/conversations/:id/stop` | aborts the run |
| `GET /api/conversations/:id/messages/:messageId/diff` | → unified diff (text) of that turn's changes |
| `GET /api/conversations/:id/agents/:agentId/diff` | → unified diff (text) of an agent's whole worktree result |
| `POST /api/conversations/:id/agents/:agentId/apply` | applies an agent's worktree result to the working directory → `{ files }` (409 on conflict) |
| `GET /api/conversations/:id/events` | SSE stream of `ServerEvent` |
| `GET /api/presets` · `POST /api/presets` · `DELETE /api/presets/:id` | team templates |
| `GET /api/settings` · `PUT /api/settings` | `{ defaultCwd? }` |
| `PUT /api/settings/providers/:provider` | `{ bin?, defaultModel?, defaultEffort?, apiKey? }` (`apiKey: null` removes) |
| `GET /api/providers[?refresh=1]` | → `ProviderStatus[]` |
| `GET /api/models[?refresh=1]` | → `ProviderModels[]` |
| `GET /api/providers/:provider/login-methods` | → `LoginMethod[]` |
| `POST /api/providers/:provider/login` | `{ method }` → `LoginSessionView` |
| `GET /api/providers/:provider/login` | → `LoginSessionView \| null` (poll while running) |
| `POST /api/providers/:provider/login/input` | `{ text }` → writes to the login process's stdin |
| `DELETE /api/providers/:provider/login` | cancels the login |
| `POST /api/providers/:provider/logout` | signs the CLI out |

Types are in `src/shared/types.ts`.

## Adding a new agent CLI

1. **Types** — add the id to `Provider`, `PROVIDERS` and `PROVIDER_LABEL` in `src/shared/types.ts`.
2. **Adapter** — create `src/server/agents/<name>.ts`:
   - a `create<Name>Parser(emit)` that turns one stdout line into `AgentEvent`s (`session`, `text`, `text_end`, `tool_start`, `tool_end`) and remembers the final result/error;
   - an `AgentRunner` whose `run()` builds the arguments (prompt, system prompt, session new/resume, permission, model, effort), calls `runProcess()` and throws `AgentRunError` on failure (`aborted = true` when stopped).
   Keep the parser pure so it can be tested with recorded output lines.
3. **Register** it in `src/server/agents/index.ts`.
4. **Settings** — default binary name in `DEFAULT_BIN` and, if the CLI reads an API key from the environment, `API_KEY_ENV` (`src/server/settings.ts`).
5. **Status & login** — `checkAuth()` and `LOGIN_METHODS` in `src/server/providers.ts`; the logout command in `logout()`.
6. **Models** — a discovery function in `src/server/models.ts` (or a static list).
7. **UI** — a color variable in `styles.css` (`--<name>`), `PROVIDER_COLOR` and `newAgent()` in `src/web/util.ts`, API-key help text in `SettingsPage.tsx`.

## Database changes

The schema lives in the `MIGRATIONS` array in `src/server/db.ts`; `PRAGMA user_version` records how many have been applied. To change the schema:

1. **Append** a new SQL string to `MIGRATIONS` (never edit a released one).
2. Update the row types and queries in `store.ts` / `settings.ts`.
3. Add or update tests in `test/store.test.ts`.

Each migration runs in its own transaction at startup. node:sqlite cannot bind `undefined`; use `nul()` for optional values, and `transaction(db, fn)` for multi-statement writes (it doesn't nest).

To inspect data:

```bash
sqlite3 data/relay.db '.tables'
sqlite3 data/relay.db 'select seq, author_kind, agent_name, status from messages order by conversation_id, seq'
```

## Changing prompts

- `buildBriefing()` — the system-level briefing (role, team, mode rules, workspace). Rebuilt every turn.
- `buildTurnPrompt()` — the per-turn message with `<chat>` and the cue line.
- `forwardText()` — how a reply is shown to other agents (text + `<actions>` log).
- `parseMentions()` — mention parsing; code spans and fenced blocks are ignored.

Prompts are in English on purpose (agents reply in the user's language). UI strings are Traditional Chinese.

## Testing

```bash
npm test               # all tests
npx vitest test/store.test.ts
```

Current tests:

- `test/store.test.ts` — SQLite store and settings (round-trips, streaming updates, crash recovery, cascading deletes, file permissions).
- `test/workspace.test.ts` — git plumbing against real temporary repositories (auto init, snapshots that leave the repo untouched, worktrees, apply, conflicts).
- `test/orchestrator.test.ts` — full runs with a fake runner swapped into `runners`: parallel worktree isolation and apply, change tracking in roundtable mode, and the directory lock.
- `test/grok.test.ts` — the Grok ACP adapter: permission policy per level, session updates → `AgentEvent`s, and the JSON-RPC connection.
- `test/claude.test.ts` — Claude's pre-approved tools and the reason shown for a refused tool call.
- `test/copy.test.ts` — the Markdown written when copying a message or a whole conversation.

`test/orchestrator.test.ts` also covers editing a user message (`resend`): later messages are dropped and every agent starts a fresh session.

Good next candidates:

- **Adapter parsers** — record real CLI output into fixture files and assert the emitted `AgentEvent`s. To capture output:

  ```bash
  echo "hello" | claude -p --output-format stream-json --verbose --include-partial-messages > claude.jsonl
  echo "hello" | codex exec --json --skip-git-repo-check - > codex.jsonl
  # Grok runs over ACP; copy fixtures from the updates it keeps per session:
  # ~/.grok/sessions/<url-encoded cwd>/<session-id>/updates.jsonl
  ```

- **Prompt helpers** — `parseMentions`, `isPass`, `buildTurnPrompt`.
- **More orchestrator scheduling** — relay hand-offs, `[PASS]` early exit and resume-failure retry, with the same fake-runner approach as `test/orchestrator.test.ts`.

Running real agents in tests costs money and needs logins, so keep automated tests offline.

## Debugging tips

- **Server logs** — the `[server]` lines in the `npm run dev` output; adapter failures include the CLI's stderr tail in the message's error.
- **SSE** — `curl -N http://localhost:8787/api/conversations/<id>/events` shows the raw event stream.
- **Reproduce a CLI call** — the adapters' argument lists in `src/server/agents/*.ts` can be run by hand; add `--debug` (Claude, Grok) to see more.
- **Worktrees** — `git -C <working dir> worktree list` and `git branch --list 'relay/*'` show what parallel conversations created; `data/worktrees/<conversation>/` holds the checkouts.
- **Stale session** — with the server stopped, delete the agent's row in `agent_sessions` to force a fresh session with full history (open conversations are cached in memory, so edit the database only while the server is down).

## Conventions

- Strict TypeScript; shared types only in `src/shared/types.ts`.
- Never send secrets to the client (`SettingsView` returns masked keys only).
- New write endpoints automatically get the JSON content-type and Host/Origin checks from the `/api/*` middleware — keep it that way.
- Spawned processes go through `process.ts` so they are tracked and killed on shutdown.
