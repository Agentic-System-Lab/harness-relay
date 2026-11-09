**English** | [繁體中文](user-guide.zh-TW.md)

# User guide

This guide walks through installing Harness Relay, signing in to the agents, designing a team (or letting the lead agent design it), and chatting with it.

## 1. Install and start

You need Node.js 22.13 or newer and at least one of the agent CLIs (`claude`, `codex`, `grok`) installed.

```bash
npm install
npm run build
npm start
```

Open **http://127.0.0.1:8787**. After a `git pull`, run `npm install` and `npm run build` again, then `npm start`. (To work on Harness Relay itself, run `npm run dev` instead and open http://localhost:5173; see the [developer guide](developer-guide.md).)

The dots at the bottom of the sidebar show each agent's status: green = ready, orange = not signed in, red = CLI not found.

To use Harness Relay from your phone, a tablet or another computer, share it with your tailnet through `tailscale serve` and add it to the phone's home screen: see [Use it from your phone (Tailscale)](remote-access.md). On the computer, Chrome and Edge can also install it as an app (the install button in the address bar), and Safari on macOS can add it to the Dock (**File → Add to Dock**).

### Language and the guided tour

The UI is available in **English** and **繁體中文**. On your first visit it follows your browser's language (any Chinese → 繁體中文, otherwise English) and remembers the choice in this browser; switch any time under **Settings & sign-in → Language**. Error messages and system notes from the server follow the same language.

The first visit also opens a short **guided tour** that points out the main features step by step (← / → to move, Esc to skip). When an update changes the tour (for example to show new features), it opens once more on your next visit. Replay it any time from **Settings & sign-in → Guided tour**.

## 2. Sign in to each agent — Settings & sign-in

Click **⚙ Settings & sign-in** in the sidebar. Each CLI has its own card showing version, account and status.

### Signing in

Pick a method and click **Sign in**. Harness Relay runs that CLI's own login command and shows what you need:

| Agent | Method | What to do |
| --- | --- | --- |
| Claude Code | Claude subscription / Anthropic Console | Open the link, authorise, then paste the code the page shows into the box and click **Submit**. |
| Codex | ChatGPT device code | Open the link, sign in to ChatGPT and enter the one-time code shown (click it to copy). |
| Codex | ChatGPT browser sign-in | A browser opens on this machine; finish signing in there. |
| Grok | xAI device code / xAI browser sign-in | Open the link and confirm the code. |

The panel turns green with **Signed in ✓** when the CLI finishes. Expand **CLI output** to see the raw output if something goes wrong.

> **Codex:** starting a new Codex sign-in signs out the current Codex account first. The page asks for confirmation.

**Sign out** signs the CLI out on this machine, which also affects other places you use that CLI.

### API keys (optional)

Under **API key** on each card:

- **Claude Code** — passed as `ANTHROPIC_API_KEY` (API billing; it takes precedence over your subscription login).
- **Grok** — passed as `XAI_API_KEY`.
- **Codex** — handed to `codex login --with-api-key`; Codex stores it and it replaces the ChatGPT login.

Harness Relay keeps the Claude Code and Grok keys in your system's credential store, filed under `harness-relay`: the macOS Keychain, Windows Credential Manager, or the Secret Service on Linux (GNOME Keyring, KWallet). The card says where. On a system without one — such as a Linux server with no desktop session — keys are kept in the database instead, readable only by your user; if you'd rather not, leave the field empty and set `ANTHROPIC_API_KEY` / `XAI_API_KEY` in the environment before starting Harness Relay. Keys saved by an earlier version are moved out of the database the next time the server starts. macOS may ask whether `node` may use the key (for example after Node.js is updated); choose **Always Allow**.

### Default model and reasoning effort

Under **Default model and reasoning effort** choose what an agent uses when its own model/effort is left on *Default*. Leaving these on **CLI default** uses the CLI's own configuration (for example `~/.codex/config.toml`). The same section lets you set a custom **Executable** path if the CLI is not on your `PATH`.

### Lead agent

**✦ Lead agent** picks the CLI (and optionally the model and effort) that designs the team in [Auto team](#auto-team) conversations, and that sorts new conversations into your [groups](#groups). Choose one that is signed in; a small, fast model is usually enough.

**Default working directory** sets the folder new conversations start in. If the folder does not exist yet, Harness Relay asks whether to create it (so does the working directory of a new conversation, or one you change under the team settings).

### What each CLI loads by itself

Each CLI's card has **Skills, MCP servers, hooks, memory and more this CLI loads by itself**: open it and click **Ask** to see that CLI's own setup for the default working directory, separate from the tool library, in a tab each: its **Skills** (with where they come from), its **MCP tools** (each MCP server with its state when the CLI reports it, and the tools it offers), its **Built-in tools** (Claude Code), its **Hooks** (when each runs and where it is set, never its command), its **Subagents** (Claude Code and Grok), its **Plugins**, and the **Instructions** and **Memory** files it reads. Harness Relay asks the CLI without sending a prompt, so no model is called: Claude Code and Codex start their MCP servers while they answer, and Claude Code runs your hooks. To list its tools, Claude Code is sent `/usage`, a command it answers by itself (nothing is spent, and no session is saved); if you have a skill or command named `usage`, that is skipped and the built-in tools are not listed. Opening the section does not ask, so you can change what is left out without starting the CLI. Claude Code and Codex give no list of their instruction files, so those are the files they are documented to read that exist. Click a file, or a skill with a path, to read it (Markdown rendered or as source).

Each tab also leaves things out of every run Harness Relay starts of this CLI: members' turns, the lead agent, and sorting conversations into groups. **Leave all out** at the top of a tab leaves out all of its kind; once the CLI has been asked, the box on each item leaves out just that one, where the CLI can do that. Every change is saved at once, the tab shows what it leaves out, and the section's title shows how many are left out in all. With **Leave all out** on, the items ticked in that tab are kept and apply again when it is cleared. The CLI's own settings files are not changed, so using it in a terminal is not affected, and the tool library's items are still provided. When something is left out, **Ask** also asks the CLI again the way Harness Relay starts it, and marks **left out** each item it then does not load, so you can see what a run actually gets (denying Claude Code's `Bash`, for example, also takes its `Monitor` tool); an item you ticked that the CLI still loads is marked **still loaded**. Ticked items the answer no longer lists (gone since, or a file or skill of a project other than the default working directory) are counted under the list, with a button to clear them. If you change what is left out after asking, ask again; if asking again runs out of time, what the CLI had answered is still marked and the rest is named. What each CLI can leave out:

- **Claude Code**: all of every kind, and one by one: skills by name (plugin and custom commands are listed with them), MCP servers and each of their tools, built-in tools, instruction files, subagents (the built-in ones too) and plugins. Its hooks have no names and its auto memory is one store, so those only all at once. **Leave all out** for skills also covers plugin and custom commands; for MCP, its own servers do not start at all and only the tool library's stay, while a single server you tick still starts and only its tools are kept from the agents (a tool library server of the same name keeps its tools); for built-in tools, agents can then only talk and use MCP tools (tools Harness Relay turns off for the permission stay off whatever is set here, and an agent left with no tool that reads files is not told about the tool library's skills); for instruction files, its `CLAUDE.md` files and rules at every level; for memory, its auto memory; for hooks, those in its settings files and plugins; for subagents, your own and plugins' (the built-in ones stay, unless one of yours or a project's replaces one of them by name: then that name has no subagent in the run); for plugins, every installed plugin with its skills, subagents, hooks and MCP servers. If Claude Code cannot list its plugins, or its subagents cannot be left out (an older Claude Code), the run fails with a message saying so instead of loading them.
- **Codex**: all of a kind, and one by one: skills, the MCP servers in your config files and each of their tools, hooks and plugins. Its MCP switch also turns off ChatGPT apps; servers that come with plugins are set on the Plugins tab. Instruction files are the project's `AGENTS.md` files, all at once: Codex still reads its own `~/.codex/AGENTS.md`. Hooks include plugins' hooks; plugins go with their skills, MCP servers and hooks. If Codex still loads skills, hooks or plugins you left out (an older Codex that does not know the setting), the run fails with a message saying so. Codex lists no subagents and has no switch for its own. Codex keeps the skills list (plugins' skills among them), instruction files and memory a chat started with, so changes to those take effect in new chats; changes to MCP servers, their tools and hooks take effect at the next turn. If Codex cannot list its MCP servers, the run fails with a message saying so instead of running them.
- **Grok**: only all at once, and skills, MCP servers and hooks only the ones it takes from Claude Code and Cursor (a project's `.claude/skills` and its Claude Code plugins' skills among them, but not their hooks). The skills Grok finds by itself still load — `~/.agents/skills`, `~/.grok/skills`, a project's `.grok/skills` and `.agents/skills`, and its built-in ones: list their names in `skills.disabled` in `~/.grok/config.toml` to turn them off, and turn off its own MCP servers there too. That file is Grok's own global setting: what you change there also applies when you use Grok in a terminal, and Harness Relay does not change it. Grok has no switch for one run for single items, instruction files or its plugins (`plugins.disabled` in `~/.grok/config.toml`), and none that leaves out only its own subagents (its subagents switch turns off the built-in ones too).

Grok reads a project's own `AGENTS.md` / `CLAUDE.md`, skills, MCP servers and hooks only in a folder you trusted. When it does not trust the folder, the Grok card says so, and so does the team editor under the working directory when the team has a Grok member. When you start a new chat whose team has a Grok member in such a folder, you are asked first: **Trust and start**, **Start without trusting**, or **Cancel**. Grok decides trust for the whole project: when the working directory is inside a git repository, the folder trusted is the repository's root (links resolved), and the confirmation says so. **Trust this folder** asks you to confirm that folder, then records the trust the same way `grok --trust` does (in `~/.grok/trusted_folders.toml`, or `$GROK_HOME`). Only trust projects you trust: Grok then also runs the project's hooks. The tool library's items reach Grok either way. **Ask again** refreshes the answer (it is kept for a minute).

The links at the top of Settings stay in view while you scroll, highlight the card you are reading, and jump to each card; each card's title links to itself (for example `#/settings/tools`), so you can bookmark a card. Links elsewhere in the app (a CLI that is not signed in, the lead agent, voice input, the tool library) open the right card.

### Tool library: MCP servers, skills and memory

**Settings → Tool library** sets up tools once for every agent, whichever CLI it runs on. They are given in addition to each CLI's own setup (your `~/.claude`, `~/.codex/config.toml`, `~/.grok` settings keep working), and changes reach an agent at its next turn.

- **MCP servers** — **Add MCP server**, give it a name (letters, digits, `_` and `-`), then either a **local command** (stdio: the command, one argument per line, environment variables) or a **URL** (Streamable HTTP, with HTTP headers). The values of environment variables and headers are usually tokens: they are kept in your system's credential store (like API keys), and the page only shows them masked. When you edit a server, leave a value empty to keep it. Tool calls follow the conversation's permission like any other action: anything beyond it asks you in the chat (or is refused, if the conversation refuses automatically).
- **Skills** — enter a folder with a `SKILL.md`, or a folder of skills (for example `~/.claude/skills`), and click **Add**. When there is more than one skill, every skill in it (the folder itself, and skill folders up to two levels down) is listed: tick the ones to add, or filter and **Select all**. These skills come in addition to each CLI's own: a skill a CLI reads by itself (Claude Code and Grok read `~/.claude/skills`) keeps working whether or not you add it here; adding it here lets every CLI use it and lets you choose who gets it. Each agent's briefing lists the skills' names and descriptions (from the front matter of `SKILL.md`), and the agent reads a skill's `SKILL.md` when a task calls for it. A skill whose `SKILL.md` is gone, or whose name another skill already has, is marked and not given.
- **Memory** — notes put in agents' briefings in every conversation, such as your preferences and project conventions. **All members** is for everyone; the **Claude Code**, **Codex** and **Grok** tabs are only for that CLI's agents and come after the shared part.

**Given by default to** — each MCP server and skill is given to the agents of the CLIs you pick: all three (the default), some, or none (then only to members you tick in the team settings). To change it for one member, see **Tools** under [Team members](#team-members).

### Agent sessions: the CLIs' own folder and AgentsView

**Settings → Agent sessions** has two optional settings. Harness Relay keeps them with its other settings, so you start it with `npm start` (or `npm run dev`) as usual, on macOS, Linux and Windows alike.

**The CLIs' own folder** — by default each CLI uses its usual home (`~/.claude`, `~/.codex`, `~/.grok`), the one you also use when you run it yourself. Enter a folder here (a full path, or one that starts with `~`), or click **Use ~/.relay-agents**, and Harness Relay gives each CLI a home of its own in it: the `claude`, `codex` and `grok` subfolders. Each CLI's sign-in, settings and session records then go there, apart from your own use of the CLIs.

- Sign in to each CLI again (in its card above, or set an API key): the new homes start empty.
- The CLIs no longer read the settings, MCP servers, skills, memory and plugins in your usual homes. The [tool library](#tool-library-mcp-servers-skills-and-memory) still gives its tools to every agent.
- Agents start a fresh session at their next turn, with the conversation's full history: their earlier sessions stay in the old homes.
- The session records are in `claude/projects/`, `codex/sessions/` and `grok/sessions/` in that folder.

Pick a folder outside your projects: Harness Relay refuses one inside its own folder or the default working directory, whose snapshots would take in the CLIs' sign-ins and session records. The folder can't be changed while a conversation runs. Empty the field to go back to the usual homes.

**AgentsView** — [AgentsView](https://www.agentsview.io) is a free tool for browsing agent sessions on your computer: every message, tool call, token and cost. Enter its address here and Harness Relay sends it the conversation after every turn, and when you rename it. Each conversation becomes one session in AgentsView, named after the conversation, with each agent's own session nested under it (the lead agent's and the group sorter's too) and their costs added up. Only addresses on this computer are accepted. When an update fails (for example, AgentsView is not running), the card says why; the chat is not affected.

- Conversations from before you set the address are sent at their next turn.
- Deleting a conversation in Harness Relay leaves what was sent in AgentsView; remove it there if you like.
- **Address to open it (optional)** — **Open AgentsView** opens the address above. To open AgentsView from another device, such as your phone over [Tailscale](remote-access.md#5-browse-agentsview-too-optional), enter that address here instead. Conversations are still sent to the address above.

To see only Harness Relay's sessions in AgentsView, set the CLIs' own folder (above), then run an AgentsView of its own that reads only that folder:

1. Install AgentsView (see [its quick start](https://www.agentsview.io/docs/quickstart/)).
2. Create the file `.relay-agents/agentsview/config.toml` in your home folder:

   ```toml
   [agents.claude]
   dirs = []
   homes = ["~/.relay-agents/claude"]

   [agents.codex]
   dirs = []
   homes = ["~/.relay-agents/codex"]

   [agents.grok]
   dirs = ["~/.relay-agents/grok/sessions"]
   ```

   AgentsView also reads the default folders of the other tools it supports (Cursor, Gemini CLI…) when they exist on your computer. To leave them out, list them in `disabled_agents` (see [AgentsView's configuration](https://www.agentsview.io/docs/configuration/)).
3. Start it with its data in that folder, on a port of your choice (9999 here). macOS and Linux:

   ```bash
   AGENTSVIEW_DATA_DIR=~/.relay-agents/agentsview agentsview serve --port 9999
   ```

   Windows PowerShell:

   ```powershell
   $env:AGENTSVIEW_DATA_DIR = "$HOME\.relay-agents\agentsview"
   agentsview serve --port 9999
   ```

   Windows Command Prompt:

   ```bat
   set AGENTSVIEW_DATA_DIR=%USERPROFILE%\.relay-agents\agentsview
   agentsview serve --port 9999
   ```

   Add `--background` to keep it running after you close the terminal; `agentsview serve stop` (with the same `AGENTSVIEW_DATA_DIR`) stops it.
4. In **Settings → Agent sessions → AgentsView**, enter `http://127.0.0.1:9999` and click **Save**.

AgentsView hides sessions with only one message from the user by default. A conversation with a single message of yours shows up after your next message, or when you turn on **Include single-turn** in AgentsView's session filter.

To browse AgentsView from your phone too, see [Use it from your phone](remote-access.md#5-browse-agentsview-too-optional).

## 3. Design the team — New chat

Click **＋ New chat**. Under **How to build the team**, choose **Auto team** or **Design your own** — or pick one of the **Templates** below them. Adjust the team if you like, and click **Start chat →**. The page remembers your last choice.

**Design your own** starts from a blank team: one member for each CLI that is ready to use, with empty roles. Write each member's position, add or remove members, and set the conversation rules (see [Team members](#team-members) and [Conversation rules](#conversation-rules)).

Below the conversation rules, **Save as template** saves the current members and rules as a template, which then appears under **Templates** for new chats.

### Auto team

With **Auto team** you don't design the team yourself. Start by describing what you need (the work, the expertise it takes) instead of asking a question. The **lead agent** (see [Lead agent](#lead-agent)) reads it together with every template in full (built-in and your own: members, roles, mode and rounds), and then either uses a template as it is, adapts one to the question (for example adds or drops a member, rewrites roles, or changes the mode or rounds), or designs a new team from scratch. Nobody answers yet: you review the team first.

- You choose only the **working directory** and the **file permission**; the lead agent cannot change the permission.
- Click **Confirm team** on the card, and then ask your first question; until then the sidebar marks the conversation **Confirm the team**. You can write your first question before confirming (even while the lead agent is still designing): it waits above the message box and goes to the team as soon as you confirm. Setting the team yourself with **Adjust team** also counts as confirming. The team sees your description as context. To have the team designed again, edit your description.
- The decision appears in the chat as a **Team design** card: the template it used, the template it adapted, or its new team; why (why the template fits, what it changed, or why no template fits); and each member's full role, folded to a few lines when long (**Show more** shows the rest). **Adjust team** opens the team settings.
- When the lead agent designed or adapted a team, the card asks whether to keep it: **Save as template** saves it (you can rename it), and it then shows up on the New chat page. A template used as it is is already saved, so the card doesn't ask.
- If the lead agent's answer can't be used (or its CLI fails), the General-question panel is used instead and the card says why. If you press **Stop** while it is designing, the next message designs the team again.
- Members that would run on a CLI that isn't signed in are moved to the lead agent's CLI.
- Editing your description (see [Copying, editing and retrying](#copying-editing-and-retrying)) designs the team again, to be confirmed again — unless you changed the team after it was designed, in which case your team answers.

### Templates

| Template | Mode | Team |
| --- | --- | --- |
| Architect → Builder → Reviewer | Relay, edit | Claude plans, Codex implements, Grok reviews; they hand off with `@` |
| Three-way debate | Roundtable ×2, read-only | Proposer, pragmatist and skeptic — for design and technology choices |
| Parallel comparison | Parallel, read-only | All three solve the same problem independently |
| General-question panel | Roundtable, read-only | Analyst → Critic → Synthesizer; for any question, not just code |
| Pair programming + QA | Roundtable, edit | Navigator guides, Driver codes, QA tests |

Choosing a template fills in the team below; you can change anything, then save the result with **Save as template**. Saved templates can be deleted with ×. Built-in templates follow the UI language.

### Team members

Each card is one agent:

- **@name** — the handle used for `@mentions`. Letters, digits, `_` and `-` (Chinese characters work too), unique within the team.
- **Claude Code / Codex / Grok** — which CLI runs this agent. You can have several agents on the same CLI (e.g. two Claude agents with different roles).
- **Position / role** — free text describing the agent's position and responsibilities. This is the most important field: tell the agent what it owns, what it should *not* do, and whom to hand off to.
- **Model** — models reported by the CLI, or **Custom…** to type an id. *Default* uses the default from Settings, or the CLI's own default.
- **Reasoning effort** — only levels the selected model supports are listed (e.g. low / medium / high / xhigh). Switching to a model that doesn't support the chosen level resets it to default.
- **↑ ↓** — reorder. Order is the speaking order in roundtable mode, and the first agent is the **leader** in relay mode.
- **Tools** — what this member gets from the [tool library](#tool-library-mcp-servers-skills-and-memory), as chips; **Change** opens the list to tick them. Ticks start from the library's defaults for the member's CLI (items not given to that CLI by default say so), and the memory tab of another CLI is not listed. Renaming a server or a skill keeps the choices. With an empty library, a link takes you to it. These come in addition to the CLI's own skills and MCP servers, which keep working.

Add members with **＋ Claude Code / ＋ Codex / ＋ Grok** (up to 8).

### Conversation rules

**Mode**

| Mode | Behaviour | Good for |
| --- | --- | --- |
| Roundtable | Agents speak in order; each sees what earlier speakers said. Set the number of rounds (1–5); the run ends early when everyone in a round replies `[PASS]`. | Discussions, reviews, refining an answer |
| Parallel | All agents answer at the same time, independently. In later rounds they see the previous round's answers. | Comparing approaches, getting independent opinions |
| Relay | One agent at a time. An agent hands the floor to a teammate by `@mentioning` them; if it mentions nobody, the floor returns to you. Set the maximum number of hand-offs per message (1–30). | Pipelines: plan → implement → review |

**Working directory** — the folder all agents work in. They share it.

**File permission** — what every agent in the conversation may do **without asking**:

| Level | Runs without asking |
| --- | --- |
| Read-only | Reading, searching and looking things up on the web. |
| Edit | Also editing files in the working directory and running project commands such as tests and builds (Claude Code: a list of common ones; Codex: anything inside its sandbox, which has no network). Pushing and publishing are not included. |
| Full access | Everything, without asking. Use only in directories you trust. |

Edit is meant for code you trust: tests, builds and project scripts run code the agents can edit, so an agent could still reach the network through them (Codex's sandbox prevents that). For code or instructions you don't trust, use read-only, or refuse actions beyond the permission. In read-only mode Claude Code's file-editing tools are switched off completely.

**Actions beyond the permission** — **Ask me** (default): when an agent wants to do something the permission doesn't cover, the chat asks you (see [Approvals](#approvals)). **Refuse automatically**: such actions are refused right away; the agent is told and tries another way. (Not shown for full access.)

**Git and file safety (edit / full access).** If the working directory is not a git repository yet, Harness Relay runs `git init` there automatically (never in your home directory or a whole drive). A working directory inside a repository that spans your home directory (such as a dotfiles repository) is refused, because every turn would record the whole folder. It never commits to your branch. Then:

- **Roundtable / relay** — agents take turns editing the working directory directly. Each reply records which files that agent changed. While such a conversation is running, other conversations cannot write to the same directory (you get an "is changing" message).
- **Parallel** — each agent works in its **own copy** (a git worktree) so they can't overwrite each other. The working directory is not touched until you choose a result and apply it (see [Reviewing and applying changes](#reviewing-and-applying-changes)).

## 4. Chat

- **Send** with Enter; Shift+Enter for a new line. While typing with an input method (e.g. Chinese), Enter confirms the candidate and does not send. On a phone or tablet, Enter starts a new line and the **↑** button sends (with a hardware keyboard, ⌘/Ctrl+Enter sends too). Your messages keep their line breaks as typed; agent replies are formatted as Markdown.
- **Attach files** — paste an image (such as a screenshot) straight into the message box, drag files onto it, or click 📎. Up to 10 files of 20 MB each per message, with or without text. Every agent that reads the message gets each file's path to open with its own tools, and images (PNG, JPEG, GIF, WebP) are also shown to it directly. Sent images appear as thumbnails (click to open the full image); other files as chips you can download.
- **Long questions** are folded to their first lines in the chat; click **Show more** to read the whole message (and **Show less** to fold it again).
- **`@mention`** — type `@` to pick a teammate. When your message mentions agents, **only those agents reply** (in relay mode they start the relay). Without mentions, the whole team takes part according to the mode. Text may follow the name directly (`@Builder請實作`); mentions inside code are ignored.
- **Streaming** — replies appear as they're written. Tool activity (file reads, edits, shell commands) is grouped in a collapsible row; a spinning icon shows the step in progress, and a refused or failed step shows its reason. The team chips under the title highlight who is speaking; with a large team the row scrolls sideways (the mouse wheel works too) and follows the speaker. Images and videos an agent saved in the working directory and embedded in its reply (`![chart](out/chart.png)`) are shown in the chat: click an image to open it full size, and videos play in place. Images from websites are shown as links and are never loaded automatically. Files an agent made for you, such as a PDF, slides or a spreadsheet, are links with a download arrow (`[Slides](out/deck.pptx)`): click one to save the file to the device you are using, the computer or a phone through Tailscale. Only files in the working directory (or the agent's worktree) can be downloaded; agents are told to save them there and link them. A link to a file that isn't there says so (**⚠ Cannot download …** after it); click it again once the agent has made the file. Mermaid code blocks are drawn as diagrams: **Source** shows the code, **Copy** copies it, and clicking the diagram switches between fit-to-width and actual size. A table too wide for the chat scrolls sideways: short cells stay on one line and longer ones wrap at a readable width, instead of every column being squeezed to a letter per line. Code blocks scroll sideways too.
- **Add to the discussion while they reply** — the message box stays open while the team is replying. Enter puts your message in a tray above the box; it reaches the next agent before its turn (in parallel mode, before the next round), and whoever was speaking sees it on their next turn. A message that @mentions someone waits for that agent's turn (and messages sent after it wait behind it, so the chat keeps your order). If no turn takes it before the run ends, the team answers it in a new run. In the chat it is marked **Added mid-reply**. Until it is delivered you can **Edit** it (its text goes back into the box) or **Withdraw** it.
- **Stop and ask this instead** — ⌘+Enter (Ctrl+Enter on Windows and Linux) while the team is replying stops it and sends your message right away, after any messages that were waiting; **Stop and send now** on the tray does the same for the waiting messages.
- **■ Stop** — stops the current run and kills the agents' processes. Messages that were waiting stay in the tray (**Not delivered yet**): send them, edit them or withdraw them; your next message or **Continue** sends them first.
- **Continue ↻** — lets the team go on without a new message (another set of rounds, or another relay starting from the leader). Useful after a relay hits its hand-off limit.
- **Passed replies** — an agent with nothing to add replies `[PASS]`; it is shown dimmed as *Nothing to add (PASS)*.
- **Questions to you** — when a good answer depends on something only you know (your situation, goal or preference), an agent asks you first instead of guessing, and the team stops: nobody else speaks, the question is marked **Waiting for your answer**, and the sidebar shows **Answer needed**. Reply in the message box: the agent that asked answers first, with your answer in hand, and then the rest of the round goes on (in parallel mode the ones that asked answer again before the next round; in relay mode the floor goes back to the one that asked). A reply that @mentions someone other than the one that asked starts afresh. **Skip question** (or **Skip, let the team go on** on the question) lets the others go on without your answer. Messages you sent while that agent was replying wait for your answer, and go out with it.
- **What agents think and do** — an agent's reasoning appears in a collapsed **Thinking** row (its latest line is visible while it streams; click to read all of it), its plan / to-do list as a checklist that updates as it works, and each tool step can be expanded to see its output.
- Each reply shows its duration, and cost and tokens when the CLI reports them.

### Approvals

When an agent wants to do something its permission doesn't cover — install a package, run a command in read-only mode, push code, write outside the working directory — its reply shows a card: what it wants to do (the exact command, file or URL) and why. The agent waits until you answer:

- **Allow** — just this once.
- **Always allow "…" in this chat** — this and later requests like it (for commands: the same program and subcommand, e.g. `npm install`; a chained command is only allowed when every part is) are allowed without asking for the rest of the conversation.
- **Decline** — optionally type what it should do instead first; the agent gets your message and carries on.

A banner above the message box points to waiting requests; the sidebar marks the conversation **Needs you** and the browser tab title shows how many conversations need you. Pressing **■ Stop** declines everything still waiting, and a request whose agent stopped (it crashed or timed out) expires. If you allow something in a read-only conversation while another conversation is changing the same directory, it is declined and the agent is told why. Codex runs commands in its sandbox and asks only when it decides it needs more than the sandbox allows.

### Reviewing and applying changes

When an agent changes files, its reply ends with a card listing the files (A added, M modified, D deleted, with lines added/removed):

- **View this turn's diff** — what the agent changed in this turn.
- In parallel mode the card says **in worktree** with the agent's branch, and the agent's latest card also has:
  - **View @name's full result** — everything this agent changed since the round started;
  - **Apply to working directory** — copies that result into your working directory. Nothing is committed: review the changes with your usual tools and commit them yourself.

After you apply one result, the other agents' results are marked as out of date, and the next parallel round starts every agent from the updated directory. If your working directory changed in a way that conflicts with the result, nothing is applied and you get an explanation; ask an agent to redo the work on top of the current state.

### Editing the team mid-chat

Click **Team settings** in the header to change roles, models, effort, mode, permission or working directory. Changes apply from the next turn. Changing an agent's CLI makes that agent start a new session and re-read the chat history. Settings can't be saved while the team is replying.

### Schedules

**Schedule** in the header sends the team a message at set times, in this conversation, as if you had sent it — for example "@Reviewer look at the pull requests merged yesterday and list the risks" every weekday at 09:00.

- **Message** — what to send. As usual, when you @mention members, only they answer.
- **When** — **Once** (a date and time), **Every day** or **Every week** (pick the days) at a time, or **Every few hours** (counted from when you set its times; changing only the message keeps the rhythm). The next three times and the time zone are shown before you save; times are in the schedule's time zone, and on a device in another zone you can switch it to that device's.
- **Actions outside the permission** — in the runs the schedule starts, nobody may be watching: by default anything an agent wants to do beyond the conversation's permission is **refused automatically** (the agent is told and works around it, and the chat shows what was refused), except what you have already allowed always in this chat. Choose **Ask me** to be asked in the chat as usual; the agent then waits for you (up to 45 minutes per turn). As soon as you write into a scheduled run, it asks you as usual. A conversation set to refuse automatically, or with full access, is not changed by this.
- **Missed times** — Harness Relay only sends while it is running. A time missed while it was closed or the computer slept is **skipped**, with a note in the chat, or **sent once when it starts** (only once, however many were missed).
- **On** — untick it to pause the schedule without deleting it.

The header shows the schedule (point at it for the next time), and the sidebar shows a clock next to the conversation; both turn amber when the last time was not sent. A message the schedule sent is marked **Scheduled**. A scheduled message waits while the team is replying, like one you send then; it is held back (with a note) while an agent waits for your answer (it never counts as your answer), while the team is still to be confirmed, or while the previous scheduled message is still waiting for the team. If the team was stopped with a scheduled message still waiting, it goes out at the next time. When another conversation is changing the same folder, it is tried again for up to 30 minutes. If you answer an agent's question while a scheduled message waits, your answer goes first and the scheduled message follows; if it is for an agent who does not speak in that run, it then gets a run of its own, which refuses approvals like any scheduled run unless the schedule says to ask. **Run once now** sends it right away to try it out; **Delete schedule** removes it. A conversation has one schedule, and you need a confirmed team to turn it on. With a schedule on, **Team settings** reminds you that your changes apply to its runs, and warns when the team has full access.

### Browsing files

**Files** in the header opens the conversation's working directory: folders first, a filter for the folder you are in, and ↑ to go up. Click a file to preview it: code with line numbers and highlighting, Markdown rendered (or its source), images and videos. **Download** saves any file to the device you are using, also one that cannot be previewed, such as a PDF or slides. **Copy path** copies the file's full path. In parallel mode you can also pick an agent's worktree, to look at its result before you apply it. Only what is inside the chosen folder is shown, `.git` folders are left out, and files over 512 KB show their beginning. On a phone, the list and the preview take turns; **Back to the list** returns.

### Copying, editing and retrying

- **Copy** under a message (shown when you point at it) copies that message's text as Markdown, exactly as it was written: links keep their full URLs, and formatting, tables, code and line breaks stay as they are (also when you open the app over plain http, for example from a phone). Selecting text yourself copies what is shown instead (a link's text without its URL). **Copy chat** in the header copies the whole conversation, with each message labelled by who said it (the name and CLI the agent had then); a code block a stopped reply left open is closed. Tool activity is left out.
- **Edit** under one of your own messages lets you change it and send it again (Enter sends, Shift+Enter adds a line, Esc cancels; on a phone or tablet Enter adds a line and **Send** sends). Everything after that message is deleted and the team answers again from there; every agent starts a fresh session and re-reads the history up to your edited message. Files the deleted replies changed are **not** restored — if any of them changed files you are asked to confirm first. Editing is not available while the team is replying.
- **↻ Retry** under an agent's reply lets that agent answer again. Its reply and everything after it are deleted (you are asked to confirm when there is anything after it); outside relay mode, the later speakers of the same round answer again too.

### Voice input

Press 🎙 next to Send and speak; press it again (it shows a red timer while recording) and the text appears where the cursor is, so you can fix it, add an `@mention` and send it yourself. Esc cancels a recording, and one recording lasts at most two minutes. Speech is turned into text on your computer by whisper.cpp; the recording is never uploaded.

Voice input is optional. The first time you press 🎙, a dialog explains what will be downloaded and where it goes:

- **The engine** (whisper.cpp) — on macOS it is installed with Homebrew (`brew install whisper-cpp`) and uses the GPU (Metal); on Linux and Windows Harness Relay downloads the official build (about 5–10 MB), which runs on the CPU. If you have whisper.cpp already, it is used.
- **A model** — pick one; the dialog suggests the best fit for your computer (Large v3 Turbo on Apple silicon, Small elsewhere).

Click **Download and install** and keep working: it installs in the background (a dot on 🎙 shows it), and **Settings → Voice input** shows each step, the download progress and the installer's output, with **Cancel install**. Every file is checked against its known contents (SHA-256) before it is used.

In **Settings → Voice input** you can also install it from scratch, download and switch models (**Download and use**, **Use**, **Remove**), choose the spoken language (follow the UI language, auto-detect, Chinese written in Traditional characters, or English), point to your own `whisper-server`, and **Remove voice input** to delete what was downloaded. The engine starts the first time you speak and stops after 10 idle minutes, which frees the memory the model takes.

### Conversation list

The sidebar lists conversations in their [groups](#groups), newest first, each with its state:

| Badge | Meaning |
| --- | --- |
| **Needs you** (orange) | An agent is waiting for your approval. |
| **Confirm the team** (orange) | The lead agent designed a team; confirm it, then ask your first question ([Auto team](#auto-team)). |
| **Replying** (blue, pulsing) | The team is working. |
| **New reply** (green, bold title) | It finished while you were looking at something else. |
| **Error** (red) | The last reply ended with an error you haven't looked at yet. |

A clock before the time means the conversation has a [schedule](#schedules) (point at it for the next time); it is amber when the last time was not sent. Conversations keep running when you switch to another one (or close the tab); the badges update by themselves. Click the title in the chat header to rename; hover a conversation and click × to delete it. A conversation with a large team shows its first few member dots and a **+N** count.

To make room, collapse the sidebar with the panel button next to *Harness Relay*. Three buttons stay in the top-left corner: one brings the sidebar back, one starts a new chat, and one opens the sidebar with [search](#search) ready. The choice is remembered in this browser. (On a phone the sidebar is a drawer opened with ☰ instead, and the page does not zoom: no pinch or double-tap zoom, and no zooming in on the message box. On a phone or tablet the header is a single row: the title with **Copy chat**, **Files**, **Schedule** and **Team settings** (icons on a phone: two sheets, a folder, a clock, two people; the clock is blue while a schedule is on); the team, its mode and its permission are under **Team settings**, except that a red **Full access** tag beside the title warns when the agents may run any command. The message box stays one line until you type, and its buttons move below the text when they would leave it too little room.)

### Groups

Click **New group** under **New chat**, type a name and press Enter. Groups appear in the order you made them, and **Other** — the default group, which always exists — comes last: conversations in no group are there.

- **Move a conversation**: drag it onto a group (the group lights up), or hover it, click the folder button and pick a group. On a phone or tablet, where dragging does not work, the folder button is always shown.
- **Sorted for you**: when a new conversation gets its first message and you have groups, the lead agent ([Settings → Lead agent](#lead-agent)) reads the message, next to the team, and puts the conversation in the group it fits; while it decides, the conversation says **Sorting…**. When no group fits it stays in **Other**. This happens once per conversation, and never moves a conversation you have already moved yourself. With no groups, nothing is asked.
- **Rename or delete a group**: hover its name and click the pencil or ×. Deleting a group moves its conversations to **Other**; they are not deleted. Names must be different from each other and from **Other**.
- **Collapse a group**: click its name. A collapsed group shows the dot of its most urgent conversation (needs you, replying, error, new reply). Collapsed groups are remembered in this browser.

### Search

Click **Search** under **New chat** (or the magnifier in the corner of a collapsed sidebar) and type. Conversations whose title or messages — what you and the agents wrote — contain every word you typed are listed in place of the groups, ignoring case: those whose title matches first, then the most recent. Each result shows where it matched, with the words highlighted, its group and how many messages match. Click one to open it; press Escape or × to go back to the groups. Chinese works without spaces: any part of a word matches.

## 5. Tips for writing roles

- Give each agent a distinct responsibility and say what it should **not** do ("don't edit files yourself").
- In relay mode, say explicitly whom to hand off to and when ("when done, list changed files and `@Reviewer`").
- Put the final say with one agent ("you speak last and give the user the final answer").
- To compare several implementations, use **parallel** mode with edit permission: every agent gets its own copy and you apply the one you like. For a plan → build → review flow, use **relay** so each agent builds on the previous one's changes.
- Not sure? Start with **Auto team**, and save the designs that work well as templates.

## 6. Where data is stored

All conversations, templates and settings are stored in `data/relay.db` (SQLite) in the project folder, readable only by your user. API keys are the exception: they go to your system's credential store (see [API keys](#api-keys-optional)). Files you attach are kept in `data/attachments/<conversation>/`, readable only by your user, and are deleted with the conversation (or when editing an earlier message drops the messages they belonged to). Parallel-mode worktrees live in `data/worktrees/` (on `relay/…` branches of your repository) and are removed when you delete the conversation. Each CLI also keeps its own session history in its usual location (`~/.claude…`, `~/.codex`, `~/.grok`), or in [the CLIs' own folder](#agent-sessions-the-clis-own-folder-and-agentsview) when you set one. Voice input's models (and, on Linux and Windows, its engine) are in `data/voice/`; **Settings → Voice input → Remove voice input** deletes them. The [tool library](#tool-library-mcp-servers-skills-and-memory) is in `data/relay.db` too, except the values of MCP servers' variables and headers, which go to the credential store like API keys. Your language choice and which version of the tour you finished are kept in the browser. Back up by copying `data/` while the app is stopped.

## 7. Troubleshooting

| Symptom | What to try |
| --- | --- |
| Agent shows *Not signed in* | Sign in from Settings & sign-in, or set an API key. Then click **Check again**. |
| *Command not found* | Install the CLI, or set **Executable** under the provider's **Default model and reasoning effort** section in Settings. |
| A reply ends with an error box | Read the message: it is the CLI's own error (rate limits, auth, invalid model…). Fix it and press **Continue** or resend. |
| Auto team always falls back to the General-question panel | The card says why. Check that the lead agent's CLI is signed in (Settings → Lead agent), or pick another lead agent. |
| Agent seems to have forgotten the conversation | If its CLI session could not be resumed, Harness Relay automatically starts a fresh session with the full history; this is expected after changing the working directory or the agent's CLI. |
| Model list is empty or outdated | Click **Check again** on the Settings page to refresh; you can always pick **Custom…** and type a model id. |
| "Is changing" when sending | Another conversation is writing to the same directory. Wait until it finishes, stop it, or use parallel / read-only mode. |
| Apply reports a conflict | Your working directory changed since the agents started. Nothing was applied; send a new message so the agents start again from the current state, or merge the agent's `relay/…` branch yourself. |
| Agent in parallel mode can't run tests | Worktrees don't contain ignored files such as `node_modules/`; ask the agent to install dependencies in its worktree first. |
| An agent seems stuck | Look for a **Needs you** badge or an approval card: it may be waiting for your answer. |
| Saving an API key fails (*Could not save the API key to the system credential store*) | The keychain / keyring is locked or access was denied. Unlock it (or allow access when asked) and save again, or set the environment variable instead. |
| "Reconnecting…" stays up | The server is down or restarting; the page reconnects by itself once it is back. |
| *Forbidden host* when you open it from your phone or another device | Start Harness Relay with that address in `RELAY_ALLOWED_HOSTS`; see [Use it from your phone](remote-access.md#troubleshooting). |
| "Too broad" when choosing a working directory | The folder is inside a git repository rooted at your home directory (such as a dotfiles repository). Pick a project folder, or run `git init` in the project folder. |
| Some messages are in the other language | System notes and errors are written in the language that was active when they happened; switching language doesn't translate them. |
| 🎙 says the microphone is not available | Allow this page to use the microphone (the site permissions next to the address bar), and check the system's privacy settings for your browser. |
| Voice input install fails | Open **Settings → Voice input** and read the error and the install log. On macOS install [Homebrew](https://brew.sh) first; on an older Linux (glibc before 2.34) install whisper.cpp yourself and set the **whisper-server path** under **Advanced**. |
| Transcription is slow | Choose a smaller model in **Settings → Voice input** (Small or Base); without a GPU the large models take several seconds. The first transcription after a while also loads the model. |
| Transcribed Chinese uses Simplified characters, or the wrong language | Set **Spoken language** to Chinese (Traditional) or English instead of auto-detect; a larger model also helps. |
| Every agent is *Not signed in* after setting the CLIs' own folder | Expected: the CLIs' new homes start empty. Sign in to each CLI again in Settings, or set API keys. |
| Settings says *The last update of AgentsView failed* | Start AgentsView, or check the address and port in **Settings → Agent sessions**. `ECONNREFUSED` means nothing listens there. A conversation is sent again after its next turn. |
| A conversation is missing in AgentsView | AgentsView hides sessions with only one message from the user: turn on **Include single-turn** in its session filter. |
| Port already in use | Start with another port: `PORT=8790 npm start` on macOS and Linux, `$env:PORT=8790; npm start` in Windows PowerShell. The same works for `npm run dev`, whose UI proxy follows `PORT`. |
