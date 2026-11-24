**English** | [繁體中文](multi-day-runs.zh-TW.md)

# Tasks that run for days

> **Status: not started; an inventory (2026-11-24), and the order it recommends.** See [Proposals](README.md).

This inventory answers one question: can Harness Relay today have agents carry out a task reliably over several days, and what problems are left? It describes the code and the docs as they are, and what is missing, without a design. It was taken at `main` commit `278c4b62`, and its line numbers refer to that commit.

## 1. Conclusion

**Yes, in one form only, and on conditions.**

- **The form**: an automation (schedule) with a tracked goal splits work of several days into several runs.
  - The schedule starts each run.
  - Agents end their replies with `<progress status="working|done|blocked">`.
  - `done` switches the schedule off; `blocked` tells the user.
  - This is the path the product is built for: the user guide says the automation "follows the task across runs and days" (`docs/user-guide.md:844`).
- **It is not** one agent working for days on end:
  - A turn lasts at most 24 hours by default, a safety net against a hung CLI; `RELAY_TURN_TIMEOUT_MIN` raises it to 7 days at most (`src/server/config.ts:88`).
  - An agent's background work usually ends with its turn. Two exceptions: Claude Code waits for it for up to 10 minutes by default (with the account's workflows on, up to nearly the turn's time limit), and with full access a detached process keeps running, but outside Relay's control.
  - Time-based schedules run at most once an hour; event triggers are checked every 2 minutes.
- **The conditions** (without any one of them, the task stops, quietly loses a run, or gets worse):
  1. **The server stays up**: the computer does not sleep, and something outside restarts the server after a crash.
  2. **Unattended runs need nothing beyond their permission**: such requests are refused automatically, or reviewed by the lead agent.
  3. **In a schedule that runs in its own conversation, agents ask the user nothing**: once one asks, every later time is skipped until the user answers. A schedule that opens a new conversation each time is not affected.
  4. **No CLI's plan runs out and no sign-in expires**: Relay acts on neither failure, and only some adapters reword a sign-in error as "sign in again". Relay does not wait for a limit to reset, does not switch accounts, and does not alert the user separately.
  5. **The conversation does not grow so long that the full history a fresh session is sent no longer fits its context.**
  6. **The tracked goal's runs are the ones the scheduler sends at its set times**: runs that an event trigger, a webhook or **Run once now** started are neither retried nor recovered after a restart.
  7. **If the automation runs a fixed command first, the working directory's code and configuration stay unchanged**: after a change, every later time fails until the user approves it.

Section 2 lists what exists, section 3 the problems, section 4 the order to fix them in, section 5 how to run a task over days today, and section 6 the questions still open.

## 2. What exists

| Mechanism | What it does | Evidence |
| --- | --- | --- |
| When an automation runs | Once, daily, weekly, every 1–168 hours, on an event (mail, calendar, GitHub, a file), on its webhook, or by hand with **Run once now**. The scheduler looks every 15 seconds and handles the times due on waking. A time more than 10 minutes past counts as missed: skipped by default, or sent once late. A time that finds the conversation busy (a settings change or an apply holding it, say) is tried again for up to 30 minutes, then skipped. | `src/server/scheduler.ts:67,75,78`; `docs/architecture.md:276-317` |
| Tracked goal | A goal of at most 2,000 characters. Every turn's briefing carries the goal, its status and the latest 12 progress notes (30 kept, at most 1,000 characters each). `done` switches the schedule off; `blocked` marks the conversation as needing the user and alerts them. | `src/shared/tracking.ts`; `src/shared/types.ts:3124,3147-3154`; `src/server/prompt.ts:536-560` |
| Retries | When **every** reply of a run failed, the run is tried again after 5, 30 and 120 minutes, then waits for the next set time; a run that could not start is retried the same way. Three limits:<br>• Only runs the scheduler sent at a set time are retried; event triggers, webhooks and **Run once now** are not.<br>• When the next set time comes before a retry, that time replaces it.<br>• Each wait counts from the end of the failed run. | `src/server/orchestrator.ts:2789-2791,3116-3170`; `src/server/scheduler.ts:382,488` |
| Restart recovery | A tracked goal's run still going when the server stopped (quit, restart, the app's update, a crash) is tried again as soon as the server starts. Three limits:<br>• Only runs marked in flight, which takes `retries`, so again only set times.<br>• When the server was down past the next set time plus 10 minutes, that time is skipped as missed, with no note that a run was cut off.<br>• Each restart uses up one retry. | `src/server/scheduler.ts:434-445,458,464-465`; `src/server/orchestrator.ts:3065-3067,3160-3163` |
| Sessions carried on | In one conversation each agent resumes its own CLI session and is sent only the new messages. Compaction is left to the CLI; Claude Code's `compact_boundary` and Codex's `contextCompaction` show as notices. | `docs/architecture.md:117-150`; `src/server/agents/claude.ts:1401`; `src/server/agents/codex.ts:854` |
| Permissions when nobody watches | A run a schedule starts refuses approval requests automatically, but what the conversation always allows still goes through. Three other cases:<br>• The schedule set to `approvals: ask`: the user is asked as usual.<br>• **Approve for me**: the lead agent reviews; what it does not approve, or fails to review, is refused.<br>• Full access: nothing is asked. | `src/server/prompt.ts:451-459`; `src/server/orchestrator.ts:6527-6532,6564`; `docs/architecture.md:301` |
| Notifications | The inbox keeps the newest 200, on the server, the same for every browser. Web Push; a push about something that needs the user lives at least 24 hours. `blocked` has an alert of its own (**Goal held up**). | `src/server/inbox.ts`; `src/server/alerts.ts:35-36`; `docs/user-guide.md:995,1023` |
| Running all the time | The docs have a systemd user service example (`Restart=on-failure`, and they mention `loginctl enable-linger`). The desktop app has a **Keep this computer awake while running** option, and updates only once no agents are at work. | `docs/remote-access.md:181-205,219`; `desktop/src/main.ts:1065-1071`; `desktop/src/update.ts:1170-1206` |
| Long-term memory | An experiment (Settings → Labs), off by default. | `docs/user-guide.md:364` |
| No clash with the CLIs' own goals | Relay turns off Codex's `features.goals` and Grok's `/goal` and tracks the goal itself. | `src/server/agents/codex.ts:147-154`; `src/server/agents/grok.ts:1301` |

## 3. Problems

Severity: **high** = stops or cuts off a task over days, or quietly loses a run; **medium** = the task goes on, but its results or quality get worse over time; **medium to low** = resources that pile up, harmless at first, slowing the server or filling the disk over time; **low** = a nuisance of upkeep.

### A. Stops a task, cuts it off or loses a run (high)

**A1. Usage limits, 429s and lapsed sign-ins are not told apart, and not acted on**
- **Errors have no kind**: every failure becomes `AgentRunError(message, aborted?, usage?)`, with no field for a kind (`src/server/agents/types.ts:333-341`).
  - Claude Code's error text is passed on as it is; only `error_max_budget_usd` is handled apart (`src/server/agents/claude.ts:1943-1948`).
  - Codex uses `turn.error.message`, `additionalDetails` and the text of its `error` notifications (`src/server/agents/codex.ts:1073-1074,1186-1189`).
  - Only OpenHands recognises a 429, and only to reword the message (`src/server/agents/openhands.ts:1256-1257`).
  - Some adapters reword sign-in errors (see A6).
- **No waiting for a reset, no other account**:
  - `usage.ts` reads each account's `resetsAt`, but it is used only for display, and by the lead agent to leave out used-up models when it designs a team and in its fallback plan (`src/server/planner.ts:255,1260`). Neither `orchestrator.ts` nor `scheduler.ts` uses it.
  - A schedule always keeps its team (`keepTeam: true`, `src/server/orchestrator.ts:2880`), so a scheduled run never checks usage, and no run moves to another account or CLI midway.
- **No automatic retry looks at the kind of error**:
  - The only immediate retry: once per agent turn, in a run the user started too. When the agent had a session and failed before saying anything, the turn is tried again at once in a fresh session, with the full history (`src/server/orchestrator.ts:6856-6876`).
  - A tracked goal's retries after 5, 30 and 120 minutes do not look at the kind either (`src/server/orchestrator.ts:3132-3134`).
- **What it does depends on how often the schedule runs**:
  - Daily or weekly: the three retries are used up within about 2.5 hours plus the runs' own time. A run that hits Claude's 5-hour window or weekly limit then waits for the next set time.
  - More often than about every 2.5 hours: the next set time comes before the later retries and starts again at attempt 0. The retries never run out; each time hits the same limit again.
  - Without a goal: never retried.

**A2. Unattended, requests beyond the permission are refused**
- A run a schedule starts refuses approval requests by default, for example a command outside the sandbox or an install that needs the network (`Run.refuseApprovals`, `docs/architecture.md:301`; `src/server/orchestrator.ts:6527-6532`).
- With `approvals: ask`, an approval waits for the user, and the wait counts toward the turn's time limit (`src/server/agents/types.ts:343-348`).
- **Approve for me** does not keep a run from refusals:
  - The lead agent never approves pushing, publishing, more access for the turn, or a request that does not say what it would do.
  - What it does not approve, or fails to review, is refused (`src/server/orchestrator.ts:6564`).
  - Each request it reviews is one lead-agent run, on the lead's own quota. The same request already approved in the run, and requests it never reviews, start no lead-agent run (`src/server/orchestrator.ts:2411-2416`).
- Full access asks nothing, at the user's own risk.

**A3. A schedule in its own conversation skips its later times while the user is waited for**
- What makes a run wait for the user: an agent's `[ASK_USER]` question, a card of steps, a secret card, or a fixed command it proposes (`src/server/orchestrator.ts:6883-6889`).
- Meanwhile every scheduled message is `skipped`, since it would be taken for the user's answer (`src/server/orchestrator.ts:2735`). Times skipped one after another share one note.
- The task stays stopped until the user answers. There is a push alert, but no time limit and no default answer.
- A schedule that opens a new conversation each time is not affected (`if (s.newChat) return undefined;`, `src/server/orchestrator.ts:2733`; `docs/user-guide.md:839`).

**A4. A run the user started, cut off by a restart or a crash, is not resumed, and nobody is told**
- At startup every reply still `streaming` is marked `aborted`, and the approvals and browser hand-overs it waited on `expired` (`src/server/store.ts:918-946`).
- Only a tracked goal's runs are recovered (`Scheduler.recover()`, `src/server/scheduler.ts:434-445`). Startup does not send the queued messages either.
- Work the user started takes **Retry** or **Continue** by hand.
- `aborted` raises no alert; only `done` and `error` do (`src/shared/notify.ts:72-76`), so the user is not told the run was cut off.

**A5. The server has to stay up, and nothing built in looks after it**
- Schedules send only while Relay runs; no system scheduler is behind them (`docs/architecture.md:1161`).
- `npm start` is one `tsx` process, with no supervisor.
- The desktop app shows a notification when its server crashes, and does not restart it (`desktop/src/supervisor.ts:164-169`; `desktop/src/main.ts:370-371`).
- **Keep this computer awake while running** is off by default (`desktop/src/prefs.ts:29`), and uses Electron's `prevent-app-suspension`.
  - The docs say that with `caffeinate -i` a MacBook still sleeps when its lid is closed, unless it is on power with an external display (`docs/remote-access.md:179`).
  - It presumably does the same; **not tried**.
- A codespace stops after 30 minutes without activity by default, which can be raised (`docs/codespaces.md:13`).
- The most reliable setup today is the docs' systemd example on a machine that does not sleep (`docs/remote-access.md:181-205`).

**A6. A lapsed sign-in is not made clear, and sometimes the task quietly goes on**
- **A CLI's sign-in lapses**:
  - Copilot, Cursor, Muse, Antigravity and the open agents reword it as "sign in again"; Claude Code, Codex and Grok show an ordinary error.
  - Relay does not check sign-ins in the background.
  - An `error` alert comes only when the failed reply is the conversation's latest (`src/shared/notify.ts:72-76`).
- **An OAuth account's refresh token is refused** (`invalid_grant`):
  - The account is marked `reauth` (`src/server/oauth/broker.ts:241,449-452`).
  - But in a turn the tool only returns `… failed: …` to the agent, and the turn goes on (`src/server/gateway.ts:1064-1066`).
  - So the agent may still report `working`, and the user gets no alert about the sign-in.
- **An event trigger's check fails** (a mail sign-in that lapsed, say):
  - The schedule records `error` and `failures`, and checks again later (`src/server/scheduler.ts:328-340`).
  - The sidebar's clock turns amber and the drawer has a line about it (`docs/architecture.md:315`), but the chat gets no note and there is no push.
- **A Google OAuth app still in Testing**: its refresh tokens expire after 7 days (`docs/architecture.md:1168`), which stops a task over days that uses Gmail or Calendar.
- **An MCP server's access token** that expires during a turn is refused by the server until the next turn (`docs/architecture.md:1169`).

**A7. Gaps in retries and recovery quietly lose runs**
- **A tracked goal's runs started by an event trigger, a webhook or Run once now**: not retried when they fail, nor recovered after a restart (`retries: Boolean(opts.retries) && opts.event === undefined`, `src/server/orchestrator.ts:2790`; `src/server/scheduler.ts:382`).
- **An event-started run that fails after it started**: the check has recorded the event as seen, so no later check sends it again. Only an event answered `busy` or `skipped` is kept for the next check (`src/server/scheduler.ts:381-392,403-417`).
- **Down past the next set time plus 10 minutes**: the run that was cut off is not recovered. `retryTracked()` returns when the next time comes first (`src/server/orchestrator.ts:3160-3163`), and `fire()` then takes that time as missed and skips it by default (`src/server/scheduler.ts:458,464-465`).

**A8. An automation that runs a fixed command first keeps failing once an agent changed code**
- A change to the code or configuration its pin covers in the working directory, the files agents usually change, fails every later time until the user approves it. One note about it is left, not one per time (`changedNote()`, `src/server/orchestrator.ts:2900-2908`; `docs/user-guide.md:841`).
- It counts as `failed`, which uses up the tracked goal's retries (`src/server/scheduler.ts:488`).
- `command-changed` is not an alert kind (`ALERT_KINDS`, `src/shared/types.ts:1494`), so there is no push.

### B. The task goes on, but gets worse over time (medium)

**B1. A hung turn waits for the whole time limit**
- The turn's time limit is 24 hours by default (`src/shared/types.ts:3739`), a limit on its whole length.
- There is no inactivity watchdog that stops a turn after a while with no output: a search for `idle|inactiv|watchdog|heartbeat` finds only the browser's, voice input's and IMAP's.
- A hung CLI can hold the conversation for the whole time limit:
  - A schedule in its own conversation: the first scheduled message after the hang is queued, the later ones skipped.
  - A schedule that opens a new conversation each time: it goes on opening them, and while the folder is held, each one's team works in a worktree of its own.

**B2. Background work ends with the turn**
- **Claude Code**: once `-p` has answered, it waits for its background work (background subagents, workflows, background commands): up to 10 minutes by default, and with the account's workflows on, up to the turn's time limit less a margin (`src/server/agents/claude.ts:618-629`).
- **Antigravity, Grok, Muse**: with their subagents on, the briefing asks the agent to wait for all its background work before it ends its reply, as "anything still running when your reply ends is lost" (`SUBAGENT_WAIT_RULE`, `src/server/prompt.ts:515-521`).
- **Muse**: its `cron_create` and `monitor` end with the turn (`docs/architecture.md:1137`).
- **Antigravity**: a command it moved to the background ends with the turn (`docs/architecture.md:1131`).
- **Open agents**: their sandbox stops what a run left running.
- **Full access**: a detached process is outside the turn's process tree, and no longer under Relay's control (`docs/architecture.md:1162`).
- So work that takes days (training, a long crawl, a long build) cannot be left to Relay to look after across turns. The proposal [Steps only the user can take](user-handoffs.md) lists programs that keep running as still open.

**B3. A fresh session is sent the whole history at once, with no limit**
- In one conversation, the CLI compacts its own context.
- A fresh session is sent the whole chat at once (`Here is the group chat so far:`, `src/server/prompt.ts:874-876`).
  - What is sent has no size limit (`src/server/orchestrator.ts:6685-6687`), nor do the adapters add one.
  - `docs/architecture.md:1147` says so too.
- When a fresh session starts:
  - The agent had a session and failed before saying anything (not only when resuming failed; the automatic fallback, `src/server/orchestrator.ts:6856-6876`);
  - Retry, an edited message, a branch (`docs/architecture.md:1153`);
  - A raised permission;
  - Another provider, or a model moved to another backend;
  - Muse after every restart of the server (`docs/architecture.md:1137`).
- In a conversation that has gone on for days, that prompt can be larger than the model's context window, and fail; the fallback after the failure sends the whole history too.
- Besides: Cline does not compact over ACP, and Grok and Copilot get no context window for the user's own endpoints' models (`docs/architecture.md:1166`).

**B4. With a new conversation each time, little is remembered between runs**
- The prompt carries only the latest 12 progress notes, at most 1,000 characters each (`src/shared/types.ts:3147-3151`; `src/server/prompt.ts:538`).
- Anything else agents have to write into files (`docs/architecture.md:1161`); long-term memory is off by default (`docs/user-guide.md:364`).

**B5. Progress and done are only what the agents say**
- **`done` is not checked**: "Harness Relay does not check that it is really reached" (`docs/architecture.md:1161`).
- **A missing report goes unnoticed**: a reply without its `<progress>` block is not caught; a search for `no progress` and `noProgress` finds nothing.
- **Retried only when everything failed**: a run counts as failed only when every one of its replies failed (`src/server/orchestrator.ts:3132-3134`). None of these is retried:
  - Only some replies failed;
  - One reply was `[PASS]`;
  - One reply was stopped.
- **No check for a stalled goal**: run after run reporting `working` with nothing changing goes unnoticed.
- **A schedule without a goal**: never retried.

**B6. How often a task can move on is limited**
- A time-based schedule runs every hour at most, in whole hours (`src/server/validate.ts:862`).
- There is no "start the next run as soon as the last one ended".
- A run longer than the interval queues the next time, and the ones after it are skipped.
- A conversation has one schedule at most.

**B7. A CLI's version can change during the days**
- **Updates turned off**: only OpenCode's and Cline's (`src/server/agents/opencode.ts:158,437`; `src/server/agents/cline.ts:154,175`).
- **Copilot**: updates are turned off only when its usage is read (`--no-auto-update`, `src/server/usage.ts:575-577`); its turns keep the account's own `autoUpdate`. The docs say it "may update itself under Harness Relay" (`docs/architecture.md:1135`).
- **No setting about updates found**: Claude Code, Codex, Grok, Muse, Antigravity, Cursor, Goose, OpenHands, Pi. Whether they update themselves when they run without a terminal was **not checked**.
- The risk: once a CLI updates to a version `src/shared/cliVersions.ts` was not checked with, its adapter may break in the middle of the task.

**B8. Parallel mode's results, and a team's own worktree, wait to be applied by hand**
- **Parallel mode**: a result is applied only once the user picks it (`docs/user-guide.md:711`).
- **A team's own worktree**: when another conversation writes in the folder, the team works in a worktree of its own, and its result reaches the folder only once applied (`docs/architecture.md:1126`).
  - Once there, the team stays in that worktree until the user applies its work (`teamWorkPending()`, `src/server/orchestrator.ts:3590,4074`).
- So with nobody watching, neither case builds up progress in the working directory.

**B9. No spending limit across runs**
- A member's limits are each for one turn or one session: Claude Code's `--max-budget-usd`, Copilot's `--max-ai-credits`, Goose's and OpenCode's steps (`src/shared/types.ts:203-214`).
- On a key or an endpoint billed by use, nothing stops what every run and retry of a task over days adds up to.

### C. Resources that pile up over time (medium to low)

**C1. Conversations are never cleaned up**
- No automatic archiving or deletion was found; a conversation goes only when the user deletes it (`src/server/orchestrator.ts:1183-1229`).
- An hourly schedule that opens a new conversation each time adds 24 a day, each kept in memory, in the database and on disk, with its worktrees, refs and state folders.

**C2. The server's memory only grows**
- `Store.cache` holds whole conversations (every message); one is added when read, removed only when it is deleted, and the cache empties only with a restart (`src/server/store.ts:910,1078-1083,1263,1324`). `savedSeen` the same.
- With AgentsView set up, each conversation adds an entry (`src/server/agentsview.ts:482,488`).
- One long-lived scheduled conversation grows without end too (`docs/architecture.md:1161`).

**C3. Polling costs grow with the history**
- `Store.list()` reads every conversation each time, with a `LIKE` scan of the whole table that no index serves (`src/server/store.ts:1008-1021`).
- How often:
  - While agents work, `AlertWatcher` and `Inbox` each every 1.5 seconds (`src/server/alerts.ts:22`; `src/server/inbox.ts:21`); `AlertWatcher` only while a browser is subscribed to push.
  - Every open tab every 3 seconds (`src/web/App.tsx:428`).
- The list has no pages.

**C4. Disk use only grows**
- **Snapshot refs**: each turn that changed something adds up to 2 `refs/harness-relay/…`, removed only by an edit, a Retry or deleting the conversation (`src/server/workspace.ts:173`; `src/server/orchestrator.ts:7041-7047`). Relay never runs `git gc` itself, and git's own automatic gc cannot remove what the refs keep.
- **What snapshots hold**: a snapshot takes every file git does not ignore with `git add -A`, untracked ones too (`src/server/workspace.ts:318`; `docs/architecture.md:763`). Large files a long task writes in the working directory (data, logs, checkpoints) go into `.git` at every turn that changed something, stay there because the refs keep them, and are hashed again at every turn.
- **Worktrees**: parallel mode's and a team's own stay until the conversation is deleted; no startup sweep removes orphaned ones.
- **Attachments**: every scheduled message gets a copy of the schedule's files, in a new conversation each time or not (`src/server/orchestrator.ts:2968,3211`).
- **Browser profiles**: removed only when the conversation is deleted (`src/server/browser/session.ts:856-858,1845`).
- **The open agents' state folders**: one for each member of each conversation.
- **The CLIs' session histories**: kept in each account's home. Deleting a conversation clears only the open agents' state (`src/server/orchestrator.ts:1209-1213`); only removing an account deletes its home, with them (`docs/architecture.md:1155`).

**C5. The SQLite database only grows**
- WAL, without `VACUUM`, `auto_vacuum` or `journal_size_limit` (`src/server/db.ts:897`): deleting data does not make the file smaller.
- `agent_seen` has a row for each message and member.

**C6. Log rotation depends on how the server runs**
- **The desktop app**: 5 MB a file, with one `.old` kept (`desktop/src/log.ts:11,64-73`).
- **`npm start`**: stdout and stderr only; whatever takes them decides their size. systemd's journal is fine.

**C7. Leftover sandboxed processes wait for the next start**
- Each run's end sweeps them once; what survives waits for the next start of the server, mostly on macOS (`src/server/relaySandbox.ts:1306-1309`).

**C8. Notifications are easily pushed out (low)**
- Every failed attempt raises an `error` alert (`src/shared/notify.ts:72-76`): up to 3 for each time of an hourly schedule.
- The inbox keeps only the newest 200 (`docs/architecture.md:1159`).

### D. Where the docs and the code disagree

**D1. Whether a scheduled message that waited in the queue is followed and retried depends on its path**
- The docs: `docs/architecture.md:307` says a scheduled message that waited in the queue "is not followed: it is not retried if all its replies fail".
- **Path 1, delivered into the running run** (by `deliverQueued()` before an agent's next turn, `src/server/orchestrator.ts:6157`):
  - The run's tracking does not change, and the message's `tracked` is ignored.
  - Not followed and not retried: the docs are right.
- **Path 2, starting a run of its own** (through `startQueued()`: the run ended before any turn took it, or the lead agent was reviewing):
  - `carriedTracking()` carries its `tracked` as it is, `retries` included (`src/server/orchestrator.ts:3056-3057`); the run is marked in flight (`src/server/orchestrator.ts:3670`) and retried by `trackedRunEnded()` (`src/server/orchestrator.ts:3134`).
  - Followed, retried, and recovered after a restart: the docs are wrong.
- The test covers only the goal reaching path 2 (`test/orchestrator-tracking.test.ts:120`), not its retry.
- A fix has to cover both paths.

**D2. A string nothing uses**
- The i18n string `trackingRunFailed` is defined and used nowhere (`src/server/i18n.ts:1074,2551`).

## 4. The order it recommends

By how much each one matters to a task over days. Each needs a proposal of its own before it is built.

1. **Act on the kind of failure** (A1, A6)
   - Give `AgentRunError` a kind: usage limit, sign-in, network, other.
   - A usage limit: try again at its `resetsAt`, or on another account of the same CLI, rather than after a fixed 5, 30 and 120 minutes; daily and weekly schedules gain most.
   - A lapsed sign-in, an OAuth account marked `reauth`: an alert of its own.
2. **Close the gaps in retries and recovery** (A7, A8)
   - Retry a tracked goal's runs that an event trigger or a webhook started too, and do not lose an event whose run failed.
   - Recover a run cut off by a long outage, or at least leave a note.
   - Push when a fixed command's code changed, and do not let that failure use up retries.
3. **An inactivity watchdog for turns** (B1): stop a turn after a while with no event at all, and leave it to the retries.
4. **A limit on a fresh session's history** (B3): a summary and the latest N messages, say, so that a long conversation does not outgrow the context the moment its session is fresh.
5. **Recovery for the user's own runs after a restart** (A4): at least offer **Continue** and alert the user after a restart; or carry on by itself, as a tracked goal does.
6. **A server that looks after itself** (A5): the desktop app restarting its server when the server crashes, and keeping the computer awake by default while an automation is on.
7. **Stalls, missing reports and spending** (B5, B9)
   - A reply without its `<progress>` block, or N runs in a row with nothing changing: mark the conversation as needing the user.
   - A spending limit across runs.
8. **Keeping less** (C1–C5)
   - Archive or delete old conversations a schedule opened, and prune snapshot refs.
   - Let `Store.cache` drop what is old, and give the list pages.
   - Look at large untracked files that snapshots take.
   - `VACUUM` the database now and then, or set `journal_size_limit`.

## 5. Running a task over days today

1. **The machine**: one that does not sleep, with the server as a service as in the systemd example of `docs/remote-access.md`. A codespace does not suit, even with a longer timeout, and neither does a MacBook with its lid closed.
2. **The schedule**: an automation with a goal to track, at **set times**; runs an event trigger or a webhook starts are neither retried nor recovered after a restart.
   - Keep the interval no shorter than one run, or the later times are skipped.
   - To get past a usage limit's window, make the interval at least as long as the window (5–6 hours for Claude's 5-hour window, say).
   - Longer is not always better: a daily schedule uses up its retries in about 2.5 hours, and after the limit resets waits most of a day.
3. **Permission**: let the task be done within it.
   - **Approve for me** lets some requests through, but pushing, publishing, more access for the turn and a request that does not say what it would do are always refused, and each request it reviews costs a lead-agent run.
   - Full access asks nothing, at your own risk.
4. **Notifications**: turn on push, to see `blocked`, questions and errors on a phone. These are not pushed, so come back and look:
   - A fixed command's code changed;
   - An event check failed;
   - An OAuth account needs to sign in again;
   - The retries gave up after the third. Each failure has its own `error` alert, but the note that they gave up has none;
   - A run you started that a restart or a crash cut off (`aborted` raises no alert).
5. **Mode and memory**:
   - Roundtable or relay mode, not parallel mode.
   - Have agents keep what later runs need in files in the working directory; turn on long-term memory if needed.
   - Put large output in a folder `.gitignore` covers, so that snapshots do not take it.
   - In a schedule in its own conversation, agents should not ask the user anything; if they must, open a new conversation each time.
6. **Check first**: enough plan usage; a Google OAuth app out of Testing; and, with a fixed command run first, agents leaving the files its pin covers alone.

## 6. Open questions

- Whether the desktop app's **Keep this computer awake while running** (Electron's `prevent-app-suspension`) keeps a MacBook awake with its lid closed (A5): not tried.
- Whether Claude Code, Codex, Grok, Muse, Antigravity, Cursor, Goose, OpenHands and Pi update themselves in a run without a terminal (B7): not checked.
- Whether what each CLI prints when it hits a plan limit, a 429 or a lapsed sign-in can be told apart reliably (what item 1 of section 4 rests on): it depends on the CLIs at run time, and could not be settled from the code.
- Whether a scheduled message that waited in the queue should be followed and retried (D1): its two paths behave differently today, and which one is meant has to be decided first.
