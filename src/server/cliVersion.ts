import { realpathSync, statSync } from 'node:fs';
import { MIN_VERSIONS, tooOldFor } from '../shared/cliVersions';
import { PROVIDER_LABEL, type Provider } from '../shared/types';
import { antigravityHasKey } from './agents/antigravity';
import { findOnPath } from './executable';
import { t } from './i18n';
import { capture, stripAnsi } from './process';

/*
 * Each CLI's version, as its program says (`--version`), and whether it is older than Harness Relay
 * supports (`MIN_VERSIONS` in src/shared/cliVersions.ts). Harness Relay starts its CLIs without a
 * terminal: an older one takes a subcommand it does not know for a prompt (Codex 0.27 then opens its
 * terminal UI and fails with "Device not configured (os error 6)"; others send the words to the
 * model). So a CLI that is too old is not started at all: its status says so, and every run and
 * question is refused before it starts (`tooOld()`).
 */

/** The version in a CLI's `--version` output (`codex-cli 0.167.0`, `2.1.0 (Claude Code)`). */
export function parseVersion(out: string): string | undefined {
  const m = stripAnsi(out).match(/\d+\.\d+\.\d+[\w.-]*/);
  // Not the sentence's full stop: Copilot prints "GitHub Copilot CLI 1.0.109."
  return m?.[0].replace(/[.-]+$/, '');
}

/**
 * A CLI stopped by a signal as soon as it started, before it said anything: macOS kills a program
 * whose signature it no longer trusts so (Codex 0.47 to 0.130, signed with a certificate since
 * revoked). Its version cannot be read, and nothing else it is started for would run either.
 */
export class CliKilledError extends Error {
  constructor(public signal: string) {
    super(t().cliKilledAtStart(signal));
  }
}

/** How long a version read is kept while its program file stays the same (an npm shim stays the same while the package changes). */
export const VERSION_TTL_MS = 10 * 60_000;

/** The versions read, by program and PATH: the file they were read from, when, and the answer. */
const read = new Map<string, { file: string; at: number; version: Promise<string | undefined> }>();

/** Where `bin` is and what it is now (its real path, size and time), to tell an updated program; empty when it cannot be found. */
function fileOf(bin: string, env: NodeJS.ProcessEnv): string {
  try {
    const found = /[\\/]/.test(bin) ? bin : findOnPath(bin, env, process.platform);
    if (!found) return '';
    const real = realpathSync(found);
    const s = statSync(real);
    return `${real}\0${s.size}\0${s.mtimeMs}`;
  } catch {
    return '';
  }
}

/**
 * A CLI's version (`--version`), kept while its program stays the same (`fresh`: asked again). Throws
 * what starting it threw (`CommandNotFoundError`: it is not there), or `CliKilledError`.
 */
export function cliVersion(bin: string, env: NodeJS.ProcessEnv, fresh = false): Promise<string | undefined> {
  const key = `${bin}\0${env.PATH ?? env.Path ?? ''}`;
  const file = fileOf(bin, env);
  const kept = read.get(key);
  if (!fresh && file && kept && kept.file === file && Date.now() - kept.at < VERSION_TTL_MS) return kept.version;
  const version = capture(bin, ['--version'], env, { timeoutMs: 10_000 }).then((r) => {
    if (r.signal && !r.timedOut && !r.aborted && !r.stdout.trim() && !r.stderr.trim()) throw new CliKilledError(r.signal);
    return parseVersion(r.stdout || r.stderr);
  });
  const entry = { file, at: Date.now(), version };
  if (file) read.set(key, entry);
  else read.delete(key);
  // Only an answer is kept: a program that could not be started is asked again next time.
  version.catch(() => {
    if (read.get(key) === entry) read.delete(key);
  });
  return version;
}

/** A CLI older than Harness Relay supports: its version and the oldest one it needs. */
export interface TooOld {
  version: string;
  min: string;
}

/**
 * Whether a CLI is older than Harness Relay supports, as its program says. A CLI whose version cannot
 * be read (not there, or no version in its answer) is not called too old: starting it says what is wrong.
 * Throws `CliKilledError` for a program killed as it starts: nothing it is started for would run either.
 */
export async function tooOld(p: Provider, bin: string, env: NodeJS.ProcessEnv): Promise<TooOld | undefined> {
  // A CLI without a minimum is not asked its version at all; nor is Antigravity without its Gemini API
  // key, which is never started then (it would answer on a Google sign-in it keeps): its own refusal says why.
  if (!MIN_VERSIONS[p] || (p === 'antigravity' && !antigravityHasKey(env))) return undefined;
  let version: string | undefined;
  try {
    version = await cliVersion(bin, env);
  } catch (err) {
    if (err instanceof CliKilledError) throw err;
    return undefined;
  }
  const min = tooOldFor(p, version);
  return min && version ? { version, min } : undefined;
}

/** What Harness Relay says of a CLI that is too old, in the request's language. */
export function tooOldText(p: Provider, old: TooOld): string {
  return t().cliTooOld(PROVIDER_LABEL[p], old.version, old.min);
}

/** A CLI is too old to be started (`tooOld()`): its message says which version it needs. */
export class CliTooOldError extends Error {
  constructor(
    public provider: Provider,
    public old: TooOld,
  ) {
    super(tooOldText(provider, old));
  }
}

/** Throws `CliTooOldError` when the CLI is older than Harness Relay supports. */
export async function assertNotTooOld(p: Provider, bin: string, env: NodeJS.ProcessEnv): Promise<void> {
  const old = await tooOld(p, bin, env);
  if (old) throw new CliTooOldError(p, old);
}

/** Forgets the versions read (tests). */
export function forgetVersions(): void {
  read.clear();
}
