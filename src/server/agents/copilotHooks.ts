import { resolve } from 'node:path';
import { PROVIDER_LABEL } from '../../shared/types';
import type { HookHandler } from '../gateway';
import { HOOK_WAIT, type HookResult, type TurnHooks } from '../hooks';
import { t } from '../i18n';
import { patchFilePaths } from '../patchFiles';
import { stripAnsi } from '../process';
import { realPath } from '../protect';
import { AgentRunError } from './types';

const COMMANDS = ['bash', 'powershell', 'write_bash', 'write_powershell'];
const EDITS = ['create', 'edit', 'str_replace_editor', 'apply_patch'];

function hookInput(args: unknown): unknown {
  if (typeof args !== 'string') return args;
  try {
    return JSON.parse(args);
  } catch {
    // Freeform tools such as apply_patch can supply plain text.
    return args;
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function copilotHookCall(payload: Record<string, unknown>, cwd: string): HookResult {
  const tool = payload.toolName;
  if (typeof tool !== 'string' || !tool) throw new Error('Copilot did not name the tool in its hook');
  const input = hookInput(payload.toolArgs);
  const args = record(input);
  const toolResult = record(payload.toolResult);
  const failed = typeof payload.error === 'string' || toolResult.resultType === 'failure';
  const output = payload.error ?? toolResult.textResultForLlm;
  const result = { tool, input, ...(typeof output === 'string' ? { output } : {}), ...(failed ? { failed } : {}) };
  if (COMMANDS.includes(tool)) {
    const command = typeof input === 'string' ? input : (args.command ?? args.input);
    return { ...result, kind: 'command', command: typeof command === 'string' ? command : undefined };
  }
  if (EDITS.includes(tool)) {
    const dir = typeof payload.cwd === 'string' ? resolve(cwd, payload.cwd) : cwd;
    const files = [args.path, args.fileName, args.file_path, args.filePath]
      .filter((path): path is string => typeof path === 'string' && Boolean(path))
      .map((path) => resolve(dir, path));
    if (tool === 'apply_patch') files.push(...patchFilePaths(typeof input === 'string' ? input : (args.patch ?? args.input), dir));
    return { ...result, kind: 'edit', files: [...new Set(files)] };
  }
  return { ...result, kind: 'other' };
}

function hookHandler(hooks: TurnHooks, cwd: string): HookHandler {
  return async (when, payload) => {
    const call = copilotHookCall(record(payload), cwd);
    if (when === 'before') {
      if (call.kind === 'command' && call.command === undefined) throw new Error('Copilot did not supply the shell command to its hook');
      const reason = await hooks.before(call);
      return reason ? { code: 0, stdout: JSON.stringify({ permissionDecision: 'deny', permissionDecisionReason: reason }) } : { code: 0 };
    }
    const said = await hooks.after(call);
    if (!said) return { code: 0 };
    return call.failed ? { code: 2, stdout: said } : { code: 0, stdout: JSON.stringify({ additionalContext: said }) };
  };
}

interface CopilotHookCommand {
  type: 'command';
  exec: string;
  args: string[];
  env: Record<string, string>;
  timeoutSec: number;
}

export interface CopilotTeamHooks {
  events: Record<string, CopilotHookCommand[]>;
  socketDir: string;
}

export function copilotTeamHooks(hooks: TurnHooks, cwd: string): CopilotTeamHooks {
  const program = hooks.program(hookHandler(hooks, cwd), 'inline');
  if (!program?.env || !program.socketDir) throw new AgentRunError(t().hooksNoProgram(PROVIDER_LABEL.copilot));
  const events: CopilotTeamHooks['events'] = {};
  for (const when of ['before', 'after'] as const) {
    if (!hooks.kinds(when).size) continue;
    const budget = hooks.budgetSec(when);
    const action: CopilotHookCommand = {
      type: 'command',
      exec: program.bin,
      args: [...program.args, when, String(budget + HOOK_WAIT.program)],
      env: program.env,
      timeoutSec: budget + HOOK_WAIT.cli,
    };
    if (when === 'before') events.preToolUse = [action];
    else {
      events.postToolUse = [action];
      events.postToolUseFailure = [action];
    }
  }
  return { events, socketDir: program.socketDir };
}

/** Copilot's local /env lists each loaded event and its source files. */
export function copilotHooksListed(text: string, file: string, events: readonly string[]): boolean {
  const section =
    stripAnsi(text)
      .split(/^\*\*Hooks\*\*[^\S\n]*$/m)[1]
      ?.split(/^\*\*.+\*\*[^\S\n]*$/m)[0] ?? '';
  const paths = new Set([file, realPath(file)]);
  return events.every((name) =>
    section.split('\n').some((line) => line.startsWith(`- ${name}: `) && [...line.matchAll(/`([^`]+)`/g)].some((m) => paths.has(m[1]!))),
  );
}
