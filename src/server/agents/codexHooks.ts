import { userInfo } from 'node:os';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { PROVIDER_LABEL } from '../../shared/types';
import { HOOK_WAIT, commandHookHandler, shellWords, type HookResult, type TurnHooks } from '../hooks';
import { t } from '../i18n';
import { AgentRunError } from './types';

const EVENTS = [
  { name: 'PreToolUse', eventName: 'preToolUse', when: 'before' },
  { name: 'PostToolUse', eventName: 'postToolUse', when: 'after' },
] as const;

/** Read the file headers of a patch that Codex parses with StreamingPatchParser. */
function codexPatchFiles(patch: unknown, cwd: string): string[] {
  if (typeof patch !== 'string') return [];
  const files = new Set<string>();
  const moveMarker = '*** Move to: ';
  let inUpdate = false;
  let canMove = false;
  for (const raw of patch.split('\n')) {
    // Inside Update File, leading spaces mark context lines. Elsewhere Codex trims the header
    // before reading its marker. Neither case trims the path following the marker.
    const endTrimmed = raw.replace(/\p{White_Space}+$/u, '');
    const line = inUpdate ? endTrimmed : endTrimmed.replace(/^\p{White_Space}+/u, '');
    const header = /^\*\*\* (Add|Delete|Update) File: (.+)$/su.exec(line);
    if (line === '*** End Patch') break;
    if (header) {
      files.add(resolve(cwd, header[2]!));
      inUpdate = header[1] === 'Update';
      canMove = inUpdate;
      continue;
    }
    if (canMove && line.startsWith(moveMarker)) files.add(resolve(cwd, line.slice(moveMarker.length)));
    if (line !== '*** End of File') canMove = false;
  }
  return [...files];
}

export function codexHookCall(payload: Record<string, any>, cwd: string): HookResult {
  const tool = payload.tool_name;
  if (typeof tool !== 'string' || !tool) throw new Error('Missing tool_name in the Codex hook');
  const input = payload.tool_input;
  const response = payload.tool_response;
  const output = typeof response === 'string' ? response : JSON.stringify(response);
  const failed =
    response?.isError === true || response?.success === false || (typeof response?.exit_code === 'number' && response.exit_code !== 0);
  const result = { tool, input, ...(output !== undefined ? { output } : {}), ...(failed ? { failed } : {}) };
  if (tool === 'Bash') return { ...result, kind: 'command', command: typeof input?.command === 'string' ? input.command : undefined };
  if (tool === 'apply_patch') {
    const dir = typeof payload.cwd === 'string' ? resolve(cwd, payload.cwd) : cwd;
    return { ...result, kind: 'edit', files: codexPatchFiles(input?.command, dir) };
  }
  return { ...result, kind: 'other' };
}

export function codexTeamHooks(hooks: TurnHooks, cwd: string, deniedPaths?: readonly string[], fallbackShell = '') {
  let shell = fallbackShell;
  try {
    shell = userInfo().shell ?? fallbackShell;
  } catch {
    // Accounts without a passwd entry fall back to the process environment or Codex's default.
  }
  if (/^(?:powershell|pwsh)(?:\.exe)?$/.test(basename(shell))) throw new AgentRunError(t().codexHookShell);

  const handle = commandHookHandler(
    hooks,
    (payload, when) => {
      if (when === 'before' && ['Bash', 'apply_patch'].includes(payload.tool_name) && typeof payload.tool_input?.command !== 'string') {
        throw new Error('Missing command in the Codex hook');
      }
      return codexHookCall(payload, cwd);
    },
    (said) => ({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: said } }),
  );
  const program = hooks.program(handle);
  if (!program) throw new AgentRunError(t().hooksNoProgram(PROVIDER_LABEL.codex));
  if (deniedPaths) {
    // The out-of-sandbox program is invoked with its script, socket and token file in that order.
    // A sandboxed command must not be able to change the script or read the token.
    const protectedFile = (file: string | undefined) =>
      !!file &&
      deniedPaths.some((dir) => {
        const rel = relative(dir, file);
        return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep);
      });
    if (!protectedFile(program.args[0]) || !protectedFile(program.args[2])) {
      throw new AgentRunError(t().codexHooksUnprotected);
    }
  }
  const definitions = EVENTS.flatMap(({ name, eventName, when }) => {
    const kinds = hooks.kinds(when);
    if (!kinds.size) return [];
    const names = [...(kinds.has('command') ? ['Bash'] : []), ...(kinds.has('edit') ? ['apply_patch'] : [])];
    const matcher = kinds.has('any') ? null : `^(?:${names.join('|')})$`;
    const budget = hooks.budgetSec(when);
    const command = shellWords([program.bin, ...program.args, when, String(budget + HOOK_WAIT.program)]);
    const timeoutSec = budget + HOOK_WAIT.cli;
    return [{ name, eventName, matcher, command, timeoutSec }];
  });
  const config = Object.fromEntries(
    definitions.map(({ name, matcher, command, timeoutSec }) => [
      `hooks.${name}`,
      [{ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command, timeout: timeoutSec }] }],
    ]),
  );
  return { config, definitions };
}

type HookEntry = Record<string, unknown>;
type HookList = { data: { hooks: HookEntry[] }[] };
type HookBinding = { key: string; hash: string; definition: ReturnType<typeof codexTeamHooks>['definitions'][number] };

export async function codexListTeamHooks(
  conn: { request(method: string, params?: unknown): Promise<unknown> },
  params: { cwds: string[] } | { threadId: string },
): Promise<HookList> {
  try {
    const result = (await conn.request('hooks/list', params)) as HookList | undefined;
    if (result?.data?.length && Array.isArray(result.data) && result.data.every((group) => Array.isArray(group?.hooks))) return result;
  } catch {
    // An older CLI can ignore the config keys. With team hooks installed, it must confirm them.
  }
  throw new AgentRunError(t().codexHooksUnchecked);
}

/** Match only the definitions passed by this invocation. Codex supplies the current hash for each. */
export function codexBindTeamHooks(
  list: HookList,
  definitions: ReturnType<typeof codexTeamHooks>['definitions'],
  leaveNativeOut: boolean,
): { bindings: HookBinding[]; state: Record<string, Record<string, unknown>> } {
  const hooks = list.data.flatMap((group) => group.hooks);
  const bindings = definitions.map((definition) => {
    const matches = hooks.filter((hook) => matchesDefinition(hook, definition));
    const hook = matches[0];
    if (matches.length !== 1 || typeof hook?.key !== 'string' || typeof hook.currentHash !== 'string' || !hook.currentHash) {
      throw new AgentRunError(t().codexHooksUnchecked);
    }
    return { key: hook.key, hash: hook.currentHash, definition };
  });
  const state = Object.fromEntries(
    leaveNativeOut ? hooks.filter((h) => typeof h.key === 'string').map((h) => [h.key, { enabled: false }]) : [],
  );
  return {
    bindings,
    state: { ...state, ...Object.fromEntries(bindings.map(({ key, hash }) => [key, { enabled: true, trusted_hash: hash }])) },
  };
}

function matchesDefinition(hook: HookEntry, d: HookBinding['definition']): boolean {
  return (
    hook.source === 'sessionFlags' &&
    hook.handlerType === 'command' &&
    hook.eventName === d.eventName &&
    hook.command === d.command &&
    hook.matcher === d.matcher &&
    hook.timeoutSec === d.timeoutSec &&
    hook.async === false
  );
}

export function codexVerifyTeamHooks(list: HookList, bindings: HookBinding[]): Set<string> {
  const hooks = list.data.flatMap((group) => group.hooks);
  for (const { key, hash, definition } of bindings) {
    const matches = hooks.filter((hook) => hook.key === key);
    const hook = matches[0];
    if (
      matches.length !== 1 ||
      !hook ||
      hook.enabled !== true ||
      hook.trustStatus !== 'trusted' ||
      hook.currentHash !== hash ||
      !matchesDefinition(hook, definition)
    ) {
      throw new AgentRunError(t().codexHooksUnchecked);
    }
  }
  return new Set(bindings.map(({ key }) => key));
}
