import type { AllowRule, ApprovalKind } from '../shared/types';
import { approvalKey, parseCommandLine, unwrapShell } from './commands';

/*
 * "Always allow in this conversation": an answer is remembered as rule keys, and later
 * requests whose keys are all allowed are approved without asking.
 *
 * - command: one key per command the line runs (`npm test && git push` → "npm test", "git push";
 *   also commands in `$( )`, backticks and `sh -c '…'`), so allowing `npm test` never lets a chained
 *   or embedded `rm …` through. `sudo` stays in the key; a command whose program is computed when it
 *   runs, or `git -c …`, is keyed by its full text;
 * - edit: all file edits ("*");
 * - fetch: the host name;
 * - other: the tool's name.
 */

export { unwrapShell };

/** Programs whose second word is a subcommand (`git push`, `npm install`), not an argument. */
const WITH_SUBCOMMANDS = new Set(
  (
    'npm pnpm yarn bun npx pnpx deno git gh cargo rustup go docker podman kubectl helm terraform pip pip3 uv poetry ' +
    'pdm hatch conda brew apt apt-get dnf yum dotnet mvn gradle bundle rails composer mix swift flutter dart nx turbo ' +
    'aws az gcloud firebase vercel'
  ).split(' '),
);

/** The first version's keys: whitespace-separated words of each command in a chain. */
function legacyKeys(detail: string): string[] {
  return unwrapShell(detail)
    .split(/&&|\|\||[;|\n]/)
    .map((segment) => {
      const words = segment.trim().split(/\s+/).filter(Boolean);
      while (words.length && /^\w+=/.test(words[0]!)) words.shift(); // FOO=bar cmd
      const program = words[0]?.split('/').pop();
      if (!program) return '';
      const sub = words[1];
      return WITH_SUBCOMMANDS.has(program) && sub && /^[a-z][\w:-]*$/i.test(sub) ? `${program} ${sub}` : program;
    });
}

export function approvalKeys(kind: ApprovalKind, detail?: string, tool?: string): string[] {
  switch (kind) {
    case 'command': {
      // Every command the line runs (chains, pipes, substitutions, `sh -c '…'`), each by program and
      // subcommand — plus the keys the first, simpler reading gave, as a floor: a request is only
      // approved automatically when all of them are allowed, so a line this reading gets wrong can
      // never match more than it used to.
      const line = detail ?? '';
      let keys: string[];
      try {
        keys = parseCommandLine(line)
          .map((cmd) => approvalKey(cmd, WITH_SUBCOMMANDS))
          .filter((k): k is string => Boolean(k));
      } catch {
        keys = [line.trim()]; // too convoluted to read: only this exact command
      }
      return [...new Set([...keys, ...legacyKeys(line)])].filter(Boolean);
    }
    case 'edit':
      return ['*'];
    case 'fetch':
      try {
        return [new URL(detail ?? '').hostname || '*'];
      } catch {
        return detail ? [detail] : [];
      }
    default:
      return tool ? [tool] : [];
  }
}

export function isAllowed(rules: AllowRule[] | undefined, kind: ApprovalKind, keys: string[]): boolean {
  return keys.length > 0 && keys.every((key) => rules?.some((r) => r.kind === kind && r.key === key));
}
