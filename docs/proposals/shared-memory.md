**English** | [繁體中文](shared-memory.zh-TW.md)

# Shared memory across agents

> **Status: proposal, not implemented.** See [Proposals](README.md).

Let what one agent learns reach the other agents and later conversations, with the user deciding what is kept.

## What exists today

Harness Relay agents remember things in three layers:

1. **The conversation.** Each agent resumes its own CLI session every turn (`agent_sessions`), so it remembers what it saw in this chat. Retrying or editing a message starts every agent afresh with the remaining history.
2. **The tool library's memory.** Text the user writes in Settings: one part for every agent (`all`) and one per CLI (`MemoryScope` in `src/shared/types.ts`). It goes into each agent's briefing on every turn (`toolSections()` in `src/server/prompt.ts`), in every conversation. Agents cannot change it.
3. **What each CLI remembers by itself**, because it runs in the working directory:

   | CLI | Instructions (written by people) | Notes the CLI writes itself |
   | --- | --- | --- |
   | Claude Code | `CLAUDE.md`, `CLAUDE.local.md`, `.claude/rules/`, in its config folder and up from the folder | auto memory, `~/.claude/projects/<folder>/memory/`; on by default |
   | Codex | `AGENTS.override.md` or `AGENTS.md`, in `CODEX_HOME` and from the repository root down | memories, `~/.codex/memories/`; off by default (`codex features list`) |
   | Grok | `AGENTS.md` (and `CLAUDE.md`), only in a trusted folder | cross-session memory, `~/.grok/memory-v2/`; experimental, off by default (`[memory] enabled`) |

   Each CLI's card in Settings lists its instruction and memory files (`src/server/native.ts`), except Grok's memory notes: `grok inspect` reports only instruction files.

## What is missing

- An agent cannot add to what the other agents get. What Claude Code saves in its auto memory, Codex and Grok never see; the library's memory changes only when the user edits it.
- The library's memory is global: a note about one repository goes into the briefing of every conversation in every folder.
- A conversation's conclusions reach the next conversation only if the user copies them.
- Grok's memory notes are not listed in its card.

## Goals

- Agents can **suggest** memory; the user decides. Memory goes into every agent's briefing in every conversation, so it carries the weight of the user's own instructions. Nothing an agent writes — or a web page, issue or webhook event it read — may get there without the user's yes.
- Memory per project.
- The same for all three CLIs.
- The briefing stays small, and nothing is cut silently.
- Harness Relay never writes into the CLIs' own memory folders.

## Design

### 1. Memory suggestions

The briefing tells agents: when you learn something lasting that teammates or later conversations should know — a convention, a decision, where something lives, a command that works — put it at the end of your reply:

```text
<remember scope="project">
Run `npm run build` before `npm test`: the tests read dist/web.
</remember>
```

`scope` is `project` (the default), `all`, or the agent's own CLI.

- The parser lives in `src/shared/remember.ts`, pure and shared, like `src/shared/ask.ts`: the UI hides the blocks while a reply streams, and blocks inside code are not read (the same Markdown-prose rule as `@mentions`).
- When the turn ends, the server takes the blocks out of the reply text and adds a `memory` part to the message: `{ text, scope, state: 'pending' }`, stored as JSON like approval parts. At most 3 per reply, 500 characters each; the rest are dropped with a note in the part.
- The UI shows a card under the reply: *@Builder suggests remembering … for this project*, with **Save**, **Edit** and **Dismiss**. Saving appends the text to the chosen memory part as its own line, and marks the part `saved`. Other agents get it in their briefing from the next turn on.
- Because the block is removed from the text, it is not forwarded to teammates as chat.

### 2. Project memory

A new memory part per project, keyed by the **project root**: the git repository root of the conversation's working directory, else the directory's real path (the rule Grok uses for trust; `gitRoot()` already exists in `src/server/native.ts`). Parallel-mode worktrees count as their conversation's project.

- The briefing's `# Memory` section gives the parts in this order: for everyone, for this project, for this CLI.
- An agent can turn it off like the other parts: the exception key `memory:project` in `AgentConfig.tools`.
- Stored in a new table `project_memory` (`root` primary key, `text`, `updated_at`), not in the `tool_library` JSON, because the number of projects grows.
- Settings → Tools → Memory gets a project list: the projects that have memory, plus the default working directory. A conversation's header links to its project's memory.

### 3. Size

The memory is sent with the briefing on every turn. Settings shows how large the memory each CLI's agents would get is (everyone + project + CLI) and warns above 8 KB. The memory is never cut to fit; the warning asks the user to trim it.

### 4. Bringing in what the CLIs remember

- Each memory file listed in a CLI's card gets **Copy to memory**: it opens the file, the user picks what to keep, and it is appended to the `all` or the project part. Harness Relay only reads the CLIs' memory folders. Their formats belong to the CLIs: Claude Code keeps a `MEMORY.md` index, and Grok keeps a SQLite database and a search index next to its notes.
- Grok's card lists its global memory topics (`~/.grok/memory-v2/global/topics/*.md`). Workspace topics live in folders named `<project>-<hash>`, and the hash is not documented, so they are listed only once `grok inspect` reports them or the rule is documented.

### 5. Carrying a conversation forward

A **Suggest memory** action on a conversation asks the lead agent (the setting used by the auto team) for the lasting facts of the conversation in the `<remember>` format. They appear as suggestions, as in step 1. This also serves [triggers](triggers.md) that start a new conversation on every fire.

## HTTP API

| Method and path | Purpose |
| --- | --- |
| `POST /api/conversations/:id/messages/:messageId/memory/:index` | `{ action: 'save' \| 'dismiss', text?, scope? }`: answer a suggestion |
| `GET /api/tools/memory/projects` | the projects with memory, with size |
| `PUT /api/tools/memory/projects` | `{ root, text }`: set a project's memory (empty text deletes it) |
| `POST /api/conversations/:id/suggest-memory` | ask the lead agent for suggestions |

## Database

One migration: the table `project_memory`. Suggestions are message parts (kind `memory`) with their data as JSON in `message_parts.data`, so they need no table of their own.

## Tests

- `src/shared/remember.ts`: blocks found and removed, scopes, blocks in code ignored, limits, a block cut off by a stopped reply.
- The orchestrator with the fake runner: a reply with a block gets a `memory` part and loses the block from its text; teammates do not receive it as chat; a saved suggestion is in every agent's next briefing.
- The tool library: project memory by root, the briefing order, the `memory:project` exception, the size warning.
- The HTTP API with `app.request()`: save, edit while saving, dismiss, a second answer refused, project memory set and deleted.
- `test/native.test.ts`: Grok's global topics listed.

## Steps

1. Memory suggestions into the existing `all` and per-CLI parts.
2. Project memory.
3. Copy from the CLIs' memory files, and Grok's topics in its card.
4. Suggest memory for a whole conversation.

## Alternatives considered

- **A `remember` MCP tool served by Harness Relay.** Deferred: it needs a server process each CLI starts and a way for it to reach the app; Claude Code asks before every MCP tool call below full access, so in a conversation that refuses automatically it could not be used; and the call returns before the user decides. A text block works the same with all three CLIs and is pure to test, like `[ASK_USER]`. A tool could be added later on top of the same suggestions.
- **Save without asking.** Rejected as the default: memory steers every later conversation, and an agent can be led by what it reads. It could become a per-scope setting (open question).
- **Write into each CLI's own memory.** Rejected: three formats and indexes owned by other programs, which change between versions; and it would still not share anything between the CLIs.
- **One file in the repository (`AGENTS.md`) as the shared memory.** Not instead, but alongside: Codex and Grok read `AGENTS.md`, Claude Code reads `CLAUDE.md`, and a team can commit them. Agents can already edit them when asked. Project memory is for what should not be committed, or should hold for folders that are not repositories.

## Open questions

- Should a scope be allowed to save suggestions without asking (for example per CLI, or for a trusted project)?
- Should a saved line remember where it came from (conversation, agent, date), shown in Settings and left out of the briefing?
- What happens to project memory when a repository moves? Settings could list projects whose folder no longer exists, so they can be moved or deleted.
