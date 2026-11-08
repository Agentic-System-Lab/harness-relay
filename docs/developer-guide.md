**English** | [繁體中文](developer-guide.zh-TW.md)

# Developer guide

How the code is organized, how to run and test it, and how to extend it. Read [Architecture](architecture.md) first for the big picture.

## Stack

| Layer | Tech |
| --- | --- |
| Language | TypeScript (strict), ES modules |
| Server | Node.js ≥ 22.13, [Hono](https://hono.dev) on `@hono/node-server`, run with `tsx` (no build step) |
| Database | SQLite via the built-in `node:sqlite` (`DatabaseSync`) |
| API keys | OS credential store via [`@napi-rs/keyring`](https://github.com/Brooooooklyn/keyring-node) (prebuilt binaries, no compiler needed) |
| Client | React 19, Vite, `react-markdown` + `remark-gfm` + `rehype-highlight` |
| Tests | Vitest |

## Project layout

```text
src/
  shared/types.ts          types shared by server and client (+ PROVIDERS, effortsFor…)
  shared/mentions.ts       the @mention rule shared by the server and the UI (Markdown prose only)
  shared/search.ts         search words, matches ignoring case, excerpts, highlighting (server and UI)
  server/
    index.ts               wiring, static files, startup and shutdown
    web.ts                 serves the built UI: hashed assets cached for good, index.html checked every time
    app.ts                 createApp(): routes, security middleware, SSE (testable with app.request())
    orchestrator.ts        team turns: scheduling, prompt delivery, streaming into messages; auto team, resend
    planner.ts             auto team: lead-agent prompt, reply parsing, runnable team, fallback
    grouping.ts            sidebar groups: the lead agent sorts a new conversation by its first message
    prompt.ts              role briefing, turn prompt, @mention parsing, [PASS]
    approvals.ts           "always allow" rule keys (one per command the line runs)
    commands.ts            reads a shell command line: simple commands, sh -c, wrappers, publish check
    i18n.ts                server messages (zh-TW / en), language per request and run
    agents/
      types.ts             AgentRunner interface, AgentEvent, helpers
      claude.ts            Claude Code: stream-json both ways, can_use_tool control requests
      codex.ts             Codex: `codex app-server` (thread / turn / approval requests)
      grok.ts              Grok: ACP (`grok agent stdio`)
      acp.ts               JSON-RPC peer used by the Codex and Grok adapters
      index.ts             runner registry
    process.ts             spawn/kill helpers (process groups, line streaming, raw-byte capture, timeouts)
    providers.ts           CLI status, login sessions, logout, model cache
    models.ts              model / effort discovery per CLI
    db.ts                  open SQLite, migrations, transaction()
    store.ts               conversations, messages, agent sessions, presets, sidebar groups, search
    settings.ts            provider settings, default cwd, child-process env
    secrets.ts             OS credential store for API keys (keyring), availability check
    attachments.ts         files attached to messages: storage, safe names, images for the agents
    presets.ts             built-in team templates, in both languages
    validate.ts            input validation for agents and settings
    voice.ts               voice input: whisper.cpp engine and model installs (pinned, SHA-256 checked), the engine process, transcription
    workspace.ts           git: auto init, snapshots, worktrees, diffs, apply
    errors.ts              HttpError (user-facing errors with a status)
    hub.ts                 SSE fan-out
  web/
    main.tsx App.tsx api.ts util.ts copy.ts styles.css index.html
    chat.ts                ChatView's pure logic: stream reconnect decision, Apply availability, team-drawer draft
    sidebar.ts             the sidebar's pure logic: conversations in their groups, pending moves, a collapsed group's state
    voice.ts               voice input's pure logic: WAV encoding, silence, inserting the transcript, install progress
    recorder.ts            microphone recording in the browser, decoded to 16 kHz mono
    useVoice.ts            the voice status hook (polls while an install runs)
    i18n.tsx               language detection, provider, useT()
    locales/               zh-TW.ts (source of the message shape), en.ts
    components/            Sidebar, SidebarGroups (groups, drag and drop), SidebarSearch,
                           NewChat, TeamEditor, ModelPicker, ChatView,
                           MessageItem (incl. plan card), ChangesCard, Composer, Markdown,
                           SettingsPage, CopyButton, Logo, Onboarding (guided tour),
                           MemberDots, icons, VoiceInput (microphone, setup dialog, install progress),
                           VoiceSettings (Settings → Voice input),
                           useDialog (focus handling for dialogs)
test/                      Vitest tests
.github/workflows/ci.yml   CI: typecheck, tests and build on pull requests and pushes to main
.github/workflows/pages.yml  publishes site/ to GitHub Pages
scripts/preview-site.ts    npm run site:preview: serves site/ locally like Pages
site/                      the landing page (static HTML, English + 繁體中文); DESIGN-GUIDELINES.md is not served
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

`npm run build` puts the libraries the page loads at startup in their own chunks (`react`, `highlight`, `vendor`), so a browser keeps them across app updates; Mermaid stays lazy. It warns when a chunk loaded at startup passes 500 kB (`vite.config.ts`); Mermaid's lazy chunks are larger and only load when a diagram needs them.

`npm run dev` restarts the server on every file change. A restart aborts any running agent turn (its message is marked aborted), so avoid editing server files while a long turn is running.

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8787` | API port (the Vite proxy uses it too) |
| `HOST` | `127.0.0.1` | Bind address |
| `RELAY_DATA_DIR` | `./data` | Where `relay.db` lives |
| `RELAY_DEFAULT_CWD` | process cwd | Initial default working directory (until changed in Settings) |
| `RELAY_ALLOWED_HOSTS` | — | Extra comma-separated host names accepted by the Host/Origin check |
| `RELAY_KEYRING` | — | `off` keeps API keys in the database instead of the OS credential store (e.g. for a throwaway data directory) |

The server passes its own environment to the CLIs, minus Claude Code's nesting variables, plus stored API keys (`SettingsStore.env()`).

## Request flow

1. The client posts `POST /api/conversations/:id/messages` → `Orchestrator.send()` prepares the workspace (for edit / full access: `git init` if needed, and the directory lock unless the mode is parallel), appends the user message and starts `execute()` in the background (the request returns `202`).
2. `execute()` first lets the lead agent design the team when the conversation is in auto-team mode (`designTeam()`, see [Architecture → Auto team](architecture.md#auto-team)), then chooses speakers by mode (creating per-agent worktrees first in parallel mode) and calls `turn()` for each.
3. `turn()` creates a streaming agent message, records the starting state (worktree `HEAD` or a snapshot), computes the messages the agent hasn't seen, builds the prompt (`prompt.ts`), and calls `runners[provider].run()` in the right directory, passing `requestApproval` unless the conversation refuses automatically.
4. The adapter spawns the CLI (`process.ts`), parses each stdout line and emits `AgentEvent`s.
5. `turn()` applies events to the message (text, thinking, plan, tool rows and output), emits SSE events through the `Hub`, and saves through the `Store`. An approval request adds an approval part and waits for `POST …/approvals/:approvalId`. When the CLI exits it records the files changed (commit in the worktree, or a second snapshot) on the message.

## HTTP API

All write requests must send `Content-Type: application/json` (CSRF guard). Errors are `{ "error": string }` with status 400/404/409/415/500. Send `X-Relay-Lang: zh-TW | en` to get errors, system notes and built-in templates in that language (the web app always does).

| Method & path | Body → response |
| --- | --- |
| `GET /api/conversations` | → `ConversationSummary[]` (with `running`, `waiting`, `lastStatus`, `groupId` and `sorting` for the sidebar) |
| `GET /api/search?q=` | → `SearchResult[]`: conversations whose title or user / agent messages contain every word of `q` (ignoring case), title matches first, then the most recent; at most 50 |
| `PUT /api/conversations/:id/group` | `{ groupId }` → `{ ok }`: puts the conversation in a sidebar group (`null` = Other); 404 for an unknown group. A conversation the user moved is never sorted automatically |
| `GET /api/groups` | → `ConversationGroup[]`, in the order they were made (the default group, Other, is not listed) |
| `POST /api/groups` | `{ name }` → `ConversationGroup` (400 for an empty, too long or taken name — including Other / 其他 — or more than 50 groups) |
| `PATCH /api/groups/:id` | `{ name }` → `ConversationGroup` |
| `DELETE /api/groups/:id` | deletes the group; its conversations go to Other |
| `POST /api/conversations` | `{ title?, agents, settings, createCwd? }` → `Conversation`; with `settings.autoTeam: true`, `agents` may be empty — the lead agent designs the team on the first message; a `settings.cwd` that does not exist is a 404 with `code: "cwd-missing"` unless `createCwd: true`, which creates it |
| `GET /api/conversations/:id` | → `Conversation` |
| `PATCH /api/conversations/:id` | `{ title?, agents?, settings?, createCwd? }` → `Conversation` (409 while running; setting `agents` turns auto team off; a missing `settings.cwd` as in `POST`) |
| `DELETE /api/conversations/:id` | stops a run and deletes |
| `POST /api/conversations/:id/messages` | `{ text, attachments?, interrupt? }` (empty text and no files = continue) → `202` `{ ok, queued }`. While the team replies (or its design waits for confirmation) the message waits in the queue (`queued: true`) and is delivered before the next turn; `interrupt: true` stops the team and sends it now. `attachments`: `[{ name, mimeType, data }]` with base64 `data`; at most 10 files of 20 MB each |
| `DELETE /api/conversations/:id/queue/:messageId` | → `ChatMessage`: withdraws a message still waiting to be delivered (404 once it was delivered) |
| `GET /api/conversations/:id/attachments/:attachmentId` | → the attached file (images inline, anything else as a download) |
| `PUT /api/conversations/:id/messages/:messageId` | `{ text }` → `202`: edit a user message — it and everything after it are deleted, every agent starts a fresh session, and the team answers again (`Orchestrator.resend()`) |
| `POST /api/conversations/:id/messages/:messageId/retry` | → `202`: delete an agent reply and what follows, and let that agent (and the later speakers of its round) answer again |
| `POST /api/conversations/:id/approvals/:approvalId` | `{ allow, always?, note? }`: answer an agent's approval request (404 when already answered or expired) |
| `POST /api/conversations/:id/messages/:messageId/save-plan` | `{ name? }` → `TeamPreset`: saves the lead agent's custom team design as a template |
| `POST /api/conversations/:id/stop` | aborts the run |
| `GET /api/conversations/:id/messages/:messageId/diff` | → unified diff (text) of that turn's changes |
| `GET /api/conversations/:id/agents/:agentId/diff` | → unified diff (text) of an agent's whole worktree result |
| `POST /api/conversations/:id/agents/:agentId/apply` | applies an agent's worktree result to the working directory → `{ files }` (409 on conflict) |
| `GET /api/conversations/:id/events` | SSE stream of `ServerEvent` |
| `GET /api/presets` · `POST /api/presets` · `DELETE /api/presets/:id` | team templates |
| `GET /api/settings` · `PUT /api/settings` | `{ defaultCwd?, createCwd?, lead? }` (`lead`: `{ provider, model?, effort? }`, the auto-team lead agent; a `defaultCwd` that does not exist is a 404 with `code: "cwd-missing"` unless `createCwd: true`, which creates it) |
| `PUT /api/settings/providers/:provider` | `{ bin?, defaultModel?, defaultEffort?, apiKey? }` (`apiKey: null` removes) |
| `GET /api/providers[?refresh=1]` | → `ProviderStatus[]` |
| `GET /api/models[?refresh=1]` | → `ProviderModels[]` |
| `GET /api/providers/:provider/login-methods` | → `LoginMethod[]` |
| `POST /api/providers/:provider/login` | `{ method }` → `LoginSessionView` |
| `GET /api/providers/:provider/login` | → `LoginSessionView \| null` (poll while running) |
| `POST /api/providers/:provider/login/input` | `{ text }` → writes to the login process's stdin |
| `DELETE /api/providers/:provider/login` | cancels the login |
| `POST /api/providers/:provider/logout` | signs the CLI out |
| `GET /api/voice` | → `VoiceStatus`: engine, models, selected model and language, the current or last install (`job`), the engine process (poll while `job.state` is `running`) |
| `PUT /api/voice/settings` | `{ model?, language?, bin? }` → `VoiceStatus` (`bin`: path to `whisper-server`, empty = find it) |
| `POST /api/voice/install` | `{ model? }` → `VoiceStatus`: installs what is missing (engine, model) in the background, then selects the model (409 while another install runs; 400 when it cannot be installed here or the disk is too full) |
| `DELETE /api/voice/install` | cancels the install |
| `DELETE /api/voice/models/:model` | deletes a downloaded model |
| `DELETE /api/voice` | deletes the downloaded models and engine (one installed with Homebrew stays) |
| `POST /api/voice/prepare` | starts the engine ahead of a transcription (sent when recording starts) |
| `POST /api/voice/transcribe` | `{ audio }` (base64 16 kHz mono 16-bit WAV, at most 120 s) → `{ text }` (409 when voice input is not set up) |

Types are in `src/shared/types.ts`.

## Adding a new agent CLI

1. **Types** — add the id to `Provider`, `PROVIDERS` and `PROVIDER_LABEL` in `src/shared/types.ts`.
2. **Adapter** — create `src/server/agents/<name>.ts`:
   - a `create<Name>Parser(emit)` (or update handler) that turns the CLI's output into `AgentEvent`s (`session`, `text`, `text_end`, `thinking`, `plan`, `tool_start`, `tool_end` with `output` / `error`) and remembers the final result/error;
   - an `AgentRunner` whose `run()` builds the arguments (prompt, system prompt, session new/resume, permission, model, effort), calls `runProcess()` and throws `AgentRunError` on failure (`aborted = true` when stopped);
   - approvals: when the CLI asks to do something the permission does not cover, call `o.requestApproval({ kind, detail, reason, tool })` and answer the CLI with the result (when `requestApproval` is absent, refuse).
   Keep the parser pure so it can be tested with recorded output lines.
3. **Register** it in `src/server/agents/index.ts`.
4. **Settings** — default binary name in `DEFAULT_BIN` and, if the CLI reads an API key from the environment, `API_KEY_ENV` (`src/server/settings.ts`).
5. **Status & login** — `checkAuth()` and `LOGIN_METHODS` in `src/server/providers.ts`; the logout command in `logout()`.
6. **Models** — a discovery function in `src/server/models.ts` (or a static list).
7. **UI** — a color variable in `styles.css` (`--<name>`), `PROVIDER_COLOR` and `newAgent()` in `src/web/util.ts`, API-key help text in both locale files (`settings.apiKeyHelp`).
8. **Messages** — login method labels in `src/server/i18n.ts` (`login`), in both languages.

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
- `parseMentions()` — mention parsing; text may follow a name directly, and code spans and fenced blocks of any kind (also unclosed ones) are ignored.
- `buildPlannerPrompt()` / `PLANNER_BRIEFING` (`planner.ts`) — what the lead agent is asked in auto-team mode, and the JSON it must return.
- `buildGroupPrompt()` / `GROUPER_BRIEFING` (`grouping.ts`) — how the lead agent is asked to sort a new conversation into the user's groups.

Prompts are in English on purpose (agents reply in the user's language). User-facing text is translated — see [Translations](#translations).

## Translations

The UI and the server's user-facing text come in Traditional Chinese (`zh-TW`) and English (`en`).

- **UI strings** — add the key to `src/web/locales/zh-TW.ts` first: its shape is the `Messages` type. `en.ts` is typed `Messages`, so TypeScript reports a missing or mistyped English entry; text with values is a function (`(n: number) => …`). In components use `const t = useT()` (or `useI18n()` for the language and `setLang`). Code outside React gets the messages passed in (`relativeTime(ts, t)`, `conversationMarkdown(conv, t)`).
- **Server strings** — `src/server/i18n.ts` has both dictionaries; call `t()` where the text is produced. The language comes from the request (`X-Relay-Lang`) through AsyncLocalStorage and follows the runs the request starts, so do not cache translated text in long-lived objects.
- **Built-in templates** — `src/server/presets.ts` keeps names, descriptions and roles in both languages.
- **Another language** — add it to `Lang` / `LANGS` in `src/shared/types.ts`, add a locale file and a server dictionary, the template texts, and its detection rule in `browserLang()`.

`test/i18n.test.ts` checks that both UI dictionaries have the same shape (including list lengths, which types don't check).

The guided tour's steps are `tour.steps` in the locales; the element each step points at (its `data-tour` attribute) is `TOUR_TARGETS` in `src/web/components/Onboarding.tsx`, by step index. When you add, remove or reorder steps, change both locales and `TOUR_TARGETS` together. When you change the steps in a way worth seeing, raise `TOUR_VERSION` in the same file: the browser remembers which version was finished (`localStorage` key `relay:onboarded`), so people who finished an earlier one see the tour again once. `test/tour.test.ts` checks the target count and fails when the steps change, as a reminder: update the version and the fingerprint it prints (only the fingerprint for a typo fix).

## Testing

```bash
npm test               # all tests
npx vitest test/store.test.ts
```

Current tests:

- `test/store.test.ts` — SQLite store and settings (round-trips, streaming updates, crash recovery, cascading deletes, file permissions), sidebar groups (order, renaming, deleting a group moves its conversations to Other, automatic sorting only once and never over the user's move or into a deleted group), search (every word, ignoring case, title matches first, Chinese, `%` and `_`, system notes left out, the excerpt, replies still streaming), and API keys with a fake credential store: never written to the database, old database keys moved out and scrubbed from the files, a refusing store.
- `test/workspace.test.ts` — git plumbing against real temporary repositories (auto init, snapshots that leave the repo untouched, worktrees, apply, conflicts, CRLF / non-UTF-8 content applied byte for byte, long and unusual file lists, kept snapshot refs, repositories that are too broad).
- `test/process.test.ts` — process helpers: byte-exact output, stopping subprocesses that ignore SIGTERM (also after the CLI exited, and on shutdown), a missing working directory, relative executable paths.
- `test/hub.test.ts` — SSE fan-out when a browser reconnects.
- `test/web.test.ts` — serving the built UI: hashed assets cached for good, index.html (also for client routes) checked every time, a missing asset is a 404, earlier routes untouched.
- `test/app.test.ts` — the HTTP API through `createApp()` and `app.request()`: Host / Origin / Content-Type checks, deleting a conversation while it replies, changes refused while the team replies, settings validation, creating a missing working directory (default, new or edited conversation) only when asked, template ids, sidebar groups (names that must be new and not Other in either language, rename, delete, moving a conversation, unknown groups) and search.
- `test/prompt.test.ts` — `@mention` parsing (text right after a name, code fences), `[PASS]`, forwarding of failed / stopped / passed replies, the parallel briefing.
- `test/commands.test.ts` — reading shell command lines: publishing commands in their many forms, and "always allow" keys that do not let embedded commands through.
- `test/chat.test.ts` — ChatView logic: when Enter sends (not on a phone or tablet), when to reconnect the event stream, which worktree result can be applied, the team drawer's draft, asking before creating a missing working directory.
- `test/markdown.test.ts` — mention chips follow the server's rule and skip code and links; images are shown as links; the user's own messages keep their line breaks; table cells stay on one line or wrap at a readable width, so wide tables scroll sideways.
- `test/orchestrator.test.ts` — full runs with a fake runner swapped into `runners`: parallel worktree isolation and apply, change tracking in roundtable mode, the directory lock (also for auto team), requests that arrive while a run is set up or a result is applied, agents asking the user (the team stops; the one that asked answers first after the reply, in roundtable, parallel and relay; Continue skips it; a reply to someone else, or an edit, starts afresh; messages written meanwhile wait for the answer), messages sent while the team replies (delivered before the next turn of an agent they are for, in the order sent; a follow-up run for what no turn took; kept after Stop; sent first by an interrupt, the next message or Continue; withdrawn; kept across a restart), deleting a conversation mid-run, keeping a session when a fresh start fails too, and telling teammates what a failed turn changed.
- `test/grok.test.ts` — the Grok ACP adapter: permission policy per level, session updates → `AgentEvent`s, and the JSON-RPC connection.
- `test/claude.test.ts` — Claude's pre-approved and removed tools, its arguments (`--system-prompt-snapshot off`, flags an older version rejects) and the reason shown for a refused tool call.
- `test/copy.test.ts` — the Markdown written when copying a message or a whole conversation, in both languages; a message is copied exactly as written (URLs, formatting, CRLF), also without the clipboard API.
- `test/approvals.test.ts` — "always allow" rule keys and matching (chained commands, shell wrappers).
- `test/codex.test.ts` — the Codex app-server adapter: thread items → `AgentEvent`s (text, reasoning, plan, command output, usage) and approval requests / responses.
- `test/sidebar.test.ts` — the sidebar's conversation states, conversations in their groups (Other last, conversations of a missing group in Other), moves not yet confirmed, and the state a collapsed group shows.
- `test/search.test.ts` — search words, matches ignoring case (longest first, overlaps merged), excerpts around the first match, highlighting.
- `test/grouping.test.ts` — the prompt that asks the lead agent to sort a conversation, and reading its reply (a number or a name; 0 or null is none; anything else is refused).
- `test/planner.test.ts` — the lead agent's reply: JSON extraction, templates vs. custom teams, validation, remapping to signed-in CLIs, the fallback, and the prompt.
- `test/tour.test.ts` — the guided tour: one target per step, showing it again after a new version, and a fingerprint of the steps that fails when they change without a new version.
- `test/i18n.test.ts` — language detection (server header and browser), language carried through async work, bilingual templates, and the two UI dictionaries having the same shape.
- `test/voice.test.ts` — voice input with fake downloads, processes and engine: the pinned catalogue, the background install (engine, model, check) on Linux and with Homebrew on macOS, a SHA-256 mismatch, cancelling, disk space, a custom engine path, an engine that does not start, the engine on 127.0.0.1 behind a secret path, transcription and its language, switching and deleting models, settings, and the HTTP routes.
- `test/voice-web.test.ts` — voice input in the browser: WAV encoding, silence detection, inserting the transcript at the caret, and what the microphone and Settings show.

`test/orchestrator.test.ts` also covers approvals with a fake agent (asking and waiting, "always allow", a decline note, expiry on stop, refusing automatically), retrying a reply, editing a user message (`resend`: later messages are dropped and every agent starts a fresh session) and auto team with a fake lead agent (a custom design that waits for confirmation before its team answers, a team set by hand as confirmation, saving it as a template, using a template, the fallback, designing again after the request is edited, and planning runs that lock nothing), sorting a new conversation into a group with a fake lead agent (by its first message only, next to the team, not without groups, never over the user's move, stopped when the conversation is deleted), and attached files (saved with safe names, images and paths delivered to each agent, kept when a message is edited, deleted with dropped messages, files-only messages, bad uploads).

Good next candidates:

- **Adapter parsers** — record real CLI output into fixture files and assert the emitted `AgentEvent`s. To capture output:

  ```bash
  echo "hello" | claude -p --output-format stream-json --verbose --include-partial-messages > claude.jsonl
  # Codex and Grok speak JSON-RPC; log what the adapter sees with a console.log in
  # JsonRpcConnection.handleLine, or copy Grok's per-session updates from
  # ~/.grok/sessions/<url-encoded cwd>/<session-id>/updates.jsonl
  ```

- **Prompt helpers** — `buildTurnPrompt`.
- **More orchestrator scheduling** — relay hand-offs and `[PASS]` early exit, with the same fake-runner approach as `test/orchestrator.test.ts`.

Running real agents in tests costs money and needs logins, so keep automated tests offline. Tests never touch the real credential store either: `SettingsStore` takes it as a constructor argument, and only `src/server/index.ts` passes `openSystemKeyring()`.

## Continuous integration

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs on every pull request and every push to `main`: `npm ci`, `npm run typecheck`, `npm test` and `npm run build`, on Ubuntu with Node 22 (the oldest supported) and Node 24. A new push to a pull request cancels its previous run. Run the same commands locally before pushing.

To block merging until the checks pass, add a branch protection rule (or ruleset) for `main` in the repository settings and require the `Typecheck, test, build` checks.

### Website

The landing page at https://agentic-system-lab.github.io/harness-relay/ is plain HTML, CSS and JavaScript in [`site/`](../site/): `index.html` (English), `zh-TW/index.html` (繁體中文) and shared `assets/`. There is no build step. [`.github/workflows/pages.yml`](../.github/workflows/pages.yml) runs on pushes to `main` that touch `site/`, `docs/media/` or the workflow itself: it copies `site/` and the demo videos from `docs/media/` into one folder, leaves out Markdown files, and deploys it to GitHub Pages (repository settings → Pages → Source: GitHub Actions). Preview it with `npm run site:preview` ([`scripts/preview-site.ts`](../scripts/preview-site.ts)): it serves `site/` on http://127.0.0.1:4180 (`SITE_PORT` changes the port) with the videos read from `docs/media/`, the way Pages will. Read [`site/DESIGN-GUIDELINES.md`](../site/DESIGN-GUIDELINES.md) before changing the page; it also says what to update when the demo is re-recorded.

## Debugging tips

- **Server logs** — the `[server]` lines in the `npm run dev` output; adapter failures include the CLI's stderr tail in the message's error.
- **SSE** — `curl -N http://localhost:8787/api/conversations/<id>/events` shows the raw event stream.
- **Language** — add `-H 'X-Relay-Lang: en'` to a `curl` call to see the English errors and templates.
- **Auto team** — the lead agent's run is a normal CLI session in the conversation's working directory; its reply and its cost are on the plan message (`messages.plan`, `cost_usd`).
- **Reproduce a CLI call** — the adapters' argument lists in `src/server/agents/*.ts` can be run by hand; add `--debug` (Claude, Grok) to see more.
- **Worktrees** — `git -C <working dir> worktree list` and `git branch --list 'relay/*'` show what parallel conversations created; `data/worktrees/<conversation>/` holds the checkouts.
- **Voice input** — `GET /api/voice` shows what is installed and the last install's log; the engine runs as `whisper-server` (see `ps`) and stops after 10 idle minutes. Downloads go to `data/voice/` (`models/`, and `engine/` on Linux and Windows).
- **Stale session** — with the server stopped, delete the agent's row in `agent_sessions` to force a fresh session with full history (open conversations are cached in memory, so edit the database only while the server is down).

## Conventions

- Strict TypeScript; shared types only in `src/shared/types.ts`.
- Never send secrets to the client (`SettingsView` returns masked keys only).
- New write endpoints automatically get the JSON content-type and Host/Origin checks from the `/api/*` middleware — keep it that way.
- Spawned processes go through `process.ts` so they are tracked and killed on shutdown.
