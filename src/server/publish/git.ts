import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { GH_MISSING, GH_SIGNED_OUT, GIT_MISSING } from '../../shared/types';
import { CONFIG } from '../config';
import { HttpError } from '../errors';
import { gitCommand } from '../gitProcess';
import { t } from '../i18n';
import { CommandNotFoundError, runProcess, tail, type SpawnOptions, type SpawnResult } from '../process';
import { DATA_DIR } from '../settings';
import { ghBin, ghEnv, gitConfig, gitEnv, signedOut } from '../share';

export type Run = (o: SpawnOptions) => Promise<SpawnResult>;

/** A GitHub login, as GitHub allows one. */
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
/** A repository's full name, `owner/name`, as Relay makes them. */
export const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

/** Runs gh in its environment for sharing (`ghEnv`), saying when it is missing or not signed in. */
async function gh(run: Run, args: string[]): Promise<SpawnResult> {
  let r: SpawnResult;
  try {
    r = await run({ bin: ghBin(), args, env: ghEnv(), timeoutMs: 60_000 });
  } catch (err) {
    if (err instanceof CommandNotFoundError) throw new HttpError(400, t().publish.noGh, GH_MISSING);
    throw err;
  }
  if (r.code !== 0 && !r.timedOut && signedOut(r.stderr)) throw new HttpError(400, t().shareSignedOut, GH_SIGNED_OUT);
  return r;
}

/** The GitHub account gh is signed in as. */
export async function githubLogin(run: Run = runProcess): Promise<string> {
  const r = await gh(run, ['api', '--hostname', 'github.com', 'user', '--jq', '.login']);
  const login = r.stdout.trim();
  if (r.code !== 0 || !LOGIN.test(login)) throw new HttpError(502, t().publish.github(r.timedOut ? t().timedOut : tail(r.stderr, 300)));
  return login;
}

/** Makes a private repository of the signed-in account's; its full name. */
export async function createRepo(name: string, run: Run = runProcess): Promise<string> {
  const r = await gh(run, [
    'api',
    '--hostname',
    'github.com',
    '--method',
    'POST',
    'user/repos',
    '-f',
    'name=' + name,
    '-F',
    'private=true',
    '-f',
    'description=Published from Harness Relay',
    '--jq',
    '.full_name',
  ]);
  const full = r.stdout.trim();
  if (r.code === 0 && REPO.test(full)) return full;
  if (/name already exists/i.test(r.stdout + r.stderr)) throw new HttpError(409, t().publish.repoExists(name));
  throw new HttpError(502, t().publish.github(r.timedOut ? t().timedOut : tail(r.stderr, 300)));
}

/**
 * Whether the account has a repository of that name (`gh api repos/<login>/<name>`): true when GitHub
 * answers with it, false when it says there is none; undefined when it could not tell.
 */
export async function repoExists(login: string, name: string, run: Run = runProcess): Promise<boolean | undefined> {
  if (!LOGIN.test(login) || !/^[a-z0-9-]{1,40}$/.test(name)) return undefined;
  const r = await gh(run, ['api', '--hostname', 'github.com', `repos/${login}/${name}`, '--silent']);
  if (r.code === 0) return true;
  return /HTTP 404|Not Found/i.test(r.stderr) ? false : undefined;
}

/** The repository's address for git: GitHub's, or the end-to-end tests' folder of stand-in repositories. */
export function repoRemote(repo: string, base: string | undefined = CONFIG.publishGitDir): string {
  if (!REPO.test(repo)) throw new Error(`not a repository: ${repo}`);
  return base ? join(base, repo + '.git') : `https://github.com/${repo}.git`;
}

/** Where a publish's temporary repositories go: Relay's data folder, out of the agents' reach (see `shareTmpRoot`). */
export function publishTmpRoot(): string {
  return join(DATA_DIR, 'tmp');
}
const PREFIX = 'publish-';

/** Removes what publishes left there when the server stopped during them: for the server's start. */
export async function clearPublishTmp(root: string = publishTmpRoot()): Promise<void> {
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return;
  }
  await Promise.all(names.filter((n) => n.startsWith(PREFIX)).map((n) => rm(join(root, n), { recursive: true, force: true })));
}

/** A path for `git fast-import`, C-quoted: its backslashes and double quotes escaped. */
export function fastImportPath(name: string): string {
  return '"' + name.replace(/[\\"]/g, '\\$&') + '"';
}

/**
 * `git fast-import`'s input for one commit on `main` holding exactly `files` (with the executable bit
 * for those in `executables`), after `parent` when there is one.
 */
export function fastImportStream(
  files: ReadonlyMap<string, Buffer>,
  executables: ReadonlySet<string>,
  message: string,
  parent: boolean,
  now = Math.floor(Date.now() / 1000),
): Buffer {
  const parts: Buffer[] = [];
  const text = (s: string) => parts.push(Buffer.from(s, 'utf8'));
  const msg = Buffer.from(message, 'utf8');
  text(`commit refs/heads/main\ncommitter Harness Relay <harness-relay@localhost> ${now} +0000\ndata ${msg.length}\n`);
  parts.push(msg);
  text('\n');
  if (parent) text('from refs/heads/main^0\n');
  text('deleteall\n');
  for (const name of [...files.keys()].sort()) {
    const data = files.get(name)!;
    text(`M ${executables.has(name) ? '100755' : '100644'} inline ${fastImportPath(name)}\ndata ${data.length}\n`);
    parts.push(data);
    text('\n');
  }
  text('done\n');
  return Buffer.concat(parts);
}

/**
 * Pushes the snapshot to the repository's `main` as one commit, after the commit there when there is
 * one: in a bare repository of its own under `root` (Relay's data folder), through git's fast-import
 * (no working tree, none of the user's filters, hooks or signing), signed in by gh alone over HTTPS
 * (`gitEnv`). The commit's id.
 */
export async function pushSnapshot(
  repo: string,
  files: ReadonlyMap<string, Buffer>,
  executables: ReadonlySet<string>,
  run: Run = runProcess,
  root: string = publishTmpRoot(),
  base: string | undefined = CONFIG.publishGitDir,
  signal?: AbortSignal,
): Promise<string> {
  const env = gitEnv();
  // The stand-in repositories of the end-to-end tests are folders on this computer.
  if (base) env.GIT_ALLOW_PROTOCOL = 'file';
  let bin: string;
  try {
    bin = await gitCommand(env);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, t().gitMissing, GIT_MISSING);
  }
  const git = async (args: string[], o: { stdin?: Buffer; timeoutMs?: number; allowFail?: boolean } = {}) => {
    let r: SpawnResult;
    try {
      r = await run({ bin, args, env, stdin: o.stdin, timeoutMs: o.timeoutMs ?? 60_000, signal });
    } catch (err) {
      if (err instanceof CommandNotFoundError) throw new HttpError(400, t().gitMissing, GIT_MISSING);
      throw err;
    }
    signal?.throwIfAborted();
    if (r.code !== 0 && !o.allowFail) throw new HttpError(502, t().publish.push(r.timedOut ? t().timedOut : tail(r.stderr, 300)));
    return r;
  };
  const remote = repoRemote(repo, base);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const dir = await mkdtemp(join(root, PREFIX));
  try {
    const config = gitConfig(ghBin());
    const at = [...config, '--git-dir', dir];
    await git([...config, 'init', '--bare', '--quiet', '--template=', '--initial-branch=main', dir]);
    // An update goes after what is there; a new repository has nothing yet.
    const fetched = await git([...at, 'fetch', '--quiet', '--no-tags', '--depth=1', remote, '+refs/heads/main:refs/heads/main'], {
      timeoutMs: 120_000,
      allowFail: true,
    });
    const parent = fetched.code === 0;
    await git([...at, 'fast-import', '--quiet', '--done'], {
      stdin: fastImportStream(files, executables, 'Publish from Harness Relay', parent),
      timeoutMs: 120_000,
    });
    const commit = (await git([...at, 'rev-parse', '--verify', 'refs/heads/main^{commit}'])).stdout.trim();
    if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(commit)) throw new HttpError(502, t().publish.push(commit));
    await git([...at, 'push', '--quiet', '--no-verify', remote, 'refs/heads/main:refs/heads/main'], { timeoutMs: 300_000 });
    return commit;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
