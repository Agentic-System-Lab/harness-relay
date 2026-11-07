**English** | [繁體中文](README.zh-TW.md)

# Harness Relay

A ChatGPT-style group chat where **Claude Code, Codex and Grok** work together — on your code or any other question — and talk to each other.

Before each conversation you design the team: give every coding agent a position (architect, builder, reviewer, skeptic…), pick its model and reasoning effort, and choose how they take turns. Harness Relay then drives the real CLIs on your machine, passes each agent the messages it hasn't seen yet, and streams everything into one chat.

## Features

- **Three coding agents in one chat** — runs the `claude`, `codex` and `grok` CLIs you already have, with their own tools, sessions and logins.
- **Design the team per conversation** — roles, model, reasoning effort, turn order; five built-in templates (coding and general questions) plus your own saved templates. Roles can be edited mid-chat.
- **Auto team** — let a lead agent read your first question and pick a template or design a better-suited team; save the teams it designs as templates.
- **Agents talk to each other** — three conversation modes:
  - **Roundtable**: agents speak in order and build on each other, for up to N rounds; ends early when everyone replies `[PASS]`.
  - **Parallel**: everyone answers independently each round; later rounds see the earlier answers.
  - **Relay**: one agent at a time; an agent hands off by `@mentioning` a teammate.
- **`@mentions`** — address specific agents; only they reply.
- **Safe editing with git** — the working directory becomes a git repository automatically; each reply shows the files that agent changed, with a diff. In parallel mode every agent works in its own git worktree, and you apply the result you like.
- **Live streaming** — reply text and tool activity (file edits, shell commands) stream in as they happen; stop or continue at any time. Refused or failed tool calls show why.
- **Approvals in the chat** — the permission (read-only / edit / full access) decides what agents may do without asking; anything beyond it is asked in the chat — allow once, always allow in this chat, or decline with a note.
- **See what agents think and do** — reasoning, plans / to-do lists and each tool's output stream into the chat.
- **Copy, edit and retry** — copy any message or the whole chat as Markdown; edit one of your messages, or retry an agent's reply, and the team answers again from there.
- **Clear status at a glance** — the sidebar marks conversations that need you, are replying, or have a new reply; conversations keep running when you switch away.
- **Settings & login page** — sign in to each CLI separately (device code / browser / paste-code flows), set API keys, executable paths, default model and effort, and the lead agent.
- **English and 繁體中文** — the UI follows your browser language (switchable in Settings); a guided tour introduces the main features on the first visit.
- **Local-first** — everything is stored in a single SQLite file; the server only listens on `127.0.0.1`.

## Requirements

- Node.js **22.13+** (uses the built-in `node:sqlite`)
- The agent CLIs you want to use, installed and on your `PATH`:
  - [Claude Code](https://docs.claude.com/en/docs/claude-code) (`claude`)
  - [Codex CLI](https://github.com/openai/codex) (`codex`)
  - Grok CLI (`grok`)

You don't need all three — the app works with any subset, and you can sign in from the Settings page.

## Quick start

```bash
npm install
npm run dev
```

Open **http://localhost:5173**, go to **Settings & Login** to check that each agent is signed in, then click **New chat**, pick a template, and start talking.

For a production-style single server:

```bash
npm run build
npm start          # serves the UI and API on http://127.0.0.1:8787
```

## Documentation

| | English | 繁體中文 |
| --- | --- | --- |
| User guide | [docs/user-guide.md](docs/user-guide.md) | [docs/user-guide.zh-TW.md](docs/user-guide.zh-TW.md) |
| Architecture | [docs/architecture.md](docs/architecture.md) | [docs/architecture.zh-TW.md](docs/architecture.zh-TW.md) |
| Developer guide | [docs/developer-guide.md](docs/developer-guide.md) | [docs/developer-guide.zh-TW.md](docs/developer-guide.zh-TW.md) |

## Safety

Agents run with the file-system permission you choose for the conversation (**read-only**, **edit**, or **full access**). Full access lets agents run any command without asking — use it only in directories you trust. The server binds to `127.0.0.1` and rejects cross-site requests, but anyone with access to your machine's localhost can drive the agents. See [Architecture → Security](docs/architecture.md#security).

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | API server (port 8787, auto-restart) + Vite dev server (port 5173) |
| `npm run build` | Build the web UI into `dist/web` |
| `npm start` | Serve the built UI and the API from one process |
| `npm run typecheck` | Type-check server, client and tests |
| `npm test` | Run the test suite (Vitest) |
