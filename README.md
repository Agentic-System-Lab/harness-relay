**English** | [繁體中文](README.zh-TW.md)

# Harness Relay

**Website:** https://agentic-system-lab.github.io/harness-relay/

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/Agentic-System-Lab/harness-relay/tree/latest-release?quickstart=1)

**Try it for free without installing anything:** open the newest release in a GitHub codespace of your own, with the seven agent CLIs that are not open source installed and the app started, on an address only your GitHub account can open. See [Try it in GitHub Codespaces](docs/codespaces.md#steps).

---

[![Harness Relay demo: you create a group and ask a question, the lead agent sorts the chat into the group and designs a team for the question, you confirm it, Claude Code, Codex and Grok read the code and answer, a follow-up question gets a team of its own, you open the code they discussed in the file browser, and a search finds the chat again](docs/media/demo-en.webp)](docs/media/demo-en.mp4)

A local task assistant: the real **Claude Code, Codex, Grok, Cursor, Antigravity, Copilot and Muse Code** CLIs, and five open-source coding agents (**OpenCode, Goose, Cline, OpenHands and Pi**) on the model backends you choose, make up your team. Give each a role, choose how they take turns, and they work on your code, or any question, and answer each other.

For each question, a lead agent picks the team from your templates (or adapts one, or designs a new one), and you confirm it. Harness Relay then runs the CLIs with your own sign-ins and tools, passes each agent the messages it hasn't seen yet, and streams everything into one chat.

## Features

- **Twelve coding agents, one task assistant**: the CLIs you already have, with their own tools, sessions and sign-ins, and the open-source ones on your API keys or your own OpenAI-compatible server; mix them in one team. ([Signing in](docs/user-guide.md#2-sign-in-to-each-agent--settings--sign-in), [model backends](docs/user-guide.md#open-source-agents-and-model-backends))
- **A team for every question**: the lead agent picks or designs the team (roles, models, reasoning effort, turn order) from your templates, you confirm it, and once the team has answered it reviews the replies and marks what needs your attention. ([Auto team](docs/user-guide.md#auto-team), [templates](docs/user-guide.md#templates), [lead review](docs/user-guide.md#lead-review))
- **Agents talk to each other**: roundtable, parallel or relay, and `@mentions` to address one of them. ([Conversation rules](docs/user-guide.md#conversation-rules))
- **Safe editing with git**: each working directory (up to eight per chat) becomes a git repository, each reply shows the files it changed with a diff, and in parallel mode every agent works in its own worktree. ([Reviewing and applying changes](docs/user-guide.md#reviewing-and-applying-changes))
- **You stay in charge**: a permission per chat (read-only, edit, full access), approvals in the chat for anything beyond it, agents that ask you rather than guess, and messages you can send while they reply. ([Approvals](docs/user-guide.md#approvals), [chatting](docs/user-guide.md#4-chat))
- **Everything live**: replies, reasoning, plans and tool activity stream in; Mermaid diagrams, images and the files agents make show in the chat; copy, edit, retry or branch from any reply. ([Copying, editing and retrying](docs/user-guide.md#copying-editing-and-retrying), [branching](docs/user-guide.md#branching-a-conversation))
- **Harness Relay's own tools**: a browser of its own, mail and a calendar for every CLI's agents, through one MCP server; what reaches other people waits in an outbox until you send it. ([Harness Relay's tools](docs/user-guide.md#harness-relays-tools-browser-mail-and-calendar))
- **Schedules**: send the team a message at set times, such as a review of yesterday's commits every weekday at 9:00, or when a program on this computer calls the schedule's webhook; a schedule can track a goal across days until an agent says it is reached, and tries a failed run again. ([Schedules](docs/user-guide.md#schedules))
- **Files, voice and sharing**: attach files and screenshots, browse the working directory, dictate with voice input that stays on your computer, and share a chat as Markdown or a link. ([Browsing files](docs/user-guide.md#browsing-files), [voice input](docs/user-guide.md#voice-input), [sharing](docs/user-guide.md#sharing-a-conversation))
- **Organised**: groups, pinned chats at the top, search, each chat's status in the sidebar, and notifications and sound, as push notifications on a phone. ([Groups](docs/user-guide.md#groups), [pinned chats](docs/user-guide.md#pinned-conversations), [search](docs/user-guide.md#search), [notifications](docs/user-guide.md#notifications-and-sound))
- **Set up once for every CLI**: a CLI not found installs from its card in one click (and removes again), a tool library of MCP servers, skills and memory, several accounts per CLI, each account's plan usage, what each CLI loads by itself, and the agents' sessions in [AgentsView](https://www.agentsview.io). ([Installing a CLI](docs/user-guide.md#installing-a-cli-from-settings), [tool library](docs/user-guide.md#tool-library-mcp-servers-skills-and-memory), [accounts](docs/user-guide.md#more-than-one-account), [plan usage](docs/user-guide.md#plan-usage), [AgentsView](docs/user-guide.md#agent-sessions-the-clis-own-folder-and-agentsview))
- **Local-first, on your devices**: one SQLite file and a server on `127.0.0.1`; your phone through Tailscale; an optional desktop app; English and 繁體中文. ([Use it from your phone](docs/remote-access.md#1-share-the-server-with-your-tailnet), [desktop app](#desktop-app))

Every feature, step by step, is in the [user guide](docs/user-guide.md).

## Requirements

- Node.js **22.13+** (it uses the built-in `node:sqlite`).
- Any of the agent CLIs, installed and on your `PATH`, or [installed from Settings](docs/user-guide.md#installing-a-cli-from-settings) with one click; you don't need them all. [Installing the agent CLIs](docs/user-guide.md#installing-the-agent-clis) lists each one, how to install it, the versions checked, and what the sandboxes need (on Linux, `bubblewrap`, `socat` and `ripgrep` for the open-source agents), which [Settings can install](docs/user-guide.md#setting-up-the-sandboxes).
- [Git](https://git-scm.com/downloads), for edit and parallel modes.

## Quick start

```bash
git clone https://github.com/Agentic-System-Lab/harness-relay
cd harness-relay
npm install
npm run build
npm start
```

Open the sign-in link `npm start` prints in the terminal (`http://127.0.0.1:8787/#code=…`; Harness Relay takes only browsers that signed in, see [Safety](#safety)), check under **Settings & sign-in** that each agent is signed in (or set up a model backend for the open-source agents, below), then click **New chat**, choose the working directory and permission, and ask your first question: the lead agent proposes a team for it.

- After a `git pull`, run `npm install` and `npm run build` again, then `npm start`.
- To use it from your phone, share it with your tailnet: [Use it from your phone (Tailscale)](docs/remote-access.md#1-share-the-server-with-your-tailnet).
- Working on Harness Relay itself? Run `npm run dev` instead (at http://localhost:5173): see [Running](docs/developer-guide.md#running) in the developer guide.

### Open-source agents and model backends

OpenCode, Goose, Cline, OpenHands and Pi have no sign-in: they run on the model backends you set up under **Settings → Model backends**, an API key for OpenAI, Anthropic or xAI, or your own OpenAI-compatible server (vLLM, Ollama, LM Studio, llama.cpp). Give a member a model as `backend/model`, such as `openai/gpt-5.4-nano` or `homelab/muse-glimmer-30b-nvfp4`. The Claude subscription and Grok's sign-in cannot be used by these CLIs. Claude Code, Codex, Grok and Copilot can run on your own endpoints too.

How to set them up, and what to expect from each agent: [Open-source agents and model backends](docs/user-guide.md#open-source-agents-and-model-backends) in the user guide. How each one works: [OpenCode](docs/open-agents.md#opencode), [Goose](docs/open-agents.md#goose), [Cline](docs/open-agents.md#cline), [OpenHands](docs/open-agents.md#openhands) and [Pi](docs/open-agents.md#pi), in Open agents.

## Desktop app

Rather not keep a terminal open? The desktop app for macOS (Apple Silicon), Windows and Linux runs the same server in the background and shows the chat in a window of its own. Closing the window leaves the server running behind an icon in the menu bar or system tray, so your phone keeps working. It can open at login, keep the computer awake, share with your phone in one click, and updates itself. It needs the agent CLIs (and Git) but not Node.js, except for the open-source agents' sandbox.

Download it from the [website](https://agentic-system-lab.github.io/harness-relay/) or [Releases](https://github.com/Agentic-System-Lab/harness-relay/releases). The installers are not signed yet, so the system warns the first time: [Desktop app](docs/user-guide.md#desktop-app) in the user guide says what to do, how updates work and how to build one yourself.

## Safety

Agents can change your files and run commands, so Harness Relay keeps them within the bounds you set:

- **A permission per conversation**: read-only, edit or full access. Full access lets agents run any command without asking, so use it only in directories you trust; below it, anything beyond the permission is asked in the chat.
- **OS sandboxes below full access**: Claude Code, Codex, Grok, Copilot and Muse Code use their own, and the five open-source agents run in [Harness Relay's own](docs/sandboxing.md#harness-relays-own-sandbox). Cursor and Antigravity have none Harness Relay can use, so every command they want to run asks you first (for Cursor, all but those on your Cursor team's auto-run allowlist). The sandboxes differ, above all on the network (in edit mode, project code that Grok or Copilot runs can still reach it), and fewer of them work on native Windows, so use read-only for code or instructions you don't trust. Platform by platform: [OS sandboxes by platform](docs/sandboxing.md#platforms); CLI by CLI: [Architecture → Permission mapping](docs/architecture.md#permission-mapping).
- **Places agents cannot reach**: below full access, your browsers' folders and Harness Relay's database; and edit mode is refused in a folder that holds Harness Relay itself, your home folder or a CLI's own folder. ([What agents may not read or write](docs/sandboxing.md#what-agents-may-not-read-or-write))
- **Only your browsers**: the server binds to `127.0.0.1`, rejects cross-site requests and takes only browsers you signed in. Share it only with your tailnet, through `tailscale serve`. ([Architecture → Security](docs/architecture.md#security), [Use it from your phone → Security](docs/remote-access.md#security))
- **Keys in your credential store**: API keys and MCP servers' secret values go to the macOS Keychain, Windows Credential Manager or the Secret Service on Linux; on a system without one, into the database, encrypted. ([API keys](docs/user-guide.md#api-keys-optional))

## Scripts

| Command | What it does |
| --- | --- |
| `npm start` | Serve the built UI and the API from one process on http://127.0.0.1:8787 |
| `npm run login` | Print another one-time sign-in link, for when the one `npm start` printed is used or old |
| `npm run dev` | For development: the API server (port 8789, auto-restart) and Vite (port 5173) |
| `npm run format:check`, `npm run typecheck`, `npm test`, `npm run build` | What CI runs for every pull request (`npm run format` formats the code with Prettier) |

The other commands (end-to-end tests, the desktop app, the website, the demo) are in the [developer guide](docs/developer-guide.md#running), with what [CI](docs/developer-guide.md#continuous-integration) runs.

## Documentation

| | English | 繁體中文 |
| --- | --- | --- |
| User guide | [docs/user-guide.md](docs/user-guide.md) | [docs/user-guide.zh-TW.md](docs/user-guide.zh-TW.md) |
| Architecture | [docs/architecture.md](docs/architecture.md) | [docs/architecture.zh-TW.md](docs/architecture.zh-TW.md) |
| Developer guide | [docs/developer-guide.md](docs/developer-guide.md) | [docs/developer-guide.zh-TW.md](docs/developer-guide.zh-TW.md) |
| Use it from your phone (Tailscale) | [docs/remote-access.md](docs/remote-access.md) | [docs/remote-access.zh-TW.md](docs/remote-access.zh-TW.md) |
| Try it in GitHub Codespaces | [docs/codespaces.md](docs/codespaces.md) | [docs/codespaces.zh-TW.md](docs/codespaces.zh-TW.md) |
| Open agents (OpenCode, Goose, Cline, OpenHands, Pi) | [docs/open-agents.md](docs/open-agents.md) | [docs/open-agents.zh-TW.md](docs/open-agents.zh-TW.md) |
| OS sandboxes by platform | [docs/sandboxing.md](docs/sandboxing.md) | [docs/sandboxing.zh-TW.md](docs/sandboxing.zh-TW.md) |
| Adding a coding agent | [docs/adding-a-coding-agent.md](docs/adding-a-coding-agent.md) | [docs/adding-a-coding-agent.zh-TW.md](docs/adding-a-coding-agent.zh-TW.md) |
| End-to-end test scenarios | [e2e/README.md](e2e/README.md) | [e2e/README.zh-TW.md](e2e/README.zh-TW.md) |
| Desktop app, for developers | [desktop/README.md](desktop/README.md) | [desktop/README.zh-TW.md](desktop/README.zh-TW.md) |
| Proposals (not implemented yet) | [docs/proposals/README.md](docs/proposals/README.md) | [docs/proposals/README.zh-TW.md](docs/proposals/README.zh-TW.md) |

## Contributing

Bug reports, ideas and pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) explains how to report a problem, set up the project and prepare a change; every change to user-facing text or docs comes in both English and 繁體中文. You can also [report a problem](docs/user-guide.md#reporting-a-problem) from the app. Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md). Found a security problem? Report it privately, as [SECURITY.md](SECURITY.md#reporting-a-vulnerability) explains.

## License

Harness Relay's code is licensed under the [Sustainable Use License](LICENSE) (version 1.0, written by n8n; SPDX [`SUL-1.0`](https://spdx.org/licenses/SUL-1.0.html)), a [fair-code](https://faircode.io/) license. You may use and change it for your own internal business purposes, at work included, or for personal or non-commercial use, and share it, changed or not, free of charge for non-commercial purposes, with its terms (and a notice saying you changed it, if you did). You may not sell it: neither charge for copies of it nor offer it to others for a fee, as a hosted service, say. It is source-available software, not open source as the Open Source Initiative defines it. The libraries and fonts it includes keep their own licenses. This is a summary; the terms are those in [LICENSE](LICENSE).
