**English** | [繁體中文](README.zh-TW.md)

# End-to-end test scenarios

What the end-to-end tests (`npm run test:e2e`) try today, area by area. They drive the built UI in a real browser ([Playwright](https://playwright.dev)) against the real server, with a fake for each of the twelve agent CLIs (Claude Code, Codex, Grok, Cursor, Antigravity, Copilot, Muse Code, and the five open agents: OpenCode, Goose, Cline, OpenHands and Pi), so they run offline, cost nothing and run on macOS, Linux and Windows alike, but for what each system's sandboxes allow ([Platforms and browsers](#platforms-and-browsers)).

How they work, how to run one and how to write one is in the developer guide, [End-to-end tests](../docs/developer-guide.md#end-to-end-tests). This page is the list of scenarios: when you add, change or remove an end-to-end test, change this page and [its Chinese copy](README.zh-TW.md) in the same commit ([AGENTS.md](../AGENTS.md), "Documentation").

There are 391 tests in 31 spec files, in each browser that runs them (Chromium by default). Some run only on some systems, or only where Harness Relay's own sandbox works: see [Platforms and browsers](#platforms-and-browsers).

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

- **A server of its own** on a free port, with temporary data, a temporary home, the CLIs' homes (`.claude`, `.codex`, `.grok`, `.gemini`, `.copilot`, `.config/cursor`, and Muse Code's `.config/muse` and `.local/share/muse` in that home, the open agents' in the data folder) and the OS keyring off: nothing of your own Harness Relay, CLIs or keychain is read or changed, your credentials (Cursor's, Antigravity's and Google's too) are left out of its environment, and git looks for a repository no further up than the test's folder ([`support/relay.ts`](support/relay.ts)). On macOS and Linux its folder is in `/tmp` (or `E2E_TMP_DIR`), whose path is short enough for the sockets of Harness Relay's own sandbox.
- **A fake model endpoint** of its own: a small HTTP server set up as the model backend `e2e` (**Settings → Model backends**) with the models `e2e-model` and `e2e-model-mini`, and `e2e/e2e-model` as each open agent's default model, so the open agents a test installs are ready (OpenHands with its terminal switch on). No model answers there: it lists its models, and takes the log lines of the fakes that run inside Harness Relay's own sandbox. A test can start without it (`openBackend: false`), with OpenHands' switch off (`sandboxTerminal: false`), or with CLIs not installed (`missingClis`).
- **A working directory** with a small project in it: `README.md`, `src/hello.ts` and `src/lib/math.ts` (`seedProject()`). A test that needs other folders adds them next to it (`relay.addProject()`).
- **A browser page signed in** with a new one-time code, the guided tour done and the UI in English ([`fixtures.ts`](fixtures.ts)). A test changes that with `test.use()`: `lang: 'zh-TW'`, `signIn: false`, `tour: true`, or more environment for the server (`serverEnv`).
- **Fake CLIs** ([`fake-cli/`](fake-cli/)), one for each of the twelve. A test server has Claude Code, Codex and Grok installed, and the CLIs the test is about (a test of each CLI its own, a test of the two teams its team's, `withClis()` in [`support/clis.ts`](support/clis.ts) any other): the others are not installed there, as the server asks every installed CLI for its version, sign-in, models and what it loads by itself whenever a page opens, some six starts each. They speak each CLI's protocol and answer `Hello from <name> (<CLI>). You said: “<the user's latest message>”.` The test steers them with `e2e:` directives in the message (`e2e:write=notes.md`, `e2e:approve`, `e2e:slow`…). A fake always tries what a directive asks, and whether it happens depends only on what Harness Relay gave the CLI (its permission, flags and settings, sandbox, folders and the answers to its approval requests), so a test that writes where it may not tells whether the adapter set the CLI up right. The fakes of Claude Code, Codex, Grok, Copilot and Muse Code work out what their CLI's own sandbox would allow; Cursor's and Antigravity's, which have no sandbox, ask as the real ones do; the open agents' fakes write and reach hosts for real, so below full access what is not theirs is refused by Harness Relay's own sandbox itself (on macOS and Linux). A fake inside it cannot write the fakes' log, so it sends its lines to the fake endpoint.
- **A fake `gh`** ([`fake-cli/fake-gh.cjs`](fake-cli/fake-gh.cjs)) for sharing and a problem report's screenshots: it keeps its gists in the test's own folder (`fake-github/`), never on GitHub, and `E2E_FAKE_SIGNED_OUT=gh` signs it out. On Linux, a fake folder dialog (`zenity`) too. AgentsView is a small HTTP server inside [`specs/sessions.spec.ts`](specs/sessions.spec.ts), as Harness Relay only sends it requests.

In the tables below, the CLI column says which CLIs a test runs with: **each** means once for each of the twelve; **each with a sign-in** once for each of Claude Code, Codex, Grok, Cursor, Antigravity, Copilot and Muse Code; **each open agent** once for each of OpenCode, Goose, Cline, OpenHands and Pi; and **two teams** that the test runs twice, with a team of the seven with a sign-in and with a team of the five open agents (its title then starts with `open agents:`). Where a CLI runs only with full access (the open agents on Windows, OpenCode on Linux), a test about permissions skips it, saying why, and any other test runs it with full access. On CI, a CLI's own tests (each, and its place in the two teams) run on macOS and Windows only for the CLIs Harness Relay runs differently there than on Linux: see [Platforms and browsers](#platforms-and-browsers).

## Areas

| Area | Spec | Tests | Related docs |
| --- | --- | --- | --- |
| [Signing in](#signing-in) | [`signin.spec.ts`](specs/signin.spec.ts) | 14 | [Architecture → Signing in](../docs/architecture.md#signing-in) |
| [The home page](#the-home-page) | [`home.spec.ts`](specs/home.spec.ts) | 2 | [User guide → Start a chat](../docs/user-guide.md#3-start-a-chat--new-chat-and-templates) |
| [A new chat and the lead agent's team](#a-new-chat-and-the-lead-agents-team) | [`chat.spec.ts`](specs/chat.spec.ts) | 5 | [User guide → Auto team](../docs/user-guide.md#auto-team), [Architecture → Auto team](../docs/architecture.md#auto-team) |
| [Templates](#templates) | [`templates.spec.ts`](specs/templates.spec.ts) | 4 | [User guide → Templates](../docs/user-guide.md#templates) |
| [Changing a chat's team](#changing-a-chats-team) | [`team.spec.ts`](specs/team.spec.ts) | 4 | [User guide → Editing the team mid-chat](../docs/user-guide.md#editing-the-team-mid-chat) |
| [A member's model and reasoning effort](#a-members-model-and-reasoning-effort) | [`models.spec.ts`](specs/models.spec.ts) | 13 | [User guide → Default model and reasoning effort](../docs/user-guide.md#default-model-and-reasoning-effort), [Team members](../docs/user-guide.md#team-members) |
| [How members take turns](#how-members-take-turns) | [`turns.spec.ts`](specs/turns.spec.ts) | 55 | [Architecture → Turn scheduling](../docs/architecture.md#turn-scheduling-modes), [How agents share context](../docs/architecture.md#how-agents-share-context) |
| [What an agent does on its way to a reply](#what-an-agent-does-on-its-way-to-a-reply) | [`activity.spec.ts`](specs/activity.spec.ts) | 13 | [Architecture → Agent activity](../docs/architecture.md#agent-activity) |
| [Approvals](#approvals) | [`approvals.spec.ts`](specs/approvals.spec.ts) | 39 | [User guide → Approvals](../docs/user-guide.md#approvals), [Architecture → Approvals](../docs/architecture.md#approvals), [Permission mapping](../docs/architecture.md#permission-mapping) |
| [Files and changes](#files-and-changes) | [`files.spec.ts`](specs/files.spec.ts) | 20 | [User guide → Reviewing and applying changes](../docs/user-guide.md#reviewing-and-applying-changes), [Browsing files](../docs/user-guide.md#browsing-files), [Architecture → Workspaces and file changes](../docs/architecture.md#workspaces-and-file-changes) |
| [Working directories and other folders](#working-directories-and-other-folders) | [`folders.spec.ts`](specs/folders.spec.ts) | 34 | [Architecture → Several working directories](../docs/architecture.md#several-working-directories), [OS sandboxes by platform](../docs/sandboxing.md) |
| [Harness Relay's own sandbox](#harness-relays-own-sandbox) | [`sandbox.spec.ts`](specs/sandbox.spec.ts) | 17 | [OS sandboxes by platform → Harness Relay's own sandbox](../docs/sandboxing.md#harness-relays-own-sandbox), [Open agents → The relay sandbox](../docs/open-agents.md#the-relay-sandbox) |
| [What reaches each CLI besides the prompt](#what-reaches-each-cli-besides-the-prompt) | [`inputs.spec.ts`](specs/inputs.spec.ts) | 34 | [Architecture → Tool library](../docs/architecture.md#tool-library) |
| [The tool library](#the-tool-library) | [`tools.spec.ts`](specs/tools.spec.ts) | 15 | [User guide → Tool library](../docs/user-guide.md#tool-library-mcp-servers-skills-and-memory), [Architecture → Tool library](../docs/architecture.md#tool-library) |
| [Changing a chat's history](#changing-a-chats-history) | [`history.spec.ts`](specs/history.spec.ts) | 3 | [User guide → Copying, editing and retrying](../docs/user-guide.md#copying-editing-and-retrying), [Branching a conversation](../docs/user-guide.md#branching-a-conversation) |
| [Copying and sharing](#copying-and-sharing) | [`share.spec.ts`](specs/share.spec.ts) | 5 | [User guide → Sharing a conversation](../docs/user-guide.md#sharing-a-conversation), [Architecture → Sharing a conversation](../docs/architecture.md#sharing-a-conversation) |
| [The sidebar](#the-sidebar) | [`sidebar.spec.ts`](specs/sidebar.spec.ts) | 7 | [User guide → Groups](../docs/user-guide.md#groups), [Search](../docs/user-guide.md#search) |
| [Schedules](#schedules) | [`schedule.spec.ts`](specs/schedule.spec.ts) | 1 | [User guide → Schedules](../docs/user-guide.md#schedules), [Architecture → Schedules](../docs/architecture.md#schedules) |
| [Settings](#settings) | [`settings.spec.ts`](specs/settings.spec.ts) | 13 | [User guide → Signing in](../docs/user-guide.md#signing-in), [Lead agent](../docs/user-guide.md#lead-agent), [Open agents → Model backends](../docs/open-agents.md#model-backends) |
| [CLIs that are scripts on Windows](#clis-that-are-scripts-on-windows) | [`windows.spec.ts`](specs/windows.spec.ts) | 5 | [Architecture → CLI adapters](../docs/architecture.md#cli-adapters) |
| [Accounts](#accounts) | [`accounts.spec.ts`](specs/accounts.spec.ts) | 35 | [User guide → More than one account](../docs/user-guide.md#more-than-one-account), [API keys](../docs/user-guide.md#api-keys-optional), [Architecture → Accounts](../docs/architecture.md#accounts) |
| [Plan usage](#plan-usage) | [`usage.spec.ts`](specs/usage.spec.ts) | 9 | [User guide → Plan usage](../docs/user-guide.md#plan-usage), [Architecture → Providers](../docs/architecture.md#providers-status-login-and-models) |
| [What each CLI loads by itself, and Grok's trust](#what-each-cli-loads-by-itself-and-groks-trust) | [`native.spec.ts`](specs/native.spec.ts) | 5 | [User guide → What each CLI loads by itself](../docs/user-guide.md#what-each-cli-loads-by-itself), [Architecture → What each CLI loads by itself](../docs/architecture.md#what-each-cli-loads-by-itself) |
| [Agent sessions and AgentsView](#agent-sessions-and-agentsview) | [`sessions.spec.ts`](specs/sessions.spec.ts) | 10 | [User guide → Agent sessions](../docs/user-guide.md#agent-sessions-the-clis-own-folder-and-agentsview), [Architecture → Agent homes and AgentsView](../docs/architecture.md#agent-homes-and-agentsview) |
| [Voice input's install](#voice-inputs-install) | [`voice.spec.ts`](specs/voice.spec.ts) | 2 | [User guide → Voice input](../docs/user-guide.md#voice-input), [Architecture → Voice input](../docs/architecture.md#voice-input) |
| [Reporting a problem](#reporting-a-problem) | [`report.spec.ts`](specs/report.spec.ts) | 5 | [User guide → Reporting a problem](../docs/user-guide.md#reporting-a-problem), [Architecture → Reporting a problem](../docs/architecture.md#reporting-a-problem) |
| [The guided tour and the theme](#the-guided-tour-and-the-theme) | [`appearance.spec.ts`](specs/appearance.spec.ts) | 7 | [User guide → Language and the guided tour](../docs/user-guide.md#language-and-the-guided-tour) |
| [Notifications and sound](#notifications-and-sound) | [`notifications.spec.ts`](specs/notifications.spec.ts) | 4 | [User guide → Notifications and sound](../docs/user-guide.md#notifications-and-sound), [Architecture → Notifications](../docs/architecture.md#notifications) |
| [Limits the environment sets](#limits-the-environment-sets) | [`limits.spec.ts`](specs/limits.spec.ts) | 4 | [Developer guide → Environment variables](../docs/developer-guide.md#environment-variables) |
| [Languages](#languages) | [`i18n.spec.ts`](specs/i18n.spec.ts) | 2 | [Architecture → Languages](../docs/architecture.md#languages) |
| [On a phone](#on-a-phone) | [`mobile.spec.ts`](specs/mobile.spec.ts) | 5 | [Use it from your phone](../docs/remote-access.md) |

## Signing in

[`signin.spec.ts`](specs/signin.spec.ts): a browser that has not signed in (`signIn: false`). The last four also in a development build of the UI (React's StrictMode, which runs each effect twice), which `global-setup.ts` builds next to the usual one.

| Scenario | What is checked |
| --- | --- |
| A browser that is not signed in gets the sign-in page, and a code signs it in | The sign-in page shows and the API answers 401; a wrong code says it is wrong or has expired; a new code opens the app on its home page, and the session outlives a reload. |
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

## The home page

[`home.spec.ts`](specs/home.spec.ts)

| Scenario | What is checked |
| --- | --- |
| The app opens on it, and the logo and name lead back to it | The home page shows the logo and its tagline; the sidebar's logo and **Harness Relay** (marked as the current page there) go back to it from the New chat page and from a chat (`#/`). |
| The logo plays its animation once on each visit, with transform and opacity alone, and not with reduced motion | The logo's dots, its turn and the tagline animate for a while (not for no time, as a nameless `animation` shorthand minified to `none` would), once, changing only `transform` and `opacity`; they end by themselves and play again when the home page opens again; with reduced motion nothing animates. |

## A new chat and the lead agent's team

[`chat.spec.ts`](specs/chat.spec.ts): a chat started from the New chat page, where the lead agent builds a team for each question.

| Scenario | CLI | What is checked |
| --- | --- | --- |
| The lead agent proposes a team, and once it is confirmed the team answers | Claude Code | The team card names the team, the reason and the member; after **Confirm team** the reply comes with its CLI's tag; the chat is in the sidebar under its first question, and the reply is stored as done. |
| The lead agent's teams used without asking | Claude Code | The card says **Used without asking** and the team answers without waiting. |
| A team of every CLI answers in turn | two teams | Each member answers with its own CLI's tag, in roundtable order: Claude Code, Codex, Grok, Cursor; Antigravity, Copilot, Muse Code; and OpenCode, Goose, Cline, OpenHands, Pi (a team with a CLI that runs only with full access here in a chat with full access). The lead agent puts at most five members in a team for a new question, so the seven with a sign-in answer as two teams, of four and three, each in a chat of its own. |
| A follow-up question gets a team again | Claude Code, Codex | The second question gets a team of its own, and only its member answers it. |

## Templates

[`templates.spec.ts`](specs/templates.spec.ts)

| Scenario | CLI | What is checked |
| --- | --- | --- |
| The built-in templates are listed, and one opens to show its members | — | "Three-way debate" is marked built-in, and its dialog lists Proposer, Pragmatist and Skeptic. |
| In a template's editor, three columns wide, the add card lists every CLI on a row of its own and is as tall as a member beside it | — | At 1280px the editor's grid has three columns: with the built-in relay template's three members the add card is on a row of its own and lists every CLI without scrolling; beside a fourth member, and beside the first row's two once two are removed, its list scrolls and those members keep their own heights (measured again with the add card hidden: cards in one row are always as tall as each other, so comparing them would prove nothing). |
| The lead agent picks a template as it is | Claude Code, Codex, Grok | The card says it uses "Three-way debate"; over its two rounds each member answers with its CLI, then passes (six replies). |
| A team the lead agent designed is saved as a template | Claude Code, Grok | **Save as template** suggests the team's name, the card says it was saved, and the template is on the New chat page. |

## Changing a chat's team

[`team.spec.ts`](specs/team.spec.ts)

| Scenario | CLI | What is checked |
| --- | --- | --- |
| The lead agent changes the team when asked, and the new member answers once it is saved | Claude Code, Grok | In **Team settings → Ask the lead agent**, the request reaches the lead agent, the drawer shows the member it added, and after **Save** both members answer. |
| When the lead agent's answer cannot be read, a template stands in | Claude Code | An answer that is not JSON falls back to "General-question panel", whose three members answer. |
| A team proposed for a new question is declined | Claude Code, Codex | **No, keep the current team**: the card says it was not used, the current team answers and the proposed member does not. |
| The add card is as tall as the members beside it with a shadow while more CLIs are below, lists every CLI on a row of its own, and one tall card stretches only its row | — | In **Team settings** (two columns at 1280px), the list being a group named **Add member**: beside one member, the member keeps its own height (measured again with the add card hidden) and the list of the twelve CLIs scrolls. Where the browser has scroll-driven animations, a shadow shows along the list's bottom edge (a screenshot of that strip differs without it), also with reduced motion, each button given the focus stops above it, and it is gone once the list is scrolled to its end. With two members, on a row of its own, the card lists them all without scrolling or shadow; made to take a height it is not given (as a wrong column count would), it is at least 280px tall and scrolls, never an empty box. Beside a third member that member keeps its own height, and a role box made taller in the first row leaves the second row's cards as they were. |

## A member's model and reasoning effort

[`models.spec.ts`](specs/models.spec.ts): chosen in **Team settings** and saved.

| Scenario | CLI | What is checked |
| --- | --- | --- |
| The model and effort chosen for a member reach Claude Code as `--model` and `--effort` | Claude Code | `opus` and High are stored with the member, and its turn gets `--model opus --effort high`. |
| The model and effort chosen for a member reach its CLI | each but Claude Code | A model from the CLI's own list (as `codex debug models`, `grok models`, Cursor, Antigravity and Copilot list them, and Muse Code's fixed one; for an open agent, its model backends': the fake endpoint's `e2e/e2e-model-mini`) and an effort it offers for it are stored with the member, and the fake logs the turn running with them, as the adapter passes them (Codex's `thread/start` parameters, Grok's `session/set_config_option` before the prompt, Copilot's `--model` and `--reasoning-effort`, Muse Code's `--model` and `-c reasoning_effort=…`, …) and as the CLI names them (OpenCode's and Pi's `relay-e2e/e2e-model-mini`, OpenHands' `openai/e2e-model-mini`). OpenCode offers no effort for that model, so none is kept, and Goose's provider for an endpoint offers only `off`, which its turn runs with. |
| The default model and effort in Settings are what a member left on Default runs with | Claude Code | With sonnet and Low saved as the default, the drawer says "Default: sonnet", the member stays on Default, and its turn gets `--model sonnet --effort low`. |

## How members take turns

[`turns.spec.ts`](specs/turns.spec.ts)

| Scenario | CLI | What is checked |
| --- | --- | --- |
| An agent asks the user, waits for the answer, then answers with it | Claude Code | The question shows without `[ASK_USER]`, with a card that waits for the answer; the composer says **Answer @Claude…** and the sidebar **Answer needed**; the answer reaches the agent. |
| A question is skipped, and the rest of the team goes on | Claude Code, Grok | **Skip, let the team go on**, and the next member answers. |
| Relay mode: a member hands the floor to the teammate it mentions | Claude Code, Codex | The first member answers first and mentions the second, which answers; then the floor comes back to the user (two replies). |
| A message that @mentions a member is answered by that member only | Claude Code, Codex, Grok | Only @Grok answers. |
| In a later round, members with nothing to add pass, and the round ends early | Claude Code, Codex | With three rounds: both answer, both pass, and there is no third round. |
| A reply can be stopped | each | While the reply streams, **Stop** ends it with "(stopped)", and the live tag and the Stop button go away. |
| An error inside the CLI's protocol is shown on the reply | each | The error as each CLI reports it shows on the reply: Claude's error result, a failed Codex turn, an ACP agent's JSON-RPC error (Cursor's error text in its reply, as Cursor sends one), Pi's failed message. |
| A member's next turn resumes its own session | each | The second turn resumes the session the first started (the fakes refuse to resume one they never started, as the real CLIs do), and its reply shows that turn's own cost and tokens, the same as the first's (none for Cursor, Muse Code, OpenCode and Goose: see [What they do not cover](#what-they-do-not-cover)), also where the fake reports the session's totals as the real CLI does (Claude Code's, counted on from its file's last `cost-state` record, with the run's own beside them as 2.1.323 gives it; Cline's; OpenHands'). |
| A member whose CLI lost its session starts a new one with the chat so far | Claude Code | With the CLI's sessions deleted, the next prompt carries the whole chat, the first message too. |
| A failed reply shows the CLI's error, and Retry answers again | each | A CLI that exits with an error: its error is on the reply, and **Retry** answers. |
| A message sent while the team replies waits, then reaches the next member | Claude Code, Grok | The message waits in the tray while the first member answers slowly, and the next member answers it. |

## What an agent does on its way to a reply

[`activity.spec.ts`](specs/activity.spec.ts)

| Scenario | CLI | What is checked |
| --- | --- | --- |
| Thinking, a tool call and a to-do list are shown with the reply | each | The steps fold into rows; opened, they show the thinking, the CLI's own tool for a listing of the working directory done with its output (Claude's `Bash`, Codex's `Shell`, Grok's `list_dir`, Cursor's, Antigravity's and Copilot's `Read`, Muse Code's `Search`, OpenCode's `glob`, Goose's `tree`, Cline's `read_files`, OpenHands' `file_editor`, Pi's `List`, or `Bash` with full access), and the to-do list with one of three done and one in progress (Cline and Pi have none to show). |
| A reply in Markdown is rendered | Claude Code | A heading, a list, a table and highlighted code. |

## Approvals

[`approvals.spec.ts`](specs/approvals.spec.ts): an agent that wants to run a command (`echo e2e-approval`) in a chat that asks the user, a read-only one for every CLI but Pi, which has no command tool there, and Copilot, which runs `echo` without asking (it takes it for read-only): they ask in edit mode, about the one kind of command that asks there (`npm publish e2e-approval`, through `e2e:approve=publish`). Goose asks to run `env echo e2e-approval`, since in read-only Harness Relay lets it run plain reading commands such as `echo` without asking. The answer reaches each CLI's own request: Claude Code's `can_use_tool`, Codex's approval request, the ACP agents' `session/request_permission` (Grok, Cursor, Antigravity, Copilot, Muse Code, OpenCode, Goose, Cline, OpenHands) and the dialog of Pi's gate.

| Scenario | CLI | What is checked |
| --- | --- | --- |
| A command the user allows runs | each | The card shows the command and the sidebar **Needs you**; after **Allow** the command ran and the card says Allowed. Skipped where the CLI runs only with full access. |
| A command the user declines does not run, and the note goes with it | each | The card says "Declined: Not now". Claude Code, Grok, OpenCode, Goose and Pi get the note with the refusal; Codex's answer has no room for one, and Cursor, Muse Code, Cline and OpenHands drop it (the reply says only that the command was declined); Antigravity and Copilot end their turn at a refusal, and their reply says so and nothing more. Skipped where the CLI runs only with full access. |
| "Always allow" answers the same request by itself the next time | Claude Code | The second request is allowed automatically, with no card. |
| Stopping the team while a request waits ends it without running the command | Claude Code | The reply ends "(stopped)" and the request is declined or unanswered. |
| With full access, the command runs and files are written anywhere without asking | each | The header warns **Full access**; the command runs and a file is written in another folder, with no card (on every system: no sandbox is around a CLI with full access). |
| A chat that refuses automatically declines without asking | Claude Code | The command is declined, with no card. |

## Files and changes

[`files.spec.ts`](specs/files.spec.ts)

| Scenario | CLI | What is checked |
| --- | --- | --- |
| In edit mode an agent changes files, and the chat shows what changed | Claude Code | The file is in the working directory, which became a git repository; the changes card lists it and opens the turn's diff. |
| In a read-only chat no file is written | each | Claude Code, Muse Code and Pi run without their file tools, and Cursor's write is refused by its own rules, all without a card; the others ask, and are declined (Antigravity and Copilot then end their turn); no file is written and there is no changes card. Skipped where the CLI runs only with full access. (That a write the user allows still cannot reach the folder: [Harness Relay's own sandbox](#harness-relays-own-sandbox).) |
| Grok in a read-only chat that refuses automatically says why | Grok | The tool's error says it is not allowed in read-only mode. |
| Every CLI writes in edit mode, and each turn records its own change | two teams | Each member writes its own file (`<cli>.txt`), and each reply's changes card lists it. A CLI that runs only with full access here does so in a chat of its own. |
| In parallel mode each member works in its own worktree, and a result can be applied | Claude Code, Codex | Both changes cards say "in worktree" and nothing reaches the working directory until **Apply to working directory** brings in Codex's file. |
| The file browser shows the working directory and previews a file | Claude Code | **Files** lists the project; `src/hello.ts` opens with its code; Escape closes it. |
| A folder downloads as a ZIP file of its files, without .git | Claude Code | The working directory's ZIP (`work.zip`) holds exactly its files, with their contents, and no `.git`; a folder's own (`src.zip`) only that folder. |
| A folder too large to zip in full is offered without what git ignores | Claude Code | An ignored file set to more than 1 GiB without writing to it (on Windows it still takes the space on disk) makes it too large: declining the offer downloads nothing, accepting gives the ZIP without the ignored folder. |

## Working directories and other folders

[`folders.spec.ts`](specs/folders.spec.ts): the fakes write only where the real CLIs could, so these tell whether a chat's folders reach each CLI. The open agents' fakes write for real, and Harness Relay's own sandbox refuses what is not theirs to write.

| Scenario | CLI | What is checked |
| --- | --- | --- |
| A folder the chat was not given stays out of reach in edit mode | each (Grok not on Windows) | Refused automatically, nothing is written next door: the CLIs with a sign-in but Copilot and Muse Code ask, and are refused (Antigravity then ends its turn); Copilot's write is refused by its own sandbox without asking, and its turn goes on; Muse Code's file tool refuses it without asking, and its sandbox refuses the command that writes there, which it tries next and its adapter allows in edit mode; an open agent writes without asking and Harness Relay's own sandbox refuses it. Skipped where the CLI runs only with full access, and for Grok on native Windows, which has no sandbox there. |
| Writing in a folder the chat was not given asks first, and writes once the user allows it | Claude Code, Codex, Cursor, Antigravity | **Allow** on the "wants to change files" card, and the file is written there. Not Grok, whose sandbox refuses it all the same, nor Copilot, whose sandbox refuses it without asking, nor Muse Code, which asks nothing there (its file tool refuses it, its sandbox the command it tries next), nor the open agents, whose sandbox no answer widens. |
| Folders are added and removed in the box, and the chat works in all of them | Claude Code | Folders typed into **Working directories** become chips and can be removed; the chat stores the folders left, and the agent writes in the first and the second, not the removed one. |
| Each CLI writes in each folder, and the changes card lists them by folder | each | Two files in two folders: the card says "Changed 2 files" with a group per folder, and the diff shows both. Cursor asks before it writes in the second folder, and is allowed. |
| The file browser lists every working directory | Claude Code | **Files** has a **Folder** list with both folders; the second shows its own files. |
| In parallel mode each member gets a worktree of each folder, and Apply applies them all | Claude Code, Codex | Both replies have a worktree change in each folder; **Apply** writes Codex's files in both folders. |
| Settings' default working directories are where new chats start | — | A folder saved in **Settings → Default working directories** is in the box of the next new chat. |
| The folder dialog adds the folders chosen in it, and the chat starts in all of them | Linux only | **Choose folders…** (the fake `zenity`) adds two folders; the dialog opened inside the last folder, with several allowed and an English title; the new chat has the three folders. |
| The folder dialog in Chinese, on a server without a UTF-8 locale | Linux only | The dialog's title is in Chinese and it gets `LC_CTYPE=C.UTF-8`; Cancel adds nothing. |

## Harness Relay's own sandbox

[`sandbox.spec.ts`](specs/sandbox.spec.ts): the sandbox the open agents run in below full access ([OS sandboxes by platform](../docs/sandboxing.md#harness-relays-own-sandbox)), and what Harness Relay does where it has none or where a CLI would run a project's own setup by itself. The open agents' fakes write and reach hosts for real, so what they may not do is refused by the real sandbox, not by the fake. The tests that need it run where it works (macOS, and Linux with bubblewrap, socat and ripgrep), and are skipped elsewhere, saying why, or fail when `E2E_REQUIRE_RELAY_SANDBOX=1` says it must work (CI).

| Scenario | CLI | What is checked |
| --- | --- | --- |
| In a read-only chat a write the user allows still cannot reach the working directory | each open agent but Pi | **Allow** on the "wants to change files" card: the fake writes, the sandbox refuses it (the folder is read-only there), and the reply says "I may not write out.txt here."; no file, no changes card. Pi has no write tool in a read-only chat. |
| A host the run may not reach is asked about, and refused when declined | each open agent | `e2e:fetch=http://e2e.example.invalid/`: the sandbox's proxy asks before it connects (so no name needs to resolve), the "wants to read a web page" card names the host, and **Decline** refuses it. OpenHands and Pi ask in edit mode, the lowest where they have a tool to reach a URL. |
| Below full access, an open agent that runs only with full access here does not run, and says why | each open agent | On Windows (all five) and on Linux (OpenCode): the reply's error says it only runs with full access, and its CLI never got the prompt. Skipped where it runs below full access. |
| OpenHands below full access needs its terminal switch | OpenHands | With the switch off (`sandboxTerminal: false`), the reply's error says that below full access OpenHands runs only with a terminal in the sandbox. macOS only: Linux gives the sandbox a terminal of its own, and Windows runs it with full access only. |
| Antigravity's project setup is asked about before agy starts, and a refusal keeps it from starting | Antigravity | With `.agents/mcp_config.json` in the working directory, the "wants to use a tool" card names it; declined, the turn does not start (its error says why) and agy never gets the prompt. On every system: Antigravity has no sandbox. |
| Copilot's project hooks are asked about before Copilot starts; a refusal keeps it from starting, and once allowed the turn runs | Copilot | With `.github/hooks/audit.json` in the working directory, the "wants to use a tool" card names it; declined, the turn does not start (its error says why) and Copilot never gets the prompt; on the next message **Allow** lets the turn run, and the fake found the hook it would have run when its session opened. On every system: Copilot runs a project's hooks by itself whatever its sandbox (and its `disableAllHooks`). |

## What reaches each CLI besides the prompt

[`inputs.spec.ts`](specs/inputs.spec.ts)

| Scenario | CLI | What is checked |
| --- | --- | --- |
| An MCP server from the tool library, with its secret kept off the command line | each | The member names the server it got, and its secret value is in no argument the CLI was started with. |
| An HTTP MCP server from the tool library, with its secret header kept off the command line | each but Antigravity | The CLI gets it as an HTTP server at its URL, with the `Authorization` header and its value, which is in no argument the CLI was started with. Antigravity's adapter gives it no HTTP servers, since agy says over ACP that it takes none. |
| An attached image | each but Cline | The image is attached in the composer, the reply says it got one image, and the prompt names the file for the agent's own tools. Cline takes no images over ACP (its model gets only their paths, in the prompt's text). |

## The tool library

[`tools.spec.ts`](specs/tools.spec.ts): **Settings → Tool library**. What a member's Tools say with the library empty is checked once; every other test runs twice: in a chat with a member of each CLI with a sign-in, and in one with a member of each open agent (`open agents: …`). A test that turns an item off for a CLI, or on or off for a member, takes the team's second and third members for that (Codex and Grok; Goose and Cline).

| Scenario | CLI | What is checked |
| --- | --- | --- |
| With an empty tool library, or one with nothing for its CLI, each member's Tools say what its own CLI loads by itself | Claude Code, Goose | In **Team settings**, Claude Code's card says it loads its own setup as usual and Goose's that it runs with a config folder of Harness Relay's own, each the text for its own CLI (`emptyLibraryText()`), with the link to the tool library. With a memory note for Codex only, neither card calls the library empty: each says it has nothing for that CLI yet (`noneForCliText()`). |
| An MCP server added on the page reaches every CLI, its secret masked and kept off the command line | two teams | The row says "All members"; editing shows the value empty with a masked placeholder; neither the page nor `GET /api/tools` holds the secret; each member names the server and got its value, in no argument; Claude Code's `--mcp-config` file is gone after the turn. |
| An MCP server turned off for a CLI, or in a member's Tools, is not given | two teams | Off for the second CLI (Codex; Goose) in "Given by default to", it gets nothing; ticked in its member's **Tools** and unticked in the third's (Grok; Cline), the second gets it (its saved value kept) and the third does not. Over its items, the second member's **Tools** say what its own CLI loads by itself (`toolsHintText()`). |
| A skill picked from a folder is in each CLI's briefing, and each reads its SKILL.md | two teams | Of a folder with two skills, the one added is in each briefing and each reads its first line; the other never shows. Claude Code may read it only through the `Read(…)` rule its adapter adds (the fake refuses without it). |
| A skill turned off for a CLI, or in a member's Tools, is not given | two teams | Off for the third CLI (Grok; Cline) and unticked in the first's **Tools** (Claude; OpenCode), neither gets it, and Claude Code's arguments name it nowhere. |
| Memory for all members and for one CLI reaches each briefing, and a member's Tools can leave it out | two teams | The second CLI (Codex; Goose) gets the shared memory and its own note, in order, the others only the shared one; unticking "Shared memory" in the third's **Tools** (Grok; Cline) leaves it none. |
| An MCP server given a new value on the page gets it at the next turn, and once removed it is given no more | two teams | Edited, the page shows the new mask and each CLI's next turn gets only the new value, in no argument; removed, the next turn gets it neither by name nor by value. A second server stays throughout, so that "given nothing" cannot pass on a turn that got no library at all. |
| A skill and a memory note removed on the page are given no more | two teams | One of two skills and the shared memory note removed: the next briefing and reply have neither, while the other skill and each CLI's own note still arrive. |

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
| A conversation is renamed and deleted | — | The title changes in the header and the sidebar; **Delete conversation** removes it from the sidebar and the server, and the home page opens in its place. |
| Search finds a conversation by what an agent wrote in it | Codex | Searching for words of the reply finds that one chat, which opens. |
| A conversation started in the UI keeps the title given at the start | Claude Code | The title stays after the first question. |
| A conversation dragged into a group is kept there, and dragged out goes back to Other | — | The server stores the group, which a reload keeps; dragged to Other, its group is cleared and the group shows "Drag conversations here" again. |
| A branched conversation's family moves between groups as one | Codex | Dragging the branch moves its original with it, the branch still under it; dragging the original back brings both. |
| Every CLI's dot and the count fit on one line | — | With all twelve CLIs installed and ready (the server's answer changed on the way, "12/12 ready"), the line overflows nowhere, its first dot is under Settings' ⚙, and the chevron's tip ends at the report icon's right edge, also turned down with the names shown. |

## Schedules

[`schedule.spec.ts`](specs/schedule.spec.ts)

| Scenario | CLI | What is checked |
| --- | --- | --- |
| A chat's schedule is saved, and running it once sends its message to the team | Codex | Saved "Every day", the sidebar marks the chat; **Run once now** sends the message, marked Scheduled, and the member answers. |

## Settings

[`settings.spec.ts`](specs/settings.spec.ts)

| Scenario | CLI | What is checked |
| --- | --- | --- |
| Each CLI is found, with its version, and signed in | each, in one test | Each card shows the CLI's version, and **Signed in** (Claude Code with its account) or, for an open agent on the fake endpoint, **Ready**; the sidebar's twelve dots are OK ("12/12 ready", an open agent's titled "Model backends set up"); their names show when asked for, and stay after a reload. |
| A CLI that is not installed shows so in Settings and the sidebar | Cursor, Antigravity | Left not installed (`missingClis`): their dots and cards say **Not installed**. |
| An open agent without a model backend is not ready, and its turn says to set one up | OpenCode | `openBackend: false`: its dot says "No model backend yet", its card **Not ready** with "No model backend set up yet (Settings → Model backends)", and its reply's error that OpenCode has no model. |
| A CLI's executable path can be set, and a wrong one shows it as missing | Grok | A path that does not exist shows **Not installed**; an empty one finds it again. |
| The language can be switched, and the choice is kept | — | 繁體中文 changes the page, a reload keeps it, and English changes it back. |
| Another CLI can be the lead agent | Codex as lead agent | The New chat page names it, the team card says "Lead agent: Codex", and the lead agent's prompt went to Codex. |
| A CLI that is not signed in shows as signed out, and its reply says why | each with a sign-in | `E2E_FAKE_SIGNED_OUT=<cli>`: its health dot and card say **Not signed in** (without the CLI's own words), with a **Sign in** button, while another CLI stays signed in; its reply carries the CLI's error. |

## CLIs that are scripts on Windows

[`windows.spec.ts`](specs/windows.spec.ts): Windows only. Everywhere else, and by default on Windows too, the fakes are programs found on the PATH. Here each CLI's executable path is set in Settings, as a user does, to a launcher of the kind it comes with on Windows, which Harness Relay starts as the program it runs (`src/server/winLaunch.ts`), never through `cmd.exe`.

| Scenario | CLI | What is checked |
| --- | --- | --- |
| Started through Cursor's own launcher, it is found with its version and answers | Cursor | Through `cursor-agent.cmd` (which runs a Node and a script of Cursor's), Settings shows its version, and a turn with full access runs as Cursor. |
| Started through Muse Code's own launcher, it is found with its version and answers | Muse Code | The same through `muse.cmd` (whose script runs `muse-bin-<version>.exe`, the binary its `.muse-version` names), which Harness Relay starts as that binary. |
| Started through npm's shim for a Node script, it is found with its version and answers | Cline, Pi | The same through npm's `.cmd` shim for a Node script. |
| Started through npm's shim for a program, it is found with its version and answers | OpenCode | The same through npm's `.cmd` shim for a program. |

## Accounts

[`accounts.spec.ts`](specs/accounts.spec.ts): **Settings → each CLI's card → Add an account**, for the seven CLIs with a sign-in (the open agents have no accounts: they run on the model backends). Cursor's, Antigravity's and Muse Code's added accounts sign in with an API key only, which these tests give them.

| Scenario | CLI | What is checked |
| --- | --- | --- |
| An added account has a folder of its own, and a member set to use it runs there | each with a sign-in | The account lives in `<data>/accounts/<cli>-<id>`, which its card shows, and is signed in there (Cursor's, Antigravity's and Muse Code's with the key given it: "Using an API key"; Copilot's sign-in asked in a home of the question's own, in the data folder's `tmp`, with a copy of the account's sign-in state); a member on it runs with that home (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GROK_HOME`, Cursor's account folder, Antigravity's `.gemini` in it, Copilot's home of the run's own, its sessions linked to that folder, Muse Code's data folder `data/muse` in it, its config folder being the turn's own), a member on the default account with the default one. |
| Each account signs in and out on its own | Claude Code | **Sign out** runs `auth logout` in the added account's home only; **Sign in** goes through the CLI's own flow (a link, then a pasted code) and shows the account signed in. |
| Signing an added account out signs out only that account | Codex, Grok, Copilot | `logout` (Copilot's over ACP) runs in that account's folder only; its card says **Not signed in**, and the default account stays signed in. |
| With the credential store off, an account's API key is kept in the database, shown masked, and given to its CLI only | Claude Code, Grok, Cursor, Antigravity, Copilot, Muse Code | The key box says where keys are kept (a key-only account's is open from the start); saved, the key shows masked with "Using an API key" and never in `/api/settings`; that account's run gets it (`ANTHROPIC_API_KEY`, `XAI_API_KEY`, `CURSOR_API_KEY`, `GEMINI_API_KEY`, `COPILOT_GITHUB_TOKEN`, `META_API_KEY`), in no argument, and the default account's does not. |
| An account's API key signs that account in with Codex's own login | Codex | Codex takes no key in its environment: the key goes on stdin to `codex login --with-api-key` in that account's folder only, Harness Relay keeps none, and only that account's runs have it. |
| The API key Harness Relay was started with is the default account's only | each with a sign-in | A key in the server's own environment (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY`, `CURSOR_API_KEY`, `GEMINI_API_KEY`, `COPILOT_GITHUB_TOKEN`, `META_API_KEY`) reaches the default account's turns and not an added account's (Cursor's, Antigravity's and Muse Code's run on a key of their own). |
| Removing an added account signs it out and deletes its folder, and its member and the lead agent use the default account | each with a sign-in | The confirmation names the folder; the account signs out there (a key-only one has nothing to sign out of), then the folder and its sessions are gone; the lead agent goes back to the default account; the member's next turn runs in the default home, in a new session. |
| An account added while the CLIs' status is on its way keeps the newer answer's state | Claude Code | The page's next status answer is held back until after the account is added (`page.route`): when that older answer, without the account, comes in last, the account's pill stays **Signed in** instead of going back to "Checking…". |
| A CLI signed out outside Harness Relay shows so when Settings is opened again | Claude Code | Signed out in its home, as `claude auth logout` in a terminal would, while the server's cache still says signed in. Reopened, Settings checks again while the app gets the cached answer, held back (`page.route`) until Settings' own has landed: coming in last, it does not win, and the pill says **Not signed in**. |
| An account is not removed while a conversation runs | Claude Code | During a slow reply **Remove** says a conversation is running and nothing changes; once the chat is stopped, it works. |

## Plan usage

[`usage.spec.ts`](specs/usage.spec.ts): **Settings → each CLI's card → an account's Plan usage**, for the seven CLIs with a sign-in. Each fake reports its plan's usage as its CLI does, without a prompt (Claude Code's `get_usage`, Codex's `account/rateLimits/read`, Grok's `_x.ai/billing`, `muse usage --json`, Copilot's `account.getQuota` on its headless server, Antigravity's `/usage` and `/credits` in print mode, Cursor's plan from `about --format json`): 42% used for the default sign-in (e2e@example.com), 7% for any other account, and it logs each ask with its home.

| Scenario | CLI | What is checked |
| --- | --- | --- |
| The default account shows how much of its plan is left, or why its CLI does not say | each with a sign-in | Claude Code, Codex, Grok, Antigravity, Copilot and Muse Code: the plan (none for Muse Code), the first limit's name ("5-hour limit", "Weekly limit", "5-hour limit · Gemini 3.1 Pro", "Monthly limit · Premium requests", "Allowance"), "58% left · 42% used · resets …" (Copilot: "126 of 300 requests used") and a meter at 42, asked once, in the default account's home (Copilot's in a home of the question's own). Cursor: its plan from `about` and that its usage shows only in its own terminal UI. No error in any of them. |
| Each account shows its own plan's usage, asked in its own folder, and Check again asks again | Claude Code | An added account signed in as another address shows, once its box is scrolled into view, "93% left · 7% used" and its weekly limit beside the default account's 58%, each asked in its own home; its **Check again** (named after the account) asks that account's CLI once more and not the default account's. |
| An account on an API key says it has no plan limits, and one signed out shows no usage | Claude Code | An account with a key of its own (its `get_usage` says `rate_limits_available: false`) says it runs on an API key, with no limits; a signed-out account has no usage box. |

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
| The folder chosen in Settings is where each CLI keeps its sessions | two teams | The folder is saved (owner-only, not checked on Windows), each CLI's session lands in `<folder>/<cli>/` (an open agent's in its member's state there), and nothing goes to the usual homes. |
| After the folder changes, each member starts a fresh session there with the chat so far | two teams | The next prompt carries the whole chat, the new session is in the new folder, and the old one stays where it was. |
| A folder inside Harness Relay's own folder or the default working directory is refused | — | Both refusals are shown, nothing is created, and the setting stays empty. |
| The folder cannot change while a conversation runs | Claude Code | During a slow reply Save says a conversation is running; once it is stopped, Save works. |
| A conversation is sent to AgentsView after each turn and when it is renamed, with its members' sessions under it | Claude Code, Codex | The upload carries AgentsView's own `Origin` and the project and machine of a session it knows; the transcript holds the question, both replies and the title; each member's session is linked under it; a rename sends the new title. |
| A Cursor member's session is the one Harness Relay recorded, sent after the thread and filed under it | Codex, Cursor | The session (its id derived from the conversation's and the member's) goes after the thread, in its project and machine; it holds what the member heard, its thinking, its call listing the folder as Claude Code's `Read` with the folder as `file_path`, the call's result and its reply, and is named after the member, its CLI and the conversation; it is linked under the thread, and Cursor's own session id is never sent. |
| Copilot's and Muse Code's own sessions are filed under the thread as AgentsView names them, with none recorded for them | Copilot, Muse Code | Each member's own session is asked for and linked under the thread by the id its CLI gave it, as `copilot:<id>` and `muse:<id>`; only the thread is uploaded (both replies and the title), and no member's recorded session is sent or linked. |
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
| On a phone, the tour is a sheet at the bottom of the screen, and a long step's text scrolls above its buttons | At 390×560, the longest step (file permission) sits at the bottom of the screen with **Next** inside it; its text scrolls, also with End while **Next** has the focus, a line shows above the buttons, and the next step starts at its top. |
| On a phone, the tour slides up once as it opens, also from Settings, comes to rest at the bottom of the screen, and not with reduced motion | Opened at 390×560, the sheet slides up from below the screen (`translateY(100%)`) and the backdrop fades in from clear, changing only `transform` and `opacity`, both ending by themselves; the sheet then rests with its bottom at the screen's and **Next** in view and focused (focusing **Next** while the sheet was still below the screen moved nothing); the next step keeps the same finished animations, so nothing plays again; **Settings → Guided tour → Replay the tour** plays them again, later, and the sheet rests at the bottom; with reduced motion nothing animates and the sheet is at the bottom. |
| On a wide screen, Next stays in one place through the steps in the middle of the screen | At 1280×800, nothing in the tour animates, and every step not pointing at the sidebar has **Next** at the same height: the card is as tall as the tallest step. |
| Dark or light chosen in Settings is set on the page, kept after a reload, and wins over the system | Dark sets `data-theme`, the background and the `theme-color` metas, and survives a reload; Light stays light with the system dark. |
| Following the system follows its light or dark mode | **Follow system** removes `data-theme`, and the page follows the emulated light or dark mode, open and after a reload. |

## Notifications and sound

[`notifications.spec.ts`](specs/notifications.spec.ts): **Settings → Notifications and sound**, and what the page does when the team finishes or needs the user. The browser's notifications and sound are recorded by stand-ins (`Notification`, `AudioContext`, and `document.hasFocus()` for a window behind another), set before the app's scripts, and the browser has no push service (`PushManager` taken away), so the page tells the user itself, as in the desktop app's window. The team is one Claude member.

| Scenario | What is checked |
| --- | --- |
| Settings asks the browser, plays the sound to try it, and sends a test notification | Without push it says notifications come while the page is open; **Send a test notification** is off until **Show notifications** is on (which asks the browser's permission); **Play a sound** plays it once; the test shows a silent notification with the sound; the choices stay after a reload. |
| With its window behind another, a team to confirm and a finished reply each show a notification, and a click opens the chat | The lead agent's team waiting ("…ready for you to confirm") and the reply ("Claude finished replying" with the start of the reply), each titled with the conversation and tagged with it, silent, with three notes and two; clicking one from the home page opens the chat. |
| An agent's question shows a notification with what it asked | `e2e:ask`: "Claude asked you something" and the question; the sound off plays nothing. |
| Says nothing of the chat the user is looking at, and only plays the sound for another one | A reply in the chat in front, its window focused: nothing. A slow reply (`e2e:slow=5`) that ends while the home page is shown: the sound and no notification. Both turned off in Settings: nothing. |

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
| The app, its templates and the lead agent's card are in Chinese; the agents get English prompts | In zh-TW, the home page's tagline, the New chat page, a built-in template, the composer's hint and the team card are in Chinese, and the turn prompt is in English ([AGENTS.md](../AGENTS.md), "Prompts and languages"). |
| The sign-in page and the server's own messages follow the language | The sign-in page and the server's error for a wrong code are in Chinese. |

## On a phone

[`mobile.spec.ts`](specs/mobile.spec.ts): a Pixel 7's screen and touch, the way the chat is used over Tailscale. Skipped in Firefox, which has no mobile emulation.

| Scenario | CLI | What is checked |
| --- | --- | --- |
| The sidebar opens from the menu, and a chat works by touch | Grok | The menu button's three lines (an icon) sit in the middle of it, within a tenth of a pixel; the sidebar is out of view until **Open sidebar**, and closes again on going somewhere; the send button sends (Enter is a new line on a touch screen); the header's actions are under **More**. |
| A long message keeps the page from scrolling sideways | Claude Code | A 300-character word and a Markdown reply leave no sideways scroll. |
| On a narrow phone, a template's editor and the team settings do not scroll sideways, and the add card lists every CLI | — | At 320px (narrower than a 290px member card and its margins) and 280px (where English's **hand-offs / message** goes on a line of its own), the built-in relay template's editor and a relay chat's **Team settings** scroll no more than a pixel sideways, and in their one column the add card lists every CLI without a scroll of its own. |
| On a narrow phone, a new schedule of any kind does not scroll sideways, in either language, nor does a chat's Schedule | — | On the New schedule page, for each kind of schedule in English and in Chinese, nothing scrolls sideways at 320px and 280px (in English the four kinds go two by two, and the week's seven days go onto two rows); with **Every few hours** the interval's unit is only "hours", and its hint, a line of its own, is the hours box's accessible description. A chat's **Schedule** drawer with **Every week** does not scroll sideways at those widths either. |
| The home page's tagline is smaller, each of its lines on one line, and the logo closes the sidebar | — | The tagline is under its 22px, English on two lines and Chinese on one, without sideways scroll; tapping the sidebar's **Harness Relay** on the home page closes the sidebar. |

## Each CLI at a glance

The scenarios tried with each CLI (most of them as a test per CLI, the rest with teams of the seven with a sign-in or of the five open agents), so a change in one adapter shows up here: all twelve on Linux and locally, and on CI's macOS and Windows runners the CLIs each one runs differently ([Platforms and browsers](#platforms-and-browsers)). The CLIs with a sign-in of their own:

| Scenario | Claude Code | Codex | Grok | Cursor | Antigravity | Copilot | Muse Code |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Thinking, a tool call and a to-do list | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Plan usage in Settings | ✓ (5-hour and weekly limits) | ✓ (5-hour and weekly windows) | ✓ (the week's credits) | its plan only | ✓ (a model's 5-hour quota, credits) | ✓ (premium requests, counted) | ✓ (the allowance) |
| A command allowed, and declined with a note | ✓ | ✓ (no note) | ✓ | ✓ (the note dropped) | ✓ (the refusal ends its turn) | ✓ (in edit mode, `npm publish`; the refusal ends its turn) | ✓ (the note dropped) |
| Full access: runs and writes anywhere without asking | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| A read-only chat writes nothing | ✓ (no file tools) | ✓ (asks, declined) | ✓ (asks, declined) | ✓ (its own rules refuse, no card) | ✓ (asks, declined; ends its turn) | ✓ (asks, declined; ends its turn) | ✓ (no file tools) |
| A folder the chat was not given stays out of reach | ✓ (asks, refused) | ✓ (asks, refused) | ✓ (asks, refused; not on Windows) | ✓ (asks, refused) | ✓ (asks, refused; ends its turn) | ✓ (its sandbox refuses it, without asking) | ✓ (its file tool refuses it, its sandbox the command it tries next) |
| Writing there once the user allows it | ✓ | ✓ | — (its sandbox refuses it) | ✓ | ✓ | — (its sandbox refuses it, without asking) | — (it asks nothing there) |
| Several working directories: a file in each | ✓ | ✓ | ✓ | ✓ (the second asks first) | ✓ | ✓ | ✓ |
| An MCP server from the tool library, its secret off the command line | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| An HTTP MCP server and its header | ✓ | ✓ | ✓ | ✓ | — (none given) | ✓ | ✓ |
| An attached image | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| A reply stopped; an error inside the protocol; a failed reply and Retry | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| The next turn resumes its own session | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Version and sign-in in Settings, and signed out | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Not installed, in Settings and the sidebar | — | — | ✓ (a wrong executable path) | ✓ | ✓ | — | — |
| A member's model and effort | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| In a team of the seven: answering in turn (in teams of four and three, as the lead agent designs them), edit mode's changes, the tool library, the CLIs' own folder for sessions | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Its own skills listed, and left out of the next run | ✓ | ✓ | ✓ (after trusting the folder) | — | — | — | — |
| An added account's own home | ✓ | ✓ | ✓ | ✓ (with its API key) | ✓ (with its API key) | ✓ (its sign-in asked in a home of its own) | ✓ (with its API key) |
| An added account signed out on its own | ✓ | ✓ | ✓ | — (key only) | — (key only) | ✓ (over ACP) | — (key only) |
| An account's API key, to that account only | ✓ | ✓ (through `codex login`) | ✓ | ✓ | ✓ | ✓ | ✓ |
| The server's own API key, to the default account only | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Removing an added account | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| A project's own setup asked about before the CLI starts | — | — | — | — | ✓ | ✓ (its project hooks) | — |
| Started through a `.cmd` launcher on Windows | — | — | — | ✓ (its own) | — | — | ✓ (its own) |
| Its session in AgentsView, under the conversation's thread | ✓ | ✓ | — | ✓ (recorded by Harness Relay) | — | ✓ (`copilot:<id>`) | ✓ (`muse:<id>`) |

The open agents, in Harness Relay's own sandbox below full access:

| Scenario | OpenCode | Goose | Cline | OpenHands | Pi |
| --- | --- | --- | --- | --- | --- |
| Runs below full access (elsewhere with full access only, and says so when asked for less) | macOS | macOS, Linux | macOS, Linux | macOS (with its terminal switch, also tried off), Linux | macOS, Linux |
| Thinking, a tool call and a to-do list | ✓ | ✓ | ✓ (no to-do list) | ✓ | ✓ (no to-do list) |
| A command allowed, and declined with a note | ✓ | ✓ (`env echo`) | ✓ (the note dropped) | ✓ (the note dropped) | ✓ (in edit mode, `npm publish`, through its gate) |
| Full access: runs and writes anywhere without asking | ✓ | ✓ | ✓ | ✓ | ✓ |
| A read-only chat writes nothing | ✓ (asks, declined) | ✓ (asks, declined) | ✓ (asks, declined) | ✓ (asks, declined) | ✓ (no write tool) |
| A write allowed in a read-only chat, refused by the sandbox | ✓ | ✓ | ✓ | ✓ | — (no write tool) |
| A folder the chat was not given stays out of reach (the sandbox refuses it) | ✓ | ✓ | ✓ | ✓ | ✓ |
| Writing there once the user allows it | — | — | — | — | — |
| A host the run may not reach asked about, and refused | ✓ | ✓ | ✓ | ✓ (in edit mode) | ✓ (in edit mode) |
| Several working directories: a file in each | ✓ | ✓ | ✓ | ✓ | ✓ |
| An MCP server from the tool library, its secret off the command line | ✓ | ✓ | ✓ | ✓ | ✓ |
| An HTTP MCP server and its header | ✓ | ✓ | ✓ | ✓ | ✓ |
| An attached image | ✓ | ✓ | — (paths only) | ✓ | ✓ |
| A reply stopped; an error inside the protocol; a failed reply and Retry | ✓ | ✓ | ✓ | ✓ | ✓ |
| The next turn resumes its own session | ✓ | ✓ | ✓ | ✓ | ✓ |
| Version and "Ready" in Settings, on the fake endpoint | ✓ | ✓ | ✓ | ✓ | ✓ |
| Not ready without a model backend | ✓ | — | — | — | — |
| A member's model (the endpoint's) and effort | ✓ (no effort) | ✓ (`off`) | ✓ | ✓ | ✓ |
| In a team of the five: answering in turn, edit mode's changes, the tool library, the CLIs' own folder for sessions | ✓ | ✓ | ✓ | ✓ | ✓ |
| Started through a `.cmd` launcher on Windows | ✓ (npm's, for a program) | — | ✓ (npm's, for a Node script) | — | ✓ (npm's, for a Node script) |

## Platforms and browsers

- [`.github/workflows/e2e.yml`](../.github/workflows/e2e.yml) runs every spec in Chromium on Ubuntu, macOS and Windows with Node 24, and on Ubuntu with Node 22, for each pull request and each push to `main`: each in two jobs, half the tests each (Playwright's `--shard=1/2` and `2/2`), so that no job runs much over seven minutes. Run it by hand to choose other browsers; locally, `E2E_BROWSERS=chromium,firefox,webkit` ([`playwright.config.ts`](../playwright.config.ts)). On Ubuntu it installs what Harness Relay's own sandbox needs (bubblewrap, socat and ripgrep, and the AppArmor profile that lets `/usr/bin/bwrap` make its namespaces), on Ubuntu and macOS it runs the sandbox's own checks (`scripts/sandbox-check.ts`) first, and it sets `E2E_REQUIRE_RELAY_SANDBOX=1` there, so a test that needs the sandbox fails rather than skips.
- The open agents run below full access on macOS and Linux only (Linux with bubblewrap, socat and ripgrep): on Windows, which Harness Relay's own sandbox does not cover, they run with full access only, and so does OpenCode on Linux. There the tests about permissions skip them, saying why, the others run them with full access, and [Harness Relay's own sandbox](#harness-relays-own-sandbox) checks that a chat below full access does not start them. Without the sandbox on a Mac or Linux computer, the tests that need it are skipped, saying why (`E2E_RELAY_SANDBOX`, which `global-setup.ts` works out once).
- On CI (`E2E_SYSTEM_CLIS=1`) each CLI's own tests run on Linux for all twelve, and on macOS and Windows only for the CLIs Harness Relay runs differently there than on Linux in a way their fakes can tell (`testedOn` in `support/clis/<cli>.ts`, which says why); elsewhere they are skipped, saying where they run. **macOS**: the five open agents (Harness Relay's own sandbox as Seatbelt makes it, OpenCode below full access there only, OpenHands' terminal switch) and Claude Code, for the seven with a sign-in, whose fakes do there what they do on Linux. **Windows**: the seven with a sign-in (Claude Code without sandbox settings, Codex without a permission profile, Grok's `workspace` profile, Cursor's sessions linked as a junction, Antigravity's home given as `USERPROFILE`, Copilot's folders linked as junctions, Muse Code's sign-in copied and its PowerShell), OpenCode and Goose (their own shell) and OpenHands (its PowerShell terminal); not Cline or Pi, which run there with full access only, as on Linux with full access ([CLIs that are scripts on Windows](#clis-that-are-scripts-on-windows) still starts them there). Locally, without the variable, every CLI's tests run on every system; run the workflow by hand with **every_cli** for all twelve on macOS and Windows too.
- OpenHands below full access needs a terminal in the sandbox on macOS: the test servers turn its switch on, and the test with it off runs on macOS only.
- [CLIs that are scripts on Windows](#clis-that-are-scripts-on-windows) runs on Windows only.
- The folder dialog tests run on Linux only: Linux finds its dialog on the PATH, where the fake one stands in; macOS and Windows open their own by their full paths.
- "A folder the chat was not given stays out of reach" is skipped for Grok on Windows, which has no sandbox there ([OS sandboxes by platform](../docs/sandboxing.md)).
- Copilot runs below full access on macOS, Linux and Windows alike, as its own sandbox does: its fake keeps to the policy its run's settings give, so its tests need no sandbox on the computer that runs them.
- [On a phone](#on-a-phone) is skipped in Firefox.
- The add card test in [Changing a chat's team](#changing-a-chats-team) checks the list's shadow only in a browser with scroll-driven animations (Chromium, WebKit), as there is no shadow elsewhere: in Firefox it checks the rest.
- The two copy tests in [Copying and sharing](#copying-and-sharing) run in Chromium only (reading the clipboard), and "Without gh" is skipped on Windows.
- The three tests of [Reporting a problem](#reporting-a-problem) that read the mail's links are skipped in a browser without the Navigation API.

## What they do not cover

- **The CLIs themselves.** The fakes check Harness Relay's side of each protocol; the [live tests](#the-live-tests) try the real ones, by hand. A CLI that changes what it writes is caught by the adapter tests' recorded messages (`test/claude.test.ts`, `test/codex.test.ts`, `test/grok.test.ts`, `test/cursor.test.ts`, `test/antigravity.test.ts`, `test/copilot.test.ts`, `test/muse.test.ts` and the open agents', the last ones replaying messages recorded from the real CLIs) and by trying the real CLI in the app.
- **The CLIs' own sandboxes.** The fakes of Claude Code, Codex, Grok, Copilot and Muse Code work out from what Harness Relay gave them what their CLI's sandbox would allow (Copilot's from its run's settings, and it answers `/sandbox policy` with the policy they give, as Copilot prints it); only Harness Relay's own sandbox, around the open agents, is the real one. That the real CLIs below full access write nowhere outside the chat's folders is tried by the live tests (`live/sandbox.spec.ts`).
- **AgentsView itself.** It is a stand-in server in [`sessions.spec.ts`](specs/sessions.spec.ts) that answers Harness Relay's requests and never reads a session file. That the real AgentsView reads each CLI's own sessions where Harness Relay's runs leave them, under the ids Harness Relay links (Copilot's `session-state` and Muse Code's data folder among them, in the CLIs' usual homes and through the user guide's `config.toml` for an AgentsView of its own), and files them under the thread, was tried by hand, with AgentsView 0.46.1 (for Copilot and Muse Code also on the sessions copilot 1.0.109 and muse 1.4.18 wrote on Linux and Windows through their adapters).
- **What Cursor does without asking in a temporary folder.** The real Cursor writes in a temporary folder (`/tmp`, macOS' `/private/var/folders`) without asking; its fake does not, as the tests' folders are all in one and every write outside the workspace would then go through unasked. Nor does a spec try a Cursor team's auto-run allowlist (the fake has one, `E2E_FAKE_CURSOR_TEAM_ALLOW`). The real Muse Code's sandbox lets its commands write in the temporary folder too; its fake's does not, for the same reason.
- **The CLIs' real plan usage.** [Plan usage](#plan-usage) checks Harness Relay's side with the fakes' answers; the real CLIs' answers are covered by the answers recorded from them in `test/usage.test.ts` (Antigravity's only as agy 1.5.8 types them: no real Google account's was seen), and no live test asks a real CLI. The fake agy answers a signed-out `/usage` at once with an error, where the real one asks for a sign-in on stderr and waits (the unit tests' stand-in does that). Error messages and the zh-TW wording of the panel are covered by `test/usage-web.test.ts`, not here.
- **How smoothly the home logo's animation runs.** [The home page](#the-home-page) checks that it animates `transform` and `opacity` alone, once; that Chrome runs it on the compositor, with no layout or paint after the page is drawn, was checked by hand in a Chrome trace.
- **Push notifications and the system's own notifications.** [Notifications and sound](#notifications-and-sound) records them with stand-ins; push needs a real push service (Google's, Apple's…), so the server's side (subscriptions, encryption, signing, what it sends and holds) is covered by unit tests (`test/push.test.ts`, `test/alerts.test.ts`, `test/push-api.test.ts`) the page's side by `test/alerts-web.test.ts`, and the service worker's handlers, with a stand-in `self`, by `test/sw.test.ts`; a browser subscribing with its push service and a real push reaching a phone are not tried by any test.
- **OpenCode's and Goose's tokens and cost.** Harness Relay reads them from those CLIs' own SQLite databases (`opencode.db`, `sessions.db`), which their fakes do not keep, so their replies show none here; the adapters' tests (`test/opencode.test.ts`, `test/goose.test.ts`) run whole turns against databases written as the real CLIs write them.
- **Features no spec goes through yet**: voice input itself, recording and transcribing (it downloads its engine and models, and needs a microphone; only its install's panel is tried); the files a shared reply links to, and uploading a report's screenshots (both push to a gist with git, which the fake `gh` does not stand in for); API keys in the OS credential store (the tests keep it off, so they go to the database); signing Codex, Grok, Cursor, Antigravity, Copilot and Muse Code in from Settings (their own flows; Copilot's device sign-in is tried by `test/providers.test.ts`), and what the real Codex does with a key `codex login --with-api-key` was given; Copilot refusing to start below full access when its sandbox's policy is not the one its run set up (`test/copilot.test.ts` covers it); Muse Code asking about a command's network (its fake asks, in its sandbox, for `e2e:approve=publish`, which no spec sends it), and a Muse Code member starting a fresh session after its chat's permission changed or the server restarted (`test/muse.test.ts` covers it); AgentsView's links to the lead agent's and the group sorter's sessions, conversations sent once an address is set, and the members' sessions Harness Relay records for the open agents (`test/agentsview.test.ts` covers them, and Cursor's, which a spec tries too); a ZIP too large even without what git ignores; and the desktop app's window beyond signing in (its own checks, `desktop/scripts/smoke.ts` and `desktop/scripts/check-package.ts`, start a read-only chat of these fake claude, codex and grok and have each answer a question, on the bundled server and in the packaged app: in CI on Linux and Windows, and on every system before a release). Some of them have unit tests in [`test/`](../test/), listed in the developer guide's [Testing](../docs/developer-guide.md#testing).

## The live tests

[`live/`](live/) holds a second suite, `npm run test:e2e:live` with [`playwright.live.config.ts`](../playwright.live.config.ts): the real CLIs, signed in as you are, on real models, so it costs a little and never runs on CI. It is not counted above. It tries all twelve CLIs by default, each test skipped unless the environment names what it needs (an endpoint, `E2E_LIVE_CLOUD=1` for the CLIs' own cloud models): on a Mac, 48 tests in three files with one endpoint, and 58 with the cloud models too (one more for each `E2E_LIVE_MODEL_<CLI>`; with nothing set, 21 tests are listed, all skipped). They try each CLI on an endpoint's model picked in Team settings, a CLI's default model set to an endpoint's in Settings, the seven CLIs' own cloud models (Claude Code's, Codex's, Grok's, Cursor's, Antigravity's, Copilot's and Muse Code's), a member on a deleted endpoint's model, a model typed for an endpoint, the open agents on native Windows below full access, a team on cloud and local models together, each CLI writing a file in each of a chat's two working directories through its shell (on an endpoint's model, and the seven with a sign-in on their own too), Cursor's own file tool in the second one, Antigravity ending its turn at a refused command and asking about a project's own MCP server before it starts, Copilot doing the same with a refused command and a project's own hook, and every CLI below full access writing nothing outside the chat's folders. How to run them: the developer guide's [Live tests](../docs/developer-guide.md#live-tests).

## Related docs

- [Developer guide → End-to-end tests](../docs/developer-guide.md#end-to-end-tests): how they work, the fixtures, the fake CLIs and their `e2e:` directives, and writing a test.
- [Developer guide → Testing](../docs/developer-guide.md#testing) and [Continuous integration](../docs/developer-guide.md#continuous-integration): the unit tests and the CI workflows.
- [Contributing → Tests](../CONTRIBUTING.md#tests): the rules for tests.
- [User guide](../docs/user-guide.md): the features these scenarios go through, as a person uses them.
- [Architecture](../docs/architecture.md): how the server does what they check ([CLI adapters](../docs/architecture.md#cli-adapters), [Permission mapping](../docs/architecture.md#permission-mapping), [Security](../docs/architecture.md#security)).
- [OS sandboxes by platform](../docs/sandboxing.md): why a folder the chat was not given stays out of each CLI's reach, and where it does not.
- [Open agents](../docs/open-agents.md): their model backends, permissions and the relay sandbox, which their fakes run in.
- [Use it from your phone](../docs/remote-access.md): what [On a phone](#on-a-phone) stands for.
- [Developer guide → Live tests](../docs/developer-guide.md#live-tests): the second suite, with the real CLIs.
- Code: [`playwright.config.ts`](../playwright.config.ts), [`fixtures.ts`](fixtures.ts), [`global-setup.ts`](global-setup.ts), [`support/`](support/) (`relay.ts`, `app.ts`, `clis.ts` and the facts of each CLI in `clis/`, `fake-cli.ts`, `sandbox.ts`), [`fake-cli/`](fake-cli/) and [`specs/`](specs/).
