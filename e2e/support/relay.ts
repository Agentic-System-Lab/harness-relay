/**
 * One Harness Relay server for one test: `src/server/index.ts` with the built UI, on a free port,
 * with everything it keeps in a temporary folder of its own (data, the CLIs' homes, a home folder,
 * the default working directory), the fake CLIs first on its PATH and the OS credential store off.
 * Nothing of the user's own Harness Relay, CLIs or keychain is read or changed.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { ROOT, SERVER_ENTRY, WEB_DIR } from './paths';

/** What a fake CLI wrote to its log (E2E_FAKE_LOG): a start, or a prompt it got. */
export interface FakeLogEntry {
  cli: 'claude' | 'codex' | 'grok';
  pid: number;
  at: number;
  args?: string[];
  prompt?: string;
  briefing?: string;
}

export interface RelayServer {
  /** `http://127.0.0.1:<port>` */
  base: string;
  /** The temporary folder that holds everything below. */
  root: string;
  dataDir: string;
  /** The default working directory of new chats: a small project (see `seedProject`). */
  workDir: string;
  home: string;
  /** Another small project next to `workDir`, `<root>/<name>`, with a `<name>.md` of its own. */
  addProject(name: string): string;
  /** A one-time code that signs a browser in (`/#code=…`). */
  newSignInCode(): Promise<string>;
  /** A request to the API, signed in (as a browser of its own). */
  api<T = unknown>(path: string, init?: { method?: string; body?: unknown }): Promise<T>;
  /** What the fake CLIs logged so far. */
  fakeLog(): FakeLogEntry[];
  /** The server's output so far. */
  output(): string;
  stop(): Promise<void>;
}

export interface StartOptions {
  fakeBinDir: string;
  /** Extra environment for the server (and so for the CLIs). */
  env?: Record<string, string>;
}

const STARTUP_MS = 60_000;

export async function startRelay(o: StartOptions): Promise<RelayServer> {
  if (!existsSync(join(WEB_DIR, 'index.html'))) throw new Error(`The UI is not built in ${WEB_DIR}: run \`npm run build\`.`);
  // The real path: macOS's temporary folder is a link (/var → /private/var), Windows' may be a short
  // 8.3 name (RUNNER~1), and the server shows real paths.
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'relay-e2e-')));
  const dataDir = join(root, 'data');
  const home = join(root, 'home');
  const workDir = join(root, 'work');
  const fakeLog = join(root, 'fake-cli.jsonl');
  for (const d of [dataDir, home, join(home, '.claude'), join(home, '.codex'), join(home, '.grok'), join(home, '.config')]) mkdirSync(d, { recursive: true });
  seedProject(workDir);

  const env: NodeJS.ProcessEnv = { ...process.env };
  // Claude Code's nesting variables (when the tests run inside a Claude Code session) and the
  // runner's own: none of them is the server's business.
  for (const k of Object.keys(env)) if (/^(CLAUDECODE|CLAUDE_CODE_|PLAYWRIGHT_|PW_|TEST_|E2E_|FORCE_COLOR$)/.test(k)) delete env[k];
  Object.assign(env, {
    PORT: '0',
    HOST: '127.0.0.1',
    RELAY_DATA_DIR: dataDir,
    RELAY_DEFAULT_CWD: workDir,
    RELAY_WEB_DIR: WEB_DIR,
    RELAY_KEYRING: 'off',
    RELAY_KEYRING_SERVICE: 'harness-relay-e2e',
    RELAY_UPDATES: 'off',
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    CODEX_HOME: join(home, '.codex'),
    GROK_HOME: join(home, '.grok'),
    GIT_AUTHOR_NAME: 'Relay E2E',
    GIT_AUTHOR_EMAIL: 'e2e@example.com',
    GIT_COMMITTER_NAME: 'Relay E2E',
    GIT_COMMITTER_EMAIL: 'e2e@example.com',
    GIT_CONFIG_NOSYSTEM: '1',
    E2E_FAKE_LOG: fakeLog,
    // The fake CLIs first, found by name as the real ones are; this Node next, for the scripts.
    PATH: [o.fakeBinDir, dirname(process.execPath), env.PATH ?? env.Path ?? ''].join(delimiter),
    NO_COLOR: '1',
    ...o.env,
  });
  // Windows names it Path; two spellings would leave the child one of them.
  if (process.platform === 'win32') delete env.Path;

  let output = '';
  const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx', SERVER_ENTRY], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  const link = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`The server did not start in ${STARTUP_MS / 1000} s:\n${output}`)), STARTUP_MS);
    const take = (chunk: Buffer) => {
      output += chunk.toString('utf8');
      const m = /Sign this browser in[^:]*: (http:\/\/\S+)/.exec(output);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]!);
      }
    };
    child.stdout!.on('data', take);
    child.stderr!.on('data', take);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`The server exited (${code}) before it listened:\n${output}`));
    });
  });
  const url = new URL(link);
  const base = url.origin;
  const firstCode = /code=([^&]+)/.exec(url.hash)![1]!;

  // The tests' own requests sign in as a browser does: a cookie and a key.
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ code: firstCode }),
  });
  if (!login.ok) throw new Error(`Could not sign the tests in: ${login.status} ${await login.text()}`);
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
  const { key } = (await login.json()) as { key: string };

  const api = async <T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> => {
    const method = init.method ?? (init.body === undefined ? 'GET' : 'POST');
    const r = await fetch(base + path, {
      method,
      headers: {
        cookie,
        'x-relay-key': key,
        'x-relay-lang': 'en',
        origin: base,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${text}`);
    return (text ? JSON.parse(text) : undefined) as T;
  };

  return {
    base,
    root,
    dataDir,
    workDir,
    home,
    api,
    addProject(name) {
      const dir = join(root, name);
      seedProject(dir);
      writeFileSync(join(dir, `${name}.md`), `# ${name}\n`);
      return dir;
    },
    async newSignInCode() {
      return (await api<{ code: string }>('/api/auth/codes', { body: {} })).code;
    },
    fakeLog() {
      if (!existsSync(fakeLog)) return [];
      return readFileSync(fakeLog, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as FakeLogEntry);
    },
    output: () => output,
    async stop() {
      if (child.exitCode === null && child.signalCode === null) {
        // SIGTERM lets it stop its agents and close the database; Windows has no signal to send, so
        // the process ends at once there (the fake CLIs end with their stdin).
        child.kill('SIGTERM');
        await Promise.race([exited, new Promise((r) => setTimeout(r, 15_000))]);
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000))]);
      }
      // Windows may hold a file a moment after its process ended; a folder left in the temporary
      // folder is no reason to fail a test.
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
      } catch (err) {
        console.warn(`[e2e] could not remove ${root}: ${(err as Error).message}`);
      }
    },
  };
}

/** A small project to work in: a README, some code and a nested folder (not a git repository: edit mode makes one). */
export function seedProject(dir: string): void {
  mkdirSync(join(dir, 'src', 'lib'), { recursive: true });
  writeFileSync(join(dir, 'README.md'), '# Sample project\n\nA project the end-to-end tests work in.\n');
  writeFileSync(join(dir, 'src', 'hello.ts'), "export function hello(name: string): string {\n  return `Hello, ${name}!`;\n}\n");
  writeFileSync(join(dir, 'src', 'lib', 'math.ts'), 'export const add = (a: number, b: number) => a + b;\n');
}
