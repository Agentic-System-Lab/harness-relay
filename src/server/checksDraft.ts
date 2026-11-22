import { CHECK_LIMITS, type CheckCommand, type CheckHook, type CheckList } from '../shared/types';
import type { OutputSchema } from './agents/types';
import { orNull, strictObject } from './planner';
import { validateChecks } from './validate';

/*
 * Team checks drafted by the lead agent at the user's request (the team checks editor's "Ask the lead
 * agent", `LeadDrafts.checks()`): the user says what the team must not break, and the lead returns the
 * whole list. For a conversation or a new chat it reads the project first, in its working directory,
 * read-only, so that the commands it proposes exist there; a template's list or Settings' default has
 * no project, and gets rules for the kind of project the user describes. The editor shows the list
 * until the user saves it: nothing runs here, and no command it proposes is run until the user tries
 * it or the team's checks do.
 */

export const CHECKS_BRIEFING =
  "You are the lead agent of Harness Relay, a task assistant in which coding-agent CLIs work together on the user's questions in a group chat. " +
  'Right now your only job is to write the team checks the way the user asks: the rules Harness Relay itself checks once the team has answered. ' +
  "Do not change any file, run any command or do the team's work. Reply with the JSON object you are asked for and nothing else.";

/** Where the list is for: a project's working directories (the first is where the lead runs), or none. */
export interface ChecksPlace {
  cwds: string[];
}

/** `defaults`: Settings' default list, copied into new chats and automations; `template`: a template's. */
export type ChecksVariant = 'team' | 'template' | 'defaults';

/** The list as the lead reads it: every rule, without the ids Harness Relay keeps for results. */
function listForLead(list: CheckList | undefined): Record<string, unknown> {
  const l = list ?? {};
  return {
    protectedPaths: l.protectedPaths ?? [],
    commitPattern: l.commitPattern ?? '',
    commands: (l.commands ?? []).map(({ id: _id, ...c }) => c),
    hooks: (l.hooks ?? []).map(({ id: _id, ...h }) => h),
    previewApp: Boolean(l.previewApp),
    autoFix: Boolean(l.autoFix),
  };
}

export function buildChecksPrompt(
  request: string,
  list: CheckList | undefined,
  place: ChecksPlace | undefined,
  variant: ChecksVariant,
  platform: NodeJS.Platform = process.platform,
): string {
  const where = place
    ? `The team works in ${
        place.cwds.length === 1 ? `the working directory ${place.cwds[0]}` : `the working directories ${place.cwds.join(', ')}`
      }, and you are running in ${place.cwds[0]}, read-only. Before you write any command, read what the project says about how it is built and checked: its package.json scripts, Makefile, CI workflows (such as .github/workflows), test and lint configurations, and its contributing guide. Propose only commands that exist in this project and run as they are.`
    : variant === 'defaults'
      ? "This is Harness Relay's default list in Settings: it is copied into every new chat and automation, whatever its project. You are running in an empty folder: there is no project to read. Write rules that suit every project of the kind the user describes."
      : 'This is the list of a team template: it is copied into each conversation that uses the template, whatever its project. You are running in an empty folder: there is no project to read. Write rules that suit the kind of project the user describes.';
  const windows = platform === 'win32';
  return `The user is editing the team checks and asks you to write them. ${where} Write the list the way the user asks. The user reviews it before saving it.

The list now:
<checks>
${JSON.stringify(listForLead(list), null, 2)}
</checks>

What the user asks for:
<request>
${request}
</request>

What each rule does (Harness Relay checks them itself once the team has answered, in runs that may write files, whichever coding agent each member runs on; it reports what failed to the team and never undoes anything):
- "protectedPaths": files the team may not change, as gitignore-like patterns in each working directory: * and ? within a name, ** across folders, a pattern without / matches a name at any depth, a trailing / a whole folder. Ignored files count too (.env, *.pem). At most ${CHECK_LIMITS.protectedPaths}, each at most ${CHECK_LIMITS.pattern} characters.
- "commitPattern": a JavaScript regular expression every commit subject the team makes must match ("" for none), such as ^(feat|fix|docs|refactor|test|chore)(\\(.+\\))?: .+ for Conventional Commits. At most ${CHECK_LIMITS.commitPattern} characters.
- "commands": commands that must succeed after a run that changed something, such as a test suite or a linter: "run" is a shell command line (sh -c), "cwd" a folder relative to the first working directory ("" for that directory), "timeoutMin" minutes before it is stopped (1-${CHECK_LIMITS.maxTimeoutMin}, ${CHECK_LIMITS.timeoutMin} by default). Below full access they run in Harness Relay's own sandbox, with no network: never a command that needs the network, such as installing packages or downloading anything. "localPorts" (macOS) lets one listen on and connect to local ports, which a test with a server of its own needs; "unixSockets" (Linux) lets one open Unix sockets; both off unless the command needs them. At most ${CHECK_LIMITS.commands}, each at most ${CHECK_LIMITS.command} characters.${windows ? ' Commands do not run on Windows yet, and Harness Relay runs on Windows here: propose none unless the user asks for them.' : ''}
- "hooks": commands run around the members' own tool calls, as they happen: "when" is "before" (a non-zero exit refuses the call, its output the reason the agent gets) or "after" (a non-zero exit sends its output back to the agent); "tools" is "command" (shell commands), "edit" (file changes) or "any"; the call is in the environment (RELAY_HOOK_TOOL, RELAY_HOOK_COMMAND, RELAY_HOOK_FILES); "timeoutSec" 1-${CHECK_LIMITS.maxHookTimeoutSec}, ${CHECK_LIMITS.hookTimeoutSec} by default. At most ${CHECK_LIMITS.hooks}.${windows ? ' Hooks do not run on Windows yet either.' : ''}
- "previewApp": the app the team builds must open in Harness Relay's app preview.
- "autoFix": a result that did not pass goes back to the team by itself, to be fixed (at most ${CHECK_LIMITS.autoFixes} times in a row).

How to write the list:
- Return the whole list. Change only what the user asks for, and keep every other rule exactly as it is.
- Add a commit pattern only when the user asks for one or the project states its convention (a commitlint configuration, its contributing guide); hooks only when the user asks for them.
- Never protect a file the team must change to do its work; protect what it must not touch (secrets, lockfiles it should not rewrite, generated files, CI configuration) only when the user asks for that.
- When the request cannot be done with these rules, return the list as it is and say why in the reason.${
    variant === 'defaults' ? '\n- Leave "hooks" empty: the default hooks are set apart from this list.' : ''
  }

Write the reason in the language of the user's request. Read files only; do not change anything.

Reply with only this JSON object, in a \`\`\`json code block, with the whole list:
{"protectedPaths": ["<pattern>"], "commitPattern": "<regular expression, or empty>", "commands": [{"run": "<command line>", "cwd": "<folder, or empty>", "timeoutMin": <minutes, or null>, "localPorts": <true|false>, "unixSockets": <true|false>}], "hooks": [{"when": "before" | "after", "tools": "command" | "edit" | "any", "run": "<command line>", "cwd": "<folder, or empty>", "timeoutSec": <seconds, or null>}], "previewApp": <true|false>, "autoFix": <true|false>, "reason": "<what you wrote or changed and why: one or two sentences for the user>"}`;
}

/** The drafted list (`buildChecksPrompt()`, `decideChecks()`). */
export const CHECKS_SCHEMA: OutputSchema = strictObject({
  protectedPaths: { type: 'array', items: { type: 'string' } },
  commitPattern: { type: 'string', description: '"" for none' },
  commands: {
    type: 'array',
    items: strictObject({
      run: { type: 'string' },
      cwd: { type: 'string', description: '"" for the first working directory' },
      timeoutMin: orNull('integer', 'null for the default'),
      localPorts: { type: 'boolean' },
      unixSockets: { type: 'boolean' },
    }),
  },
  hooks: {
    type: 'array',
    items: strictObject({
      when: { type: 'string', enum: ['before', 'after'] },
      tools: { type: 'string', enum: ['command', 'edit', 'any'] },
      run: { type: 'string' },
      cwd: { type: 'string', description: '"" for the first working directory' },
      timeoutSec: orNull('integer', 'null for the default'),
    }),
  },
  previewApp: { type: 'boolean' },
  autoFix: { type: 'boolean' },
  reason: { type: 'string' },
});

/** What a list's rule is, apart from its id: a command or hook the lead kept keeps its id (and its results). */
const commandKey = (c: Pick<CheckCommand, 'run' | 'cwd'>) => `${c.run.trim()}\u0000${c.cwd ?? ''}`;
const hookKey = (h: Pick<CheckHook, 'when' | 'tools' | 'run' | 'cwd'>) =>
  `${h.when}\u0000${h.tools}\u0000${h.run.trim()}\u0000${h.cwd ?? ''}`;

/**
 * Turn the lead's list into one the editor can show, checked as a saved one is (`validateChecks()`): a
 * rule that cannot be used is left out (`dropped` counts them) rather than lose the others; a command
 * or hook the list had keeps its id. A field the lead left out keeps what the list had.
 */
export function decideChecks(
  raw: Record<string, any>,
  before: CheckList | undefined,
  /** Settings' default list: its hooks are set apart (the tool library's Hooks), so the list's stay as they are. */
  keepHooks = false,
): { checks: CheckList; reason: string; dropped: number } {
  const reason = String(raw.reason ?? '')
    .trim()
    .slice(0, 800);
  const prev = before ?? {};
  let dropped = 0;
  // Each rule on its own first, so that one the lead got wrong does not cost the others.
  const usable = <T>(items: unknown, key: 'protectedPaths' | 'commands' | 'hooks', max: number): T[] | undefined => {
    if (!Array.isArray(items)) return undefined;
    const out: T[] = [];
    for (const item of items.slice(0, max)) {
      try {
        const one = validateChecks({ [key]: [item] })[key] as T[] | undefined;
        if (one?.length) out.push(one[0]!);
      } catch {
        dropped++;
      }
    }
    dropped += Math.max(0, items.length - max);
    return out;
  };
  const paths = usable<string>(raw.protectedPaths, 'protectedPaths', CHECK_LIMITS.protectedPaths);
  const commands = usable<CheckCommand>(
    Array.isArray(raw.commands)
      ? raw.commands.map((c: Record<string, unknown>) => withoutDefaults(c, ['timeoutMin', 'cwd']))
      : raw.commands,
    'commands',
    CHECK_LIMITS.commands,
  );
  const hooks = keepHooks
    ? undefined
    : usable<CheckHook>(
        Array.isArray(raw.hooks) ? raw.hooks.map((h: Record<string, unknown>) => withoutDefaults(h, ['timeoutSec', 'cwd'])) : raw.hooks,
        'hooks',
        CHECK_LIMITS.hooks,
      );
  let commitPattern = prev.commitPattern ?? '';
  if (typeof raw.commitPattern === 'string') {
    try {
      commitPattern = validateChecks({ commitPattern: raw.commitPattern }).commitPattern ?? '';
    } catch {
      dropped++;
    }
  }
  const prevCommands = new Map((prev.commands ?? []).map((c) => [commandKey(c), c.id]));
  const prevHooks = new Map((prev.hooks ?? []).map((h) => [hookKey(h), h.id]));
  const list = validateChecks({
    protectedPaths: paths ?? prev.protectedPaths ?? [],
    commitPattern,
    commands: (commands ?? prev.commands ?? []).map((c) => ({ ...c, id: prevCommands.get(commandKey(c)) ?? c.id })),
    hooks: (hooks ?? prev.hooks ?? []).map((h) => ({ ...h, id: prevHooks.get(hookKey(h)) ?? h.id })),
    previewApp: typeof raw.previewApp === 'boolean' ? raw.previewApp : Boolean(prev.previewApp),
    autoFix: typeof raw.autoFix === 'boolean' ? raw.autoFix : Boolean(prev.autoFix),
  });
  return { checks: list, reason, dropped };
}

/** A command or hook as `validateChecks()` takes it: an empty folder, and no time limit, mean the default. */
function withoutDefaults(item: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  if (!item || typeof item !== 'object') return item;
  const out = { ...item };
  for (const k of keys) if (out[k] === '' || out[k] === null || out[k] === undefined) delete out[k];
  return out;
}
