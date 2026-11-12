**English** | [繁體中文](README.zh-TW.md)

# End-to-end test scenarios

What the end-to-end tests (`npm run test:e2e`) try today, area by area. They drive the built UI in a real browser ([Playwright](https://playwright.dev)) against the real server, with fake `claude`, `codex` and `grok` CLIs, so they run offline, cost nothing and run the same on macOS, Linux and Windows.

How they work, how to run one and how to write one is in the developer guide, [End-to-end tests](../docs/developer-guide.md#end-to-end-tests). This page is the list of scenarios: when you add, change or remove an end-to-end test, change this page and [its Chinese copy](README.zh-TW.md) in the same commit ([AGENTS.md](../AGENTS.md), "Documentation").

There are 171 tests in 26 spec files, in each browser that runs them (Chromium by default).

## Running them

```bash
npm run test:e2e:install                      # once: the Chromium Playwright drives
npm run test:e2e                              # every spec, in Chromium (builds the UI first when it is out of date)
npx playwright test e2e/specs/approvals.spec.ts
npx playwright test -g "relay mode"           # by title
npx playwright test --ui                      # pick and watch tests in Playwright's window
```

The developer guide has the rest (other browsers, the report, the variables they read).

## What every test starts with

- **A server of its own** on a free port, with temporary data, a temporary home, the CLIs' homes and the OS keyring off: nothing of your own Harness Relay, CLIs or keychain is read or changed, your credentials are left out of its environment, and git looks for a repository no further up than the test's folder ([`support/relay.ts`](support/relay.ts)).
- **A working directory** with a small project in it: `README.md`, `src/hello.ts` and `src/lib/math.ts` (`seedProject()`). A test that needs other folders adds them next to it (`relay.addProject()`).
- **A browser page signed in** with a new one-time code, the guided tour done and the UI in English ([`fixtures.ts`](fixtures.ts)). A test changes that with `test.use()`: `lang: 'zh-TW'`, `signIn: false`, `tour: true`, or more environment for the server (`serverEnv`).
- **Fake CLIs** ([`fake-cli/fake-cli.cjs`](fake-cli/fake-cli.cjs)) that speak each CLI's protocol and answer `Hello from <name> (<CLI>). You said: “<the user's latest message>”.` The test steers them with `e2e:` directives in the message (`e2e:write=notes.md`, `e2e:approve`, `e2e:slow`…). A fake always tries what a directive asks, and whether it happens depends only on what Harness Relay gave the CLI (its permission, sandbox, folders and the answers to its approval requests), so a test that writes where it may not tells whether the adapter set the CLI up right.
- **A fake `gh`** ([`fake-cli/fake-gh.cjs`](fake-cli/fake-gh.cjs)) for sharing and a problem report's screenshots: it keeps its gists in the test's own folder (`fake-github/`), never on GitHub, and `E2E_FAKE_SIGNED_OUT=gh` signs it out. On Linux, a fake folder dialog (`zenity`) too. AgentsView is a small HTTP server inside [`specs/sessions.spec.ts`](specs/sessions.spec.ts), as Harness Relay only sends it requests.

In the tables below, **each** in the CLI column means the test runs once for each CLI (Claude Code, Codex and Grok).

## Areas

| Area | Spec | Tests | Related docs |
| --- | --- | --- | --- |
| [Signing in](#signing-in) | [`signin.spec.ts`](specs/signin.spec.ts) | 14 | [Architecture → Signing in](../docs/architecture.md#signing-in) |
| [A new chat and the lead agent's team](#a-new-chat-and-the-lead-agents-team) | [`chat.spec.ts`](specs/chat.spec.ts) | 4 | [User guide → Auto team](../docs/user-guide.md#auto-team), [Architecture → Auto team](../docs/architecture.md#auto-team) |
| [Templates](#templates) | [`templates.spec.ts`](specs/templates.spec.ts) | 3 | [User guide → Templates](../docs/user-guide.md#templates) |
| [Changing a chat's team](#changing-a-chats-team) | [`team.spec.ts`](specs/team.spec.ts) | 3 | [User guide → Editing the team mid-chat](../docs/user-guide.md#editing-the-team-mid-chat) |
| [A member's model and reasoning effort](#a-members-model-and-reasoning-effort) | [`models.spec.ts`](specs/models.spec.ts) | 4 | [User guide → Default model and reasoning effort](../docs/user-guide.md#default-model-and-reasoning-effort), [Team members](../docs/user-guide.md#team-members) |
| [How members take turns](#how-members-take-turns) | [`turns.spec.ts`](specs/turns.spec.ts) | 19 | [Architecture → Turn scheduling](../docs/architecture.md#turn-scheduling-modes), [How agents share context](../docs/architecture.md#how-agents-share-context) |
| [What an agent does on its way to a reply](#what-an-agent-does-on-its-way-to-a-reply) | [`activity.spec.ts`](specs/activity.spec.ts) | 4 | [Architecture → Agent activity](../docs/architecture.md#agent-activity) |
| [Approvals](#approvals) | [`approvals.spec.ts`](specs/approvals.spec.ts) | 12 | [User guide → Approvals](../docs/user-guide.md#approvals), [Architecture → Approvals](../docs/architecture.md#approvals), [Permission mapping](../docs/architecture.md#permission-mapping) |
| [Files and changes](#files-and-changes) | [`files.spec.ts`](specs/files.spec.ts) | 10 | [User guide → Reviewing and applying changes](../docs/user-guide.md#reviewing-and-applying-changes), [Browsing files](../docs/user-guide.md#browsing-files), [Architecture → Workspaces and file changes](../docs/architecture.md#workspaces-and-file-changes) |
| [Working directories and other folders](#working-directories-and-other-folders) | [`folders.spec.ts`](specs/folders.spec.ts) | 14 | [Architecture → Several working directories](../docs/architecture.md#several-working-directories), [OS sandboxes by platform](../docs/sandboxing.md) |
| [What reaches each CLI besides the prompt](#what-reaches-each-cli-besides-the-prompt) | [`inputs.spec.ts`](specs/inputs.spec.ts) | 9 | [Architecture → Tool library](../docs/architecture.md#tool-library) |
| [The tool library](#the-tool-library) | [`tools.spec.ts`](specs/tools.spec.ts) | 7 | [User guide → Tool library](../docs/user-guide.md#tool-library-mcp-servers-skills-and-memory), [Architecture → Tool library](../docs/architecture.md#tool-library) |
| [Changing a chat's history](#changing-a-chats-history) | [`history.spec.ts`](specs/history.spec.ts) | 3 | [User guide → Copying, editing and retrying](../docs/user-guide.md#copying-editing-and-retrying), [Branching a conversation](../docs/user-guide.md#branching-a-conversation) |
| [Copying and sharing](#copying-and-sharing) | [`share.spec.ts`](specs/share.spec.ts) | 5 | [User guide → Sharing a conversation](../docs/user-guide.md#sharing-a-conversation), [Architecture → Sharing a conversation](../docs/architecture.md#sharing-a-conversation) |
| [The sidebar](#the-sidebar) | [`sidebar.spec.ts`](specs/sidebar.spec.ts) | 6 | [User guide → Groups](../docs/user-guide.md#groups), [Search](../docs/user-guide.md#search) |
| [Schedules](#schedules) | [`schedule.spec.ts`](specs/schedule.spec.ts) | 1 | [User guide → Schedules](../docs/user-guide.md#schedules), [Architecture → Schedules](../docs/architecture.md#schedules) |
| [Settings](#settings) | [`settings.spec.ts`](specs/settings.spec.ts) | 5 | [User guide → Signing in](../docs/user-guide.md#signing-in), [Lead agent](../docs/user-guide.md#lead-agent) |
| [Accounts](#accounts) | [`accounts.spec.ts`](specs/accounts.spec.ts) | 18 | [User guide → More than one account](../docs/user-guide.md#more-than-one-account), [API keys](../docs/user-guide.md#api-keys-optional), [Architecture → Accounts](../docs/architecture.md#accounts) |
| [What each CLI loads by itself, and Grok's trust](#what-each-cli-loads-by-itself-and-groks-trust) | [`native.spec.ts`](specs/native.spec.ts) | 5 | [User guide → What each CLI loads by itself](../docs/user-guide.md#what-each-cli-loads-by-itself), [Architecture → What each CLI loads by itself](../docs/architecture.md#what-each-cli-loads-by-itself) |
| [Agent sessions and AgentsView](#agent-sessions-and-agentsview) | [`sessions.spec.ts`](specs/sessions.spec.ts) | 6 | [User guide → Agent sessions](../docs/user-guide.md#agent-sessions-the-clis-own-folder-and-agentsview), [Architecture → Agent homes and AgentsView](../docs/architecture.md#agent-homes-and-agentsview) |
| [Voice input's install](#voice-inputs-install) | [`voice.spec.ts`](specs/voice.spec.ts) | 2 | [User guide → Voice input](../docs/user-guide.md#voice-input), [Architecture → Voice input](../docs/architecture.md#voice-input) |
| [Reporting a problem](#reporting-a-problem) | [`report.spec.ts`](specs/report.spec.ts) | 5 | [User guide → Reporting a problem](../docs/user-guide.md#reporting-a-problem), [Architecture → Reporting a problem](../docs/architecture.md#reporting-a-problem) |
| [The guided tour and the theme](#the-guided-tour-and-the-theme) | [`appearance.spec.ts`](specs/appearance.spec.ts) | 4 | [User guide → Language and the guided tour](../docs/user-guide.md#language-and-the-guided-tour) |
| [Limits the environment sets](#limits-the-environment-sets) | [`limits.spec.ts`](specs/limits.spec.ts) | 4 | [Developer guide → Environment variables](../docs/developer-guide.md#environment-variables) |
| [Languages](#languages) | [`i18n.spec.ts`](specs/i18n.spec.ts) | 2 | [Architecture → Languages](../docs/architecture.md#languages) |
| [On a phone](#on-a-phone) | [`mobile.spec.ts`](specs/mobile.spec.ts) | 2 | [Use it from your phone](../docs/remote-access.md) |

## Signing in

[`signin.spec.ts`](specs/signin.spec.ts): a browser that has not signed in (`signIn: false`). The last four also in a development build of the UI (React's StrictMode, which runs each effect twice), which `global-setup.ts` builds next to the usual one.

| Scenario | What is checked |
| --- | --- |
| A browser that is not signed in gets the sign-in page, and a code signs it in | The sign-in page shows and the API answers 401; a wrong code says it is wrong or has expired; a new code opens the app, and the session outlives a reload. |
| A sign-in link signs in once; the code cannot be used again | `/#code=…` signs in and the code leaves the address bar; the same link in another page shows its error. |
| A link opened in a tab that shows the sign-in page already signs it in | The tab goes from the sign-in page into the app. |
| A link's error does not come back after signing in with a code and being signed out | Once signed out again, the sign-in page has no stale error. |
| A sign-in link opened in a tab signed in already keeps it signed in, with requests still on their way | Requests sent with the old key that answer "signed out" arrive with the sign-in's answer, and the page never signs out. |
| A tab that shows the sign-in page follows a sign-in in another tab of the browser | It opens the app without a code of its own. |
| A sign-in link opened in another tab keeps every tab signed in, with requests still on their way | The first tab stays in the app. |
| A tab still on its first check follows a sign-in in another tab | Its first answer is stale by then, and it signs in anyway. |
| A sign-in that gets no answer is given up after 30 seconds, with a message | With the page's clock run forward, the sign-in page says why. |
| A browser signs itself out in Settings | **Settings → Signed-in browsers** lists "this browser"; **Sign out** goes back to the sign-in page. |
| In a development build: a sign-in link opens the app on the first load, asking once whether the browser is signed in | StrictMode's second run of the effect does not ask again or lose the code. |
| In a development build: a link opened in a tab signed in already, or in another tab | As above, with StrictMode. |
| In a development build: a link that does not work shows its error on the first load | The error is on the sign-in page. |

## A new chat and the lead agent's team

[`chat.spec.ts`](specs/chat.spec.ts): a chat started from the New chat page, where the lead agent builds a team for each question.

| Scenario | CLI | What is checked |
| --- | --- | --- |
| The lead agent proposes a team, and once it is confirmed the team answers | Claude Code | The team card names the team, the reason and the member; after **Confirm team** the reply comes with its CLI's tag; the chat is in the sidebar under its first question, and the reply is stored as done. |
| The lead agent's teams used without asking | Claude Code | The card says **Used without asking** and the team answers without waiting. |
| A team of all three CLIs answers in turn | all three | Each member answers with its own CLI's tag, in roundtable order: Claude, Codex, Grok. |
| A follow-up question gets a team again | Claude Code, Codex | The second question gets a team of its own, and only its member answers it. |

## Templates

[`templates.spec.ts`](specs/templates.spec.ts)

| Scenario | CLI | What is checked |
| --- | --- | --- |
| The built-in templates are listed, and one opens to show its members | — | "Three-way debate" is marked built-in, and its dialog lists Proposer, Pragmatist and Skeptic. |
| The lead agent picks a template as it is | all three | The card says it uses "Three-way debate"; over its two rounds each member answers with its CLI, then passes (six replies). |
| A team the lead agent designed is saved as a template | Claude Code, Grok | **Save as template** suggests the team's name, the card says it was saved, and the template is on the New chat page. |

## Changing a chat's team

[`team.spec.ts`](specs/team.spec.ts)

| Scenario | CLI | What is checked |
| --- | --- | --- |
| The lead agent changes the team when asked, and the new member answers once it is saved | Claude Code, Grok | In **Team settings → Ask the lead agent**, the request reaches the lead agent, the drawer shows the member it added, and after **Save** both members answer. |
| When the lead agent's answer cannot be read, a template stands in | Claude Code | An answer that is not JSON falls back to "General-question panel", whose three members answer. |
| A team proposed for a new question is declined | Claude Code, Codex | **No, keep the current team**: the card says it was not used, the current team answers and the proposed member does not. |

## A member's model and reasoning effort

[`models.spec.ts`](specs/models.spec.ts): chosen in **Team settings** and saved.

| Scenario | CLI | What is checked |
| --- | --- | --- |
| The model and effort chosen for a member reach its CLI | each | They are stored with the member, and the CLI gets them as its adapter passes them: Claude Code's `--model` and `--effort`, Codex's `thread/start` parameters (`model_reasoning_effort`), Grok's `session/set_config_option` before the prompt. |
| The default model and effort in Settings are what a member left on Default runs with | Claude Code | With sonnet and Low saved as the default, the drawer says "Default: sonnet", the member stays on Default, and its turn gets `--model sonnet --effort low`. |

## How members take turns

[`turns.spec.ts`](specs/turns.spec.ts)

| Scenario | CLI | What is checked |
| --- | --- | --- |
| An agent asks the user, waits for the answer, then answers with it | Claude Code | The question shows without `[ASK_USER]`, with a card that waits for the answer; the composer says **Answer @Claude…** and the sidebar **Answer needed**; the answer reaches the agent. |
| A question is skipped, and the rest of the team goes on | Claude Code, Grok | **Skip, let the team go on**, and the next member answers. |
| Relay mode: a member hands the floor to the teammate it mentions | Claude Code, Codex | The first member answers first and mentions the second, which answers; then the floor comes back to the user (two replies). |
| A message that @mentions a member is answered by that member only | all three | Only @Grok answers. |
| In a later round, members with nothing to add pass, and the round ends early | Claude Code, Codex | With three rounds: both answer, both pass, and there is no third round. |
| A reply can be stopped | each | While the reply streams, **Stop** ends it with "(stopped)", and the live tag and the Stop button go away. |
| An error inside the CLI's protocol is shown on the reply | each | Claude's error result, a failed Codex turn and a Grok JSON-RPC error show on the reply. |
| A member's next turn resumes its own session | each | The second turn resumes the session the first started (the fakes refuse to resume one they never started, as the real CLIs do). |
| A member whose CLI lost its session starts a new one with the chat so far | Claude Code | With the CLI's sessions deleted, the next prompt carries the whole chat, the first message too. |
| A failed reply shows the CLI's error, and Retry answers again | each | A CLI that exits with an error: its error is on the reply, and **Retry** answers. |
| A message sent while the team replies waits, then reaches the next member | Claude Code, Grok | The message waits in the tray while the first member answers slowly, and the next member answers it. |

## What an agent does on its way to a reply

[`activity.spec.ts`](specs/activity.spec.ts)

| Scenario | CLI | What is checked |
| --- | --- | --- |
| Thinking, a tool call and a to-do list are shown with the reply | each | The steps fold into rows; opened, they show the thinking, the tool (Claude's `Bash`, Codex's `Shell`, Grok's `list_dir`) done with its output, and the to-do list with one of three done and one in progress. |
| A reply in Markdown is rendered | Claude Code | A heading, a list, a table and highlighted code. |

## Approvals

[`approvals.spec.ts`](specs/approvals.spec.ts): an agent that wants to run a command (`echo e2e-approval`) in a read-only chat that asks the user. The answer reaches each CLI's own request: Claude Code's `can_use_tool`, Codex's approval request and Grok's `session/request_permission`.

| Scenario | CLI | What is checked |
| --- | --- | --- |
| A command the user allows runs | each | The card shows the command and the sidebar **Needs you**; after **Allow** the command ran and the card says Allowed. |
| A command the user declines does not run, and the note goes with it | each | The card says "Declined: Not now"; Claude Code and Grok get the note with the refusal (Codex's answer has no room for one). |
| "Always allow" answers the same request by itself the next time | Claude Code | The second request is allowed automatically, with no card. |
| Stopping the team while a request waits ends it without running the command | Claude Code | The reply ends "(stopped)" and the request is declined or unanswered. |
| With full access, the command runs and files are written anywhere without asking | each | The header warns **Full access**; the command runs and a file is written in another folder, with no card. |
| A chat that refuses automatically declines without asking | Claude Code | The command is declined, with no card. |

## Files and changes

[`files.spec.ts`](specs/files.spec.ts)

| Scenario | CLI | What is checked |
| --- | --- | --- |
| In edit mode an agent changes files, and the chat shows what changed | Claude Code | The file is in the working directory, which became a git repository; the changes card lists it and opens the turn's diff. |
| In a read-only chat no file is written | each | Claude Code runs without its file tools (no card); Codex and Grok ask, and are declined; no file is written and there is no changes card. |
| Grok in a read-only chat that refuses automatically says why | Grok | The tool's error says it is not allowed in read-only mode. |
| Every CLI writes in edit mode, and each turn records its own change | all three | Each member writes its own file, and each reply's changes card lists it. |
| In parallel mode each member works in its own worktree, and a result can be applied | Claude Code, Codex | Both changes cards say "in worktree" and nothing reaches the working directory until **Apply to working directory** brings in Codex's file. |
| The file browser shows the working directory and previews a file | Claude Code | **Files** lists the project; `src/hello.ts` opens with its code; Escape closes it. |
| A folder downloads as a ZIP file of its files, without .git | Claude Code | The working directory's ZIP (`work.zip`) holds exactly its files, with their contents, and no `.git`; a folder's own (`src.zip`) only that folder. |
| A folder too large to zip in full is offered without what git ignores | Claude Code | An ignored file set to more than 1 GiB without writing to it (on Windows it still takes the space on disk) makes it too large: declining the offer downloads nothing, accepting gives the ZIP without the ignored folder. |

## Working directories and other folders

[`folders.spec.ts`](specs/folders.spec.ts): the fakes write only where the real CLIs could, so these tell whether a chat's folders reach each CLI.

| Scenario | CLI | What is checked |
| --- | --- | --- |
| A folder the chat was not given stays out of reach in edit mode | each (Grok not on Windows) | Refused automatically, nothing is written next door. Grok has no sandbox on native Windows, so it is skipped there. |
| Writing in a folder the chat was not given asks first, and writes once the user allows it | Claude Code, Codex | **Allow** on the "wants to change files" card, and the file is written there. |
| Folders are added and removed in the box, and the chat works in all of them | Claude Code | Folders typed into **Working directories** become chips and can be removed; the chat stores the folders left, and the agent writes in the first and the second, not the removed one. |
| Each CLI writes in each folder, and the changes card lists them by folder | each | Two files in two folders: the card says "Changed 2 files" with a group per folder, and the diff shows both. |
| The file browser lists every working directory | Claude Code | **Files** has a **Folder** list with both folders; the second shows its own files. |
| In parallel mode each member gets a worktree of each folder, and Apply applies them all | Claude Code, Codex | Both replies have a worktree change in each folder; **Apply** writes Codex's files in both folders. |
| Settings' default working directories are where new chats start | — | A folder saved in **Settings → Default working directories** is in the box of the next new chat. |
| The folder dialog adds the folders chosen in it, and the chat starts in all of them | Linux only | **Choose folders…** (the fake `zenity`) adds two folders; the dialog opened inside the last folder, with several allowed and an English title; the new chat has the three folders. |
| The folder dialog in Chinese, on a server without a UTF-8 locale | Linux only | The dialog's title is in Chinese and it gets `LC_CTYPE=C.UTF-8`; Cancel adds nothing. |

## What reaches each CLI besides the prompt

[`inputs.spec.ts`](specs/inputs.spec.ts)

| Scenario | CLI | What is checked |
| --- | --- | --- |
| An MCP server from the tool library, with its secret kept off the command line | each | The member names the server it got, and its secret value is in no argument the CLI was started with. |
| An HTTP MCP server from the tool library, with its secret header kept off the command line | each | The CLI gets it as an HTTP server at its URL, with the `Authorization` header and its value, which is in no argument the CLI was started with. |
| An attached image | each | The image is attached in the composer, the reply says it got one image, and the prompt names the file for the agent's own tools. |

## The tool library

[`tools.spec.ts`](specs/tools.spec.ts): **Settings → Tool library**, in a chat with a Claude Code, a Codex and a Grok member.

| Scenario | CLI | What is checked |
| --- | --- | --- |
| An MCP server added on the page reaches every CLI, its secret masked and kept off the command line | all three | The row says "All members"; editing shows the value empty with a masked placeholder; neither the page nor `GET /api/tools` holds the secret; each member names the server and got its value, in no argument; Claude Code's `--mcp-config` file is gone after the turn. |
| An MCP server turned off for a CLI, or in a member's Tools, is not given | all three | Off for Codex in "Given by default to", Codex gets nothing; ticked in Codex's **Tools** and unticked in Grok's, Codex gets it (its saved value kept) and Grok does not. |
| A skill picked from a folder is in each CLI's briefing, and each reads its SKILL.md | all three | Of a folder with two skills, the one added is in each briefing and each reads its first line; the other never shows. Claude Code may read it only through the `Read(…)` rule its adapter adds (the fake refuses without it). |
| A skill turned off for a CLI, or in a member's Tools, is not given | all three | Off for Grok and unticked in Claude's **Tools**, neither gets it, and Claude Code's arguments name it nowhere. |
| Memory for all members and for one CLI reaches each briefing, and a member's Tools can leave it out | all three | Codex gets the shared memory and its own note, in order, the others only the shared one; unticking "Shared memory" in Grok's **Tools** leaves Grok none. |
| An MCP server given a new value on the page gets it at the next turn, and once removed it is given no more | all three | Edited, the page shows the new mask and each CLI's next turn gets only the new value, in no argument; removed, the next turn gets it neither by name nor by value. A second server stays throughout, so that "given nothing" cannot pass on a turn that got no library at all. |
| A skill and a memory note removed on the page are given no more | all three | One of two skills and the shared memory note removed: the next briefing and reply have neither, while the other skill and each CLI's own note still arrive. |

## Changing a chat's history

[`history.spec.ts`](specs/history.spec.ts)

| Scenario | CLI | What is checked |
| --- | --- | --- |
| A message is edited and sent again: what came after it is replaced | Claude Code | The edit box warns that resending deletes what follows; the chat then holds the corrected message and one new reply. |
| Retry on a finished reply lets the member answer again | Grok | The CLI gets the prompt again, and the chat still holds one reply. |
| A conversation branched from a reply goes on by itself, and the original stays as it was | Codex | **Branch conversation** opens a new chat that says what it continues from; its new message is not in the original, and the sidebar lists both. |

## Copying and sharing

[`share.spec.ts`](specs/share.spec.ts): sharing goes through the user's own `gh`, here the fake one.

| Scenario | CLI | What is checked |
| --- | --- | --- |
| A reply's copy button copies its Markdown, not the text on screen | Codex | The clipboard holds the source (a heading, a table's pipes, a code fence), and the button says Copied. Chromium only. |
| The share dialog copies the whole conversation, or up to a reply, as Markdown | Claude Code | The header's dialog copies the whole transcript; a reply's own **Share** only what comes up to it. Chromium only. |
| A shared chat is a secret gist of the page the browser made, listed in Settings until removed | Claude Code | `gh gist create --filename index.html …` stores a secret gist whose page has the question and the reply but not the steps between (thinking, tools); the link is gistpreview's, and the gist's own is beside it; **Settings → Shared conversations** lists it, and **Remove** deletes the gist (`gist delete <id> --yes`). |
| With gh signed out, sharing says how to sign it in, and nothing is shared | Grok | `E2E_FAKE_SIGNED_OUT=gh`: the help names `gh auth login`, **Create link** can be tried again, and nothing is stored. |
| Without gh, sharing says how to install it and sign it in | Claude Code | A `gh` that cannot start gets the help with the install commands and the restart note. Not on Windows, where a `#!` line cannot stand in for a missing program. |

## The sidebar

[`sidebar.spec.ts`](specs/sidebar.spec.ts)

| Scenario | CLI | What is checked |
| --- | --- | --- |
| The lead agent sorts a new conversation into the user's group | Claude Code | A group made with **New group** gets the new chat whose first message names it. |
| A conversation is renamed and deleted | — | The title changes in the header and the sidebar; **Delete conversation** removes it from the sidebar and the server. |
| Search finds a conversation by what an agent wrote in it | Codex | Searching for words of the reply finds that one chat, which opens. |
| A conversation started in the UI keeps the title given at the start | Claude Code | The title stays after the first question. |
| A conversation dragged into a group is kept there, and dragged out goes back to Other | — | The server stores the group, which a reload keeps; dragged to Other, its group is cleared and the group shows "Drag conversations here" again. |
| A branched conversation's family moves between groups as one | Codex | Dragging the branch moves its original with it, the branch still under it; dragging the original back brings both. |

## Schedules

[`schedule.spec.ts`](specs/schedule.spec.ts)

| Scenario | CLI | What is checked |
| --- | --- | --- |
| A chat's schedule is saved, and running it once sends its message to the team | Codex | Saved "Every day", the sidebar marks the chat; **Run once now** sends the message, marked Scheduled, and the member answers. |

## Settings

[`settings.spec.ts`](specs/settings.spec.ts)

| Scenario | CLI | What is checked |
| --- | --- | --- |
| Each CLI is found, with its version, and signed in | each, in one test | Each card shows the CLI's version and **Signed in** (Claude Code with its account); the sidebar's dots are OK for the three and show Cursor, which no fake stands in for, as not installed ("3/4 ready"); their names show when asked for, and stay after a reload. |
| A CLI's executable path can be set, and a wrong one shows it as missing | Grok | A path that does not exist shows **Not installed**; an empty one finds it again. |
| The language can be switched, and the choice is kept | — | 繁體中文 changes the page, a reload keeps it, and English changes it back. |
| Another CLI can be the lead agent | Codex as lead agent | The New chat page names it, the team card says "Lead agent: Codex", and the lead agent's prompt went to Codex. |
| A CLI that is not signed in shows as signed out, and its reply says why | Codex | `E2E_FAKE_SIGNED_OUT=codex`: its health dot and card say **Not signed in** (without the CLI's own words), with a **Sign in** button, and its reply carries the CLI's error. |

## Accounts

[`accounts.spec.ts`](specs/accounts.spec.ts): **Settings → each CLI's card → Add an account**.

| Scenario | CLI | What is checked |
| --- | --- | --- |
| An added account has a folder of its own, and a member set to use it runs there | each | The account lives in `<data>/accounts/<cli>-<id>`, which its card shows; a member on it runs with that home (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GROK_HOME`), a member on the default account with the default one. |
| Each account signs in and out on its own | Claude Code | **Sign out** runs `auth logout` in the added account's home only; **Sign in** goes through the CLI's own flow (a link, then a pasted code) and shows the account signed in. |
| Signing an added account out signs out only that account | Codex, Grok | `logout` runs in that account's folder only; its card says **Not signed in**, and the default account stays signed in. |
| With the credential store off, an account's API key is kept in the database, shown masked, and given to its CLI only | Claude Code, Grok | The key box says where keys are kept; saved, the key shows masked with "Using an API key" and never in `/api/settings`; that account's run gets it (`ANTHROPIC_API_KEY`, `XAI_API_KEY`), in no argument, and the default account's does not. |
| An account's API key signs that account in with Codex's own login | Codex | Codex takes no key in its environment: the key goes on stdin to `codex login --with-api-key` in that account's folder only, Harness Relay keeps none, and only that account's runs have it. |
| The API key Harness Relay was started with is the default account's only | each | A key in the server's own environment (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY`) reaches the default account's turns and not an added account's. |
| Removing an added account signs it out and deletes its folder, and its member and the lead agent use the default account | each | The confirmation names the folder; the account signs out there, then the folder and its sessions are gone; the lead agent goes back to the default account; the member's next turn runs in the default home, in a new session. |
| An account added while the CLIs' status is on its way keeps the newer answer's state | Claude Code | The page's next status answer is held back until after the account is added (`page.route`): when that older answer, without the account, comes in last, the account's pill stays **Signed in** instead of going back to "Checking…". |
| A CLI signed out outside Harness Relay shows so when Settings is opened again | Claude Code | Signed out in its home, as `claude auth logout` in a terminal would, while the server's cache still says signed in: reopened, Settings' own check wins over the cached answer the app asks for at the same time, and the pill says **Not signed in**. |
| An account is not removed while a conversation runs | Claude Code | During a slow reply **Remove** says a conversation is running and nothing changes; once the chat is stopped, it works. |

## What each CLI loads by itself, and Grok's trust

[`native.spec.ts`](specs/native.spec.ts): an account's box **Skills, MCP servers, hooks, memory and more this CLI loads by itself → Ask**, and Grok's trust in a project.

| Scenario | CLI | What is checked |
| --- | --- | --- |
| Its own skill is listed, and one left out is not loaded in its next run | Claude Code, Codex | A skill in the CLI's home is listed (Codex's by its file) and loaded in a turn; ticked, **Ask** marks it "left out", and the next turn loads none (Claude Code's `skillOverrides`, Codex's `skills.config`). |
| The Grok card shows the folder's trust; trusting it loads the project's skills, and leaving them out reaches the next run | Grok | Untrusted, the card says so and lists no skill; **Trust this folder** writes `$GROK_HOME/trusted_folders.toml`, and the project's skill appears; **Leave all out** reaches the next turn (`GROK_CLAUDE_SKILLS_ENABLED=false`), which runs trusted and loads none. |
| A team with a Grok member says when Grok does not trust the folder, and trusting it there records the trust | Grok | From the team card, the trust is recorded and Grok's turn runs trusted. |
| The team starts without trusting the folder when the user declines | Grok | Nothing is recorded, **Confirm team** still starts, and Grok's turn runs untrusted. |

## Agent sessions and AgentsView

[`sessions.spec.ts`](specs/sessions.spec.ts): **Settings → Agent sessions**. AgentsView is a stand-in HTTP server on 127.0.0.1 inside the spec.

| Scenario | CLI | What is checked |
| --- | --- | --- |
| The folder chosen in Settings is where each CLI keeps its sessions | all three | The folder is saved (owner-only, not checked on Windows), each CLI's session lands in `<folder>/<cli>/`, and nothing goes to the usual homes. |
| After the folder changes, each member starts a fresh session there with the chat so far | all three | The next prompt carries the whole chat, the new session is in the new folder, and the old one stays where it was. |
| A folder inside Harness Relay's own folder or the default working directory is refused | — | Both refusals are shown, nothing is created, and the setting stays empty. |
| The folder cannot change while a conversation runs | Claude Code | During a slow reply Save says a conversation is running; once it is stopped, Save works. |
| A conversation is sent to AgentsView after each turn and when it is renamed, with its members' sessions under it | Claude Code, Codex | The upload carries AgentsView's own `Origin` and the project and machine of a session it knows; the transcript holds the question, both replies and the title; each member's session is linked under it; a rename sends the new title. |
| An address elsewhere is refused, and when an update fails Settings says why while the chat goes on | Claude Code | An address off this computer is refused with the reason, and the setting stays empty; when AgentsView answers 503, the reply has no error and the card says the last update failed, and why. |

## Reporting a problem

[`report.spec.ts`](specs/report.spec.ts): the sidebar's **Report a problem**. The mail's links are caught in the page (`window.open`, the clipboard, and the `mailto:` navigation, cancelled), so nothing opens and nothing goes online. The three tests that read the mail's links are skipped in a browser without the Navigation API.

| Scenario | What is checked |
| --- | --- |
| The mail's links carry the description and the version and system details | Send waits for a description; the details match `/api/about`, the browser, each CLI's version and the language, without a temporary path; the `mailto:` link has the address, a subject from the first line and the body; the Gmail link the same; **Copy report** copies the whole mail; the dialog opens empty again once sent. |
| A report closed before it was sent is kept, and the kind and subject chosen go in the mail | The kind, subject and description outlive Escape, and the mail says `[Harness Relay] Idea: <subject>` and `Type: Idea`. |
| A report too long for the mail link goes on the clipboard, and the mail says to paste it | The `mailto:` link stays within its limit and asks to paste the report, which is on the clipboard; the Gmail link still carries all of it. |
| Screenshots added must be uploaded or removed before the mail can go | A text file is refused with its reason; a PNG shows a thumbnail and holds both send buttons until it is removed. |
| Screenshots that cannot be uploaded say why, and the report goes without them | With the fake `gh` signed out, **Upload screenshots** says gh is not signed in, and once the screenshot is removed the report can go. |

## Voice input's install

[`voice.spec.ts`](specs/voice.spec.ts): **Settings → Voice input** with an install under way. A real install downloads the engine and a model, which the tests cannot do offline, so the page gets the server's own answer to `GET /api/voice` with an install put in.

| Scenario | What is checked |
| --- | --- |
| The install shows its steps in line, says their state to screen readers, and its download in the bar | The steps in a row, the current one marked `aria-current`, the download's percent and the bar's fill. |
| A failed install says which step stopped | The step it stopped at is shown as failed. |

## The guided tour and the theme

[`appearance.spec.ts`](specs/appearance.spec.ts): the tour as on a first visit (`tour: true`), and **Settings → Appearance**.

| Scenario | What is checked |
| --- | --- |
| The tour shows on a first visit, steps through to the end, and is not shown again | It opens at step 1 without Back; Next, Back and the arrow keys move; the last step has no Skip, **Get started** closes it, and a reload does not bring it back. |
| The tour can be skipped, and Settings starts it again | Skipped, it stays away after a reload; **Settings → Guided tour → Replay the tour** opens it at step 1, Escape closes it, and it stays done. |
| Dark or light chosen in Settings is set on the page, kept after a reload, and wins over the system | Dark sets `data-theme`, the background and the `theme-color` metas, and survives a reload; Light stays light with the system dark. |
| Following the system follows its light or dark mode | **Follow system** removes `data-theme`, and the page follows the emulated light or dark mode, open and after a reload. |

## Limits the environment sets

[`limits.spec.ts`](specs/limits.spec.ts): a server started with `RELAY_MAX_TEAM_AGENTS=2`, `RELAY_MAX_ACCOUNTS=2` and `RELAY_TURN_TIMEOUT_MIN=90`.

| Scenario | What is checked |
| --- | --- |
| The team editor stops adding members at the limit, and the server refuses more | `GET /api/limits` gives the three values; after a second member the **＋** buttons are disabled; a template of three is refused with 400. |
| A template larger than the limit says why it cannot be used, and the lead agent does not pick one | "Three-way debate" says a team may have at most two members; when the lead agent picks it, the card says why and uses "General-question panel" cut to two (Analyst and Critic). |
| A schedule's hint gives the turn timeout | With **Ask me**, the New schedule page says the agent waits up to 90 minutes per turn. |
| Settings stops adding accounts at the limit | After the second account, **Add an account** is disabled and says so. |

## Languages

[`i18n.spec.ts`](specs/i18n.spec.ts)

| Scenario | What is checked |
| --- | --- |
| The app, its templates and the lead agent's card are in Chinese; the agents get English prompts | In zh-TW, the New chat page, a built-in template, the composer's hint and the team card are in Chinese, and the turn prompt is in English ([AGENTS.md](../AGENTS.md), "Prompts and languages"). |
| The sign-in page and the server's own messages follow the language | The sign-in page and the server's error for a wrong code are in Chinese. |

## On a phone

[`mobile.spec.ts`](specs/mobile.spec.ts): a Pixel 7's screen and touch, the way the chat is used over Tailscale. Skipped in Firefox, which has no mobile emulation.

| Scenario | CLI | What is checked |
| --- | --- | --- |
| The sidebar opens from the menu, and a chat works by touch | Grok | The sidebar is out of view until **Open sidebar**, and closes again on going somewhere; the send button sends (Enter is a new line on a touch screen); the header's actions are under **More**. |
| A long message keeps the page from scrolling sideways | Claude Code | A 300-character word and a Markdown reply leave no sideways scroll. |

## Each CLI at a glance

The scenarios tried with each of the three CLIs (most of them as a test per CLI), so a change in one adapter shows up here:

| Scenario | Claude Code | Codex | Grok |
| --- | --- | --- | --- |
| Thinking, a tool call and a to-do list | ✓ | ✓ | ✓ |
| A command allowed, and declined with a note | ✓ | ✓ (no note) | ✓ |
| Full access: runs and writes anywhere without asking | ✓ | ✓ | ✓ |
| A read-only chat writes nothing | ✓ (no file tools) | ✓ (asks, declined) | ✓ (asks, declined) |
| A folder the chat was not given stays out of reach | ✓ | ✓ | ✓ (not on Windows) |
| Writing there once the user allows it | ✓ | ✓ | — |
| Several working directories: a file in each | ✓ | ✓ | ✓ |
| An MCP server from the tool library, its secret off the command line | ✓ | ✓ | ✓ |
| An attached image | ✓ | ✓ | ✓ |
| A reply stopped | ✓ | ✓ | ✓ |
| An error inside the protocol | ✓ | ✓ | ✓ |
| A failed reply (the CLI exits) and Retry | ✓ | ✓ | ✓ |
| The next turn resumes its own session | ✓ | ✓ | ✓ |
| Version and sign-in in Settings | ✓ | ✓ | ✓ |
| A member's model and effort | ✓ | ✓ | ✓ |
| An added account's own home | ✓ | ✓ | ✓ |
| The tool library's MCP server, skill and memory: given, edited and removed | ✓ | ✓ | ✓ |
| The CLIs' own folder for sessions, and a fresh session after it changes | ✓ | ✓ | ✓ |
| Its own skills listed, and left out of the next run | ✓ | ✓ | ✓ (after trusting the folder) |
| An HTTP MCP server and its header | ✓ | ✓ | ✓ |
| An added account signed out on its own | ✓ | ✓ | ✓ |
| An account's API key, to that account only | ✓ | ✓ (through `codex login`) | ✓ |
| The server's own API key, to the default account only | ✓ | ✓ | ✓ |
| Removing an added account | ✓ | ✓ | ✓ |

## Platforms and browsers

- [`.github/workflows/e2e.yml`](../.github/workflows/e2e.yml) runs every spec in Chromium on Ubuntu, macOS and Windows with Node 24, and on Ubuntu with Node 22, for each pull request and each push to `main`. Run it by hand to choose other browsers; locally, `E2E_BROWSERS=chromium,firefox,webkit` ([`playwright.config.ts`](../playwright.config.ts)).
- The folder dialog tests run on Linux only: Linux finds its dialog on the PATH, where the fake one stands in; macOS and Windows open their own by their full paths.
- "A folder the chat was not given stays out of reach" is skipped for Grok on Windows, which has no sandbox there ([OS sandboxes by platform](../docs/sandboxing.md)).
- [On a phone](#on-a-phone) is skipped in Firefox.
- The two copy tests in [Copying and sharing](#copying-and-sharing) run in Chromium only (reading the clipboard), and "Without gh" is skipped on Windows.
- The three tests of [Reporting a problem](#reporting-a-problem) that read the mail's links are skipped in a browser without the Navigation API.

## What they do not cover

- **The CLIs themselves.** The fakes check Harness Relay's side of each protocol; the [live tests](#the-live-tests) try the real ones, by hand. A CLI that changes what it writes is caught by the adapter tests' recorded messages (`test/claude.test.ts`, `test/codex.test.ts`, `test/grok.test.ts`) and by trying the real CLI in the app.
- **Features no spec goes through yet**: voice input itself, recording and transcribing (it downloads its engine and models, and needs a microphone; only its install's panel is tried); the files a shared reply links to, and uploading a report's screenshots (both push to a gist with git, which the fake `gh` does not stand in for); API keys in the OS credential store (the tests keep it off, so they go to the database); signing Codex and Grok in from Settings (their device flows), and what the real Codex does with a key `codex login --with-api-key` was given; AgentsView's links to the lead agent's and the group sorter's sessions, and conversations sent once an address is set; a ZIP too large even without what git ignores; and the desktop app's window beyond signing in (its own checks, `desktop/scripts/smoke.ts` and `desktop/scripts/check-package.ts`, start a read-only chat of these fake claude, codex and grok and have each answer a question, on the bundled server and in the packaged app: in CI on Linux and Windows, and on every system before a release). Some of them have unit tests in [`test/`](../test/), listed in the developer guide's [Testing](../docs/developer-guide.md#testing).

## The live tests

[`live/`](live/) holds a second suite, `npm run test:e2e:live` with [`playwright.live.config.ts`](../playwright.live.config.ts): the real CLIs, signed in as you are, on real models, so it costs a little and never runs on CI. It is not counted above. Its 11 tests try a CLI's default model set to an endpoint's in Settings, the CLIs' own cloud models, a member on a deleted endpoint's model, a model typed for an endpoint, the open agents on native Windows below full access, a team on cloud and local models together, and Cursor writing in a chat's second working directory. How to run them: the developer guide's [Live tests](../docs/developer-guide.md#live-tests).

## Related docs

- [Developer guide → End-to-end tests](../docs/developer-guide.md#end-to-end-tests): how they work, the fixtures, the fake CLIs and their `e2e:` directives, and writing a test.
- [Developer guide → Testing](../docs/developer-guide.md#testing) and [Continuous integration](../docs/developer-guide.md#continuous-integration): the unit tests and the CI workflows.
- [Contributing → Tests](../CONTRIBUTING.md#tests): the rules for tests.
- [User guide](../docs/user-guide.md): the features these scenarios go through, as a person uses them.
- [Architecture](../docs/architecture.md): how the server does what they check ([CLI adapters](../docs/architecture.md#cli-adapters), [Permission mapping](../docs/architecture.md#permission-mapping), [Security](../docs/architecture.md#security)).
- [OS sandboxes by platform](../docs/sandboxing.md): why a folder the chat was not given stays out of each CLI's reach, and where it does not.
- [Use it from your phone](../docs/remote-access.md): what [On a phone](#on-a-phone) stands for.
- [Developer guide → Live tests](../docs/developer-guide.md#live-tests): the second suite, with the real CLIs.
- Code: [`playwright.config.ts`](../playwright.config.ts), [`fixtures.ts`](fixtures.ts), [`global-setup.ts`](global-setup.ts), [`support/`](support/) (`relay.ts`, `app.ts`, `fake-cli.ts`), [`fake-cli/`](fake-cli/) and [`specs/`](specs/).
