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
 * line, which `ps` shows), the script from the rest, then `psql -c` with it. psql sends a `-c` string
 * to the server as it is, in one request: none of psql's own commands, variables or backticks are
 * read in it (only a string that begins with a backslash would be one command, which the comment in
 * front of it rules out), and the server runs its statements as one transaction, so that a script
 * that fails leaves nothing behind.
 */
export const PSQL_SCRIPT =
  'IFS= read -r PGURI || exit 64; SQL=$(cat) || exit 65; exec psql "$PGURI" -X -q -v ON_ERROR_STOP=1 -c "-- Harness Relay: an init script\n$SQL"';

/** The longest script: one argument of psql's command line (Linux takes 128 KiB). */
export const MAX_SCRIPT = 100 * 1024;

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

/**
 * Refuses, before anything is made, an init script Relay would not run as the image would: one with
 * psql's own commands (a line that begins with a backslash, such as `\c` or `\set`), which go to the
 * server as SQL here and fail there; one too long for psql's command line; one with a NUL byte. Plain
 * SQL is what runs, on Neon's server.
 */
export function checkInitScript(name: string, sql: Buffer): void {
  if (sql.length > MAX_SCRIPT) throw new HttpError(400, t().publish.initSize(name, MAX_SCRIPT / 1024));
  if (sql.includes(0)) throw new HttpError(400, t().publish.initBinary(name));
  const command = /^[ \t]*(\\[A-Za-z!?]*)/m.exec(sql.toString('utf8'));
  if (command) throw new HttpError(400, t().publish.initMeta(name, command[1]!));
}

/**
 * Runs a compose file's init scripts on a new Neon database, in their order from the one at `from`,
 * with the pinned `psql` (`PSQL_IMAGE`): the scripts the compose file's PostgreSQL image would have run
 * on its first start. Each is checked first (`checkInitScript`), runs as one transaction, and is told
 * to `onDone` once it committed, so that a later try goes on after it.
 */
export async function runInitScripts(
  uri: string,
  scripts: { name: string; sql: Buffer }[],
  owner: string,
  signal?: AbortSignal,
  docker: (signal?: AbortSignal) => Promise<Docker> = localDocker,
  from = 0,
  onDone: (count: number) => void = () => {},
): Promise<void> {
  const todo = scripts.slice(from);
  if (!todo.length) return;
  if (/[\r\n]/.test(uri)) throw new HttpError(502, t().publish.badAnswer);
  for (const script of todo) checkInitScript(script.name, script.sql);
  const run = await docker(signal);
  for (const [i, script] of todo.entries()) {
    const r = await run(psqlArgs(owner), {
      stdin: Buffer.concat([Buffer.from(uri + '\n'), script.sql]),
      signal,
      timeoutMs: 5 * 60_000,
    });
    signal?.throwIfAborted();
    if (r.code !== 0) throw new HttpError(502, t().publish.initFailed(script.name, r.timedOut ? t().timedOut : tail(r.stderr, 600)));
    onDone(from + i + 1);
  }
}
