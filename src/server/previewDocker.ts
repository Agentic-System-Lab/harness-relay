import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';
import type { PreviewDockerView } from '../shared/types';
import { findOnPath, isProgram } from './executable';
import { t } from './i18n';
import { runProcess, tail, type SpawnOptions, type SpawnResult } from './process';

interface DockerHost {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
  hasProgram: (path: string) => boolean;
  run: typeof runProcess;
}

function realHost(): DockerHost {
  return { platform: process.platform, env: process.env, home: homedir(), hasProgram: isProgram, run: runProcess };
}

/** Docker Desktop's documented machine and per-user install directories on Windows. */
export function windowsDockerFolders(env: NodeJS.ProcessEnv, home?: string): string[] {
  const upper = Object.fromEntries(Object.entries(env).map(([k, v]) => [k.toUpperCase(), v]));
  const programFiles = upper.PROGRAMW6432 || upper.PROGRAMFILES || 'C:\\Program Files';
  const profile = upper.USERPROFILE || home;
  const local = upper.LOCALAPPDATA || (profile && win32.join(profile, 'AppData', 'Local'));
  return [win32.join(programFiles, 'Docker', 'Docker'), ...(local ? [win32.join(local, 'Programs', 'DockerDesktop')] : [])].filter((dir) =>
    /^[a-z]:\\/i.test(dir),
  );
}

// Docker Desktop first puts the CLI in its bundle. The server may have started before the
// installer updated PATH. Re-resolve on every probe/start, including the bundled credential helpers.
function dockerPaths(host: DockerHost) {
  const { platform, home, env } = host;
  const path = platform === 'win32' ? win32 : posix;
  const dirs = (env.PATH ?? env.Path ?? '')
    .split(path.delimiter)
    .filter((dir) => path.isAbsolute(dir) && !/(?:^|[/\\])node_modules(?:[/\\]|$)/i.test(dir));
  if (platform === 'darwin') {
    dirs.push(posix.join(home, '.docker/bin'), '/Applications/Docker.app/Contents/Resources/bin', '/opt/homebrew/bin', '/usr/local/bin');
  } else if (platform === 'win32') {
    dirs.push(...windowsDockerFolders(env, home).map((dir) => win32.join(dir, 'resources', 'bin')));
  } else {
    dirs.push('/usr/local/bin', '/usr/bin', '/bin');
  }
  const search = dirs.join(path.delimiter);
  return { search, bin: findOnPath('docker', { PATH: search, PATHEXT: '.exe' }, platform, [], host.hasProgram) };
}

export function hasDockerCli() {
  return Boolean(dockerPaths(realHost()).bin);
}

// The CLI as configured for Relay's user discovers the local socket. Pin it for all later calls,
// including cleanup, so changing Docker contexts cannot send files to another daemon.
export type DockerOptions = Pick<SpawnOptions, 'signal' | 'stdin' | 'timeoutMs' | 'maxCapture' | 'onSpawn' | 'cwd'>;
export type Docker = ((args: string[], options?: DockerOptions) => Promise<SpawnResult>) & {
  /** The local socket or named pipe every call goes to, for the Engine API (a container's terminal). */
  endpoint?: string;
};

class MissingDocker extends Error {}
class DockerAccessDenied extends Error {}

export async function localDocker(signal?: AbortSignal, machine = realHost()): Promise<Docker> {
  const { search, bin } = dockerPaths(machine);
  if (!bin) throw new MissingDocker(t().previewDocker.missing);
  const original =
    machine.platform === 'win32'
      ? Object.fromEntries(Object.entries(machine.env).map(([key, val]) => [key.toUpperCase(), val]))
      : machine.env;
  const env: NodeJS.ProcessEnv = { ...original, PATH: search };
  const cli = (args: string[], commandEnv: NodeJS.ProcessEnv, options?: DockerOptions) =>
    machine.run({ bin, args, env: commandEnv, timeoutMs: 15000, ...options });
  let host = env.DOCKER_CONTEXT ? undefined : env.DOCKER_HOST;
  if (!host) {
    const result = await cli(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], env, { signal });
    host = checked(result, t().previewDocker.context).stdout.trim();
  }
  // Windows accepts UNC paths for remote shares. On Windows only its local named-pipe
  // spelling is valid. A server running in WSL is a Linux process and uses a Unix socket.
  const local =
    machine.platform === 'win32' ? /^npipe:\/\/\/\/\.\/pipe\/[a-zA-Z0-9._-]+$/.test(host) : /^unix:\/\/\/[^/\r\n][^\r\n]*$/.test(host);
  if (!local) throw new Error(t().previewDocker.local);
  const fixed = { ...env };
  delete fixed.DOCKER_HOST;
  delete fixed.DOCKER_CONTEXT;
  // Compose reads its project, files and profiles from these. Relay names every one itself.
  for (const key of Object.keys(fixed)) if (/^COMPOSE_/i.test(key)) delete fixed[key];
  const docker: Docker = (args, options) => cli(['--host', host, ...args], fixed, options);
  docker.endpoint = host;
  return docker;
}

export async function checkDockerEngine(docker: Docker, signal?: AbortSignal, platform = process.platform): Promise<void> {
  const result = await docker(['info', '--format', '{{.OSType}} {{.Architecture}}'], { signal });
  if (result.code !== 0 && !result.aborted && !result.timedOut) {
    const detail = tail(result.stderr, 1024);
    if (/permission denied|access is denied/i.test(result.stderr)) {
      const reason = platform === 'linux' ? t().previewDocker.linuxAccess : t().previewDocker.permission;
      throw new DockerAccessDenied(reason + ' ' + detail);
    }
    throw new Error(t().previewDocker.startEngine + ' ' + detail);
  }
  const info = checked(result, t().previewDocker.engine);
  if (!/^linux (?:arm64|aarch64|x86_64|amd64)\s*$/.test(info.stdout)) throw new Error(t().previewDocker.arch);
}

export type DockerStatus = Pick<PreviewDockerView, 'state' | 'detail' | 'help'>;
export async function probePreviewDocker(machine = realHost()): Promise<DockerStatus> {
  try {
    await checkDockerEngine(await localDocker(undefined, machine), undefined, machine.platform);
    return { state: 'ready' };
  } catch (e) {
    return {
      state: e instanceof MissingDocker ? 'missing' : 'unavailable',
      detail: e instanceof Error ? e.message : String(e),
      ...(machine.platform === 'linux' && e instanceof DockerAccessDenied ? { help: 'linux-access' as const } : {}),
    };
  }
}

export function checked(result: SpawnResult, step: string, withLog = true): SpawnResult {
  if (result.aborted) throw new Error(t().stopped);
  if (result.timedOut) throw new Error(t().previewDocker.timeout(step));
  if (result.code !== 0) {
    const detail = tail(result.stderr + '\n' + (withLog ? result.stdout : ''), 2048);
    throw new Error(t().previewDocker.failed(step) + (detail ? ' ' + detail : ''));
  }
  return result;
}
