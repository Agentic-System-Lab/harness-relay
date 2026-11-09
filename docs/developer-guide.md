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
  shared/schedule.ts       when a schedule sends next: wall-clock times in a time zone, clock changes (server and UI)
  server/
    index.ts               wiring, static files, startup and shutdown
    web.ts                 serves the built UI: hashed assets cached for good, index.html checked every time
    app.ts                 createApp(): routes, security middleware, SSE (testable with app.request())
    orchestrator.ts        team turns: who speaks next, prompt delivery, streaming into messages; auto team, resend
    planner.ts             auto team: lead-agent prompt, reply parsing, runnable team, fallback
    grouping.ts            sidebar groups: the lead agent sorts a new conversation by its first message
    scheduler.ts           schedules: sends each conversation's scheduled message when it comes due, missed times, notes
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
    store.ts               conversations, messages, agent sessions, presets, sidebar groups, search, schedules
    settings.ts            provider settings, default cwd, the CLIs' own homes, child-process env
    agentsview.ts          AgentsView: each conversation sent as one thread, the agents' sessions linked under it
    secrets.ts             OS credential store for API keys (keyring), availability check
    tools.ts               the tool library: MCP servers (secrets in the keyring), skills (SKILL.md front matter), memory; what each agent gets
    files.ts               browsing a conversation's files: roots, listing, preview, path checks
    native.ts              what each CLI loads by itself (its skills, MCP servers and their tools, built-in tools, hooks, subagents, plugins, instruction and memory files), asked without a prompt, and what Harness Relay's runs leave out of it
    grokTrust.ts           records Grok's trust in a folder (as grok --trust does), when the user confirms
    attachments.ts         files attached to messages: storage, safe names, images for the agents
    presets.ts             built-in team templates, in both languages
    validate.ts            input validation for agents, settings and schedules
    voice.ts               voice input: whisper.cpp engine and model installs (pinned, SHA-256 checked), the engine process, transcription
    workspace.ts           git: auto init, snapshots, worktrees, diffs, apply
    errors.ts              HttpError (user-facing errors with a status)
    hub.ts                 SSE fan-out
  web/
    main.tsx App.tsx api.ts util.ts copy.ts styles.css index.html
    public/                copied into the build as it is: manifest.webmanifest and the home-screen icons (npm run icons)
    chat.ts                ChatView's pure logic: stream reconnect decision, Apply availability, team-drawer draft
    sidebar.ts             the sidebar's pure logic: conversations in their groups, pending moves, a collapsed group's state
    schedule.ts            the schedule drawer's pure logic: the form, its problems, the next times, a schedule in a few words
    files.ts               the file browser's pure logic: breadcrumb, filter, code language, line count
    tools.ts               the team editor's tool picker: library items, defaults per CLI, an agent's exceptions
    native.ts              NativeSetupPanel's pure logic: each CLI's tabs and their counts, ticking single items, what its runs leave out, whether it changed
    route.ts               the client's routes in the URL hash, including #/settings/<section>
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
                           VoiceSettings (Settings → Voice input), ToolsSettings (Settings → Tool library),
                           SessionsSettings (Settings → Agent sessions),
                           FileBrowser (the Files dialog), NativeSetupPanel (what a CLI loads by itself),
                           GrokTrust (Grok's trust in a folder), SectionTitle,
                           ScheduleDrawer (a conversation's schedule),
                           useDialog (focus handling for dialogs)
test/                      Vitest tests
.github/workflows/ci.yml   CI: typecheck, tests and build on pull requests and pushes to main
.github/workflows/pages.yml  publishes site/ to GitHub Pages
scripts/preview-site.ts    npm run site:preview: serves site/ locally like Pages
scripts/app-icons.ts       npm run icons: draws the home-screen icons and writes the web app manifest
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

The web app manifest and the icons a phone puts on its home screen (or a browser shows for the installed app) are in `src/web/public/`. They are drawn by `npm run icons` (`scripts/app-icons.ts`) from the same three circles as the favicon and `Logo.tsx`, without an image library; run it again after changing the mark, the icons' sizes or the manifest, and commit what it writes.

`npm run dev` restarts the server on every file change. A restart aborts any running agent turn (its message is marked aborted), so avoid editing server files while a long turn is running.

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8787` | API port (the Vite proxy uses it too) |
| `HOST` | `127.0.0.1` | Bind address |
| `RELAY_DATA_DIR` | `./data` | Where `relay.db` lives |
| `RELAY_DEFAULT_CWD` | process cwd | Initial default working directory (until changed in Settings) |
| `RELAY_ALLOWED_HOSTS` | — | Extra comma-separated host names accepted by the Host/Origin check, such as the machine's Tailscale name (see [Use it from your phone](remote-access.md)) |
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
| `PUT /api/conversations/:id/schedule` | `{ text, repeat, timeZone?, enabled?, approvals?, missed? }` → `ConversationSchedule`: sets the conversation's schedule (one per conversation; replaces the one there was, keeping how it went last time). `repeat` is `{ kind: 'once', at }`, `{ kind: 'daily', time }`, `{ kind: 'weekly', time, days }` (0 = Sunday) or `{ kind: 'interval', hours }` (1–168, from when its times were last set; saving only a new message or other choices keeps the cadence); `time` is `HH:MM` in `timeZone` (default: the server's). Defaults: on, `approvals: 'deny'`, `missed: 'skip'`. 400 for an empty or too long message, a bad time, no days, a one-time schedule in the past (when on) or an unknown time zone; 409 when it is on and the team is still to be designed or confirmed |
| `DELETE /api/conversations/:id/schedule` | → `{ ok }`: removes the schedule |
| `POST /api/conversations/:id/schedule/run` | → `202` `{ ok, queued }`: sends the schedule's message now, as when it comes due (it waits in the queue while the team replies); its times stay as they are. 404 without a schedule; 409 with the reason when it is held back (the team waits for an answer, is not confirmed, or an earlier scheduled message is still waiting), the conversation is busy (a settings change, an apply, another conversation writing in the same folder) or it cannot start |
| `POST /api/conversations/:id/messages` | `{ text, attachments?, interrupt? }` (empty text and no files = continue) → `202` `{ ok, queued }`. While the team replies (or its design waits for confirmation) the message waits in the queue (`queued: true`) and is delivered before the next turn; `interrupt: true` stops the team and sends it now. `attachments`: `[{ name, mimeType, data }]` with base64 `data`; at most 10 files of 20 MB each |
| `DELETE /api/conversations/:id/queue/:messageId` | → `ChatMessage`: withdraws a message still waiting to be delivered (404 once it was delivered) |
| `GET /api/conversations/:id/attachments/:attachmentId` | → the attached file (images inline, anything else as a download) |
| `PUT /api/conversations/:id/messages/:messageId` | `{ text }` → `202`: edit a user message — it and everything after it are deleted, every agent starts a fresh session, and the team answers again (`Orchestrator.resend()`) |
| `POST /api/conversations/:id/messages/:messageId/retry` | → `202`: delete an agent reply and what follows, and let that agent (and the later speakers of its round) answer again |
| `POST /api/conversations/:id/approvals/:approvalId` | `{ allow, always?, note? }`: answer an agent's approval request (404 when already answered or expired) |
| `POST /api/conversations/:id/messages/:messageId/save-plan` | `{ name? }` → `TeamPreset`: saves the lead agent's custom team design as a template |
| `POST /api/conversations/:id/stop` | aborts the run |
| `GET /api/conversations/:id/files?root=&path=` | → `FileListing`: the folders that can be browsed (`roots`: `cwd`, plus each agent's worktree in parallel mode), and the entries of `path` in `root` (folders first; `.git` and links leading outside left out; at most 2,000). 404 for anything outside the folder |
| `GET /api/conversations/:id/files/preview?root=&path=` | → `FilePreview`: the text of a file (the first 512 KB), or that it is an image, a video or binary |
| `GET /api/conversations/:id/files/raw?root=&path=` | → an image or video in the folder, served like the media endpoint (anything else is a 404) |
| `GET /api/conversations/:id/messages/:messageId/diff` | → unified diff (text) of that turn's changes |
| `GET /api/conversations/:id/agents/:agentId/diff` | → unified diff (text) of an agent's whole worktree result |
| `POST /api/conversations/:id/agents/:agentId/apply` | applies an agent's worktree result to the working directory → `{ files }` (409 on conflict) |
| `GET /api/conversations/:id/events` | SSE stream of `ServerEvent` |
| `GET /api/presets` · `POST /api/presets` · `DELETE /api/presets/:id` | team templates |
| `GET /api/settings` · `PUT /api/settings` | `{ defaultCwd?, createCwd?, lead?, agentHome?, agentsViewUrl?, agentsViewLink? }` (`lead`: `{ provider, model?, effort? }`, the auto-team lead agent; a `defaultCwd` that does not exist is a 404 with `code: "cwd-missing"` unless `createCwd: true`, which creates it; `agentHome`: the folder of the CLIs' own homes, an absolute or `~` path, created when missing, not the home folder, a root, or inside Harness Relay's folder or the default working directory, `""` = off, 409 while a conversation runs; `agentsViewUrl`: AgentsView's address, `http(s)` on `localhost` / `127.0.0.1` / `[::1]` only, saved as its origin, `""` = off; `agentsViewLink`: where the UI's **Open AgentsView** goes instead, any http(s) address, `""` = `agentsViewUrl`). The answer has `agentsViewError` while the last update of AgentsView at the current address failed |
| `PUT /api/settings/providers/:provider` | `{ bin?, defaultModel?, defaultEffort?, apiKey?, nativeOff?, nativeItems? }` (`apiKey: null` removes; `nativeOff`: the whole list of the CLI's own parts left out of Harness Relay's runs, of `skills`, `mcp`, `tools`, `instructions`, `memory`, `hooks`, `agents`, `plugins`; parts the CLI cannot leave out are dropped; `nativeItems`: all the single items left out, `{ <kind>: [id…] }` with kinds `skills`, `mcp`, `mcpTools`, `tools`, `instructions`, `hooks`, `agents`, `plugins` and the ids from `NativeSetup`, at most 2,000 per kind; kinds the CLI cannot leave out alone are dropped) |
| `GET /api/tools` | → `ToolLibraryView`: MCP servers (variable and header values masked), skills (read from their `SKILL.md` now, with a `problem` when one cannot be used), memory per scope, where secrets are kept |
| `PUT /api/tools` | `{ skills?, memory? }` → `ToolLibraryView`. `skills` replaces the list (`[{ path, providers? }]`; a new path may be a folder of skills, and must hold at least one); `memory` changes the given parts (`all`, `claude`, `codex`, `grok`; at most 20,000 characters each) |
| `PUT /api/tools/mcp/:name` | `{ transport, command?, args?, url?, env?, headers?, providers?, previousName? }` → `ToolLibraryView`: adds a server, or with `previousName` replaces or renames one. A variable or header without `value` keeps its stored value. 409 for a taken name |
| `DELETE /api/tools/mcp/:name` | → `ToolLibraryView` (its values are removed from the credential store) |
| `GET /api/tools/skills/scan?path=` | → `{ path, skills: SkillCandidate[] }`: the skills under a folder (the folder itself and skill folders up to two levels down, at most 300), marked when already added; nothing is saved |
| `GET /api/providers[?refresh=1]` | → `ProviderStatus[]` |
| `GET /api/models[?refresh=1]` | → `ProviderModels[]` |
| `POST /api/providers/:provider/native` | `{ refresh? }` → `NativeSetup`: the skills, MCP servers (names, kinds and states only) and their tools, built-in tools (Claude Code), hooks (never their commands), subagents and plugins (when the CLI lists them) and instruction and memory files the CLI loads by itself for the default working directory, with `errors` for what it did not report. Each item the CLI can leave out alone has the `id` it is left out by. With anything left out of its runs, the CLI is asked again the way Harness Relay starts it: `nativeOff`, `nativeItems` and `asRun` say so, and items it then leaves out have `leftOut: true`. Starts the CLI briefly without a prompt (a POST, so other sites cannot set it off; Claude Code gets a `/usage` turn it answers by itself); kept for a minute per CLI, executable and folder while what is left out stays the same (`refresh: true` asks again) |
| `POST /api/providers/:provider/native/file` | `{ path }` → `FilePreview`: one of the files the CLI reported (an instruction or memory file, or a skill's `SKILL.md`, matched exactly), to read in the UI; any other path is a 404. Checked against the CLI's latest answer however old, so opening a file does not start the CLI again |
| `POST /api/providers/grok/folder-trust` | `{ cwd?, trust?, folder? }` → `GrokFolderTrust` `{ cwd, folder, above, trusted }`: whether Grok trusts `cwd` (default: the default working directory), from `grok inspect`. `folder` is the one Grok decides trust for (the repository root, links resolved, else `cwd`'s real path); `above` says it is a repository root above `cwd`. With `trust: true` (sent only after the user confirmed `folder`) it asks Grok again and records the trust for that folder as `grok --trust` would, in `$GROK_HOME/trusted_folders.toml`; 409 when Grok now names another folder than the `folder` sent, or still reports it untrusted (the file is then put back as it was) |
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

- `test/store.test.ts` — SQLite store and settings (round-trips, streaming updates, crash recovery, cascading deletes, file permissions), sidebar groups (order, renaming, deleting a group moves its conversations to Other, automatic sorting only once and never over the user's move or into a deleted group), search (every word, ignoring case, title matches first, Chinese, `%` and `_`, system notes left out, the excerpt, replies still streaming), and API keys with a fake credential store: never written to the database, old database keys moved out and scrubbed from the files, a refusing store. Also what each CLI's runs leave out of its own setup (kept, and only what that CLI can leave out: hooks, subagents and plugins included), and the single items left out (kept as JSON, only the kinds that CLI can leave out alone, a copy, kept through other updates and cleared by an empty object). Also the CLIs' own homes: each CLI's home variable pointing into the folder in place of the inherited one, the folders created (and still pointed at, with a warning, when they cannot be), saved with AgentsView's addresses, and the inherited homes back when it is off. Also schedules: kept with the conversation (and the messages they sent), listed for the sidebar, the due ones most overdue first, and gone when removed or when the conversation is deleted.
- `test/workspace.test.ts` — git plumbing against real temporary repositories (auto init, snapshots that leave the repo untouched and leave out the CLIs' own homes inside it, also named through a link, worktrees, apply, conflicts, CRLF / non-UTF-8 content applied byte for byte, long and unusual file lists, kept snapshot refs, repositories that are too broad).
- `test/process.test.ts` — process helpers: byte-exact output, stopping subprocesses that ignore SIGTERM (also after the CLI exited, and on shutdown), a missing working directory, relative executable paths.
- `test/hub.test.ts` — SSE fan-out when a browser reconnects.
- `test/web.test.ts` — serving the built UI: hashed assets cached for good, index.html (also for client routes) and the web app manifest (as `application/manifest+json`) checked every time, a missing asset is a 404, earlier routes untouched.
- `test/app-icons.test.ts` — the home-screen icons and the web app manifest: each icon's pixels are what `npm run icons` draws (opaque RGB, the right size), the manifest is the one it writes and can be installed (192 and 512 px icons, a maskable one, `standalone`), a maskable icon's mark stays inside the circle every launcher keeps, and `index.html` links the manifest and the Apple touch icon.
- `test/app.test.ts` — the HTTP API through `createApp()` and `app.request()`: Host / Origin / Content-Type checks, deleting a conversation while it replies, changes refused while the team replies, settings validation, creating a missing working directory (default, new or edited conversation) only when asked, template ids, sidebar groups (names that must be new and not Other in either language, rename, delete, moving a conversation, unknown groups) and search. Also the tool library routes (masked values, bad names, URLs, CLIs and variable names, taken names, skills and memory, listing the skills under a folder), agents' tool exceptions, what an agent gets when it runs, and browsing files (listing, preview, raw images only, paths outside the folder or into `.git`, unknown roots). Also asking what a CLI loads by itself with a fake service (the default working directory only, refresh, problems in the request's language, unknown CLI, not a GET or a form post), reading a reported file but no other path (without asking the CLI again), and Grok's folder trust through the real probe and a stand-in `grok` that keys trust like grok 1.0.77 (a folder outside a repository, a repository's subfolder trusting the repository root, a folder reached through a link trusting its real path, a different folder than the one confirmed, Grok not taking the entry and the file put back or removed, a missing folder, not a form post). Also the parts a CLI's runs leave out, in a provider update (a list of known parts only), and the single items (lists of ids by known kind, within limits; kinds the CLI cannot leave out alone dropped). Also the CLIs' own folder (created when missing, never the home folder, a root, a file, a relative path, or inside Harness Relay's folder or the default working directory; refused while a conversation runs, creating nothing; a change drops cached sign-in state and sign-ins in progress, the same folder spelled another way does not), AgentsView's address (this computer only, saved as its origin, a renamed conversation sent, the last failure shown and not for another address) and the address to open it (any http(s) address, apart from where conversations go), and `~` read the Windows way (`~\`) too. Also schedules: saving one (its next time, the request's language, shown with the conversation and in the list), switching it off and deleting it, refusing one that could never send or whose team is still to be designed or confirmed, keeping the last result and an interval's cadence across a save that leaves its times alone, and running it now (sent, then waiting while the team replies, then held back, its record left as it is; also when switched off, and the reason when the conversation is busy).
- `test/prompt.test.ts` — `@mention` parsing (text right after a name, code fences), `[PASS]`, forwarding of failed / stopped / passed replies, the parallel briefing. Also the memory and skills sections of the briefing, which says the CLI's own skills work as usual only while the user has not left them out, and lists no skills to a Claude Code agent left with no tool that reads a file. Also messages a schedule sent (`via="schedule"`), and the briefing of a conversation with a schedule (ask only when there is no reasonable answer; approvals refused unless the schedule asks).
- `test/commands.test.ts` — reading shell command lines: publishing commands in their many forms, and "always allow" keys that do not let embedded commands through.
- `test/chat.test.ts` — ChatView logic: when Enter sends (not on a phone or tablet), when to reconnect the event stream, which worktree result can be applied, the team drawer's draft, asking before creating a missing working directory.
- `test/markdown.test.ts` — mention chips follow the server's rule and skip code and links; images are shown as links; the user's own messages keep their line breaks; table cells stay on one line or wrap at a readable width, so wide tables scroll sideways.
- `test/orchestrator.test.ts` — full runs with a fake runner swapped into `runners`: parallel worktree isolation and apply, change tracking in roundtable mode, the directory lock (also for auto team), requests that arrive while a run is set up or a result is applied, agents asking the user (the team stops; the one that asked answers first after the reply, in roundtable, parallel and relay; Continue skips it; a reply to someone else, or an edit, starts afresh; messages written meanwhile wait for the answer), messages sent while the team replies (delivered before the next turn of an agent they are for, in the order sent; a follow-up run for what no turn took; kept after Stop; sent first by an interrupt, the next message or Continue; withdrawn; kept across a restart), deleting a conversation mid-run, keeping a session when a fresh start fails too, and telling teammates what a failed turn changed. Also passing what the user turned off of a CLI's own setup (all of a kind and single items) to every member's run, and to the lead agent's and the group sorter's. Also telling AgentsView after every turn and at the end of the run (with the agents' sessions known by then), linking the lead agent's and the group sorter's sessions (and sending again when the sorter ends after the run), telling it nothing about a conversation deleted while it replies, and a run kept whole when telling fails. Also schedules (`Scheduler` with a fake clock): the message sent when it comes due, marked as scheduled and shown to the agents as such, once only, and the next time; approvals refused in the runs it starts (shown as declined cards) except what the chat always allows, unless the schedule asks; asked again once the user writes into a scheduled run, or when a scheduled send also delivers the user's own waiting message; waiting in the queue while the team replies and holding a second one back, or a full queue; an earlier one left waiting after Stop sent at the next time, once; a run of its own for a message no turn took, still refusing approvals; held back while the team waits for an answer or has no confirmed team, and never taken for the answer (a reply, Continue, a scheduled @mention); a missed time skipped (with a note) or sent once late, also for a repeating schedule after several misses, and a one-time schedule switched off; retried while a settings change holds the conversation or another conversation writes in the same folder, then given up; nothing recorded when the server stops mid-send; a schedule replaced mid-send left as it is; an unreadable stored schedule dropped; a run that cannot start; and nothing for a deleted conversation.
- `test/grok.test.ts` — the Grok ACP adapter: permission policy per level, session updates → `AgentEvent`s, and the JSON-RPC connection. Also the tool library's MCP servers in ACP's form. HTTP MCP servers only for a Grok that advertises them. Also the variables that leave out what Grok loads from Claude Code and Cursor (skills, MCP servers, hooks), and its memory, next to the user's variables and the sandbox.
- `test/claude.test.ts` — Claude's pre-approved and removed tools, its arguments (`--system-prompt-snapshot off`, flags an older version rejects) and the reason shown for a refused tool call. Also the tool library: the `--mcp-config` file and `Read` rules for skill folders (none at full access), `Read` rules on Windows paths, and the `--mcp-config` document. Also leaving out what Claude Code loads by itself: the skill and MCP flags (the tool library's `--mcp-config` stays), the instruction and memory variables, hooks and every installed plugin through `--settings`, reading `claude plugin list --json`, and its own subagents denied before the prompt (only those that are not built in, by name and description; failing without sending the prompt when they cannot be, or when `initialize` does not list them). Also single items through `--settings`: skills (`skillOverrides`), instruction files (`claudeMdExcludes`, a path written so that it matches only that file, checked with picomatch as Claude Code matches it), deny rules for built-in tools, MCP servers and tools (named as Claude Code names them) and subagents, plugins by id, none for a part left out whole (except subagents and plugins), none for a server the tool library gives the run; and all built-in tools with `--tools ""`. Runs go through a stand-in `claude` (`test/fake-claude.ts`, shaped like Claude Code 2.1.319's answers): hooks and plugins off, single items through `--settings` in a private file (gone after the run) with the prompt sent at once, subagents denied before the prompt (one that replaces a built-in one too), a plain failure when its subagents or plugins cannot be left out, a Stop while the prompt waits, and the retry without a flag an older version rejects.
- `test/copy.test.ts` — the Markdown written when copying a message or a whole conversation, in both languages; a message is copied exactly as written (URLs, formatting, CRLF), also without the clipboard API.
- `test/approvals.test.ts` — "always allow" rule keys and matching (chained commands, shell wrappers).
- `test/codex.test.ts` — the Codex app-server adapter: thread items → `AgentEvent`s (text, reasoning, plan, command output, usage) and approval requests / responses. Also the tool library's MCP servers in one `mcp_servers` table (approving their own tools in full access), and Codex's MCP tool-call approvals (as codex-cli 0.167.0 sends them) shown like any approval while other elicitations are declined. Also leaving out what Codex loads by itself: the overrides (hooks and plugins among them), and the same overrides as `-c` arguments with inline tables and quoted keys; the check after the thread starts that hooks and plugins left out are really off (failing when Codex still lists them on or cannot answer, going on when it does not have the method), and a run through a stand-in `codex app-server` (the switches on its command line too, checked before the turn, failing when Codex ignored them, no turn after a Stop during the check); each of its configured MCP servers turned off in the same table, whatever its name (not those the tool library replaces); asking `config/read` for them only when MCP servers (all, single ones or their tools) are left out, and failing the run with a clear message when it cannot answer; single skills (`skills.config`), hooks (`hooks.state`) and plugins (`plugins`), as tables and as `-c` arguments; single servers and tools of the user's own config only (`disabled_tools` keeping those the user already turned off); the check that single skills, hooks and plugins are off; and the `thread/start` / `thread/resume` request that carries it all.
- `test/schedule.test.ts` — when a schedule sends: `HH:MM` and time zones, wall-clock times turned into moments (a time the clocks skip moves forward, one they repeat is the first), daily (today or tomorrow, the same time across a change of clocks), weekly (its days only, into next week), interval (from when it was saved) and one-time schedules, and times that cannot be read; the night clocks go back, midnight and half-hour changes (Santiago, Lord Howe), a weekly time across a change, and a weekday where the schedule is (Tokyo). Also `validateSchedule()` (defaults, days once each and in order, what could never send, a past one-time schedule kept when off) and the schedule drawer's logic: a new form and a saved schedule read back, a date and time from the browser, the problems it shows (like the server's), the next times, times in the schedule's own time zone, a schedule described in a few words (Monday first), when one needs a look, and when a one-time schedule is done.
- `test/sidebar.test.ts` — the sidebar's conversation states, conversations in their groups (Other last, conversations of a missing group in Other), moves not yet confirmed, and the state a collapsed group shows.
- `test/search.test.ts` — search words, matches ignoring case (longest first, overlaps merged), excerpts around the first match, highlighting.
- `test/grouping.test.ts` — the prompt that asks the lead agent to sort a conversation, and reading its reply (a number or a name; 0 or null is none; anything else is refused).
- `test/planner.test.ts` — the lead agent's reply: JSON extraction, templates vs. custom teams, validation, remapping to signed-in CLIs, the fallback, and the prompt.
- `test/tour.test.ts` — the guided tour: one target per step, showing it again after a new version, and a fingerprint of the steps that fails when they change without a new version.
- `test/i18n.test.ts` — language detection (server header and browser), language carried through async work, bilingual templates, and the two UI dictionaries having the same shape.
- `test/voice.test.ts` — voice input with fake downloads, processes and engine: the pinned catalogue, the background install (engine, model, check) on Linux and with Homebrew on macOS, a SHA-256 mismatch, cancelling, disk space, a custom engine path, an engine that does not start, the engine on 127.0.0.1 behind a secret path, transcription and its language, switching and deleting models, settings, and the HTTP routes.
- `test/voice-web.test.ts` — voice input in the browser: WAV encoding, silence detection, inserting the transcript at the caret, and what the microphone and Settings show.
- `test/tools.test.ts` — the tool library: front matter, finding skills (two levels down, a folder that is a skill itself, offered with names and whether they are added), MCP secrets in a fake credential store (masked, kept when not sent, kept under the server's id over a rename, also a rename in letter case only on a store whose names ignore case, moved out of the database, a failing store), defaults per CLI and an agent's exceptions, marked skills, and data saved before items had CLIs. Also: renaming a server or a skill keeps agents' exceptions; values that could not be moved stay in the database; values that could not be read are never saved over, and are read again once the store opens.
- `test/files.test.ts` — browsing files against a real temporary folder: paths outside it, through symlinks or into `.git` (in any letter case), listing order and the entry limit, text / image / binary previews and cutting a long file, media only for raw, and the folders a conversation offers. A folder reached through a link keeps the path it was asked for, and a cut listing keeps the first entries in display order.
- `test/files-web.test.ts` — the file browser's breadcrumb, filter, code language and line count.
- `test/tools-web.test.ts` — the team editor's tool picker: items, the memory part per CLI, defaults per CLI and recording only exceptions.
- `test/native-web.test.ts` — the panel of what a CLI loads by itself: each CLI's tabs before it is asked and their counts after (instructions and memory apart), what each CLI can leave out all at once or one by one, ticking and clearing single items, how many items its runs leave out (an MCP server with its tools once), whether what is left out changed since the answer, ticked items a fresh answer no longer lists and clearing them, and the single items as stored (`nativeItemsFor`).
- `test/native.test.ts` — what each CLI loads by itself: reading Claude Code's, Codex's and Grok's answers (recorded shapes; MCP configs and their tokens are dropped), the instruction and memory files Claude Code and Codex read (real temporary folders), a CLI that cannot be started, the cache per executable and per what is left out, the latest answer however old (for opening a reported file), problems worded per request, and which files may be read (only the reported ones). Also hooks (without their commands), subagents and plugins; marking what Harness Relay's runs leave out (not what the CLI turned off by itself); the files Claude Code and Codex skip with their variables and settings; and asking again the way Harness Relay starts each CLI, through stand-in `claude`, `codex` and `grok` executables (the same flags, overrides and variables as a run; nothing marked when that fails; a list the second answer lacks named in an error; Claude Code not started again for instruction files or memory alone; a subagent that replaces a built-in one not counted as built-in; plugins that cannot be listed). Also tools: Claude Code's built-in and MCP tools from its `/usage` turn (MCP tools by server, servers only that turn names), sent only when `/usage` is its own command (never with a skill of that name) and without a session file, and asked without the turn when it rejects `--no-session-persistence`, and again with all its skills left out (when it lists no commands); Codex's MCP tools per server from `mcpServerStatus/list` (as Codex lists them, not filtered by the config it echoes; none for a server that failed to start; a server turned off not started again; a Codex that ignored `disabled_tools` showing the tool still loaded). Items ticked that the second answer still loads (`stillLoaded`, only in lists it gave), and a second answer that runs out of time keeping what came. And single items: Claude Code's skills, built-in tools, MCP tools, a whole MCP server whose tools are taken away, subagents (a built-in one too), plugins and instruction files; Codex's skills, MCP servers and tools, hooks and plugins; each marked, through the stand-ins. Also asking again when the CLI's home moved (through a real `SettingsStore`).
- `test/agentsview.test.ts` — sending conversations to AgentsView with a fake `fetch`: the thread as a Claude Code transcript (the user's turns, replies under the agent's name and CLI, a failure noted, attachments by name, system notes and replies still streaming left out, the title last), AgentsView's session ids, the upload (file name, project and machine from a known agent session or the folder's name, `allow_shorter`, the `Origin` header) and the parent links (with the lead agent's and the group sorter's sessions), nothing sent without an address or a message, one update at a time per conversation with the newest state sent once after it, starting again right after an update that had nothing to do, dropping a deleted conversation's waiting update, redirects never followed, the place taken from the first agent session AgentsView answers for, and the last failure kept for its address until an update works.
- `test/route.test.ts` — the client's hash routes, including the settings sections, and which settings card is being read (highlighted in the links).
- `test/grok-trust.test.ts` — recording Grok's trust in a folder: the entry `grok --trust` writes, replacing an untrusted one and keeping the rest, TOML escaping of Windows paths, the file in a temporary `GROK_HOME` (owner-only), putting it back as it was, reading the trust and the folder it is decided for from `grok inspect` (a project root without its trailing slash, above the folder or not, else the folder itself), and when starting a new chat asks about it (a Grok member and a folder, not an auto team).
- `test/util.test.ts` — switching an agent or the lead agent to another CLI and back restores the model and effort picked for each CLI.
- `test/quickstart.test.ts` — the commands people copy run in any shell: npm scripts set no variables the Unix way (npm runs them with cmd.exe on Windows), the landing page, README and user guide never join commands with `&&` (Windows PowerShell 5.1 rejects it), the README quick start starts from a fresh clone, and the landing page, README and user guide install the built app (`npm run build`, then `npm start`, at http://127.0.0.1:8787); the landing page mentions `npm run dev` only for development.

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
