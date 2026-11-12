import type { AllowRule, ApprovalKind } from '../shared/types';
import { approvalKey, evaluationContext, parseCommandLine, parseShellSyntax, unwrapShell, type SimpleCommand } from './commands';

/*
 * "Always allow in this conversation": an answer is remembered as rule keys, and later
 * requests whose keys are all allowed are approved without asking.
 *
 * - command: one key per command the line runs (`npm test && git push` → "npm test", "git push";
 *   also commands in `$( )`, backticks, `sh -c '…'`, `eval`, and inside `if` / `while` / `for` /
 *   `case`, groups and function bodies), so allowing `npm test` never lets a chained or embedded
 *   `rm …` through, nor allowing `if` an `if … git push …`. `sudo` stays in the key; a command whose
 *   program is computed when it runs, or `git -c …`, is keyed by its full text;
 * - edit: all file edits ("*");
 * - fetch: the host, with its port when it is not its scheme's own (`192.168.1.5:8000`), so one
 *   port of a host allowed allows no other;
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

/**
 * The line split at `&&`, `||`, `|`, `;` and newlines, except inside quotes: there they are text,
 * like the `|` in `grep -E 'a|b'`. (Commands that do run inside quotes, `"$(…)"` and `sh -c '…'`,
 * are found by the full reading.)
 */
export function splitChain(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '\\' && quote !== "'" && i + 1 < line.length) {
      cur += ch + line[++i];
    } else if (quote) {
      if (ch === quote) quote = null;
      cur += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
    } else if (ch === ';' || ch === '\n' || ch === '|' || (ch === '&' && line[i + 1] === '&')) {
      if (ch !== ';' && ch !== '\n' && line[i + 1] === ch) i++; // && and ||
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/** The first version's keys: whitespace-separated words of each command in a chain. */
function legacyKeys(detail: string): string[] {
  return splitChain(unwrapShell(detail))
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
      // Every command the line runs (chains, pipes, substitutions, `sh -c '…'`, compound commands),
      // each by program and subcommand, from both readings of `commands.ts` — plus the keys the first,
      // simpler reading gave. Each set is a floor: a request is only approved automatically when all
      // of them are allowed, so a line one reading gets wrong can never match more than it used to.
      const line = detail ?? '';
      // A line with any context where the shell evaluates a subscript or arithmetic (`echo "${b[x]}"`,
      // `(( x ))`, `declare 'a[$(…)]'`, `find -exec …`) gets only its exact text as a key, so an allowed
      // single program never carries the evaluation in. It only stops "always allow" from generalising.
      if (evaluationContext(line)) return [line.trim()].filter(Boolean);
      const keysOf = (readLine: (line: string) => SimpleCommand[]): string[] => {
        try {
          return readLine(line)
            .map((cmd) => approvalKey(cmd, WITH_SUBCOMMANDS))
            .filter((k): k is string => Boolean(k));
        } catch {
          return [line.trim()]; // too convoluted to read: only this exact command
        }
      };
      return [...new Set([...keysOf(parseShellSyntax), ...keysOf(parseCommandLine), ...legacyKeys(line)])].filter(Boolean);
    }
    case 'edit':
      return ['*'];
    case 'fetch': {
      const text = (detail ?? '').trim();
      try {
        // A URL, or a host with or without a port (`example.com:8080`, `[::1]:22`, as a sandbox asks
        // about one), which a URL parser would otherwise read as a scheme. Keyed by host and port, so
        // that allowing one port of a host (a model server's 8000) allows no other (its SSH on 22);
        // a URL on its scheme's own port (443, 80) and a bare host are keyed by the host alone.
        const scheme = /^[a-z][a-z\d+.-]*:\/\//i.test(text);
        const url = new URL(scheme ? text : `http://${text}`);
        if (!url.hostname) return ['*'];
        // A bare host on 443 or 80 is the host alone, as the relay sandbox labels it (`hostLabel`).
        const port = !scheme && (url.port === '443' || url.port === '80') ? '' : url.port;
        return [port ? `${url.hostname}:${port}` : url.hostname];
      } catch {
        return text ? [text] : [];
      }
    }
    default:
      return tool ? [tool] : [];
  }
}

export function isAllowed(rules: AllowRule[] | undefined, kind: ApprovalKind, keys: string[]): boolean {
  return keys.length > 0 && keys.every((key) => rules?.some((r) => r.kind === kind && r.key === key));
}
