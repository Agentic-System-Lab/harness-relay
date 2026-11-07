**English** | [繁體中文](user-guide.zh-TW.md)

# User guide

This guide walks through installing Harness Relay, signing in to the agents, designing a team, and chatting with it. The UI itself is in Traditional Chinese; English labels are given in parentheses below where helpful.

## 1. Install and start

You need Node.js 22.13 or newer and at least one of the agent CLIs (`claude`, `codex`, `grok`) installed.

```bash
npm install
npm run dev
```

Open **http://localhost:5173**. (With `npm run build && npm start` the app is served at http://127.0.0.1:8787 instead.)

The dots at the bottom of the sidebar show each agent's status: green = ready, orange = not signed in, red = CLI not found.

## 2. Sign in to each agent — 設定與登入 (Settings & Login)

Click **⚙ 設定與登入** in the sidebar. Each CLI has its own card showing version, account and status.

### Signing in

Pick a method and click **登入 (Sign in)**. Harness Relay runs that CLI's own login command and shows what you need:

| Agent | Method | What to do |
| --- | --- | --- |
| Claude Code | Claude 訂閱帳號 (subscription) / Anthropic Console | Open the link, authorize, then paste the code the page shows into the box and click **送出 (Submit)**. |
| Codex | ChatGPT 裝置碼 (device code) | Open the link, sign in to ChatGPT and enter the one-time code shown (click it to copy). |
| Codex | ChatGPT 瀏覽器登入 (browser) | A browser opens on this machine; finish signing in there. |
| Grok | xAI 裝置碼 (device code) / 瀏覽器登入 (OAuth) | Open the link and confirm the code. |

The panel turns green with **登入成功 (Signed in)** when the CLI finishes. Expand **CLI 輸出 (CLI output)** to see the raw output if something goes wrong.

> **Codex:** starting a new Codex login signs out the current Codex account first. The page asks for confirmation.

**登出 (Sign out)** signs the CLI out on this machine, which also affects other places you use that CLI.

### API keys (optional)

Under **API key** on each card:

- **Claude Code** — stored by Harness Relay and passed as `ANTHROPIC_API_KEY` (API billing; it takes precedence over your subscription login).
- **Grok** — stored by Harness Relay and passed as `XAI_API_KEY`.
- **Codex** — handed to `codex login --with-api-key`; Codex stores it and it replaces the ChatGPT login.

### Default model and reasoning effort

Under **預設模型與推理強度 (Default model & reasoning effort)** choose what an agent uses when its own model/effort is left on *default*. Leaving these on **CLI 預設 (CLI default)** uses the CLI's own configuration (for example `~/.codex/config.toml`). The same section lets you set a custom **執行檔 (executable)** path if the CLI is not on your `PATH`.

At the bottom of the page, **預設工作目錄 (Default working directory)** sets the folder new conversations start in.

## 3. Design the team — 新對話 (New chat)

Click **＋ 新對話**. The page has three parts.

### Templates — 範本

| Template | Mode | Team |
| --- | --- | --- |
| 架構師 → 實作者 → 審查者 (Architect → Builder → Reviewer) | Relay, edit | Claude plans, Codex implements, Grok reviews; they hand off with `@` |
| 三方辯論 (Three-way debate) | Roundtable ×2, read-only | Proposer, pragmatist and skeptic — for design and technology choices |
| 平行解題比較 (Parallel comparison) | Parallel, read-only | All three solve the same problem independently |
| 一般問題智囊團 (General-question panel) | Roundtable, read-only | Analyst → Critic → Synthesizer; for any question, not just code |
| 結對程式 + QA (Pair programming + QA) | Roundtable, edit | Navigator guides, Driver codes, QA tests |

Choosing a template fills in the team below; you can change anything. **存成範本 (Save as template)** saves the current team for later; saved templates can be deleted with ×.

### Team members — 團隊成員

Each card is one agent:

- **@name** — the handle used for `@mentions`. Letters, digits, `_` and `-` (Chinese characters work too), unique within the team.
- **Claude Code / Codex / Grok** — which CLI runs this agent. You can have several agents on the same CLI (e.g. two Claude agents with different roles).
- **定位 / 角色 (Role)** — free text describing the agent's position and responsibilities. This is the most important field: tell the agent what it owns, what it should *not* do, and whom to hand off to.
- **模型 (Model)** — models reported by the CLI, or **自訂… (Custom…)** to type an id. *預設 (Default)* uses the default from Settings, or the CLI's own default.
- **推理強度 (Reasoning effort)** — only levels the selected model supports are listed (e.g. low / medium / high / xhigh). Switching to a model that doesn't support the chosen level resets it to default.
- **↑ ↓** — reorder. Order is the speaking order in roundtable mode, and the first agent is the **lead** in relay mode.

Add members with **＋ Claude Code / ＋ Codex / ＋ Grok** (up to 8).

### Conversation rules — 對話規則

**Mode**

| Mode | Behavior | Good for |
| --- | --- | --- |
| 圓桌 Roundtable | Agents speak in order; each sees what earlier speakers said. Set the number of rounds (1–5); the run ends early when everyone in a round replies `[PASS]`. | Discussions, reviews, refining an answer |
| 平行 Parallel | All agents answer at the same time, independently. In later rounds they see the previous round's answers. | Comparing approaches, getting independent opinions |
| 接力 Relay | One agent at a time. An agent hands the floor to a teammate by `@mentioning` them; if it mentions nobody, the floor returns to you. Set the maximum number of hand-offs per message (1–30). | Pipelines: plan → implement → review |

**工作目錄 (Working directory)** — the folder all agents work in. They share it.

**檔案權限 (File permission)** — applies to every agent in the conversation:

| Level | Meaning |
| --- | --- |
| 唯讀 Read-only | Agents can read and analyze but not modify files. |
| 可編輯 Edit | Agents can edit files in the working directory. |
| 完全存取 Full access | Agents can edit files and run any command without asking. Use only in directories you trust. |

**Git and file safety (edit / full access).** If the working directory is not a git repository yet, Harness Relay runs `git init` there automatically (never in your home directory). It never commits to your branch. Then:

- **Roundtable / relay** — agents take turns editing the working directory directly. Each reply records which files that agent changed. While such a conversation is running, other conversations cannot write to the same directory (you get a "正在修改 (is being modified)" message).
- **Parallel** — each agent works in its **own copy** (a git worktree) so they can't overwrite each other. The working directory is not touched until you choose a result and apply it (see [Reviewing and applying changes](#reviewing-and-applying-changes)).

Click **開始對話 → (Start chat)**.

## 4. Chat

- **Send** with Enter; Shift+Enter for a new line. While typing in Chinese, Enter confirms the IME candidate and does not send.
- **`@mention`** — type `@` to pick a teammate. When your message mentions agents, **only those agents reply** (in relay mode they start the relay). Without mentions, the whole team takes part according to the mode.
- **Streaming** — replies appear as they're written. Tool activity (file reads, edits, shell commands) is grouped in a collapsible row; a spinning icon shows the step in progress. The team chips in the header highlight who is speaking.
- **■ 停止 (Stop)** — stops the current run and kills the agents' processes.
- **繼續 ↻ (Continue)** — lets the team go on without a new message (another set of rounds, or another relay starting from the lead). Useful after a relay hits its hand-off limit.
- **Passed replies** — an agent with nothing to add replies `[PASS]`; it is shown dimmed as 沒有補充 (nothing to add).
- Each reply shows its duration, and cost and tokens when the CLI reports them.

### Reviewing and applying changes

When an agent changes files, its reply ends with a card listing the files (A added, M modified, D deleted, with lines added/removed):

- **查看這回合 diff (View this turn's diff)** — what the agent changed in this turn.
- In parallel mode the card says **在 worktree (in worktree)** with the agent's branch, and the agent's latest card also has:
  - **查看 @name 的完整結果 (View @name's full result)** — everything this agent changed since the round started;
  - **套用到工作目錄 (Apply to working directory)** — copies that result into your working directory. Nothing is committed: review the changes with your usual tools and commit them yourself.

After you apply one result, the other agents' results are marked as out of date (工作目錄已更新), and the next parallel round starts every agent from the updated directory. If your working directory changed in a way that conflicts with the result, nothing is applied and you get an explanation; ask an agent to redo the work on top of the current state.

### Editing the team mid-chat

Click **團隊設定 (Team settings)** in the header to change roles, models, effort, mode, permission or working directory. Changes apply from the next turn. Changing an agent's CLI makes that agent start a new session and re-read the chat history. Settings can't be saved while the team is replying.

### Conversation list

The sidebar lists conversations, newest first; a pulsing dot marks one that is running. Click the title in the chat header to rename; hover a conversation and click × to delete it.

## 5. Tips for writing roles

- Give each agent a distinct responsibility and say what it should **not** do ("don't edit files yourself").
- In relay mode, say explicitly whom to hand off to and when ("when done, list changed files and `@Reviewer`").
- Put the final say with one agent ("you speak last and give the user the final answer").
- To compare several implementations, use **parallel** mode with edit permission: every agent gets its own copy and you apply the one you like. For a plan → build → review flow, use **relay** so each agent builds on the previous one's changes.

## 6. Where data is stored

All conversations, templates and settings are stored in `data/relay.db` (SQLite) in the project folder, readable only by your user. Parallel-mode worktrees live in `data/worktrees/` (on `relay/…` branches of your repository) and are removed when you delete the conversation. Each CLI also keeps its own session history in its usual location (`~/.claude…`, `~/.codex`, `~/.grok`). Back up by copying `data/` while the app is stopped.

## 7. Troubleshooting

| Symptom | What to try |
| --- | --- |
| Agent shows 未登入 (not signed in) | Sign in from Settings & Login, or set an API key. Then click **重新檢查狀態 (Re-check status)**. |
| 找不到指令 (command not found) | Install the CLI, or set **執行檔 (executable)** under the provider's **預設模型與推理強度** section in Settings. |
| A reply ends with an error box | Read the message: it is the CLI's own error (rate limits, auth, invalid model…). Fix it and press **繼續 (Continue)** or resend. |
| Agent seems to have forgotten the conversation | If its CLI session could not be resumed, Harness Relay automatically starts a fresh session with the full history; this is expected after changing the working directory or the agent's CLI. |
| Model list is empty or outdated | Click **重新檢查狀態** on the Settings page to refresh; you can always pick **自訂… (Custom…)** and type a model id. |
| 「正在修改」 when sending | Another conversation is writing to the same directory. Wait until it finishes, stop it, or use parallel / read-only mode. |
| Apply reports a conflict (衝突) | Your working directory changed since the agents started. Nothing was applied; send a new message so the agents start again from the current state, or merge the agent's `relay/…` branch yourself. |
| Agent in parallel mode can't run tests | Worktrees don't contain ignored files such as `node_modules/`; ask the agent to install dependencies in its worktree first. |
| Port already in use | Start with another port: `PORT=8790 npm run dev` (the UI proxy follows `PORT`). |
