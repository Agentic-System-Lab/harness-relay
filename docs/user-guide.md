**English** | [繁體中文](user-guide.zh-TW.md)

# User guide

This guide walks through installing Harness Relay, signing in to the agents, designing a team (or letting the lead agent design it), and chatting with it.

## 1. Install and start

You need Node.js 22.13 or newer and at least one of the agent CLIs (`claude`, `codex`, `grok`) installed.

```bash
npm install
npm run dev
```

Open **http://localhost:5173**. (With `npm run build && npm start` the app is served at http://127.0.0.1:8787 instead.)

The dots at the bottom of the sidebar show each agent's status: green = ready, orange = not signed in, red = CLI not found.

### Language and the guided tour

The UI is available in **English** and **繁體中文**. On your first visit it follows your browser's language (any Chinese → 繁體中文, otherwise English) and remembers the choice in this browser; switch any time under **Settings & sign-in → Language**. Error messages and system notes from the server follow the same language.

The first visit also opens a short **guided tour** that points out the main features step by step (← / → to move, Esc to skip). Replay it from **Settings & sign-in → Guided tour**.

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

**✦ Lead agent** picks the CLI (and optionally the model and effort) that designs the team in [Auto team](#auto-team) conversations. Choose one that is signed in; a small, fast model is usually enough.

**Default working directory** sets the folder new conversations start in.

## 3. Design the team — New chat

Click **＋ New chat**. Under **How to build the team**, choose **Auto team** or **Design your own** — or pick one of the **Templates** below them. Adjust the team if you like, and click **Start chat →**. The page remembers your last choice.

**Design your own** starts from a blank team: one member for each CLI that is ready to use, with empty roles. Write each member's position, add or remove members, and set the conversation rules (see [Team members](#team-members) and [Conversation rules](#conversation-rules)).

Below the conversation rules, **Save as template** saves the current members and rules as a template, which then appears under **Templates** for new chats.

### Auto team

With **Auto team** you don't design the team yourself. When you send your first question, the **lead agent** (see [Lead agent](#lead-agent)) reads it and either picks the best-fitting template or designs a team better suited to it — members, roles, mode and rounds — and then that team answers.

- You choose only the **working directory** and the **file permission**; the lead agent cannot change the permission.
- The decision appears in the chat as a **Team design** card: which template or custom team, why, and each member's role. **Adjust team** opens the team settings.
- When the lead agent designed a team itself, the card asks whether to keep it: **Save as template** saves it (you can rename it), and it then shows up on the New chat page.
- If the lead agent's answer can't be used (or its CLI fails), the General-question panel is used instead and the card says why. If you press **Stop** while it is designing, the next message designs the team again.
- Members that would run on a CLI that isn't signed in are moved to the lead agent's CLI.
- Editing your first question (see [Copying, editing and retrying](#copying-editing-and-retrying)) designs the team again for the new question.

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
| Edit | Also editing files in the working directory and running project commands such as tests and builds (Claude Code: a list of common ones; Codex: anything inside its sandbox). Pushing and publishing are not included. |
| Full access | Everything, without asking. Use only in directories you trust. |

**Actions beyond the permission** — **Ask me** (default): when an agent wants to do something the permission doesn't cover, the chat asks you (see [Approvals](#approvals)). **Refuse automatically**: such actions are refused right away; the agent is told and tries another way. (Not shown for full access.)

**Git and file safety (edit / full access).** If the working directory is not a git repository yet, Harness Relay runs `git init` there automatically (never in your home directory). It never commits to your branch. Then:

- **Roundtable / relay** — agents take turns editing the working directory directly. Each reply records which files that agent changed. While such a conversation is running, other conversations cannot write to the same directory (you get an "is changing" message).
- **Parallel** — each agent works in its **own copy** (a git worktree) so they can't overwrite each other. The working directory is not touched until you choose a result and apply it (see [Reviewing and applying changes](#reviewing-and-applying-changes)).

## 4. Chat

- **Send** with Enter; Shift+Enter for a new line. While typing with an input method (e.g. Chinese), Enter confirms the candidate and does not send.
- **Attach files** — paste an image (such as a screenshot) straight into the message box, drag files onto it, or click 📎. Up to 10 files of 20 MB each per message, with or without text. Every agent that reads the message gets each file's path to open with its own tools, and images (PNG, JPEG, GIF, WebP) are also shown to it directly. Sent images appear as thumbnails (click to open the full image); other files as chips you can download.
- **Long questions** are folded to their first lines in the chat; click **Show more** to read the whole message (and **Show less** to fold it again).
- **`@mention`** — type `@` to pick a teammate. When your message mentions agents, **only those agents reply** (in relay mode they start the relay). Without mentions, the whole team takes part according to the mode.
- **Streaming** — replies appear as they're written. Tool activity (file reads, edits, shell commands) is grouped in a collapsible row; a spinning icon shows the step in progress, and a refused or failed step shows its reason. The team chips under the title highlight who is speaking; with a large team the row scrolls sideways (the mouse wheel works too) and follows the speaker.
- **■ Stop** — stops the current run and kills the agents' processes.
- **Continue ↻** — lets the team go on without a new message (another set of rounds, or another relay starting from the leader). Useful after a relay hits its hand-off limit.
- **Passed replies** — an agent with nothing to add replies `[PASS]`; it is shown dimmed as *Nothing to add (PASS)*.
- **What agents think and do** — an agent's reasoning appears in a collapsed **Thinking** row (its latest line is visible while it streams; click to read all of it), its plan / to-do list as a checklist that updates as it works, and each tool step can be expanded to see its output.
- Each reply shows its duration, and cost and tokens when the CLI reports them.

### Approvals

When an agent wants to do something its permission doesn't cover — install a package, run a command in read-only mode, push code, write outside the working directory — its reply shows a card: what it wants to do (the exact command, file or URL) and why. The agent waits until you answer:

- **Allow** — just this once.
- **Always allow "…" in this chat** — this and later requests like it (for commands: the same program and subcommand, e.g. `npm install`; a chained command is only allowed when every part is) are allowed without asking for the rest of the conversation.
- **Decline** — optionally type what it should do instead first; the agent gets your message and carries on.

A banner above the message box points to waiting requests; the sidebar marks the conversation **Needs you** and the browser tab title shows how many are waiting. Pressing **■ Stop** declines everything still waiting. Codex runs commands in its sandbox and asks only when it decides it needs more than the sandbox allows.

### Reviewing and applying changes

When an agent changes files, its reply ends with a card listing the files (A added, M modified, D deleted, with lines added/removed):

- **View this turn's diff** — what the agent changed in this turn.
- In parallel mode the card says **in worktree** with the agent's branch, and the agent's latest card also has:
  - **View @name's full result** — everything this agent changed since the round started;
  - **Apply to working directory** — copies that result into your working directory. Nothing is committed: review the changes with your usual tools and commit them yourself.

After you apply one result, the other agents' results are marked as out of date, and the next parallel round starts every agent from the updated directory. If your working directory changed in a way that conflicts with the result, nothing is applied and you get an explanation; ask an agent to redo the work on top of the current state.

### Editing the team mid-chat

Click **Team settings** in the header to change roles, models, effort, mode, permission or working directory. Changes apply from the next turn. Changing an agent's CLI makes that agent start a new session and re-read the chat history. Settings can't be saved while the team is replying.

### Copying, editing and retrying

- **Copy** under a message (shown when you point at it) copies that message's text as Markdown. **Copy chat** in the header copies the whole conversation, with each message labelled by who said it. Tool activity is left out.
- **Edit** under one of your own messages lets you change it and send it again (Enter sends, Shift+Enter adds a line, Esc cancels). Everything after that message is deleted and the team answers again from there; every agent starts a fresh session and re-reads the history up to your edited message. Files the deleted replies changed are **not** restored — if any of them changed files you are asked to confirm first. Editing is not available while the team is replying.
- **↻ Retry** under an agent's reply lets that agent answer again. Its reply and everything after it are deleted (you are asked to confirm when there is anything after it); outside relay mode, the later speakers of the same round answer again too.

### Conversation list

The sidebar lists conversations, newest first, each with its state:

| Badge | Meaning |
| --- | --- |
| **Needs you** (orange) | An agent is waiting for your approval. |
| **Replying** (blue, pulsing) | The team is working. |
| **New reply** (green, bold title) | It finished while you were looking at something else. |
| **Error** (red) | The last reply ended with an error you haven't looked at yet. |

Conversations keep running when you switch to another one (or close the tab); the badges update by themselves. Click the title in the chat header to rename; hover a conversation and click × to delete it. A conversation with a large team shows its first few member dots and a **+N** count.

To make room, collapse the sidebar with the panel button next to *Harness Relay*. Two buttons stay in the top-left corner: one brings the sidebar back, the other starts a new chat. The choice is remembered in this browser. (On a phone the sidebar is a drawer opened with ☰ instead.)

## 5. Tips for writing roles

- Give each agent a distinct responsibility and say what it should **not** do ("don't edit files yourself").
- In relay mode, say explicitly whom to hand off to and when ("when done, list changed files and `@Reviewer`").
- Put the final say with one agent ("you speak last and give the user the final answer").
- To compare several implementations, use **parallel** mode with edit permission: every agent gets its own copy and you apply the one you like. For a plan → build → review flow, use **relay** so each agent builds on the previous one's changes.
- Not sure? Start with **Auto team**, and save the designs that work well as templates.

## 6. Where data is stored

All conversations, templates and settings are stored in `data/relay.db` (SQLite) in the project folder, readable only by your user. API keys are the exception: they go to your system's credential store (see [API keys](#api-keys-optional)). Files you attach are kept in `data/attachments/<conversation>/`, readable only by your user, and are deleted with the conversation (or when editing an earlier message drops the messages they belonged to). Parallel-mode worktrees live in `data/worktrees/` (on `relay/…` branches of your repository) and are removed when you delete the conversation. Each CLI also keeps its own session history in its usual location (`~/.claude…`, `~/.codex`, `~/.grok`). Your language choice and whether you finished the tour are kept in the browser. Back up by copying `data/` while the app is stopped.

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
| Some messages are in the other language | System notes and errors are written in the language that was active when they happened; switching language doesn't translate them. |
| Port already in use | Start with another port: `PORT=8790 npm run dev` (the UI proxy follows `PORT`). |
