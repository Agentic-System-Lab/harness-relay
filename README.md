**English** | [繁體中文](README.zh-TW.md)

# Harness Relay

[![CI](https://github.com/Agentic-System-Lab/harness-relay/actions/workflows/ci.yml/badge.svg)](https://github.com/Agentic-System-Lab/harness-relay/actions/workflows/ci.yml)

**Website:** https://agentic-system-lab.github.io/harness-relay/

A local group chat for the real **Claude Code, Codex, Grok, Cursor and Antigravity** CLIs, and five open-source coding agents (**OpenCode, Goose, Cline, OpenHands and Pi**) on the model backends you choose: give each a role, choose how they take turns, and they work on your code, or any question, and answer each other.

For each question, a lead agent picks the team from your templates (or adapts one, or designs a new one), and you confirm it: a position for every agent (architect, builder, reviewer, skeptic…), its model and reasoning effort, and a mode (roundtable, parallel or relay). You design teams as templates. Harness Relay then runs `claude`, `codex`, `grok`, `cursor-agent` and `agy` with your own logins and tools, and the open-source CLIs on your API keys or your own model server, passes each agent the messages it hasn't seen yet, and streams everything into one chat.

## Demo

[![Harness Relay demo: you create a group and ask a question, the lead agent sorts the chat into the group and designs a team for the question, you confirm it, Claude Code, Codex and Grok read the code and answer, a follow-up question gets a team of its own, you open the code they discussed in the file browser, and a search finds the chat again](docs/media/demo-en.webp)](docs/media/demo-en.mp4)

## Features

- **Ten coding agents in one chat** — runs the `claude`, `codex`, `grok`, `cursor-agent` and `agy` CLIs you already have, with their own tools, sessions and logins, and the open-source `opencode`, `goose`, `cline`, `openhands` and `pi` CLIs. Mix them in one team.
- **Your own models** — the open-source agents run on the model backends you set up in Settings: API keys for OpenAI, Anthropic and xAI, or your own OpenAI-compatible endpoint (vLLM, Ollama, LM Studio, llama.cpp). A member's model is `backend/model`, such as `openai/gpt-5.4-nano` or `homelab/muse-glimmer-30b-nvfp4`. The Claude subscription and Grok's sign-in cannot be used by these CLIs (API keys only). Claude Code, Codex and Grok can run on your own endpoints too: give a member one of its models. See [Open-source agents and model backends](#open-source-agents-and-model-backends).
- **Design teams as templates** — roles, model, reasoning effort, turn order; five built-in templates (coding and general questions) to copy, and your own to add and change on the New chat page. The current team can be adjusted mid-chat, by hand or by telling the lead agent what to change.
- **Attach files** — paste screenshots, drop files or use 📎; every agent gets the files, and images are shown directly to the CLIs that take them.
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
- **Approvals in the chat** — the permission (read-only / edit / full access) decides what agents may do without asking; anything beyond it is asked in the chat — allow once, always allow in this chat, or decline with a note. The open-source agents ask through the same cards.
- **See what agents think and do** — reasoning, plans / to-do lists and each tool's output stream into the chat.
- **Copy, edit and retry** — copy any message or the whole chat as Markdown; edit one of your messages, or retry an agent's reply, and the team answers again from there.
- **Branch a conversation** — **Branch conversation** (the branch icon under an agent's reply) copies the chat up to that reply into a new conversation, to try another direction from there while the original stays as it was.
- **Share** — share the whole conversation, or everything up to one agent's reply, without tool calls and thinking: copy it as Markdown, or make a public link to a page that looks like the chat, with Harness Relay's name and logo, linking to its website (a secret gist made with your GitHub CLI, shown through gistpreview.github.io). The files the replies link to, of any kind (text, PDFs, slides, images…, up to 50 MB each), can go along in a second secret gist, the ones you choose, for anyone with the link to download. **Settings → Shared conversations** lists every link, to remove the ones that should go (both gists).
- **Clear status at a glance** — the sidebar marks conversations that need you, are replying, or have a new reply; conversations keep running when you switch away.
- **Groups and search** — make groups in the sidebar and drag conversations into them; the lead agent puts each new conversation in the group its first message fits (or leaves it in **Other**). In a group, each branch is listed under the conversation it was branched from, and they move between groups together. Search finds conversations by anything written in them.
- **Tool library: MCP servers, skills and memory** — set them up once in Settings and agents get them whichever CLI they run on, in addition to each CLI's own setup. Give each to every member or only to the members of some CLIs, keep memory for everyone plus a part per CLI, and change it per member. Tokens go to your system's credential store.
- **Agent sessions in AgentsView (optional)** — give the CLIs a folder of their own for Harness Relay's runs (such as `~/.relay-agents`), apart from your own use of them, and see each conversation in [AgentsView](https://www.agentsview.io) as one thread, with every agent's own session (tool calls, tokens and cost) under it (not Cursor's or Antigravity's, which AgentsView does not read). Both are settings, so `npm start` stays the same on macOS, Linux and Windows. See the [user guide](docs/user-guide.md#agent-sessions-the-clis-own-folder-and-agentsview).
- **Several working directories** — give a conversation up to eight folders: type each one and press Enter, pick from the ones in use, or choose them in your system's own folder dialog. The agents start in the first and get the others with the same access (Cursor works in the first one; in edit mode it asks you before writing in the others); each becomes a git repository with its own snapshots, and in parallel mode its own worktrees, so a team can work across repositories (an app and its docs, say) at once.
- **Browse the working directory** — **Files** in a conversation's header lists the working directory (or, in parallel mode, an agent's worktree) and previews code with line numbers and highlighting, Markdown, images and videos; any file can be downloaded, and any folder (the one you are in too) as a ZIP file.
- **Several accounts per CLI** — sign each CLI in to more than one account, say two Claude subscriptions, three ChatGPT accounts for Codex and three xAI accounts for Grok (Cursor keeps one sign-in per computer user, so its extra accounts sign in with an API key; Antigravity keeps its Google sign-in in the system keyring, so its extra accounts sign in with a Gemini API key), each with its own sign-in, API key, folder, default model and effort, and choice of what to leave out, and pick which account each team member (and the lead agent) runs as. See the [user guide](docs/user-guide.md#more-than-one-account).
- **Settings & login page** — sign in to each CLI separately (device code / browser / paste-code flows), set executable paths, the model backends and the lead agent, and for each account its API key and default model and effort; see the skills, MCP servers and their tools, built-in tools, hooks, subagents, plugins, instructions and memory each CLI loads by itself in each account, and leave them out of Harness Relay's runs, all of a kind or one by one (Cursor and Antigravity have no way to).
- **Report a problem** — the icon beside Settings in the sidebar writes the developer an email with your mail app or Gmail: your report filled in, with the version and system details; drag screenshots in, or upload them as a secret gist with `gh` for the mail to link to, and send it.
- **English and 繁體中文** — the UI follows your browser language (switchable in Settings); a guided tour introduces the main features on the first visit.
- **Local-first** — everything is stored in a single SQLite file; the server only listens on `127.0.0.1`.
- **On your phone too** — share it with your [Tailscale](https://tailscale.com) tailnet through `tailscale serve` (HTTPS, your devices only), open it on your phone and add it to the home screen, on iOS and Android. See [Use it from your phone](docs/remote-access.md).
- **Desktop app (optional)** — run it without a terminal on macOS, Windows or Linux: the chat in a window of its own, an icon in the menu bar or system tray that keeps the server running when the window is closed (so your phone works as before), open at login, keep the computer awake, and share with your phone in one click. See [Desktop app](#desktop-app).

## Requirements

- Node.js **22.13+** (uses the built-in `node:sqlite`)
- The agent CLIs you want to use, installed and on your `PATH`:
  - [Claude Code](https://docs.claude.com/en/docs/claude-code) (`claude`)
  - [Codex CLI](https://github.com/openai/codex) (`codex`)
  - [Grok CLI](https://github.com/xai-org/grok-build) (`grok`)
  - [Cursor CLI](https://cursor.com/cli) (`cursor-agent`)
  - [Antigravity CLI](https://antigravity.google/download) (`agy`; checked with 1.5.6 on macOS, Linux and Windows)
  - any of the five open-source agents below, with an API key or your own endpoint for them

You don't need them all — the app works with any subset: you sign in to Claude Code, Codex, Grok, Cursor and Antigravity (with your Google account or a Gemini API key) from the Settings page, and set up a model backend there for the open-source agents.

The open-source agents, with the versions Harness Relay was checked with (other versions may differ in what the adapters rely on):

| Agent | Install | Checked with |
| --- | --- | --- |
| [OpenCode](https://www.npmjs.com/package/opencode-ai) (`opencode`) | `npm install -g opencode-ai@1.19.5` | 1.19.5 |
| [Goose](https://formulae.brew.sh/formula/block-goose-cli) (`goose`) | `brew install block-goose-cli` | 1.58.1 |
| [Cline](https://www.npmjs.com/package/cline) (`cline`) | `npm install -g cline@3.0.74` | 3.0.74 |
| [OpenHands](https://pypi.org/project/openhands/) (`openhands`) | `uv tool install openhands==1.16.0` (needs [uv](https://docs.astral.sh/uv/)) | 1.16.0 |
| [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) (`pi`) | `npm install -g @earendil-works/pi-coding-agent@1.5.1` (needs Node.js 22.19 or later) | 1.5.1 |

Below full access they run in Harness Relay's own sandbox (see [Safety](#safety)). It needs nothing extra on macOS (in the [desktop app](#desktop-app), Node.js 22.12 or later on your `PATH`); on Linux install `bubblewrap`, `socat` and `ripgrep` (`sudo apt-get install bubblewrap socat ripgrep`), and on Ubuntu 23.10 or later add the AppArmor profile for `/usr/bin/bwrap` from [OS sandboxes by platform → On Linux](docs/sandboxing.md#on-linux). On native Windows they run only with full access (use WSL2 for a sandbox), and so does OpenCode on Linux (Harness Relay cannot watch its server there).

Voice input is optional and installs itself when you turn it on: on macOS it needs [Homebrew](https://brew.sh); on Linux the prebuilt engine needs glibc 2.34 or later (Ubuntu 22.04, Debian 12 and newer).

Sharing a conversation as a link is optional too: it needs the [GitHub CLI](https://cli.github.com) (`gh`) 2.66.0 or later, signed in with `gh auth login`, and `git` for the files that go along with the page.

## Quick start

```bash
git clone https://github.com/Agentic-System-Lab/harness-relay
cd harness-relay
npm install
npm run build
npm start
```

Open the sign-in link `npm start` prints in the terminal (`http://127.0.0.1:8787/#code=…`; Harness Relay takes only browsers that signed in, see [Safety](#safety)), go to **Settings & sign-in** to check that each agent is signed in (or set up a model backend for the open-source agents, below), then click **New chat**, choose the working directory and permission, and ask your first question: the lead agent proposes a team for it.

After a `git pull`, run `npm install` and `npm run build` again, then `npm start`.

To use it from your phone or another device, share it with your tailnet: see [Use it from your phone (Tailscale)](docs/remote-access.md).

Working on Harness Relay itself? Run `npm run dev` instead: the server restarts and the UI reloads as you edit, at http://localhost:5173. See the [developer guide](docs/developer-guide.md).

### Open-source agents and model backends

OpenCode, Goose, Cline, OpenHands and Pi have no sign-in in Harness Relay. They run on the **model backends** you set up under **Settings → Model backends**:

1. **API keys** — paste a key for OpenAI, Anthropic or xAI. Each key goes to your system's credential store, like the CLIs' API keys.
2. **Custom endpoints** — **Add endpoint** for your own OpenAI-compatible server (vLLM, Ollama, LM Studio, llama.cpp): a name, an id (the start of its models' ids, such as `homelab`), its base URL (such as `http://10.0.0.5:8000/v1`, or `http://localhost:11434/v1` for Ollama on this computer: a server on this computer needs its port in the address), the model names it serves (Harness Relay never asks it for them), and an API key if it needs one.
3. Give each open-agent member a model as `backend/model` in the team editor: `openai/…`, `anthropic/…`, `xai/…`, or an endpoint's id and a model name, such as `homelab/muse-glimmer-30b-nvfp4`. The model menus list the CLI's own models whose backend is set up, then each endpoint's; you can always type an id. A member left on *Default* runs on the default its menu shows: the one on the agent's card in Settings, else the CLI's own default model when that model's backend is set up; with neither, the menu says a model is needed.

An open agent is ready once its CLI is installed and at least one backend is set up. Each run gets only the key of its own model's backend, as saved here: never another backend's, and never a model provider's key from the server's environment (`OPENAI_API_KEY`, `GEMINI_API_KEY` and the like) or Cursor's and Antigravity's sign-in (`CURSOR_API_KEY`, `AGY_ADC_AUTH`). Other credentials there, such as `GITHUB_TOKEN` or AWS's variables, still reach these agents, as they do the other CLIs. The Claude subscription and Grok's sign-in cannot be used by these CLIs (Anthropic does not allow its subscription in third-party agents), so use an API key or your own endpoint for them.

**Claude Code, Codex and Grok on your own endpoints.** Their model menus list each custom endpoint's models after their own (`homelab/gemma4:e4b`, say): give a member one of them and that CLI runs on your server, with its key if it has one, and never with your Claude, ChatGPT or Grok sign-in (or their API keys). Each CLI speaks its own API, which the server must also serve: Claude Code the Anthropic Messages API (`/v1/messages`), Codex the Responses API (`/v1/responses`), Grok Chat Completions (`/v1/chat/completions`); vLLM, Ollama, LM Studio and llama.cpp serve all three. Claude Code and Codex then need no sign-in; Grok still needs its own to start. The efforts these runs send are ones every such server takes: Claude Code low to high, Codex none to high (medium in place of another, such as an `xhigh` from your Codex config), Grok none. For Grok, Harness Relay writes the endpoints' models into its `config.toml` (a marked block, hidden from Grok's own model picker) the first time a Grok member uses one.

| | Protocol | Approvals | Your decline note reaches the model | Sandbox needs (below full access) | Main limits |
| --- | --- | --- | --- | --- | --- |
| **OpenCode** | ACP (`opencode acp`) | Its rules are set to ask; Harness Relay decides and asks you | Yes | Its own server's loopback port | Below full access Harness Relay watches OpenCode's own server and stops the run if anything else drives it (on macOS its commands could read that server's password); its subagents are off below full access; its LSP and formatters are off |
| **Goose** | ACP (`goose acp`) | Asks about every tool call; in read-only, plain reading shell commands (`cat`, `ls`, `rg`…, only plain lines with options that neither write nor run another program: no expansions, globs or `xargs`, never git) run without asking | Yes, as a message right after Goose's own "declined" | macOS: the certificate-trust service with an HTTPS backend; the ports of local HTTP MCP servers | Its skills cannot be left out |
| **Cline** | ACP (`cline --acp`) | Asks about every tool call, reading included | No: its model sees only Cline's fixed "rejected" text (the note shows in the chat) | Nothing extra | No plan mode or to-do list; images go as their paths; project hooks and rules have no switch |
| **OpenHands** | ACP (`openhands acp`) | Asks about every action (calls it makes together come as one card listing them all); its subagents are removed below full access | No: only OpenHands' own fixed words | A pseudo-terminal (never tmux below full access); on macOS only with its switch in Settings, since the sandbox then opens every terminal: its commands could print into and read from your other terminal windows (not type into them) | **Stop** does not stop a running command (the process ends two seconds later; what it left is refused, never run, when the next turn resumes); project instructions and hooks always load |
| **Pi** | JSONL RPC (`pi --mode rpc`) | Below full access, Harness Relay's gate extension asks before each tool call (Pi has no prompts of its own) | Yes | Nothing extra | No plan or to-do list; instruction files only all together |

The details, agent by agent, are in [Open agents](docs/open-agents.md).


## Desktop app

Rather not keep a terminal open? The desktop app runs the same server in the background and shows the chat in a window of its own, signed in, with no address bar. Closing the window leaves the server running, with an icon in the menu bar (macOS) or the system tray (Windows, Linux), so your phone keeps working as before; its menu also opens the chat in your browser. It finds the agent CLIs the way your terminal does, can open at login and keep the computer awake, and its menu shares it with your phone through Tailscale in one step. When a newer version is out (a release, or for a release candidate also the next release candidate), its menu and the chat offer it, and the app updates itself. It needs the agent CLIs (and Git for edit and parallel modes) but not Node.js, except below full access for the open-source agents: Harness Relay's own sandbox runs with Node.js 22.12 or later from your login shell's `PATH`.

Download the installer for your system from the [website](https://agentic-system-lab.github.io/harness-relay/), which offers the newest release (never a release candidate), or from [Releases](https://github.com/Agentic-System-Lab/harness-relay/releases): a `.dmg` for macOS (Apple Silicon; Intel Macs run it from the source instead), an `.exe` for Windows, an `.AppImage` for Linux (for Windows and Linux, x64 or Arm64). The installers are not signed for distribution yet, so the system warns the first time; see [Desktop app](docs/user-guide.md#desktop-app) in the user guide. To build one yourself, run these in the clone after the quick start's `npm install` (the installer goes to `desktop/release/`):

```bash
npm install --prefix desktop
npm run desktop:dist
```

`npm start` and `npm run dev` work as before.

## Documentation

| | English | 繁體中文 |
| --- | --- | --- |
| User guide | [docs/user-guide.md](docs/user-guide.md) | [docs/user-guide.zh-TW.md](docs/user-guide.zh-TW.md) |
| Architecture | [docs/architecture.md](docs/architecture.md) | [docs/architecture.zh-TW.md](docs/architecture.zh-TW.md) |
| Developer guide | [docs/developer-guide.md](docs/developer-guide.md) | [docs/developer-guide.zh-TW.md](docs/developer-guide.zh-TW.md) |
| Use it from your phone (Tailscale) | [docs/remote-access.md](docs/remote-access.md) | [docs/remote-access.zh-TW.md](docs/remote-access.zh-TW.md) |
| Open agents (OpenCode, Goose, Cline, OpenHands, Pi) | [docs/open-agents.md](docs/open-agents.md) | [docs/open-agents.zh-TW.md](docs/open-agents.zh-TW.md) |
| OS sandboxes by platform | [docs/sandboxing.md](docs/sandboxing.md) | [docs/sandboxing.zh-TW.md](docs/sandboxing.zh-TW.md) |
| Adding a coding agent | [docs/adding-a-coding-agent.md](docs/adding-a-coding-agent.md) | [docs/adding-a-coding-agent.zh-TW.md](docs/adding-a-coding-agent.zh-TW.md) |
| Proposals (not implemented yet) | [docs/proposals/README.md](docs/proposals/README.md) | [docs/proposals/README.zh-TW.md](docs/proposals/README.zh-TW.md) |
| ↳ Scheduled and event-triggered runs | [docs/proposals/triggers.md](docs/proposals/triggers.md) | [docs/proposals/triggers.zh-TW.md](docs/proposals/triggers.zh-TW.md) |
| ↳ Shared memory across agents | [docs/proposals/shared-memory.md](docs/proposals/shared-memory.md) | [docs/proposals/shared-memory.zh-TW.md](docs/proposals/shared-memory.zh-TW.md) |
| ↳ Website previews and generative UI | [docs/proposals/preview-and-generative-ui.md](docs/proposals/preview-and-generative-ui.md) | [docs/proposals/preview-and-generative-ui.zh-TW.md](docs/proposals/preview-and-generative-ui.zh-TW.md) |

## Safety

Agents run with the file-system permission you choose for the conversation (**read-only**, **edit**, or **full access**). Full access lets agents run any command without asking — use it only in directories you trust. Below full access, the commands of every agent but Cursor and Antigravity run in an OS sandbox, which lets them write only in the working directory and the temp folders. Claude Code, Codex and Grok use their own: Codex's also keeps them off the network, and Claude Code's asks you about every host they reach. Grok's can block the network only on Linux, so in edit mode project code that Grok runs can still reach it: tests, builds and project scripts run code the agents can change, so use read-only for code or instructions you don't trust. On native Windows only Codex has a sandbox (see [OS sandboxes by platform](docs/sandboxing.md)). Cursor has none in the mode Harness Relay runs it in, on any system: below full access every command it wants to run asks you first (or is refused, if the conversation refuses automatically), except those on your Cursor team's auto-run allowlist, and a command you allow runs unsandboxed, with your rights, network included. Antigravity has none Harness Relay can use either (agy's own terminal sandbox, as it runs for Harness Relay, lets commands write nowhere in the working directory; checked with agy 1.5.6 on macOS): below full access every command it wants to run asks you first (or is refused), tests and builds included, and so does every write in read-only, and in edit mode a write outside the working directories or to what decides how agents run (`.agents`, `.gemini`, `.claude`, `.git/hooks`…); a command you allow runs unsandboxed, with your rights. After any refusal agy ends its turn at once (your decline note is shown in the chat only). The hooks and MCP servers it loads from `~/.gemini/config/` run outside any sandbox, and so would a project's own (in its `.agents` folder), which agy starts without asking: below full access Harness Relay asks you before agy starts when the working directories hold any. When you raise a conversation's permission, every agent, whichever CLI it runs on, starts a fresh session with the whole history at its next turn (kept per CLI), so a session that ran with less permission is never resumed with more; an open-source agent's state is emptied first, and the turn does not run if it cannot be. The sandboxes also keep agents out of your browsers' folders and Harness Relay's database (Cursor's own file tools only by deny rules, which Cursor matches against the path as written: another letter case of a protected path, or a link to one, gets past them; its commands only by asking; Antigravity by refusing what it asks to read or write there, a read through a link out of the working directory included, but it reads inside the working directory without asking, and its commands only by asking), and edit mode is refused in a working directory that holds Harness Relay itself, your home folder or a CLI's own folder. The server binds to `127.0.0.1`, rejects cross-site requests and takes only browsers you signed in: with the link it prints when it starts, with `npm run login`, or with a code from a signed-in browser (for your phone). So other programs on your computer, code the agents run included, cannot drive the agents through it, unless they can read your browser's data or write Harness Relay's `data/` folder (see [Signing in](docs/architecture.md#signing-in)). Share it only with your tailnet, through `tailscale serve`; don't expose it any other way (see [Use it from your phone](docs/remote-access.md#security)). See [Architecture → Security](docs/architecture.md#security).

The five open-source agents bring no sandbox of their own, so below full access Harness Relay runs each of them, and everything it starts, in [its own sandbox](docs/sandboxing.md#harness-relays-own-sandbox), built on [`@anthropic-ai/sandbox-runtime`](https://github.com/anthropics/sandbox-runtime) (Seatbelt on macOS, bubblewrap on Linux, and a filtering proxy for the network), one per run. It allows writes only to the run's own temp folder and that agent's own session and log folders, plus, in edit mode, the working directory and the conversation's attachments: in read-only an agent cannot write the working directory even when you allow an edit. It denies reading or writing your browsers' folders and Harness Relay's database, and writing the agent's own configuration, which Harness Relay writes before each run, so a run cannot widen the next one. On the network, the run's model backend is reachable without asking, and other hosts are asked about in the chat, except this computer's own addresses (or a name that leads to one), a few hosts an agent contacts by itself, and any past the 30th in a run, which are refused without asking; Harness Relay's own ports (`PORT`, 8787, 8789 and 5173: `npm start`'s and the desktop app's, and `npm run dev`'s API and Vite) are never reachable. When the sandbox cannot start, the turn fails instead of running without it; on native Windows these agents run only with full access, and so does OpenCode on Linux. A few agents need one narrow opening each, only for themselves: OpenCode, its own server's loopback port; Goose, on macOS, the certificate-trust service when it talks HTTPS (it could carry a little data out past the proxy), and connections to the ports of HTTP MCP servers on this computer (never listening on them); OpenHands, a pseudo-terminal (never tmux below full access), which on macOS opens every terminal of yours, so there it runs below full access only once you turn on its switch in Settings. Each conversation member's agent state (its sessions, logs and caches) is a folder of its own, which no run of another conversation or member can read or change, and which is removed with the conversation. When a run ends, the sandbox also stops what it started that left its process group, including after Harness Relay itself was killed (at its next start); on macOS a fully daemonized process that closes all its files is the exception. It does not limit reading the rest of the computer (`~/.ssh` included), and a model backend you allow is reachable in full; on macOS a command can also read the start-up environment of every process above it (the agent, Harness Relay's server, and the shell that started it), so start Harness Relay without API keys in its environment and keep them in Settings. See [Open agents → The relay sandbox](docs/open-agents.md#the-relay-sandbox).

API keys you save in Settings, and the values of MCP servers' environment variables and headers in the tool library, are kept in your operating system's credential store — the macOS Keychain, Windows Credential Manager, or the Secret Service (GNOME Keyring, KWallet) on Linux — not in the database. Only on a system without one, such as a headless Linux server, do they stay in `data/relay.db`, which only your user can read; to avoid that for Claude Code, Grok, Cursor and Antigravity, set `ANTHROPIC_API_KEY` / `XAI_API_KEY` / `CURSOR_API_KEY` / `GEMINI_API_KEY` before starting Harness Relay instead of saving a key (not on macOS with the open-source agents, whose sandboxed commands can read the server's start-up environment there). The open-source agents use only the keys saved under **Settings → Model backends**, kept the same way.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | For development: API server (port 8789, auto-restart) + Vite dev server (port 5173), so it runs beside the desktop app, or an `npm start` of another checkout, on 8787 (one server per data folder: beside an `npm start` of the same checkout it refuses to start) |
| `npm run build` | Build the web UI into `dist/web` |
| `npm start` | Serve the built UI and the API from one process on http://127.0.0.1:8787 |
| `npm run login` | Print a one-time link (and code) that signs a browser in, for when the one `npm start` printed is used or old |
| `npm run typecheck` | Type-check server, client and tests |
| `npm test` | Run the test suite (Vitest) |
| `npm run test:e2e` | Run the end-to-end tests: the UI in a browser against the real server, with fake CLIs (`npm run test:e2e:install` once) |
| `npm run test:e2e:live` | The same with the real CLIs on your own models (`E2E_LIVE_OLLAMA=<url>/v1`; see the developer guide, "Live tests"); not run on CI |
| `npm run site:preview` | Preview the website (`site/`) on http://127.0.0.1:4180 |
| `npm run icons` | Redraw the home-screen icons and the web app manifest in `src/web/public/` |
| `npm run demo` | Record the demo again with the real CLIs, in both languages, and update the videos, stills and the website's chapters |
| `npm run desktop` | Build the desktop app and run it without installing it (after `npm install --prefix desktop`) |
| `npm run desktop:dist` | Build the desktop app's installer for this system into `desktop/release/` |

Every pull request and every push to `main` runs typecheck, tests and build on GitHub Actions ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)), and the end-to-end tests on Linux, macOS and Windows ([`.github/workflows/e2e.yml`](.github/workflows/e2e.yml)). The [website](https://agentic-system-lab.github.io/harness-relay/) is the static page in [`site/`](site/), published to GitHub Pages by [`.github/workflows/pages.yml`](.github/workflows/pages.yml).

## Contributing

Bug reports, ideas and pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) explains how to report a problem, set up the project and prepare a change; every change to user-facing text or docs comes in both English and 繁體中文. Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md). Found a security problem? Report it privately, as [SECURITY.md](SECURITY.md) explains.

## License

This project's code is licensed under the [Apache License 2.0](LICENSE).
