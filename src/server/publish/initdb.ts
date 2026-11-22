import { HttpError } from '../errors';
import { t } from '../i18n';
import { tail } from '../process';
import { localDocker, type Docker } from '../previewDocker';

/** An image reference as compose names one: no option, space or control character can hide in it. */
const IMAGE = /^[A-Za-z0-9][A-Za-z0-9._\/:@-]{0,254}$/;

/**
 * What runs in the container: the connection's address from the first line of stdin (never a command
 * line, which `ps` shows), then `psql` on the rest, the script, stopping at its first error.
 */
export const PSQL_SCRIPT = 'IFS= read -r PGURI || exit 64; exec psql "$PGURI" -X -q -v ON_ERROR_STOP=1 -f -';

/** The `docker run` arguments of one script's run: Relay's own container, as unprivileged as psql allows. */
export function psqlArgs(image: string, owner: string): string[] {
  if (!IMAGE.test(image) || image.startsWith('-')) throw new HttpError(400, t().publish.initImage);
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
    image,
    '-c',
    PSQL_SCRIPT,
  ];
}

/**
 * Runs a compose file's init scripts on a new Neon database, one at a time in their order, with the
 * `psql` of the PostgreSQL image the compose file names (the one its preview ran): the same scripts
 * the image would have run on its first start.
 */
export async function runInitScripts(
  image: string,
  uri: string,
  scripts: { name: string; sql: Buffer }[],
  owner: string,
  signal?: AbortSignal,
  docker: (signal?: AbortSignal) => Promise<Docker> = localDocker,
): Promise<void> {
  if (!scripts.length) return;
  if (/[\r\n]/.test(uri)) throw new HttpError(502, t().publish.badAnswer);
  const run = await docker(signal);
  for (const script of scripts) {
    const r = await run(psqlArgs(image, owner), {
      stdin: Buffer.concat([Buffer.from(uri + '\n'), script.sql]),
      signal,
      timeoutMs: 5 * 60_000,
    });
    if (r.code !== 0) throw new HttpError(502, t().publish.initFailed(script.name, r.timedOut ? t().timedOut : tail(r.stderr, 600)));
  }
}
