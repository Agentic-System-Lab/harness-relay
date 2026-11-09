**English** | [繁體中文](README.zh-TW.md)

# Harness Relay

[![CI](https://github.com/Agentic-System-Lab/harness-relay/actions/workflows/ci.yml/badge.svg)](https://github.com/Agentic-System-Lab/harness-relay/actions/workflows/ci.yml)

**Website:** https://agentic-system-lab.github.io/harness-relay/

A local group chat for the real **Claude Code, Codex and Grok** CLIs: give each a role, choose how they take turns, and they work on your code, or any question, and answer each other.

For each question, a lead agent picks the team from your templates (or adapts one, or designs a new one), and you confirm it: a position for every agent (architect, builder, reviewer, skeptic…), its model and reasoning effort, and a mode (roundtable, parallel or relay). You design teams as templates. Harness Relay then runs `claude`, `codex` and `grok` with your own logins and tools, passes each agent the messages it hasn't seen yet, and streams everything into one chat.

## Demo

[![Harness Relay demo: you create a group and ask a question, the lead agent sorts the chat into the group and designs a team for the question, you confirm it, Claude Code, Codex and Grok read the code and answer, a follow-up question gets a team of its own, you open the code they discussed in the file browser, and a search finds the chat again](docs/media/demo-en.webp)](docs/media/demo-en.mp4)

## Features

- **Three coding agents in one chat** — runs the `claude`, `codex` and `grok` CLIs you already have, with their own tools, sessions and logins.
- **Design teams as templates** — roles, model, reasoning effort, turn order; five built-in templates (coding and general questions) to copy, and your own to add and change on the New chat page. The current team can be adjusted mid-chat.
- **Attach files** — paste screenshots, drop files or use 📎; every agent gets the files, and images are shown to all three CLIs directly.
- **Voice input (optional)** — press 🎙 in the message box and speak; [whisper.cpp](https://github.com/ggml-org/whisper.cpp) turns it into text on your computer, and recordings never leave it. Nothing is installed until you want it: the first press explains what gets downloaded, then installs the engine and a model in the background (follow it, switch models or remove it in Settings). macOS (Homebrew, Metal GPU), Linux and Windows (x64 / arm64).
- **A team for every question** — a lead agent reads your question, the conversation so far, the current team and every template in full, then keeps the team, uses a template as it is, adapts one, or designs a new team, and says why. You confirm it (or let it answer right away) and the team answers; follow-ups that @mention a member go straight to them. Save the teams it designs or adapts as templates.
- **Agents talk to each other** — three conversation modes:
  - **Roundtable**: agents speak in order and build on each other, for up to N rounds; ends early when everyone replies `[PASS]`.
  - **Parallel**: everyone answers independently each round; later rounds see the earlier answers.
  - **Relay**: one agent at a time; an agent hands off by `@mentioning` a teammate.
- **`@mentions`** — address specific agents; only they reply.
- **Safe editing with git** — the working directory becomes a git repository automatically; each reply shows the files that agent changed, with a diff. In parallel mode every agent works in its own git worktree, and you apply the result you like.
- **Live streaming** — reply text and tool activity (file edits, shell commands) stream in as they happen; stop or continue at any time. Refused or failed tool calls show why. Mermaid code blocks are drawn as diagrams, images and videos an agent saves in the working directory are shown in the chat, and files it makes for you (a PDF, slides, a spreadsheet) are links you can download, on the computer or a phone.
- **Keep talking while they reply** — a message sent while the team is replying waits above the message box and reaches the next agent before its turn (one that @mentions someone waits for them); withdraw or edit it until then, or press ⌘/Ctrl+Enter to stop the team and send it now.
- **Agents ask before guessing** — when a good answer depends on something only you know, an agent asks you and the team waits; once you reply, that agent answers first with your answer in hand, and the others go on from there.
- **Schedules** — send the team a message at set times (once, every day, on chosen days of the week, or every few hours), in the same conversation or in a new one each time; for example, review yesterday's commits every weekday at 9:00. **New schedule** in the sidebar starts from the schedule, and the lead agent picks its team. Nobody may be watching, so by default anything outside the permission is refused automatically; times missed while Harness Relay was closed are skipped or sent once when it starts.
- **Approvals in the chat** — the permission (read-only / edit / full access) decides what agents may do without asking; anything beyond it is asked in the chat — allow once, always allow in this chat, or decline with a note.
- **See what agents think and do** — reasoning, plans / to-do lists and each tool's output stream into the chat.
- **Copy, edit and retry** — copy any message or the whole chat as Markdown; edit one of your messages, or retry an agent's reply, and the team answers again from there.
- **Clear status at a glance** — the sidebar marks conversations that need you, are replying, or have a new reply; conversations keep running when you switch away.
- **Groups and search** — make groups in the sidebar and drag conversations into them; the lead agent puts each new conversation in the group its first message fits (or leaves it in **Other**). Search finds conversations by anything written in them.
- **Tool library: MCP servers, skills and memory** — set them up once in Settings and agents get them whichever CLI they run on, in addition to each CLI's own setup. Give each to every member or only to the members of some CLIs, keep memory for everyone plus a part per CLI, and change it per member. Tokens go to your system's credential store.
- **Agent sessions in AgentsView (optional)** — give the CLIs a folder of their own for Harness Relay's runs (such as `~/.relay-agents`), apart from your own use of them, and see each conversation in [AgentsView](https://www.agentsview.io) as one thread, with every agent's own session (tool calls, tokens and cost) under it. Both are settings, so `npm start` stays the same on macOS, Linux and Windows. See the [user guide](docs/user-guide.md#agent-sessions-the-clis-own-folder-and-agentsview).
- **Browse the working directory** — **Files** in a conversation's header lists the working directory (or, in parallel mode, an agent's worktree) and previews code with line numbers and highlighting, Markdown, images and videos; any file can be downloaded, and any folder (the one you are in too) as a ZIP file.
- **Settings & login page** — sign in to each CLI separately (device code / browser / paste-code flows), set API keys, executable paths, default model and effort, and the lead agent, and see the skills, MCP servers and their tools, built-in tools, hooks, subagents, plugins, instructions and memory each CLI loads by itself, and leave them out of Harness Relay's runs, all of a kind or one by one.
- **English and 繁體中文** — the UI follows your browser language (switchable in Settings); a guided tour introduces the main features on the first visit.
- **Local-first** — everything is stored in a single SQLite file; the server only listens on `127.0.0.1`.
- **On your phone too** — share it with your [Tailscale](https://tailscale.com) tailnet through `tailscale serve` (HTTPS, your devices only), open it on your phone and add it to the home screen, on iOS and Android. See [Use it from your phone](docs/remote-access.md).

## Requirements

- Node.js **22.13+** (uses the built-in `node:sqlite`)
- The agent CLIs you want to use, installed and on your `PATH`:
  - [Claude Code](https://docs.claude.com/en/docs/claude-code) (`claude`)
  - [Codex CLI](https://github.com/openai/codex) (`codex`)
  - [Grok CLI](https://github.com/xai-org/grok-build) (`grok`)

You don't need all three — the app works with any subset, and you can sign in from the Settings page.

Voice input is optional and installs itself when you turn it on: on macOS it needs [Homebrew](https://brew.sh); on Linux the prebuilt engine needs glibc 2.34 or later (Ubuntu 22.04, Debian 12 and newer).

## Quick start

```bash
git clone https://github.com/Agentic-System-Lab/harness-relay
cd harness-relay
npm install
npm run build
npm start
```

Open **http://127.0.0.1:8787**, go to **Settings & Login** to check that each agent is signed in, then click **New chat**, choose the working directory and permission, and ask your first question: the lead agent proposes a team for it.

After a `git pull`, run `npm install` and `npm run build` again, then `npm start`.

To use it from your phone or another device, share it with your tailnet: see [Use it from your phone (Tailscale)](docs/remote-access.md).

Working on Harness Relay itself? Run `npm run dev` instead: the server restarts and the UI reloads as you edit, at http://localhost:5173. See the [developer guide](docs/developer-guide.md).

## Documentation

| | English | 繁體中文 |
| --- | --- | --- |
| User guide | [docs/user-guide.md](docs/user-guide.md) | [docs/user-guide.zh-TW.md](docs/user-guide.zh-TW.md) |
| Architecture | [docs/architecture.md](docs/architecture.md) | [docs/architecture.zh-TW.md](docs/architecture.zh-TW.md) |
| Developer guide | [docs/developer-guide.md](docs/developer-guide.md) | [docs/developer-guide.zh-TW.md](docs/developer-guide.zh-TW.md) |
| Use it from your phone (Tailscale) | [docs/remote-access.md](docs/remote-access.md) | [docs/remote-access.zh-TW.md](docs/remote-access.zh-TW.md) |
| Proposals (not implemented yet) | [docs/proposals/README.md](docs/proposals/README.md) | [docs/proposals/README.zh-TW.md](docs/proposals/README.zh-TW.md) |
| ↳ Scheduled and event-triggered runs | [docs/proposals/triggers.md](docs/proposals/triggers.md) | [docs/proposals/triggers.zh-TW.md](docs/proposals/triggers.zh-TW.md) |
| ↳ Shared memory across agents | [docs/proposals/shared-memory.md](docs/proposals/shared-memory.md) | [docs/proposals/shared-memory.zh-TW.md](docs/proposals/shared-memory.zh-TW.md) |
| ↳ Website previews and generative UI | [docs/proposals/preview-and-generative-ui.md](docs/proposals/preview-and-generative-ui.md) | [docs/proposals/preview-and-generative-ui.zh-TW.md](docs/proposals/preview-and-generative-ui.zh-TW.md) |

## Safety

Agents run with the file-system permission you choose for the conversation (**read-only**, **edit**, or **full access**). Full access lets agents run any command without asking — use it only in directories you trust. Edit mode does not sandbox project code either: tests, builds and project scripts run code the agents can change, so use read-only for code or instructions you don't trust. The server binds to `127.0.0.1` and rejects cross-site requests, but anyone with access to your machine's localhost can drive the agents. When you share it with your tailnet through `tailscale serve`, so can every device in that tailnet; don't expose it any other way (see [Use it from your phone](docs/remote-access.md#security)). See [Architecture → Security](docs/architecture.md#security).

API keys you save in Settings, and the values of MCP servers' environment variables and headers in the tool library, are kept in your operating system's credential store — the macOS Keychain, Windows Credential Manager, or the Secret Service (GNOME Keyring, KWallet) on Linux — not in the database. Only on a system without one, such as a headless Linux server, do they stay in `data/relay.db`, which only your user can read; to avoid that, set `ANTHROPIC_API_KEY` / `XAI_API_KEY` before starting Harness Relay instead of saving a key.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | For development: API server (port 8787, auto-restart) + Vite dev server (port 5173) |
| `npm run build` | Build the web UI into `dist/web` |
| `npm start` | Serve the built UI and the API from one process on http://127.0.0.1:8787 |
| `npm run typecheck` | Type-check server, client and tests |
| `npm test` | Run the test suite (Vitest) |
| `npm run site:preview` | Preview the website (`site/`) on http://127.0.0.1:4180 |
| `npm run icons` | Redraw the home-screen icons and the web app manifest in `src/web/public/` |

Every pull request and every push to `main` runs typecheck, tests and build on GitHub Actions ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)). The [website](https://agentic-system-lab.github.io/harness-relay/) is the static page in [`site/`](site/), published to GitHub Pages by [`.github/workflows/pages.yml`](.github/workflows/pages.yml).

## Contributing

Bug reports, ideas and pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) explains how to report a problem, set up the project and prepare a change; every change to user-facing text or docs comes in both English and 繁體中文.

## License

This project's code is licensed under the [Apache License 2.0](LICENSE).
