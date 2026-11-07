import type { AllowRule, ApprovalKind } from '../shared/types';

/*
 * "Always allow in this conversation": an answer is remembered as rule keys, and later
 * requests whose keys are all allowed are approved without asking.
 *
 * - command: one key per command in a chain (`npm test && git push` → "npm test", "git push"),
 *   so allowing `npm test` never lets a chained `rm …` through;
 * - edit: all file edits ("*");
 * - fetch: the host name;
 * - other: the tool's name.
 */

const SEPARATORS = /&&|\|\||[;|\n]/;

/** `/bin/zsh -lc 'npm test'` → `npm test` (shell wrappers that CLIs add). */
export function unwrapShell(command: string): string {
  const m = command.trim().match(/^(?:\S*\/)?(?:ba|z|da)?sh\s+(?:-\w+\s+)*-\w*c\w*\s+(['"])([\s\S]*)\1$/);
  return m ? m[2]!.replace(/\\(['"\\])/g, '$1') : command.trim();
}

/** Programs whose second word is a subcommand (`git push`, `npm install`), not an argument. */
const WITH_SUBCOMMANDS = new Set(
  (
    'npm pnpm yarn bun npx pnpx deno git gh cargo rustup go docker podman kubectl helm terraform pip pip3 uv poetry ' +
    'pdm hatch conda brew apt apt-get dnf yum dotnet mvn gradle bundle rails composer mix swift flutter dart nx turbo ' +
    'aws az gcloud firebase vercel'
  ).split(' '),
);

/** The program, plus its subcommand for tools that have them: `npm install lodash` → `npm install`. */
function commandKey(segment: string): string | undefined {
  const words = segment.trim().split(/\s+/).filter(Boolean);
  while (words.length && /^\w+=/.test(words[0]!)) words.shift(); // FOO=bar cmd
  const program = words[0]?.split('/').pop();
  if (!program) return undefined;
  const sub = words[1];
  return WITH_SUBCOMMANDS.has(program) && sub && /^[a-z][\w:-]*$/i.test(sub) ? `${program} ${sub}` : program;
}

export function approvalKeys(kind: ApprovalKind, detail?: string, tool?: string): string[] {
  switch (kind) {
    case 'command': {
      const keys = unwrapShell(detail ?? '')
        .split(SEPARATORS)
        .map(commandKey)
        .filter((k): k is string => Boolean(k));
      return [...new Set(keys)];
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
