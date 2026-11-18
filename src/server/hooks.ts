import { basename } from 'node:path';
import { hookApplies } from '../shared/checks';
import { CHECK_LIMITS, CHECK_RESULT_LIMITS, type CheckHook, type CheckOutcome, type HookTools, type Provider } from '../shared/types';
import { defaultCheckCommandDeps, keptOutput, runCheckCommand, type CheckCommandDeps, type CheckCommandPlace } from './checkCommands';
import type { HookHandler, HookProgram } from './gateway';
import { t } from './i18n';

/*
 * The team's hooks (`CheckList.hooks`): commands Harness Relay runs around a member's own tool calls,
 * as they happen, whichever CLI the member runs on. Each adapter has its CLI ask before and after its
 * calls in the CLI's own way (Claude Code's hook callbacks over its control protocol…) and hands the
 * call over as a `HookCall`; this module runs the hooks that apply, as a check's commands run (below
 * full access in Harness Relay's own sandbox, `runCheckCommand()`), and says what the CLI is to do.
 *
 * A `before` hook refuses the call unless it exits 0: a non-zero exit, its time limit, a sandbox that
 * cannot start, the turn stopped, all refuse it (it fails closed), with its output as the reason the
 * agent gets. An `after` hook that does not exit 0 sends its output to the agent, which goes on with
 * it: the call has run. Each refusal and failure is also noted in the reply, for the user.
 */

/** A member's tool call, as the hooks see it, whichever CLI made it. */
export interface HookCall {
  /** What it does: runs a command, changes files with the CLI's own tool, or anything else. */
  kind: 'command' | 'edit' | 'other';
  /** The CLI's own name for the tool (`Bash`, `Edit`, `write`). */
  tool: string;
  /** command: the command line. */
  command?: string;
  /** edit: the files it changes, as full paths. */
  files?: string[];
  /** Its arguments as the CLI gave them. */
  input?: unknown;
}

/** A call that has run, for the `after` hooks. */
export interface HookResult extends HookCall {
  /** What it returned, as text. */
  output?: string;
  /** It failed (or was refused). */
  failed?: boolean;
}

/** The team's hooks for one turn, as its adapter gets them (`RunOptions.hooks`). */
export interface TurnHooks {
  /** Which calls a `before` (or `after`) hook runs around: its kinds (`any`: every call); empty when none does. */
  kinds(when: CheckHook['when']): Set<HookTools>;
  /** The longest a call may wait for its `before` (or `after`) hooks: all their time limits, one after another, in seconds. */
  budgetSec(when: CheckHook['when']): number;
  /** Before a call: why it is refused (the reason the agent gets), or undefined to let it go on as it would. */
  before(call: HookCall): Promise<string | undefined>;
  /** After a call: what to tell the agent (an `after` hook that did not pass), or undefined. */
  after(call: HookResult): Promise<string | undefined>;
  /**
   * For a CLI whose hooks are commands: the program it runs as one (`hookShim.ts`), which passes each
   * call to `handle` over Harness Relay's gateway, good until the turn is over. Undefined when it
   * cannot be given now (the gateway is not listening, or there is no Node.js to start it with).
   */
  program(handle: HookHandler): HookProgram | undefined;
  /** The turn is over: its programs' grants end. */
  dispose(): void;
  /** Adds a note to the reply, for the user (the hooks could not be given to the CLI). */
  note(text: string): void;
}

/** The longest value of the call's arguments in `RELAY_HOOK_INPUT` (a file's whole content is cut), and of all of it. */
export const HOOK_INPUT_LIMITS = { value: 2000, total: 16_000 };

/** The most notes about hooks one reply gets: the rest are counted in a last one. */
export const HOOK_NOTICES = 10;

/** The call's arguments as `RELAY_HOOK_INPUT` has them: JSON, each string cut, the whole within its limit. */
export function hookInput(input: unknown): string {
  const cut = (v: unknown, depth: number): unknown => {
    if (typeof v === 'string') return v.length > HOOK_INPUT_LIMITS.value ? `${v.slice(0, HOOK_INPUT_LIMITS.value)}…` : v;
    if (depth > 6 || v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.slice(0, 50).map((x) => cut(x, depth + 1));
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .slice(0, 50)
        .map(([k, x]) => [k, cut(x, depth + 1)]),
    );
  };
  let json: string;
  try {
    json = JSON.stringify(cut(input ?? {}, 0)) ?? '{}';
  } catch {
    json = '{}';
  }
  return json.length > HOOK_INPUT_LIMITS.total ? json.slice(0, HOOK_INPUT_LIMITS.total) : json;
}

/**
 * The variables a hook gets, over a check command's own (`checkEnv()`): when it runs, the call's kind,
 * the CLI's name for its tool, its command line, the files it changes (a full path a line), its
 * arguments as JSON (`hookInput()`), the member and its CLI; after the call, what it returned and
 * whether it failed. A value never goes into the command line itself: the hook reads it.
 */
export function hookEnv(when: CheckHook['when'], call: HookCall | HookResult, agent: string, provider: Provider): Record<string, string> {
  const r = call as HookResult;
  return {
    RELAY_HOOK_WHEN: when,
    RELAY_HOOK_KIND: call.kind,
    RELAY_HOOK_TOOL: call.tool,
    RELAY_HOOK_COMMAND: call.command ?? '',
    RELAY_HOOK_FILES: (call.files ?? []).join('\n'),
    RELAY_HOOK_INPUT: hookInput(call.input),
    RELAY_HOOK_AGENT: agent,
    RELAY_HOOK_CLI: provider,
    ...(when === 'after' ? { RELAY_HOOK_OUTPUT: keptOutput(r.output ?? ''), RELAY_HOOK_FAILED: r.failed ? '1' : '0' } : {}),
  };
}

/** A call in a few words, for the user's note: its command, the files it changes, or its tool. */
export function callLabel(call: HookCall): string {
  if (call.command) {
    const line = call.command.replace(/\s+/g, ' ').trim();
    return `\`${line.length > 120 ? `${line.slice(0, 120)}…` : line}\``;
  }
  if (call.files?.length) {
    const names = call.files.slice(0, 3).map((f) => basename(f));
    return names.join(', ') + (call.files.length > 3 ? ` (+${call.files.length - 3})` : '');
  }
  return call.tool;
}

/** What a hook's run said, for the agent: its output, else why it could not run, else how it ended. */
function hookSaid(o: CheckOutcome): string {
  const out = o.output?.trim();
  if (out) return keptOutput(out, CHECK_RESULT_LIMITS.promptOutput);
  if (o.reason) return o.reason;
  return o.exitCode === null || o.exitCode === undefined ? 'stopped' : `exit ${o.exitCode}`;
}

/** The first line of what a hook said, for the user's note. */
function firstLine(text: string): string {
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && l !== '…');
  if (!line) return t().hookNoOutput;
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

export interface TurnHooksOptions {
  /** Where they run and what they may not reach: the turn's working directories (its worktrees in parallel mode), its permission. */
  place: Omit<CheckCommandPlace, 'env' | 'timeoutMs'>;
  /** The member, as named, and its CLI, which each hook is told. */
  agent: string;
  provider: Provider;
  /** Adds a note to the reply, for the user. */
  notice: (text: string) => void;
  /** A hook program's grant from the gateway (`ToolGateway.hookProgram()`), when it has one. */
  program?: (handle: HookHandler) => { program: HookProgram; revoke: () => void } | undefined;
  deps?: CheckCommandDeps;
}

/** The turn's hooks, or undefined when the list has none. */
export function turnHooks(hooks: readonly CheckHook[] | undefined, o: TurnHooksOptions): TurnHooks | undefined {
  if (!hooks?.length) return undefined;
  const deps = o.deps ?? defaultCheckCommandDeps;
  let notes = 0;
  const notice = (text: string) => {
    notes++;
    if (notes <= HOOK_NOTICES) o.notice(text);
    else if (notes === HOOK_NOTICES + 1) o.notice(t().hookMoreNotices);
  };
  const run = (hook: CheckHook, call: HookCall | HookResult) =>
    runCheckCommand(
      { id: hook.id, run: hook.run, ...(hook.cwd ? { cwd: hook.cwd } : {}) },
      {
        ...o.place,
        env: hookEnv(hook.when, call, o.agent, o.provider),
        timeoutMs: (hook.timeoutSec ?? CHECK_LIMITS.hookTimeoutSec) * 1000,
      },
      deps,
    );
  const applying = (when: CheckHook['when'], kind: HookCall['kind']) => hooks.filter((h) => h.when === when && hookApplies(h, kind));
  const revokes: (() => void)[] = [];
  let over = false;
  return {
    program(handle) {
      if (over) return undefined;
      const grant = o.program?.(handle);
      if (!grant) return undefined;
      revokes.push(grant.revoke);
      return grant.program;
    },
    dispose() {
      over = true;
      for (const revoke of revokes.splice(0)) revoke();
    },
    note: (text) => o.notice(text),
    kinds: (when) => new Set(hooks.filter((h) => h.when === when).map((h) => h.tools)),
    budgetSec: (when) => hooks.filter((h) => h.when === when).reduce((n, h) => n + (h.timeoutSec ?? CHECK_LIMITS.hookTimeoutSec), 0),
    async before(call) {
      // In the list's order; the first that does not pass refuses the call, and the rest are not run.
      for (const hook of applying('before', call.kind)) {
        const outcome = await run(hook, call);
        if (outcome.status === 'passed') continue;
        const said = hookSaid(outcome);
        notice(t().hookRefused(hook.run, callLabel(call), firstLine(said)));
        return `Refused by the team's hook \`${hook.run}\`, which Harness Relay runs before this kind of call:\n${said}`;
      }
      return undefined;
    },
    async after(call) {
      const told: string[] = [];
      for (const hook of applying('after', call.kind)) {
        const outcome = await run(hook, call);
        if (outcome.status === 'passed') continue;
        const said = hookSaid(outcome);
        notice(t().hookFailed(hook.run, callLabel(call), firstLine(said)));
        told.push(`The team's hook \`${hook.run}\` ran after this call and did not pass:\n${said}`);
      }
      return told.length ? told.join('\n\n') : undefined;
    },
  };
}

/** A program and its arguments as one shell command line, each word quoted: what a CLI runs as its hook command. */
export function shellWords(words: readonly string[]): string {
  return words.map((w) => `'${w.replace(/'/g, `'\\''`)}'`).join(' ');
}

/**
 * The answer to a hook program of a CLI whose hooks take Claude Code's answers (Muse Code, Codex): the
 * call from what the CLI gave the hook (`toCall`), then before it a refusal as `permissionDecision:
 * deny` with its reason (nothing to let it go on as it would), and after it what the hooks said, as
 * the CLI takes it (`afterReply`). It prints its answers and exits 0: a hook that fails otherwise may
 * let the call go on (`hookShim.ts` refuses on its own when it gets no answer).
 */
export function commandHookHandler(
  hooks: TurnHooks,
  toCall: (payload: Record<string, any>) => HookResult,
  afterReply: (said: string, call: HookResult) => Record<string, unknown>,
): HookHandler {
  return async (when, payload) => {
    const call = toCall(payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, any>) : {});
    if (when === 'before') {
      const said = await hooks.before(call);
      if (!said) return { code: 0 };
      return {
        code: 0,
        stdout: JSON.stringify({
          hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: said },
        }),
      };
    }
    const said = await hooks.after(call);
    return said ? { code: 0, stdout: JSON.stringify(afterReply(said, call)) } : { code: 0 };
  };
}
