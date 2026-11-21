**English** | [繁體中文](agent-cli-features.zh-TW.md)

# The agent CLIs' own features

> **Status: proposal, not implemented.** See [Proposals](README.md).

What the twelve agent CLIs can do by themselves that Harness Relay does not use yet, or uses in a way that does not work, and which of it would make the agents do better work: subagents and workflows (Claude Code's agent teams and dynamic workflows among them), context limits on the user's own endpoints, plans, questions, steering a running turn, structured answers and budgets.

## How this was found

An audit on 2026-11-21, one CLI at a time, then checked again by reviewers who had not done it. For each CLI:

- its adapter in `src/server/agents/`, and what Harness Relay sends and reads;
- the installed CLI's `--help` and its subcommands' help, the files in its package (docs, changelogs, schemas: `codex app-server generate-json-schema` for Codex), and the strings in its binary;
- its maker's documentation, release notes and published source.

No CLI was given a prompt, and no CLI's home was read. Each finding about a CLI has a label:

- **local**: seen in the installed CLI (its help, schema, bundled code or bundled docs);
- **docs**: only in the maker's documentation, release notes or published source;
- **unsure**: needs a live run to settle.

What is said about Harness Relay itself cites its file and line, and has no label.

| CLI | Checked (`cliVersions.ts`) | Read in this audit | Newest seen |
| --- | --- | --- | --- |
| Claude Code | 2.1.322 | 2.1.330 | 2.1.330 (npm `latest`; `stable` is 2.1.323) |
| Codex | 0.167.0 | 0.167.0 | 0.171.0 |
| Grok | 1.0.77 | 1.0.89 | not looked up |
| Cursor | 2026.11.11-043ef28 | 2026.11.11-043ef28 | 2026.11.17 |
| Antigravity | 1.5.6 | 1.5.11 (its `agy changelog` up to 1.5.13) | 1.5.13 |
| Copilot | 1.0.109 | 1.0.112 | 1.0.114 (1.0.115-4 in prerelease) |
| Muse Code | 1.4.18 | 1.4.23 | 1.4.24 |
| OpenCode | 1.19.5 | 1.19.5 | 1.19.6 on npm (a 2.x line on GitHub, 2.3.2) |
| Goose | 1.58.1 | 1.58.1 | 1.60.2 |
| Cline | 3.0.74 | 3.0.74 | 3.0.74 |
| OpenHands | 1.16.0 | 1.16.0 | 1.16.0 |
| Pi | 1.5.1 | 1.5.1 | 1.6.0 |

Where the version read is newer than the one checked, a finding about it may not hold for the checked version; the [CLI check](../developer-guide.md#checking-a-clis-new-version) settles that before anything is built on it.

## What exists today

- **Harness Relay's own team runs above the CLIs.** Each conversation member is one CLI session; each turn starts the CLI once (Codex's app-server, Grok's and the others' ACP, Claude Code's stream-json, Pi's RPC), resumes the member's session, and ends the process when the turn answers. The orchestrator decides who speaks ([Turn scheduling](../architecture.md#turn-scheduling-modes)), the lead agent designs the team and reviews its replies, and [team checks](../architecture.md#team-checks) hold the team to one set of rules.
- **What the chat can show** is what the adapters turn into `AgentEvent`s (`src/server/agents/types.ts`): text, thinking, a plan, tool calls and the session id. There is no event for work done inside a turn by a subagent, nor a notice for compaction, a retry or a model switch.
- **What Harness Relay already uses**, CLI by CLI: reasoning effort; thinking summaries (Claude Code's `--thinking-display`, Codex's `model_reasoning_summary`); the plan where a CLI reports one; the CLIs' own compaction, left on where they have it; Copilot's LSP setup; Goose's steering for a refusal's reason; and switches per account for what each CLI loads by itself (skills, MCP servers, built-in tools, instruction files, memory, hooks, subagents, plugins), as far as the CLI allows ([What each CLI loads by itself](../architecture.md#what-each-cli-loads-by-itself)). Claude Code's own subagents (not its built-in ones) and single built-in tools can be left out, and so can OpenCode's subagents; Codex and Grok have no switch that spares their built-in subagents.

## What is missing

### 1. Subagents and workflows run unseen, and some are cut off

Most CLIs can now hand parts of a turn to subagents, and several can run whole workflows of them. In Harness Relay's runs most of this is on, and none of its work reaches the chat.

| CLI | Built in | In Harness Relay's runs | What reaches the chat | Problem |
| --- | --- | --- | --- | --- |
| Claude Code | `Agent` tool and custom subagents; dynamic workflows (`Workflow` tool); agent teams | `Agent` on. `Workflow` on by default for every account but Pro (local: its gate; docs), and it goes through the permission check: below full access it reaches the user as a generic approval when the conversation asks, and is refused otherwise; in full access it runs at once. Agent teams (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`) spawn no teammates in `-p`, where a named subagent runs as an ordinary one (docs) | None of their work: every event with a `parent_tool_use_id` is dropped (`claude.ts:1177`), and every `system` message (`task_started`, `task_progress`, `task_notification`) is ignored. Their tokens are in the turn's totals | Harness Relay ends stdin at the first `result` (`claude.ts:1479`) and reads until Claude Code exits, adding up the later results' usage (`claude.ts:1236-1240`). Claude Code waits for its background subagents and workflows, but stops them after 10 idle minutes (local and docs: `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`, default 600,000), while a Harness Relay turn may last a day |
| Codex | Subagents: on by default. In 0.167.0 `agents.enabled=false` turns them off unless `features.multi_agent_v2` is on, which wins; otherwise a model's `multi_agent_version` in the bundled catalog decides, and a model without one (`gpt-5.5`, an endpoint's) falls back to the `multi_agent` flag (docs: source; local: bundled catalog). The `ultra` effort delegates on its own ("Maximum reasoning with automatic task delegation", local: bundled catalog) | On, and `ultra` is offered | Nothing: other threads' notifications are dropped (`codex.ts:808`), and the `collabAgentToolCall` and `subAgentActivity` items are not handled; subagents' threads are not counted in the turn's tokens | In edit mode (not on native Windows) the protected paths are `read` entries in the thread's permission profile (`codexGuardReads()`, `codex.ts:88`). Child threads lost the sandbox's restrictions until 0.170.0 (docs: release notes); its change keeps `deny` entries, so whether `read` entries are kept: unsure. The check at the approval has no paths for a subagent: its request names only the item, whose paths came in a notification dropped at `codex.ts:808`, so `codexGuardRefuses()` refuses nothing and the card names no file. The team checks still compare protected paths on disk after the turn |
| Grok | `spawn_subagent`, in the background by default; finishing wakes the parent (local: bundled docs) | On (they can only be turned off all together, built-in ones included) | Nothing: other sessions' updates are dropped (`grok.ts:1179`) | Harness Relay closes stdin when the prompt answers (`grok.ts:1275`), so a wake-up turn never runs (unsure over ACP). `GROK_MAX_CONCURRENT_SUBAGENTS` and `GROK_SUBAGENTS_MAX_DEPTH` exist (local) and are not set |
| Cursor | Subagents (`explore`, `shell`, `browser_use`…); a `cursor/task` message for each finished Task call; with the `subagents` client capability, each subagent is also a child session and a prompt waits for its background subagents (docs: 2026.09.15; local: bundled code) | On; the capability is not advertised (`cursor.ts:608`) | Nothing: other sessions' updates and other methods are ignored (`cursor.ts:547-552`) | — |
| Copilot | `/fleet` (parallel subagents), the `rubber-duck`, `explore`, `task` and `code-review` agents, custom agents (local: help topics, bundled definitions) | The account's `subagents`, `customAgents`, `experimental` and `extensions` settings are kept (`KEPT`, `copilot.ts:144`); `/fleet` is never asked for | Nothing marked as a subagent's: the ACP runtime events (`github.com/copilot/sessionEvent`; one with `params.agentId` is a subagent's) come only for the types a client lists in `initialize`, and Harness Relay lists none (`copilot.ts:1564`). Whether subagents' calls already come as unmarked tool calls: unsure | None found up to 1.0.114: `session/prompt` waits for attached background work (local: `copilot help acp`); 1.0.115's prereleases stop waiting for background agents' updates (docs), so the next CLI check should look again |
| Antigravity | Subagents (`pro`, `flash`, `browser`, custom ones), `run_workflow` (1.5.9), `/swarm` (a preview since 1.5.5) (local: `agy changelog`) | On; below full access their calls go to the user like any other ([Sandboxing](../sandboxing.md)) | Nothing (whether their updates reach Harness Relay at all: unsure) | When the prompt answers, Harness Relay closes agy's stdin, stops it 3 s later and ends what its commands left running (`antigravity.ts:1007-1010`). A subagent still running then would wake the agent when it finishes (local: changelog 1.5.10, which also made closing stop them), so its work is lost. The `browser` subagent drives the user's own running Chrome (its profile and sign-ins) through Chrome DevTools MCP, which agy starts with `npx`, once the user has allowed remote debugging in Chrome: outside Harness Relay's browser proxy and any sandbox (docs; local: binary); 1.5.8 fixed deny and ask rules being ignored for its tools. Whether an `agy acp` session can reach it: unsure |
| Muse Code | `subagent_spawn`, `subagent_wait`, `subagent_read_result`, `subagent_status`, `subagent_send_message`, `subagent_cancel`; workflows (local: 1.4.23 binary) | 1.4.18, the version checked, gives a session no subagent tools ([CLI adapters](../architecture.md#cli-adapters), Muse Code); 1.4.23 has them (local), and whether a run gets them is unsure. Workflows off on purpose (`MUSE_RUN_RUN_SETTINGS`): their agents were always cancelled when the turn ended (`muse.ts:178-182`) | Nothing | Muse tells the model that results arrive "when your session is idle, so keep working or end your turn" (local): a child still running when the turn ends may be lost, as the workflows' agents were (unsure) |
| Cline | `spawn_agent`; agent teams (local: its ACP config, `enableSpawnAgent:!0`, `enableAgentTeams:!1`) | `spawn_agent` on, its subagents asking too ([Open agents](../open-agents.md), Cline); teams off by Cline's own ACP default | The `spawn_agent` call as one row (kind `think`, `cline.ts:374`); its subagents' calls are not shown | — |
| OpenCode | `task` tool with subagents (`explore`, `general`, custom) | Denied below full access (`opencode.ts:504`): a subagent that asks would hang | The `task` call as one row; child sessions' updates are dropped (`acpTurn.ts:767`) | A read-only `explore` with rules that never ask would not hang (local: `opencode agent list` resolved such rules; a live run is still needed) |
| Goose | Subagents (`delegate`, through the `summon` extension) | On; their tool calls are asked about like the agent's own (`GOOSE_PLATFORM_EXTENSIONS`, `goose.ts`) | Their tool calls are not shown | `GOOSE_MAX_CONCURRENT_SUBAGENTS` (default 5), `GOOSE_SUBAGENT_MAX_TURNS` and `GOOSE_SUBAGENT_MODEL` exist (local: binary) and are not set |
| OpenHands | `task` subagents | Off below full access, rightly: they act without asking (local: `TaskManager(confirmation_handler=None)`) | — | — |
| Pi | None built in (an example extension starts separate `pi` processes, without Harness Relay's gate) | — | — | — |

**Agent teams and dynamic workflows, in short.**

- Claude Code's **agent teams** are experimental and off unless `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` is set, and in `-p`, the mode Harness Relay runs it in, Claude spawns no teammates even then (docs). Cline's are off over ACP. Neither can replace Harness Relay's own teams, which mix CLIs.
- Claude Code's **dynamic workflows** (the `Workflow` tool: scripts that run up to 16 subagents at once by default, fewer on fewer processors and 1 to 256 with `CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS`, docs; and 1,000 a run, local) work in `-p` and are on by default for every account but Pro. In Harness Relay's runs they are neither governed nor shown: below full access the call reaches the user, when the conversation asks, as a generic approval card that does not say what it will run; in full access it runs at once; and its progress arrives only as `task_*` messages, which are dropped. The `ultracode` keyword (Claude plans a workflow for every substantive task) works only in a message marked as the person's own (`origin: { kind: "human" }`), so not in the unmarked stream-json messages Harness Relay sends; `--effort ultracode` works but also forces `xhigh`, while the `"ultracode": true` setting keeps the effort (docs).
- The others' workflows are the same idea inside one CLI: Antigravity's `run_workflow`, Grok's workflows, and Copilot's dynamic workflows, which come only from extensions and need its experimental mode, an extension mode other than disabled, and usage-based billing, a Microsoft 365 account or the user's own model provider while signed out of GitHub (local). Since Harness Relay keeps the account's `experimental` and `extensions` settings, an account's extension workflows can already run inside a member's turn.

What the CLIs' own subagents add to Harness Relay's team is parallel work inside one member's turn, on its own CLI and model: an exploration in a separate context, a second opinion (Copilot's `rubber-duck`), a cheaper model for small tasks. It does not replace a team of different CLIs, and today the chat does not show its work. Its tokens are in the turn's totals for Claude Code, OpenCode, Goose and Cline, but not for Codex's subagent threads ([A reply's cost and tokens](../architecture.md#a-replys-cost-and-tokens)).

### 2. Endpoint models have no context window

Harness Relay never asks an endpoint how long its models' context is (`ModelEndpointView`, `src/shared/types.ts`), and the open agents need it to compact in time. Small models on the user's own computer, which have the shortest contexts, are hit hardest.

| CLI | Without a context window | Where Harness Relay could give it |
| --- | --- | --- |
| OpenCode | A context of 0, so it never compacts before the server refuses (local: binary). After an error it reads as an overflow (HTTP 413, `context_length_exceeded`, messages such as vLLM's "maximum context length is N tokens") it compacts and retries (local), and from 1.19.6 also when the provider refuses a request body as too large (docs). A server that cuts the context silently never triggers it | `limit.context` and `limit.output` in each endpoint model's entry, now `{ name, tool_call: true }` (`opencode.ts:571`) |
| Goose | llama.cpp's `meta.n_ctx` when `/v1/models` reports it; else its catalog's limit for a model name it knows; else 128,000 tokens (docs: source of 1.58.1). So for a 32k model on vLLM or Ollama, compaction (at 80% of the context) never comes before the server refuses; Goose then compacts after an overflow error it recognises (docs: source of 1.58.1). Summing up old tool output is off unless `GOOSE_TOOL_PAIR_SUMMARIZATION` is set | `context_limit` for each model in the provider file, now `{ name }` (`goose.ts:314`), or `GOOSE_CONTEXT_LIMIT` |
| Pi | `contextWindow` 128,000 and `maxTokens` 16,384; compaction starts at `contextWindow − reserveTokens` (local: its bundled docs) | `contextWindow` and `maxTokens` in its `models.json` |
| OpenHands | Condenses by event count (`max_size: 80`, `openhands.ts:260`), and on an overflow error the server reports; a server that cuts the context silently never triggers it (local) | the condenser's `max_tokens` |
| Cline | No compaction at all over ACP in 3.0.74 (local: its ACP config sends no `compaction`, and `--compaction` is ignored with `--acp`) | Nothing: it needs Cline to honour its settings over ACP |

Other settings that help a small model, none set today: OpenCode's `compaction.prune`, `tool_output.max_lines` and `max_bytes` (defaults 2,000 lines and 51,200 bytes), and an agent's `steps`, a loop guard that forces a text answer (local); Goose's `GOOSE_MAX_TOOL_RESPONSE_SIZE` (default 200,000 characters, beyond which a response goes to a temporary file), `GOOSE_MAX_TURNS`, `GOOSE_AUTO_COMPACT_THRESHOLD`, `GOOSE_TOOL_PAIR_SUMMARIZATION` and `GOOSE_TOOL_CALL_CUTOFF` (local: binary); OpenHands' `native_tool_calling: false`, for an endpoint without tool calls (local).

### 3. Plans that never show

- **Claude Code.** One gate covers all its task-tracking tools (local: 2.1.330 binary; docs: since 2.1.268, so the checked 2.1.322 too). By default they exist only on Claude 3.x, Opus 4.0 to 4.7, Sonnet 4.0 to 4.6 and Haiku 4.5, or through an application inference profile; `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`, or naming one of them in `--allowedTools` or `--tools`, opts in. Where they exist, Claude Code gives the task tools (`TaskCreate`, `TaskUpdate`…), or `TodoWrite` with `CLAUDE_CODE_ENABLE_TASKS=0`. Harness Relay turns only `TodoWrite` into a plan (`claude.ts:1202`) and sets neither variable, so by default no plan shows on any model, and on the aliases it runs (`fable`, `opus`, `sonnet`, `haiku`: `src/server/models.ts`), which on Anthropic's own service point at the Claude 5 family, neither kind of tool exists. Anthropic's reason: newer models track multi-step work without a written checklist, and the tools' definitions and reminders take context (docs). The architecture's table gives Claude Code's plan as "the `TodoWrite` tool", and its known limitations say the plan needs `TodoWrite`; neither says that it is now off by default.
- **Codex.** It offers its `update_plan` tool only with `tools.update_plan.enabled=true`, off by default since August 2026 (docs: the 0.167.0 config schema and source; openai/codex#41744), which Harness Relay does not set: so no `turn/plan/updated` comes, and the architecture's table, which gives Codex's plan as `turn/plan/updated`, describes what no longer happens by default. The `plan` item and `item/plan/delta` belong to plan mode.
- **Cursor.** In agent mode its to-do list comes as `cursor/update_todos`, which Harness Relay ignores; a `plan` update comes only from its create-plan tool (local: bundled code). The architecture's table says Cursor's plan comes from `plan` updates; that is likely right only in plan mode (unsure until a live run).
- **Pi** has no to-do tool; its extension API can register one (local: the package's `examples/extensions/todo.ts`). Harness Relay's gate extension loads below full access and whenever the team has hooks (`piGated()`, `pi.ts:86`).
- **OpenHands'** long-horizon system prompt (`system_prompt_long_horizon.j2`) has the model keep a `task_tracker` plan, which the chat already shows; the default prompt does not mention it (local).

### 4. The CLIs' own question tools go nowhere

Harness Relay's briefing asks agents to end a reply with `[ASK_USER]` when they need the user (`src/shared/ask.ts`). Several CLIs have a question tool of their own, which in Harness Relay's runs fails or returns nothing when the model uses it:

| CLI | What happens |
| --- | --- |
| Codex | `item/tool/requestUserInput` is answered `{ answers: {} }` (`codex.ts:813`). By default the tool is offered in plan mode only, which Harness Relay does not use, and `tools.experimental_request_user_input.enabled=false` turns it off (docs: the 0.167.0 config schema and source) |
| Claude Code | In `-p`, `AskUserQuestion` is on whenever a permission prompt tool is set (local), as it is below full access when the conversation asks (`--permission-prompt-tool stdio`, `claude.ts:954`). It reaches the user as a generic approval, and allowing it returns no answers (what Claude does then: unsure); the Agent SDK answers it with `updatedInput.answers` (docs) |
| Grok | `ask_user_question` and plan-mode requests get -32601 (`grok.ts:1183`); `GROK_ASK_USER_QUESTION=0` would turn the tool off (local) |
| Antigravity | Its briefing already tells agy to ask as Harness Relay's instructions say, not with its `ask_question` tool (`antigravity.ts:450`). If it uses the tool anyway, the question comes over ACP as a form (`elicitation/create`), which Harness Relay answers -32601 (`antigravity.ts:903`); what agy does then: unsure (local: changelog 1.5.1, binary) |
| Copilot | Its `ask_user` (a question form) is declined when the client offers no elicitation, and the model is told (local: bundled code); `--no-ask-user` withholds it (local). What it does over ACP: unsure |
| Muse Code | Harness Relay declares no form elicitation (`muse.ts:1169`), so Muse cancels a `request_user_input` question itself and tells the model to state its assumptions and go on (local: binary): the question never reaches the user, but the turn goes on. `--disable-request-user-input` would withhold the tool from the main conversation (local); there is little to gain |

### 5. A message cannot reach a running turn

A message the user sends while the team works waits in the queue, and is posted before the next turn of an agent it is for ([Turn scheduling](../architecture.md#turn-scheduling-modes)). Several CLIs take one into the turn under way:

| CLI | How | Label |
| --- | --- | --- |
| Codex | `turn/steer { threadId, input, expectedTurnId }` (stable); Harness Relay already keeps the turn id | local |
| Claude Code | a user message written to the running stream-json session, with a `priority` of `now`, `next` or `later` | docs |
| Grok | `x.ai/interject`, `x.ai/queue/*` | local |
| Antigravity | another prompt while a turn runs steers it (1.5.0) | local |
| Goose | `_goose/unstable/session/steer`, which Harness Relay already uses for a refusal's reason (`goose.ts:980`) | local |
| Pi | `steer` (after the current tool calls, before the next model call) and `follow_up` RPC commands | local |
| Cursor | none: a new prompt cancels the running one | local |

Muse Code has a `user_steer` input and Copilot's ACP may steer too; neither is settled (unsure).

### 6. Structured answers for the lead agent's turns

The lead agent's team design, review and sidebar grouping are free text that Harness Relay parses (`parsePlanReply()` in `planner.ts`, `parseReviewReply()` in `reviewer.ts`, `parseGroupReply()` in `grouping.ts`). Claude Code's `--json-schema` (its `result` carries `structured_output`) and Codex's `outputSchema` on `turn/start` (stable, for one turn) make the CLI answer in a given JSON shape (local). The user's own endpoints may not support it, so the parser stays as the fallback.

### 7. Budgets, fallbacks and cost

- **Claude Code**: `--max-budget-usd` (caps the run, refuses new subagents and halts background ones; it checks Claude Code's own estimate, so not on an endpoint, where Claude Code prices the model as one of its own) and `--fallback-model` (local: help; docs). Stop sends `SIGTERM` (`process.ts`), which leaves the turn with no result; an `interrupt` control request (or `SIGINT`) ends it with a result that carries its usage (docs).
- **Copilot**: Harness Relay shows no cost for it. Its `assistant.usage` runtime event carries the cost and quota (local: its session events schema), with the same opt-in as the subagent events; `--usage-output-file` writes tokens and AI credits per model and per subagent when the session ends (local: help; whether it does over ACP after one turn: unsure). `--max-ai-credits` is a soft cap (at least 30 credits; one response can pass it) and covers subagents only from 1.0.112 (local: its bundled changelog); whether it applies on the user's own endpoint: unsure. Its `continueOnAutoMode` setting (off by default: at a per-model, weekly or integration rate limit, switch to Auto and retry; not for global limits nor the user's own provider, local) is not among the account settings Harness Relay keeps (`KEPT`, `copilot.ts:144`).
- **Goose**: `GOOSE_MAX_TURNS` (default 1,000) and the subagent limits above (local). **OpenCode**: an agent's `steps` (local).
- **Codex**: every listed model offers a `priority` service tier named Fast (1.5x or 2x speed, most with increased usage; local: bundled catalog).
- **Pi**: Harness Relay adds up only the assistant messages' usage (`pi.ts`), so a compaction's own model calls are not counted; Pi reports them in `compaction_end`'s `usage` and in `get_session_stats`, with the context's use (local: its bundled docs).

### 8. Smaller findings, CLI by CLI

| CLI | Finding | Label |
| --- | --- | --- |
| Codex | `review/start`: a built-in review of uncommitted changes, the current branch against a base, a commit, or custom instructions; it suits a reviewer role, or a parallel worktree against its base | local |
| Codex | Goals (`goals`, stable, on by default) continue a thread on their own; Harness Relay has tracked goals of its own and ends the process at `turn/completed`. `features.goals=false` would rule out a surprise | local; effect unsure |
| Codex, Claude Code, Grok, OpenCode, Pi | Forking a session (`thread/fork`, `--fork-session`, `x.ai/session/fork`, ACP `session/fork`, Pi's `fork` from a user message or `clone` at the current position): a [branched conversation](../architecture.md#branching-a-conversation) could keep each member's context instead of replaying the history | local / docs |
| Codex | Dropped notifications: `model/rerouted` (the chat may name the wrong model), warnings, live command output | local |
| Grok | ACP client hooks (`x.ai/hooks`) would add Grok to `HOOK_PROVIDERS` (`src/shared/types.ts`); they fail open on `ask`, a malformed reply, a timeout or a transport error | local |
| Grok | Whether `rules` is honoured on `session/resume` (a changed briefing on a resumed session) | unsure |
| Cursor | Plan and Ask modes: Harness Relay forces `agent` (`cursor.ts:684`). Ask mode ("no edits or command execution") would add Cursor's own read-only guard for a read-only member; plan mode still lets Markdown and canvas files change (docs: 2026.11.04) | local |
| Cursor | Model parameters besides effort, as config options of the session: a `context` of `1m`, `fast` (from the model list Cursor's service sends, as `test/cursor.test.ts:509` records it) | unsure |
| Cursor | 2026.11.14 refuses a whole-file rewrite when the file changed since the agent last read it: safer when several agents edit the same files | docs |
| Copilot | A custom agent per role: the ACP `agent` config option (1.0.40), likely listed only when custom agents exist (unsure), or `--agent`, honoured over ACP since 1.0.106 (its bundled changelog); and its `/review` and `/security-review` commands | local |
| Antigravity | Its terminal sandbox (`--sandbox`) is off on purpose: on 1.5.6 sandboxed commands could not write in the working directory over ACP (`antigravity.ts:48-50`). Worth trying again on a newer version, since each refusal ends agy's turn, though nothing in the 1.5.7 to 1.5.12 notes says it changed | local |
| OpenCode | LSP is off at every permission (`lsp: false`, `opencode.ts:158`), for a good reason below full access; but the docs' "this loses nothing" (`docs/open-agents.md:185`, `opencode.ts:149`) is not accurate: its edit tool gives the model the file's LSP errors to fix (local). Full access could offer it | local |
| OpenCode | Plan mode for read-only members (Harness Relay sets `build`, `opencode.ts:1444`) adds OpenCode's read-only reminder to the prompt; its own refusal of edits would hold only if Harness Relay wrote its rules as the plan agent's own, since Harness Relay's `"*": "ask"` comes after the built-in rules and wins (local: `opencode agent list`). `/compact` is kept from it by the guard on prompts that start with `/` (`acpPromptText()`, `acpTurn.ts`) | local |
| OpenCode | Harness Relay sets `OPENCODE_EXPERIMENTAL=false` (`opencode.ts:437`) but not `OPENCODE_EXPERIMENTAL_CODE_MODE` nor `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS`, which OpenCode reads on their own, falling back to `OPENCODE_EXPERIMENTAL` only when they are unset (local: binary); the open agents' environment starts from the server's (`open.ts:509`), so a server that inherited one passes it on, and it wins | local |
| Goose | Persistent instructions (the `tom` extension, left out in `GOOSE_PLATFORM_EXTENSIONS`; its text from `GOOSE_MOIM_MESSAGE_TEXT` or `GOOSE_MOIM_MESSAGE_FILE`): a short reminder in each turn's context block, which helps a weak model keep its rules; Goose leaves that block out for a context under 32,000 tokens | local |
| Goose | `_goose/unstable/context/report` breaks down what fills the context, with no model call | local |
| Goose | 1.59.0 and 1.60.1 fix compaction prompts that Claude models refused | docs |
| Cline | Plan mode; it holds only in a new session (`session/load` builds the runtime in `act`) | local |
| OpenHands | `reasoning_summary` for OpenAI's reasoning summaries (Responses API only; a verified OpenAI organization) | local |
| Pi | `compaction_*`, `auto_retry_*` and `summarization_retry_*` events are not shown; `cacheWarming` is `'off'` (`pi.ts:205`), where `"streaming"` warms only while a run is active | local |

### 9. Off, and should stay off

- **A model that approves in the user's place.** Each replaces the user's decision with a model's, so Harness Relay's own fixed decisions stay:
  - Codex's `auto_review`: off by default, but Harness Relay sets no reviewer (`codexConfig()`), so an account's `approvals_reviewer = "auto_review"` would apply; pin `user` (Design, step 1).
  - Cursor's auto-review: Harness Relay pins `approvalMode` to `allowlist` below full access (`cursor.ts:123`); over ACP it would run approved commands with no sandbox.
  - Muse Code's approval judge: off (`MUSE_DISABLE_APPROVAL_JUDGE`, `muse.ts:647`).
  - Copilot's assisted approval: dropped (`copilot.ts:257`, `copilot.ts:527`).
  - Claude Code's auto mode: never used (`PERMISSION_MODE`, `claude.ts:39-44`).
  - Goose's `smart_approve`: a model judges which calls only read; it also writes `permission.yaml` on every model call, which hangs in the relay sandbox. Never used (`goose.ts:88-90`).
  - Antigravity's Auto mode: a separate model reviews the commands that leave its sandbox; Harness Relay sets `default` on every turn (`antigravity.ts:1042`).
- **Copilot's autopilot** (allow all), and **`/delegate`**, which Copilot does not offer over ACP.
- **OpenHands' subagents below full access**: they act without asking.
- **Cline's agent teams and checkpoints** (Cline's ACP mode leaves them off; keep it so); **OpenCode's share, snapshot and web search**, which Harness Relay turns off (`opencode.ts:156-157`, `opencode.ts:437-441`), and its code mode (off with its experiments, unless the server inherited `OPENCODE_EXPERIMENTAL_CODE_MODE`: [section 8](#8-smaller-findings-cli-by-cli)). Harness Relay has its own teams and snapshots, and the rest reach outside the run.
- **Goals and `/goal`, `/grind`, `/learn`** in the CLIs that have them: they overlap Harness Relay's tracked goals and team checks, and `/learn` writes to `GEMINI.md` / `AGENTS.md`. Codex's goals are on by default ([section 8](#8-smaller-findings-cli-by-cli)): pin them off (step 1).

## Design

In this order; where a step depends on another, it says so.

### 1. Decide on each CLI's subagents, and pin what stays off

For these CLIs, below full access, either bound their subagents or turn them off, and say which in [Permission mapping](../architecture.md#permission-mapping); the others stay as they are today:

- **Codex**: `agents.enabled=false` and `features.multi_agent_v2=false` below full access (the architecture's [Leaving them out](../architecture.md#leaving-them-out-of-harness-relays-runs) names only `features.multi_agent = false`, which decides only for a model the catalog gives no version: complete it with this step), until a CLI check on 0.170.0 or later (step 9) shows a subagent keeps the permission profile's `read` entries; then caps (`agents.max_concurrent_threads_per_session`, `agents.default_subagent_reasoning_effort`). At every permission, pin `features.goals=false`, and `approvalsReviewer: "user"` on `thread/start`, since an account's own `approvals_reviewer` applies otherwise.
- **Grok**: `GROK_SUBAGENTS=0` until step 3 keeps its background work; then `GROK_MAX_CONCURRENT_SUBAGENTS` and `GROK_SUBAGENTS_MAX_DEPTH`.
- **Claude Code**: `Workflow` off by default with `CLAUDE_CODE_DISABLE_WORKFLOWS=1` (or a deny rule, as the switch for a single built-in tool already writes, `claudeNativeSettings()`), kept where the account turns it on; ultracode, which has Claude plan a workflow for every substantive task, only as a choice of its own, through the `"ultracode": true` setting, which keeps the member's effort; `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` set from the turn's timeout.
- **Antigravity**: `agy acp` has no switch for its subagents ([Leaving them out](../architecture.md#leaving-them-out-of-harness-relays-runs)), so they stay on; from 1.5.10 (step 9) step 3 keeps the turn until they finish, and until then its briefing asks it not to leave a subagent running when it ends its turn.
- **Goose**: `GOOSE_MAX_CONCURRENT_SUBAGENTS` lower on an endpoint, which often serves one request at a time.

### 2. Show the work subagents do

A tool call gets an optional parent: `tool_start` and `tool_end` take `parentId`, the id of the call that started the subagent, and the chat shows such calls folded under it, with the subagent's name and model when the CLI says. A new `notice` event carries what the CLI reports about its own run (compaction, a retry, a model switch). Sources, per CLI:

| CLI | Subagents' calls | Notices |
| --- | --- | --- |
| Claude Code | events with `parent_tool_use_id`; `task_*` system messages; `agentProgressSummaries` in `initialize`, for one-line summaries | `compact_boundary`, `api_retry`, `model_fallback` |
| Codex | `collabAgentToolCall` and `subAgentActivity`, and child threads' items followed by `parentThreadId`; their token usage added | `contextCompaction`, `model/rerouted` |
| Grok | `subagent_spawned`, `subagent_progress`, `subagent_finished`, `task_backgrounded` | `auto_compact_completed`, `model_auto_switched`, `auto_recovery_*` |
| Cursor | the `subagents` client capability: child sessions linked to the Task call; `cursor/task` | — |
| Copilot | `subagent.started` (`toolCallId`, `agentName`, `model`), `subagent.completed` and `subagent.failed`, and events with `params.agentId`, each type subscribed by name | `session.compaction_start` and `_complete`, `assistant.turn_retry`, `session.model_change`, `auto_mode_switch.completed` |
| Pi | — | `compaction_*`, `auto_retry_*`, `summarization_retry_*` |

The parent is an id only, so the shared types and the stored messages keep one list of calls.

### 3. Keep a turn until its background work ends

For Grok, Antigravity (from 1.5.10) and Muse Code: after the prompt answers, keep reading until the CLI reports that the work it started is done or the turn's timeout passes, and stream what comes in that time into the same reply. Where a CLI gives no such signal, its briefing asks it to wait for its subagents before it ends the turn. Cursor does this itself once the `subagents` capability is advertised (step 2); Claude Code already reads until it exits, so it needs only the ceiling from step 1.

### 4. A context window for endpoint models

Settings → Model backends gets an optional context window per model of an endpoint, filled in from the server when it says (vLLM's `/v1/models` reports `max_model_len`, llama.cpp's `meta.n_ctx`; other servers: unsure). Each open agent's adapter writes it where the table in [section 2](#2-endpoint-models-have-no-context-window) says, with a profile for a small context: OpenCode's pruning and tool output limits, Goose's tool response size and tool output summing, a step limit. Goose's persistent instructions are left out under 32,000 tokens, so they do not suit those models. For Cline, ask its makers to honour the compaction settings over ACP; until then a member whose context overflows starts a new session from Harness Relay's own record.

### 5. Plans

Claude Code's and Codex's plan tools are now off by their makers' choice, so turning them on costs context; whatever is chosen, correct the architecture's table and known limitations now.

- Claude Code: an opt-in per account: `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` with `CLAUDE_CODE_ENABLE_TASKS=0` reuses the `TodoWrite` mapping as it is; or keep the task tools and turn `TaskCreate` and `TaskUpdate` into the plan.
- Codex: the same opt-in, `tools.update_plan.enabled=true`.
- Cursor: take `cursor/update_todos` as the plan, and correct the architecture's table and the end-to-end fake (`e2e/fake-cli/agents/cursor.cjs`, with `e2e/README.md` and `e2e/README.zh-TW.md`) to what a live run shows.
- Pi: a to-do tool registered by the gate extension, which then loads in every run.

### 6. Questions

Where a CLI's question tool can be turned off, turn it off: `tools.experimental_request_user_input.enabled=false` for Codex (a guard, since by default it comes only in plan mode), `GROK_ASK_USER_QUESTION=0` for Grok, `AskUserQuestion` denied for Claude Code, `--no-ask-user` for Copilot. For Antigravity, whose briefing already steers it away from `ask_question`, find out what agy does with the refusal, and if its turn suffers, answer the form with a note that says to ask in the reply and end it with `[ASK_USER]`. Muse Code needs nothing.

### 7. Steering

A conversation setting, off by default: a message for a member that is speaking now goes into its running turn when its CLI steers ([section 5](#5-a-message-cannot-reach-a-running-turn)), and is marked as such in the chat; otherwise it waits in the queue as today.

### 8. Structured answers, budgets and cost

- The lead agent's design, review and grouping turns ask for their JSON shape when the lead runs on Claude Code or Codex with its maker's models, and parse as today otherwise.
- Optional caps per member: Claude Code's `--max-budget-usd` (not on an endpoint), Copilot's `--max-ai-credits` (soft, subagents from 1.0.112), Goose's `GOOSE_MAX_TURNS`, OpenCode's `steps`.
- Copilot's cost from its `assistant.usage` runtime events (or `--usage-output-file`, once a run shows it is written over ACP).
- Claude Code's Stop sends `interrupt` before `SIGTERM`.

### 9. Versions

Move these forward through the CLI check, for what the newer versions fix: Codex 0.170.0 (child threads keep the sandbox's `deny` entries), Cursor 2026.11.14 (stale whole-file rewrites refused), Goose 1.60.1 or later (compaction on Claude models), Antigravity 1.5.10 or later (subagents' later work reported, and stopped on close). At Copilot's next check, look again at whether `session/prompt` waits for background agents (1.0.115).

## Database

One migration, for step 4: the endpoint models' context windows, kept with their models in `model_backends`.

## Tests

- Each adapter's parser with recorded messages: subagents' calls given their parent, notices, Cursor's to-dos as the plan.
- The orchestrator with the fake runner: a steered message delivered into the running turn and marked; a turn kept until its background work ends, within the timeout.
- The adapters' arguments and settings: what step 1 pins and what step 4 writes, per permission.
- End-to-end: the fake CLIs get directives for subagents' events and steering; `e2e/README.md` and `e2e/README.zh-TW.md` list them.

## Alternatives considered

- **Claude Code's agent teams instead of Harness Relay's team.** Rejected: they are experimental, spawn no teammates in `-p`, and would be Claude Code only, while Harness Relay's teams mix CLIs.
- **The CLIs' workflows (`Workflow`, `/fleet`, `run_workflow`) instead of parallel mode.** Rejected: each stays inside one CLI, with none of parallel mode's worktrees, checks or apply. They are worth having inside one member's turn, governed (step 1) and shown (step 2).
- **Every subagent off.** The simplest and the safest; it is step 1's default for the CLIs Harness Relay cannot bound yet. As the only answer it loses parallel work inside a turn, which helps large tasks.
- **Turning on the approval judges** to cut the number of approval cards. Rejected: see [section 9](#9-off-and-should-stay-off).
- **Leaving Claude Code's and Codex's plan tools off, and only correcting the docs.** What their makers chose for today's models, and the cheapest; it costs the user the plan beside the reply. Step 5 makes it an opt-in, not a default.

## Open questions

- Should subagents' calls be folded under the call that started them, or shown in a panel of their own?
- In full access, should subagents and workflows be on by default, as the CLIs have them?
- Should Claude Code's and Codex's plan tools be offered at all, against their makers' default?
- Does steering suit every mode? In parallel mode the round is meant to see the same messages.
- Should the context window be asked of the server when the endpoint is saved, or only when the user asks?
- Which findings marked unsure should a live test settle first? Proposed: Grok's lost wake-up turns, Codex's subagents and the sandbox, Antigravity's browser subagent, Cursor's to-do list.
