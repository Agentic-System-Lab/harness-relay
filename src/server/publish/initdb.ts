import { createHash, randomBytes } from 'node:crypto';
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
 * What runs in the container: the connection's address without its password from the first line of
 * stdin, the password from the second (into `PGPASSWORD`, an environment only processes of the same
 * user, `nobody` here, and root can read, never a command line, which `ps` shows anyone), the script from the rest, then `psql -c` with it. psql sends a `-c` string
 * to the server as it is, in one request: none of psql's own commands, variables or backticks are
 * read in it (only a string that begins with a backslash would be one command, which the comment in
 * front of it rules out), and the server runs its statements as one transaction, so that a script
 * that fails leaves nothing behind.
 */
export const PSQL_SCRIPT =
  'IFS= read -r PGURI || exit 64; IFS= read -r PGPASSWORD || exit 64; export PGPASSWORD; SQL=$(cat) || exit 65; exec psql "$PGURI" -X -q -v ON_ERROR_STOP=1 -c "-- Harness Relay: an init script\n$SQL"';

/** The longest script: one argument of psql's command line (Linux takes 128 KiB). */
export const MAX_SCRIPT = 100 * 1024;

/** The `docker run` arguments of one script's run: Relay's own container, as unprivileged as psql allows, named so that it can be removed. */
export function psqlArgs(owner: string, name: string): string[] {
  return [
    'run',
    '--rm',
    '-i',
    '--name',
    name,
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
  const text = sql.toString('utf8');
  const command = /^[ \t]*(\\[A-Za-z!?]*)/m.exec(text);
  if (command) throw new HttpError(400, t().publish.initMeta(name, command[1]!));
  // A script runs as one transaction: one that ends it itself, or runs what cannot run in one, is not.
  const outside = TRANSACTION.exec(text);
  if (outside) throw new HttpError(400, t().publish.initTransaction(name, outside[1]!.replace(/\s+/g, ' ').toUpperCase()));
}

/**
 * A statement, at the start of a line, that ends the script's transaction or cannot run inside one.
 * (PL/pgSQL's `BEGIN` and `END;` in a function's body are neither, and stay.)
 */
const TRANSACTION =
  /^[ \t]*((?:BEGIN|COMMIT|ROLLBACK)(?:[ \t]+(?:WORK|TRANSACTION))?(?=[ \t]*;)|START[ \t]+TRANSACTION|CREATE[ \t]+DATABASE|DROP[ \t]+DATABASE|VACUUM|CREATE[ \t]+(?:UNIQUE[ \t]+)?INDEX[ \t]+CONCURRENTLY)\b/im;

/** A script's identity: its name and contents. One that committed is never run again; one changed after it is refused. */
export function scriptKey(script: { name: string; sql: Buffer }): string {
  return script.name + ':' + createHash('sha256').update(script.sql).digest('hex');
}

/** The connection's address without its password, and the password, which goes to psql apart from it. */
export function splitPassword(uri: string): { uri: string; password: string } {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    throw new HttpError(502, t().publish.badAnswer);
  }
  let password: string;
  try {
    password = decodeURIComponent(url.password);
  } catch {
    throw new HttpError(502, t().publish.badAnswer);
  }
  url.password = '';
  return { uri: url.href, password };
}

/**
 * Runs a compose file's init scripts on a new Neon database, in their order, with the pinned `psql`
 * (`PSQL_IMAGE`): the scripts the compose file's PostgreSQL image would have run on its first start.
 * Those `done` names (`scriptKey`) committed already and are skipped; one of them changed since is
 * refused. Each is checked first (`checkInitScript`), runs as one transaction, and is told to `onDone`
 * once it committed. A run stopped or timed out has its container removed, so that psql stops too.
 */
export async function runInitScripts(
  uri: string,
  scripts: { name: string; sql: Buffer }[],
  owner: string,
  signal?: AbortSignal,
  docker: (signal?: AbortSignal) => Promise<Docker> = localDocker,
  done: readonly string[] = [],
  onDone: (key: string) => void = () => {},
): Promise<void> {
  const ran = new Set(done);
  const names = new Set(done.map((key) => key.slice(0, key.lastIndexOf(':'))));
  const todo = scripts.filter((s) => !ran.has(scriptKey(s)));
  for (const script of todo) if (names.has(script.name)) throw new HttpError(400, t().publish.initChanged(script.name));
  if (!todo.length) return;
  // Each goes on a line of its own: a newline in either would end it early (URL parsing would drop it).
  if (/[\r\n]/.test(uri)) throw new HttpError(502, t().publish.badAnswer);
  const login = splitPassword(uri);
  if (/[\r\n]/.test(login.password)) throw new HttpError(502, t().publish.badAnswer);
  for (const script of todo) checkInitScript(script.name, script.sql);
  const run = await docker(signal);
  for (const script of todo) {
    const name = 'harness-relay-init-' + randomBytes(8).toString('hex');
    const r = await run(psqlArgs(owner, name), {
      stdin: Buffer.concat([Buffer.from(login.uri + '\n' + login.password + '\n'), script.sql]),
      signal,
      timeoutMs: 5 * 60_000,
    });
    // Killing the docker client leaves its container (and psql) running: it goes too.
    if (r.aborted || r.timedOut) await run(['rm', '-f', name], { timeoutMs: 30_000 }).catch(() => undefined);
    signal?.throwIfAborted();
    if (r.code !== 0) throw new HttpError(502, t().publish.initFailed(script.name, r.timedOut ? t().timedOut : tail(r.stderr, 600)));
    onDone(scriptKey(script));
  }
}
