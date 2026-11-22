import { HttpError } from '../errors';
import { t } from '../i18n';
import { tail } from '../process';
import { localDocker, type Docker } from '../previewDocker';

/**
 * The `psql` the init scripts run with: PostgreSQL's official image (18, Alpine), pinned by digest,
 * never the compose file's own image, which an agent may have named and which would run here with a
 * network the preview never gave it. psql 18 talks to every server version Neon has (14 to 18).
 */
export const PSQL_IMAGE = 'docker.io/library/postgres@sha256:0115267ab5a509022df9319c77be365cef335adb71556c75f60f5360ee247e71';

/**
 * What runs in the container: the connection's address from the first line of stdin (never a command
 * line, which `ps` shows), then `psql` on the rest, the script, stopping at its first error.
 */
export const PSQL_SCRIPT = 'IFS= read -r PGURI || exit 64; exec psql "$PGURI" -X -q -v ON_ERROR_STOP=1 -f -';

/** The `docker run` arguments of one script's run: Relay's own container, as unprivileged as psql allows. */
export function psqlArgs(owner: string): string[] {
  return [
    'run',
    '--rm',
    '-i',
    '--label',
    'io.harness-relay.publish.owner=' + owner,
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--user',
    '65534:65534',
    '--memory',
    '256m',
    '--pids-limit',
    '64',
    '--entrypoint',
    '/bin/sh',
    PSQL_IMAGE,
    '-c',
    PSQL_SCRIPT,
  ];
}

/** psql's own commands an init script may use: none runs a program, reads or writes a file, or connects elsewhere. */
const ALLOWED_META = new Set(['echo', 'qecho', 'set', 'unset']);

/**
 * psql's backslash commands in a script, outside strings, quoted names, dollar quotes and comments, as
 * psql finds them: each one's name and its arguments (to the end of its line, or to an unquoted
 * backslash: another command, or psql's separator `\\`, after which the line goes on as SQL).
 */
export function metaCommands(sql: string): { name: string; args: string }[] {
  const found: { name: string; args: string }[] = [];
  let i = 0;
  let depth = 0; // /* */ comments nest
  while (i < sql.length) {
    const c = sql[i]!;
    const next = sql[i + 1];
    if (depth) {
      if (c === '*' && next === '/') (depth--, (i += 2));
      else if (c === '/' && next === '*') (depth++, (i += 2));
      else i++;
      continue;
    }
    if (c === '/' && next === '*') {
      depth = 1;
      i += 2;
    } else if (c === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      i = end < 0 ? sql.length : end + 1;
    } else if (c === "'" || c === '"') {
      // E'…' strings take backslash escapes; the others double their quote.
      const escapes = c === "'" && /[eE]/.test(sql[i - 1] ?? '') && !/[A-Za-z0-9_]/.test(sql[i - 2] ?? '');
      i++;
      while (i < sql.length) {
        if (escapes && sql[i] === '\\') i += 2;
        else if (sql[i] === c) {
          if (sql[i + 1] === c) i += 2;
          else break;
        } else i++;
      }
      i++;
    } else if (c === '$' && /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.test(sql.slice(i)) && !/[A-Za-z0-9_]/.test(sql[i - 1] ?? '')) {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))![0];
      const end = sql.indexOf(tag, i + tag.length);
      i = end < 0 ? sql.length : end + tag.length;
    } else if (c === '\\') {
      if (next === '\\') {
        i += 2;
        continue;
      }
      const name = /^[A-Za-z]+|^[^\sA-Za-z]/.exec(sql.slice(i + 1))?.[0] ?? '';
      const start = i + 1 + name.length;
      // Its arguments, as psql reads them: to the end of the line, or to an unquoted backslash, which
      // starts another command, or is psql's separator `\\`, after which the line goes on as SQL.
      let j = start;
      let quote = '';
      while (j < sql.length && sql[j] !== '\n') {
        const ch = sql[j]!;
        if (quote) {
          if (quote === "'" && ch === '\\') j += 2;
          else if (ch === quote && quote === "'" && sql[j + 1] === "'") j += 2;
          else {
            if (ch === quote) quote = '';
            j++;
          }
        } else if (ch === "'" || ch === '"' || ch === '`') {
          quote = ch;
          j++;
        } else if (ch === '\\') break;
        else j++;
      }
      found.push({ name, args: sql.slice(start, j) });
      i = sql[j] === '\\' ? (sql[j + 1] === '\\' ? j + 2 : j) : j + 1;
    } else i++;
  }
  return found;
}

/**
 * Refuses an init script psql would let run a program, read or write a file here, or connect
 * elsewhere: any of its own commands but `\echo`, `\qecho`, `\set` and `\unset`, and a backtick (which
 * runs a shell command) in their arguments. Plain SQL runs on Neon's server, as it would have in the image.
 */
export function checkInitScript(name: string, sql: Buffer): void {
  for (const meta of metaCommands(sql.toString('utf8'))) {
    if (!ALLOWED_META.has(meta.name) || meta.args.includes('`')) throw new HttpError(400, t().publish.initMeta(name, '\\' + meta.name));
  }
}

/**
 * Runs a compose file's init scripts on a new Neon database, one at a time in their order, with the
 * pinned `psql` (`PSQL_IMAGE`): the same scripts the compose file's PostgreSQL image would have run on
 * its first start. Each is checked first (`checkInitScript`).
 */
export async function runInitScripts(
  uri: string,
  scripts: { name: string; sql: Buffer }[],
  owner: string,
  signal?: AbortSignal,
  docker: (signal?: AbortSignal) => Promise<Docker> = localDocker,
): Promise<void> {
  if (!scripts.length) return;
  if (/[\r\n]/.test(uri)) throw new HttpError(502, t().publish.badAnswer);
  for (const script of scripts) checkInitScript(script.name, script.sql);
  const run = await docker(signal);
  for (const script of scripts) {
    const r = await run(psqlArgs(owner), {
      stdin: Buffer.concat([Buffer.from(uri + '\n'), script.sql]),
      signal,
      timeoutMs: 5 * 60_000,
    });
    signal?.throwIfAborted();
    if (r.code !== 0) throw new HttpError(502, t().publish.initFailed(script.name, r.timedOut ? t().timedOut : tail(r.stderr, 600)));
  }
}
