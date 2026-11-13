**English** | [繁體中文](adding-a-coding-agent.zh-TW.md)

# Adding a coding agent: the procedure

How a new coding-agent CLI joins Harness Relay, step by step, as it was done for Grok, Cursor, the five open agents (OpenCode, Goose, Cline, OpenHands, Pi) and Antigravity. The [developer guide](developer-guide.md#adding-a-new-agent-cli) lists the code's touchpoints; this page is the order of work around them, and the checks each step needs before the next. [CONTRIBUTING](../CONTRIBUTING.md) has the rules every change follows.

An agent is ready to merge when it is **checked against the real CLI**: what its adapter relies on was seen, not assumed, and the docs say which version and system it was checked with.

## 1. Agree on it first

Open a **Feature request** issue before writing code: a new agent CLI is a larger change ([CONTRIBUTING → Suggesting a feature](../CONTRIBUTING.md#suggesting-a-feature)). Say which route it takes:

- **A native adapter**, for a CLI with a sign-in of its own (Claude Code, Codex, Grok, Cursor, Antigravity). It runs in its own home and account, and below full access in its own OS sandbox, or, without one that works, asks about every command (Cursor, Antigravity).
- **An open agent**, for an open-source CLI that runs on the model backends of Settings, in a home of Harness Relay's own and, below full access, in Harness Relay's own sandbox ([Open agents](open-agents.md)).

Work in a branch from `main`, in a worktree of your own inside the repository ([AGENTS.md → Worktrees](../AGENTS.md#worktrees)), with `npm install` in it and a short `RELAY_DATA_DIR` (the relay sandbox's sockets need one).

## 2. Get the CLI without touching your own setup

- **Install it apart.** Read an install script before running it, and prefer fetching its release yourself (Antigravity: its manifest, the archive, the SHA-512 check) into a folder of the worktree's scratch space; do not let it edit your shell profile or install over a copy you use.
- **Isolate its home every time you run it**: its own variable (`CODEX_HOME`, `GROK_HOME`, `CURSOR_CONFIG_DIR`), a flag (`agy acp --gemini-dir`), or `HOME` for a quick look. A plain `agy --version` already writes into `~/.gemini`; clean up what you created.
- **Keep it from opening browsers.** Signed out, some CLIs start a browser sign-in on the first command that needs one (Antigravity opens one unless it finds itself over SSH; Cursor unless `NO_OPEN_BROWSER`). Set that switch before asking it anything.

## 3. Find out how it really behaves

Read its `--help` (and each subcommand's), its documentation, its changelog (Antigravity ships one: `agy changelog`) and its source when it has one, then try each point below with the CLI itself. Write the answers down as you go: they become the adapter's header comment, the tests and the docs.

| Question | Why it matters | Seen before |
| --- | --- | --- |
| A protocol that can **ask** before a tool call (ACP, JSON-RPC, stream-json with a permission hook)? | A headless mode that cannot ask cuts the reply off at the first refusal. | Grok moved from `grok -p` to ACP for this (`Run Grok over ACP so refused tool calls no longer end the turn`). |
| What runs **without asking** in each of its modes, and what its own settings can widen? | Its own allow rules, approval modes or "always" answers must not widen read-only or edit. | Cursor: allow rules in `cli-config.json` (a private config folder per run); Antigravity: `toolPermission` and `allowNonWorkspaceAccess` (a run's own settings, which keep only the account's model and service), while its allow and deny rules do not apply over ACP. |
| Does its **sandbox** work in that mode, and does it fail closed? | Below full access the sandbox is what keeps edits to the working directory. | Cursor's ACP mode applies none; Antigravity's lets commands write nowhere in the working directory over ACP; Grok's custom profile refuses to start rather than run without one. |
| What does a **refusal** do, and can a reason reach the model? | Decides the briefing and what the chat shows. | Grok takes `_meta.followup_message`; Cursor and Cline pass only their own words; Antigravity ends its turn. |
| Where does the **briefing** go? | A system prompt (Claude Code's `--append-system-prompt`, Grok's `_meta.rules`, Antigravity's `_meta.antigravity.systemPrompt.append`), or the top of the prompt (Cursor). Whether a resumed session needs it again. | Antigravity adds every briefing it is sent, so it gets one again only when it changed. |
| **Sessions**: new, resume, load; does loading replay history? | Replayed updates are not this turn's; a session that cannot resume must fail before the turn says anything, so the orchestrator retries fresh. | Cursor's `session/load` replays; Grok's and Antigravity's `session/resume` do not. |
| **Home and sign-in**: the variable that moves its home, where the sign-in is kept, how to sign in from a link, check status and sign out without a prompt? | Accounts, Settings' sign-in, the status pill. A sign-in kept once per computer user makes extra accounts key-only. | Cursor (keychain) and Antigravity (system keyring) accounts besides the default sign in with an API key only. |
| **Models and effort**: how they are listed, named and set per session? | The model menus, and what is set on every turn. | Cursor's parameterised model picker; Antigravity resets its model on resume. |
| **MCP servers**, images, other working directories? | What the tool library and attachments can give it. | HTTP MCP servers only where the agent advertises them. |
| **What it loads by itself** (skills, MCP servers, hooks, subagents, plugins, instruction files) and a per-run switch for each? | Settings' list and `NATIVE_OFF_SUPPORT`; project files that run code (hooks, MCP servers) are a sandbox escape. | Antigravity starts a project's `.agents/hooks.json` and `mcp_config.json` as its session opens, without asking, in read-only too; other agents can write them, so Harness Relay asks before agy starts. |

**Without a paid account**, point the CLI at a stand-in for its model API when it takes a base URL (Antigravity was explored with a Gemini API key and a scripted stand-in for the Gemini API, which also showed the system prompt and tools it sends), or at a local model server (Ollama, vLLM) for an OpenAI-compatible CLI. Say in the docs what could not be checked this way (a real sign-in, real models).

## 4. Decide the permission mapping

Write the read-only / edit / full access row for it in [Architecture → Permission mapping](architecture.md#permission-mapping) before writing the adapter, and keep to it:

- **Read-only**: reading and web lookups run; anything else asks the user (or is refused when the chat refuses automatically).
- **Edit**: edits in the chat's working directories run; publishing (`isPublishCommand`) asks; commands run only inside a sandbox that keeps them there; without one, every command asks and its card says it runs outside any sandbox (`outsideSandbox`). Writes where code could run later (a project's agent config, `.git/hooks`, `.vscode`) ask.
- **Full access**: the agent's own always-allow mode.
- Below full access, the protected paths (`protectedReads()`) are denied, through the CLI's sandbox or rules where it has them, else refused when it asks.
- Never answer "allow always" (the CLI would save the rule); answer allow-once or reject-once.
- Fail closed: a setting that cannot be applied, a sandbox that cannot start, a path a rule would read as a pattern: the run does not start, saying why.

## 5. Write the adapter

Follow the [developer guide's checklist](developer-guide.md#adding-a-new-agent-cli) (a native adapter or an open agent), then the places the typechecker cannot name: the lead agent's and the agents' briefings (the list of CLIs), `agentFolders()`, and as needed `INHERITED_BACKEND_VARS`, `PROJECT_AGENT_CONFIG`, `keyOnlyAccount()` and `failedProbe()`. The typechecker names `AGENTSVIEW_SESSIONS`, but not what goes in it: find out in AgentsView's own source whether it reads the CLI's sessions where Harness Relay's runs leave them, and under what id, before giving it a prefix rather than `recorded`. Then:

- Keep the parser pure (updates in, `AgentEvent`s out) and the decisions pure (`<name>PermissionDecision`, `<name>ApprovalRequest`), so tests can feed them recorded lines.
- Start the CLI through `src/server/process.ts` only; never a shell; an open agent through `startOpenProcess()`.
- Write a run's settings in a folder of its own, owner-only, removed after the turn, never into the user's own files (Cursor's config folder, Antigravity's `--cli_dir_name` folder), and take from the user's own settings only what the run needs (Antigravity: the model and service).
- Watch for import cycles: `agents/index.ts` imports every adapter, so an adapter must not import a module that imports `agents/index.ts` back (`models.ts`, `native.ts`, `providers.ts`); a cycle shows as "Cannot access … before initialization" at the server's start (`test/parent.test.ts`).
- Both languages for every message (`src/server/i18n.ts`, the locale files), and the UI parts (colour, Settings card, API key help, native notes, the bug report form, the pull request template).

## 6. Record it and test it

- **Record the real CLI driven by your adapter**: point the adapter's binary at a small wrapper that starts the real CLI and logs every line both ways (`{dir, msg}`), and run each scenario: a plain reply with thinking and tool calls, read-only with a refusal, an automatic refusal, a protected path, edit inside and outside the working directory, full access, a resume, a stop in the middle, signed out.
- **Scrub the recordings** before they enter `test/fixtures/<name>/`: your paths (into `/work/app`, `/home/user`), your user name, keys, tokens, sign-in links; then search the folder for them.
- **Replay them** through a stand-in (`test/fake-<name>.ts`, as `fake-cline.ts` and `fake-antigravity.ts`), and test in `test/<name>.test.ts`: the decisions, the approval cards, the parser, the run's settings and arguments, the briefing, the models and the native lists, and whole turns. Add its cases to the shared tests (`providers`, `protect`, `agentsview`, `native`, `store`, `app`, `route`, `i18n`, `tour`), and run the CLI's real commands once by hand for status, models and native lists.
- **Give it an end-to-end fake** (the developer guide's [End-to-end tests](developer-guide.md#end-to-end-tests)): `e2e/fake-cli/agents/<name>.cjs`, listed in `e2e/fake-cli/fake-cli.cjs`, speaks the part of the protocol its adapter uses, with the recordings' shapes (`lib/acp.cjs` for an ACP CLI); answers every question the server asks it (version, status, models, native lists, sign-in and sign-out) and exits at once on anything else; and acts only on what Harness Relay set up: its arguments, config files and environment, the permission, the answers to its approval requests, and for an open agent the real relay sandbox below full access. Its facts go in `e2e/support/clis/<name>.ts` (listed in `clis/all.ts`): what every per-CLI spec branches on. With `implemented: true` every per-CLI test runs for it, titled `<name>: …` (`npx playwright test -g "<name>:"`), and it joins the team tests. Its `testedOn` names the systems those run on in CI (`E2E_SYSTEM_CLIS=1`): Linux always, and macOS or Windows where Harness Relay runs it differently there than on Linux in a way its fake can tell (its sandbox, its shell, how its folders are found), with the reason in a comment beside it. A fact a spec needs that no CLI had yet is an optional field at the end of `CliFacts`, with its default in `clis.ts`. Try the scenarios through the real UI with a scratch spec of its own first: it finds a wrong shape faster than the shared specs do.
- Keep the tests offline and passing on Windows: stand-ins started by their `#!` line under `skipIf(process.platform === 'win32')`, paths with `join()`.

## 7. Check it end to end

- `npm run typecheck`, `npm test`, `npm run build`, `npm run test:e2e` (its fake's tests, the team tests with it, and Settings' and the sidebar's counts, which take every CLI), and `npx tsx scripts/sandbox-check.ts` when a sandbox file changed. `npm run desktop:typecheck` when `desktop/` changed.
- **On each system** the agent runs on: macOS, Linux (a machine of its own, or Docker for the relay sandbox: [OS sandboxes by platform](sandboxing.md)), Windows (a computer or a VM; an npm CLI there is a `.cmd` shim, started as `winLaunch.ts` says). Run the suite there and the recorded scenarios against the real CLI.
- `npm run test:e2e:live` when you have a model server or a sign-in. Add the CLI to `e2e/live/live.ts`: to `CLIS`' default list, and to `ENDPOINT_CLIS`, `OPEN` or `CLOUD_CLIS` by what it runs on, so the live model, team, writing and sandbox tests take it in; a test of its own for what only it does (Antigravity's refusal ending its turn, say).

## 8. Document it, in both languages

A facts sheet of what you verified, with the version and system, keeps the docs consistent; then update, each with its `.zh-TW.md`: [README](../README.md), the [user guide](user-guide.md), [Architecture](architecture.md) (its column in each per-CLI table, an adapter paragraph, the permission mapping, providers and accounts, security and known limitations), [OS sandboxes by platform](sandboxing.md), the [developer guide](developer-guide.md) (layout, the test list), the [end-to-end scenarios](../e2e/README.md) (each area's table and "Each CLI at a glance"), [Open agents](open-agents.md) for an open agent (one section per agent, with the version checked), [Remote access](remote-access.md), CONTRIBUTING and AGENTS.md, and the landing page (`site/`, following `site/DESIGN-GUIDELINES.md`). Say what could not be checked.

## 9. Commit and review

- One commit (or a few) whose subject says what the user gets (`Add Cursor as a fourth coding agent, run over ACP with every command asked below full access`), with a body grouped by area: adapter, settings and sign-in, UI and prompts, tests, docs; whether the schema changed.
- The pull request says which real CLIs, versions and systems it was tried with. Expect review rounds: the Cursor and open-agent work took several (`close the gaps the review found`), each fixed with tests and docs in the same commit.
- When the sidebar or Settings change visibly, the demo may need recording again (`npm run demo`).
