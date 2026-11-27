import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { portableInstallEnv } from '../portableInstall';
import { dockerSearchPath } from '../previewDocker';
import { runProcess, tail, type SpawnResult } from '../process';

/*
 * Running `cua` for the computer tools: with Cua's own home (`~/.cua`, or the server's `CUA_HOME`: its
 * computers, images and their tokens, kept from the agents below full access by `protectedReads()`), its
 * telemetry off, and an environment of the server's that keeps only what it needs to find a container engine
 * (Docker's or Podman's settings, the system's folders, proxies), never a model key or a cloud's.
 *
 * Not a folder of Harness Relay's data folder: Cua's own Linux VM (macOS, Windows) keeps a socket in its
 * home, whose path must stay under 104 bytes, which a data folder deep in a checkout would not.
 */

/** Cua's home: what `cua` keeps of its computers (`CUA_HOME`, else `~/.cua`). */
export function cuaHome(source: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return source.CUA_HOME?.trim() || join(home, '.cua');
}

/**
 * Where Linux computers run (`CUA_RUNTIME_LINUX`): on macOS and Windows, Cua's own Linux VM (a small VM with
 * Docker and gVisor, or on Windows a WSL distribution of its own), apart from the user's Docker; on Linux,
 * the container engine there. The server's own setting wins.
 */
export function linuxRuntime(source: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | undefined {
  if (source.CUA_RUNTIME_LINUX?.trim()) return source.CUA_RUNTIME_LINUX.trim();
  return platform === 'darwin' || platform === 'win32' ? 'builtin' : undefined;
}

/** What `cua` is given of the server's environment, with its telemetry off. */
export function cuaEnv(
  source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  search = dockerSearchPath(source),
): NodeJS.ProcessEnv {
  const env = portableInstallEnv(source);
  for (const [key, value] of Object.entries(source))
    if (
      /^(DOCKER_HOST|DOCKER_CONTEXT|DOCKER_CONFIG|DOCKER_CERT_PATH|DOCKER_TLS_VERIFY|CONTAINER_HOST|XDG_RUNTIME_DIR|XDG_CONFIG_HOME|XDG_CACHE_HOME|USER|LOGNAME|USERNAME|COMPUTERNAME|LC_ALL|LC_CTYPE|TZ)$/i.test(
        key,
      )
    )
      env[key] = value;
  env.PATH = search;
  env.CUA_HOME = cuaHome(source, source.HOME || source.USERPROFILE || homedir());
  const runtime = linuxRuntime(source, platform);
  if (runtime) env.CUA_RUNTIME_LINUX = runtime;
  // Cua's telemetry is on unless one of these says otherwise (https://cua.ai/docs/cua-sdk/concepts/telemetry).
  env.DO_NOT_TRACK = '1';
  env.CUA_TELEMETRY = '0';
  return env;
}

/** `cua` said it could not: its words (the end of what it wrote), and its exit code. */
export class CuaError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
  ) {
    super(message);
  }
}

/** The JSON value `cua --json` printed: its last line that is one (progress may come before it). */
export function lastJson(stdout: string): unknown {
  const whole = stdout.trim();
  try {
    return JSON.parse(whole);
  } catch {
    // Several lines: the last one that is a JSON value.
  }
  const lines = whole.split(/\r?\n/).reverse();
  for (const line of lines) {
    const text = line.trim();
    if (!text.startsWith('{') && !text.startsWith('[')) continue;
    try {
      return JSON.parse(text);
    } catch {
      // not JSON
    }
  }
  return undefined;
}

/** Why a run of `cua` failed, in a line or a few: its error output's end (or its output's), without colours. */
export function cuaFailure(r: Pick<SpawnResult, 'stdout' | 'stderr' | 'code' | 'timedOut' | 'aborted'>, what: string): string {
  if (r.aborted) return what + ': stopped';
  if (r.timedOut) return what + ': it did not finish in time';
  // eslint-disable-next-line no-control-regex
  const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
  const lines = plain(r.stderr || r.stdout)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^\S+Z\s+(WARN|INFO|DEBUG|TRACE)\b/.test(l));
  return what + (lines.length ? ': ' + tail(lines.slice(-4).join(' '), 600) : ` (exit code ${r.code ?? 'none'})`);
}

export type CuaRunner = (args: string[], o: { signal?: AbortSignal; timeoutMs: number }) => Promise<SpawnResult>;

/** Runs `cua` (`bin`) with Harness Relay's environment, in its Cua home. */
export function cuaRunner(bin: () => string | undefined, env: () => NodeJS.ProcessEnv = () => cuaEnv()): CuaRunner {
  return async (args, o) => {
    const program = bin();
    if (!program) throw new CuaError('Cua is not installed', null);
    const e = env();
    mkdirSync(e.CUA_HOME!, { recursive: true, mode: 0o700 });
    return runProcess({
      bin: program,
      args,
      env: e,
      cwd: e.CUA_HOME,
      signal: o.signal,
      timeoutMs: o.timeoutMs,
      maxCapture: 1 << 20,
      maxStderrCapture: 64 * 1024,
    });
  };
}
