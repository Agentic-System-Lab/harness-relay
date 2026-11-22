**English** | [繁體中文](README.zh-TW.md)

# Harness Relay

**Website:** https://agentic-system-lab.github.io/harness-relay/

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/Agentic-System-Lab/harness-relay/tree/latest-release?quickstart=1)

**Try it for free without installing anything:** open the newest release in a GitHub codespace of your own, with the seven agent CLIs that are not open source installed and the app started, on an address only your GitHub account can open. See [Try it in GitHub Codespaces](docs/codespaces.md#steps).

---

[![Harness Relay demo: you create a group and ask a question, the lead agent sorts the chat into the group and designs a team for the question, you confirm it, Claude Code, Codex and Grok read the code and answer, a follow-up question gets a team of its own, you open the code they discussed in the file browser, and a search finds the chat again](docs/media/demo-en.webp)](docs/media/demo-en.mp4)

A local task assistant: the real **Claude Code, Codex, Grok, Cursor, Antigravity, Copilot and Muse Code** CLIs, and five open-source coding agents (**OpenCode, Goose, Cline, OpenHands and Pi**) on the model backends you choose, make up your team. Give each a role, choose how they take turns, and they work on your code, or any question, and answer each other.

For each question, a lead agent picks the team from your templates (or adapts one, or designs a new one), and you confirm it. Harness Relay then runs the CLIs with your own sign-ins and tools, passes each agent the messages it hasn't seen yet, and streams everything into one chat.

## Contents

- [Use cases](#use-cases)
- [Features](#features)
- [Requirements](#requirements)
- [Quick start](#quick-start)
  - [Model connections](#model-connections)
- [Desktop app](#desktop-app)
- [Safety](#safety)
- [Scripts](#scripts)
- [Documentation](#documentation)
- [Discussions](#discussions)
- [Contributing](#contributing)
- [License](#license)

## Use cases

These twelve examples are just a starting point. Bring your curiosity and a task of your own, and see what else your team can do. Each example has a recording of the real run, with chapters, on the [website](https://agentic-system-lab.github.io/harness-relay/use-cases/).

- **[Fix a bug three ways, keep the best one](https://agentic-system-lab.github.io/harness-relay/use-cases/#fix-a-bug)**: in parallel mode, Claude Code, Codex and Grok each fix a failing test in a git worktree of its own; you read the diffs and apply one to your working directory.
- **[Turn customer interviews into a spec](https://agentic-system-lab.github.io/harness-relay/use-cases/#product-spec)**: attach five customer interviews; in relay mode one agent pulls out the pain points, the next writes the PRD, the last challenges it, and before the PRD is written they ask you which customers come first.
- **[Read the competition, then write the launch](https://agentic-system-lab.github.io/harness-relay/use-cases/#launch-copy)**: read-only, the agents read three competitors’ pricing pages in Harness Relay’s own browser and write taglines and a launch post in turn; a branch of the conversation tries another voice.
- **[Close the month: three reconciliations, compared](https://agentic-system-lab.github.io/harness-relay/use-cases/#reconcile-accounts)**: attach a bank statement and a cash ledger; in parallel mode three agents reconcile them on their own, read-only, and lead review compares what each found and marks what to confirm yourself.
- **[Chase overdue invoices until they are settled](https://agentic-system-lab.github.io/harness-relay/use-cases/#collect-payments)**: an automation every weekday at 09:00, with a goal to track, reads your mail with Harness Relay’s own tools and writes the reminders, which wait in the outbox until you press Send; it stops once every invoice is settled.
- **[Walk into every customer call prepared](https://agentic-system-lab.github.io/harness-relay/use-cases/#call-brief)**: half an hour before each customer call on your calendar, an automation opens a new chat with the event as data; read-only, the agents read the last meeting’s notes and the customer’s mail with Harness Relay’s own tools, work out the usage numbers, and one plays the customer’s CFO.
- **[What the research says, with every source](https://agentic-system-lab.github.io/harness-relay/use-cases/#literature-review)**: three agents research the studies independently in a read-only workspace, then compare evidence and write a summary with links to the sources. The lead agent flags claims to verify.
- **[Write a quiz, and try it on a student first](https://agentic-system-lab.github.io/harness-relay/use-cases/#write-a-quiz)**: attach a chapter; in relay mode one agent writes the quiz and its key, the next takes it as a student would, the last marks it, ready to send any unclear question back to be rewritten.
- **[Redline a contract, on your own model server](https://agentic-system-lab.github.io/harness-relay/use-cases/#contract-review)**: every agent, the lead agent included, runs on Qwen3.8 27B served by your own vLLM; in relay mode one edits each clause of a vendor’s draft that departs from your playbook, the next checks every edit, the last writes the memo, and the reply’s diff is the redline.
- **[Triage an alert the moment it fires](https://agentic-system-lab.github.io/harness-relay/use-cases/#triage-an-alert)**: an automation with a webhook opens a new chat each time your monitoring calls it; read-only, the agents read the alert, the logs and the deploys and name the likely cause, and the bell tells you when they are done.
- **[Review the screens before the usability test](https://agentic-system-lab.github.io/harness-relay/use-cases/#design-review)**: attach three screenshots; in parallel mode each agent reviews them from its own angle (accessibility, layout, the words), read-only, and lists the issues to fix first.
- **[Translate the moment the English changes](https://agentic-system-lab.github.io/harness-relay/use-cases/#translate-strings)**: an automation waits for `locales/en.json` to change; in relay mode Antigravity translates the new strings into Traditional Chinese and Japanese, Copilot translates them back without the English, and Claude Code checks them, while a note you send mid-reply reaches them.

## Features

- **Twelve coding agents, one task assistant**: the CLIs you already have, with their own tools, sessions and sign-ins, and the open-source ones on your API keys or your own OpenAI-compatible server; mix them in one team. ([Signing in](docs/user-guide.md#2-sign-in-to-each-agent--settings--sign-in), [API keys and endpoints](docs/user-guide.md#model-connections))
- **A team for every question**: the lead agent picks or designs the team (roles, models, reasoning effort, turn order) from your templates, you confirm it, and once the team has answered it reviews the replies and marks what needs your attention. ([Auto team](docs/user-guide.md#auto-team), [templates](docs/user-guide.md#templates), [lead review](docs/user-guide.md#lead-review))
- **Team checks**: set protected paths, a commit format and commands such as `npm test` for your whole team in Edit and Full access chats. Harness Relay checks the work itself, and runs hooks around supported tool calls. ([Team checks](docs/user-guide.md#team-checks))
- **Agents talk to each other**: roundtable, parallel or relay, and `@mentions` to address one of them. ([Conversation rules](docs/user-guide.md#conversation-rules))
- **Safe editing with git**: each working directory (up to eight per chat) becomes a git repository, each reply shows the files it changed with a diff, in parallel mode every agent works in its own worktree, and a chat started while another one changes the same folder works in a worktree of its own. ([Reviewing and applying changes](docs/user-guide.md#reviewing-and-applying-changes), [Two chats in one folder](docs/user-guide.md#two-chats-in-one-folder))
- **You stay in charge**: a permission per chat (read-only, edit, full access), approvals in the chat for anything beyond it, agents that ask you rather than guess, and messages you can send while they reply. ([Approvals](docs/user-guide.md#approvals), [chatting](docs/user-guide.md#4-chat))
- **Everything live**: replies, reasoning, plans and tool activity stream in; Mermaid diagrams, images and the files agents make show in the chat; copy, edit, retry or branch from any reply. ([Copying, editing and retrying](docs/user-guide.md#copying-editing-and-retrying), [branching](docs/user-guide.md#branching-a-conversation))
- **Harness Relay's own tools**: a browser of its own, mail and a calendar for the agents of every CLI (Grok's, Muse Code's, and the open-source agents' but OpenCode's, in full access only), through one MCP server; what reaches other people waits in an outbox until you send it. Microsoft 365, Outlook.com and Google calendars and mail sign in in the browser (OAuth), their tokens kept from the agents. ([Harness Relay's tools](docs/user-guide.md#harness-relays-tools-browser-mail-and-calendar))
- **Automations**: send the team a message when you run one, at set times (a review of yesterday's commits every weekday at 9:00), when something happens (a new mail, an event about to begin, a pull request or a failed CI run, a file; Harness Relay checks it itself), or when a program on this computer calls its webhook; an automation can track a goal across days until an agent says it is reached, and tries a failed run again. ([Automations](docs/user-guide.md#automations))
- **Files, voice and sharing**: attach files and screenshots, browse the working directory, dictate with voice input that stays on your computer, and share a chat as Markdown or a link. ([Browsing files](docs/user-guide.md#browsing-files), [voice input](docs/user-guide.md#voice-input), [sharing](docs/user-guide.md#sharing-a-conversation))
- **Organised**: groups, pinned chats at the top, search, each chat's status in the sidebar, notifications and sound, as push notifications on a phone, and a bell that keeps every notification, the same in every browser. ([Groups](docs/user-guide.md#groups), [pinned chats](docs/user-guide.md#pinned-conversations), [search](docs/user-guide.md#search), [notifications](docs/user-guide.md#notifications-and-sound), [notification inbox](docs/user-guide.md#notification-inbox))
- **Apps and tools** lets you connect common apps, choose which assistants can use them, and review proposed messages, Google Docs edits and Obsidian note changes in the outbox. [Connect common apps](docs/user-guide.md#common-apps)
- **The agents' own features**: per account, each CLI's own subagents and Claude Code's workflows on or off; a subagent's steps shown under the step that started it; a message sent straight into the speaking member's running turn; context windows for your own models; a member's own limit. ([Subagents and workflows](docs/user-guide.md#subagents-and-workflows))
- **Labs**: experimental ways for agents to use Harness Relay's tools, off by default and one at a time: script them in Harness Relay's own sandbox (CodeAct), or read a long text in parts with a model you choose (RLM), each with what it costs. ([Labs](docs/user-guide.md#labs))
- **Long-term memory**: what agents learn in one chat (your preferences and decisions, facts they checked) is kept as notes for later chats, shown in each reply, yours to change, and tidied by the lead agent now and then. ([Long-term memory](docs/user-guide.md#long-term-memory))
- **Set up once for every CLI**: a CLI not found installs from its card in one click (and removes again), a tool library of MCP servers (those that sign in with OAuth signed in from it), skills and memory, several accounts per CLI, each account's plan usage, what each CLI loads by itself, and the agents' sessions in [AgentsView](https://www.agentsview.io). ([Installing a CLI](docs/user-guide.md#installing-a-cli-from-settings), [tool library](docs/user-guide.md#tool-library-mcp-servers-skills-and-memory), [accounts](docs/user-guide.md#more-than-one-account), [plan usage](docs/user-guide.md#plan-usage), [AgentsView](docs/user-guide.md#agent-sessions-the-clis-own-folder-and-agentsview))
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

Open the sign-in link `npm start` prints in the terminal (`http://127.0.0.1:8787/#code=…`; Harness Relay takes only browsers that signed in, see [Safety](#safety)), then open **Settings & sign-in** to find a ready assistant or connect one. Choose **Start a new chat**, enter your question, check the working directory and permission, and send. You can review the proposed team before it answers or let it start right away.

- After a `git pull`, run `npm install` and `npm run build` again, then `npm start`.
- To use it from your phone, share it with your tailnet: [Use it from your phone (Tailscale)](docs/remote-access.md#1-share-the-server-with-your-tailnet).
- Working on Harness Relay itself? Run `npm run dev` instead (at http://localhost:5173): see [Running](docs/developer-guide.md#running) in the developer guide.

<a id="open-source-agents-and-model-backends"></a>
<a id="open-source-agents-and-custom-models"></a>
<a id="api-keys-and-endpoints-for-open-source-agents"></a>

### Model connections

In **Settings → Model connections**, **API keys for open-source assistants** lets OpenCode, Goose, Cline, OpenHands and Pi use an OpenAI, Anthropic or xAI key. Those five agents and Claude Code, Codex, Grok and GitHub Copilot can also use **Custom endpoints**. Expand it to connect your own OpenAI-compatible server (vLLM, Ollama, LM Studio or llama.cpp). Enter its base URL and optional key, click **Load models**, select the models you want and click **Save**. Relay checks selected and manually entered IDs. If the server offers no model metadata, Relay asks before saving the IDs unverified. Give a member a model as `backend/model`, such as `openai/gpt-5.4-nano` or `homelab/muse-glimmer-30b-nvfp4`. The Claude subscription and Grok sign-in are unavailable to these five open-source agents.

How to set them up, and what to expect from each agent: [Model connections](docs/user-guide.md#model-connections) in the user guide. How each one works: [OpenCode](docs/open-agents.md#opencode), [Goose](docs/open-agents.md#goose), [Cline](docs/open-agents.md#cline), [OpenHands](docs/open-agents.md#openhands) and [Pi](docs/open-agents.md#pi), in Open agents.

## Desktop app

Rather not keep a terminal open? The desktop app for macOS (Apple Silicon), Windows and Linux runs the same server in the background and shows the chat in a window of its own. Closing the window leaves the server running behind an icon in the menu bar or system tray, so your phone keeps working. It can open at login, keep the computer awake, share with your phone in one click, and updates itself. The app can install the agent CLIs from Settings and offers to [install Git when needed](docs/user-guide.md#conversation-rules). The open-source agents’ sandbox may need Node.js.

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

The other commands (end-to-end tests, the desktop app, the website, the demo, [checking an agent CLI's new version](docs/developer-guide.md#checking-a-clis-new-version)) are in the [developer guide](docs/developer-guide.md#running), with what [CI](docs/developer-guide.md#continuous-integration) runs.

## Documentation

To learn to use Harness Relay, start with the [docs on the website](https://agentic-system-lab.github.io/harness-relay/docs/), a page per task. The documents below go into every detail, and into how it works.

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

## Discussions

Questions, ideas and what you made with Harness Relay are welcome in [GitHub Discussions](https://github.com/Agentic-System-Lab/harness-relay/discussions). To report a bug, open an [issue](https://github.com/Agentic-System-Lab/harness-relay/issues/new/choose) instead.

- [Q&A](https://github.com/Agentic-System-Lab/harness-relay/discussions/categories/q-a): ask how to do something, or why it works as it does
- [Ideas](https://github.com/Agentic-System-Lab/harness-relay/discussions/categories/ideas): suggest a feature or a change, and talk it over
- [Show and tell](https://github.com/Agentic-System-Lab/harness-relay/discussions/categories/show-and-tell): share a team, a template or a way of working you made
- [Announcements](https://github.com/Agentic-System-Lab/harness-relay/discussions/categories/announcements): releases and news from the maintainers
- [Polls](https://github.com/Agentic-System-Lab/harness-relay/discussions/categories/polls): vote on questions put to everyone
- [General](https://github.com/Agentic-System-Lab/harness-relay/discussions/categories/general): anything else

## Contributing

Bug reports, ideas and pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) explains how to report a problem, set up the project and prepare a change; every change to user-facing text or docs comes in both English and 繁體中文. You can also [report a problem](docs/user-guide.md#reporting-a-problem) from the app. Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md). Found a security problem? Report it privately, as [SECURITY.md](SECURITY.md#reporting-a-vulnerability) explains.

## License

Harness Relay's code is licensed under the [Sustainable Use License](LICENSE) (version 1.0, written by n8n; SPDX [`SUL-1.0`](https://spdx.org/licenses/SUL-1.0.html)), a [fair-code](https://faircode.io/) license. You may use and change it for your own internal business purposes, at work included, or for personal or non-commercial use, and share it, changed or not, free of charge for non-commercial purposes, with its terms (and a notice saying you changed it, if you did). You may not sell it: neither charge for copies of it nor offer it to others for a fee, as a hosted service, say. It is source-available software, not open source as the Open Source Initiative defines it. The libraries and fonts it includes keep their own licenses. This is a summary; the terms are those in [LICENSE](LICENSE).
