/**
 * One Harness Relay server for one test: `src/server/index.ts` with the built UI, on a free port,
 * with everything it keeps in a temporary folder of its own (data, the CLIs' homes, a home folder,
 * the default working directory), the fake CLIs first on its PATH and the OS credential store off.
 * The CLIs no fake stands in for (Cursor and the open agents) are not installed there, as on CI.
 * Nothing of the user's own Harness Relay, CLIs or keychain is read or changed.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { PROVIDERS } from '../../src/shared/types';
import { CLIS as FAKE_CLIS } from './fake-cli';
import { ROOT, SERVER_ENTRY, WEB_DIR } from './paths';

/** What a fake CLI wrote to its log (E2E_FAKE_LOG): a start, or a prompt it got; or a start of the fake folder dialog or the fake gh. */
export interface FakeLogEntry {
  cli: 'claude' | 'codex' | 'grok' | 'zenity' | 'gh';
  pid: number;
  at: number;
  args?: string[];
  prompt?: string;
  briefing?: string;
  /** A session started (`resumed: false`) or resumed. */
  session?: string;
  resumed?: boolean;
  /** The images and the tool library's MCP servers a turn got. */
  images?: number;
  mcp?: string[];
  /** The values the tool library's MCP servers were given, by server (env, or an HTTP server's headers). */
  mcpEnv?: Record<string, Record<string, string>>;
  /** A start: the CLI's home it runs in (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GROK_HOME`). */
  home?: string;
  /** A start: whether it was given an API key (`ANTHROPIC_API_KEY`, `XAI_API_KEY`): the one the test expects (`E2E_EXPECTED_API_KEY` in `serverEnv`), another, or none (null). */
  apiKey?: 'expected' | 'other' | null;
  /** A turn: the model and reasoning effort it runs with (null: the CLI's own default). */
  model?: string | null;
  effort?: string | null;
  /** A turn: the skills the CLI loaded by itself (its own, not the tool library's), and for Grok whether it trusts the folder. */
  skills?: string[];
  trusted?: boolean;
  /** The fake folder dialog's character set. */
  env?: { LANG: string | null; LC_CTYPE: string | null };
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
  /**
   * The live tests (`e2e/live/`): the real CLIs, signed in as the user is, on real models. The
   * server's data, working directories and keyring stay the test's own, but HOME and each CLI's own
   * folder are the user's (their sign-ins), no fake comes first on the PATH, and no CLI is set to be
   * missing; `E2E_LIVE_BIN_<PROVIDER>` names a CLI that is not on the PATH.
   */
  live?: boolean;
}

const STARTUP_MS = 60_000;

export async function startRelay(o: StartOptions): Promise<RelayServer> {
  if (!existsSync(join(WEB_DIR, 'index.html'))) throw new Error(`The UI is not built in ${WEB_DIR}: run \`npm run build\`.`);
  // The real path: macOS's temporary folder is a link (/var → /private/var), Windows' may be a short
  // 8.3 name (RUNNER~1), and the server shows real paths.
  // Live runs use Harness Relay's own sandbox, whose sockets need a short data folder path on macOS
  // and Linux: macOS's temporary folder is too deep for it.
  const root = realpathSync.native(mkdtempSync(join(o.live && process.platform !== 'win32' ? '/tmp' : tmpdir(), 'relay-e2e-')));
  const dataDir = join(root, 'data');
  const home = join(root, 'home');
  const workDir = join(root, 'work');
  const fakeLog = join(root, 'fake-cli.jsonl');
  for (const d of [dataDir, home, join(home, '.claude'), join(home, '.codex'), join(home, '.grok'), join(home, '.config')]) mkdirSync(d, { recursive: true });
  seedProject(workDir);

  const bins = Object.entries(process.env).flatMap(([k, v]) => {
    const m = /^E2E_LIVE_BIN_([A-Z]+)$/.exec(k);
    return m && v ? [[m[1]!.toLowerCase(), v] as const] : [];
  });
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Claude Code's nesting variables (when the tests run inside a Claude Code session), the runner's
  // own, and the developer's own Harness Relay settings (limits, a voice folder): none of them is the
  // server's business. A spec that needs one sets it (`serverEnv`).
  for (const k of Object.keys(env)) if (/^(CLAUDECODE|CLAUDE_CODE_|PLAYWRIGHT_|PW_|TEST_|E2E_|RELAY_|FORCE_COLOR$)/.test(k)) delete env[k];
  // Nor the user's own Cursor sign-in by key, or its folder (live runs sign in as the user does).
  if (!o.live) for (const k of ['CURSOR_API_KEY', 'CURSOR_AUTH_TOKEN', 'CURSOR_CONFIG_DIR']) delete env[k];
  // Nor, outside live runs, the developer's credentials: should a real CLI or gh ever be found
  // instead of a fake (a fake build removed under a run), it finds no key or token to reach a service with.
  if (!o.live) for (const k of Object.keys(env)) if (/^(ANTHROPIC_|OPENAI_|XAI_|GROK_|CODEX_|GH_|GITHUB_TOKEN$|GITHUB_ENTERPRISE_TOKEN$)|_(API_KEY|TOKEN|SECRET|SECRET_ACCESS_KEY|ACCESS_KEY_ID)$/i.test(k)) delete env[k];
  const homes = o.live
    ? {}
    : {
        HOME: home,
        USERPROFILE: home,
        XDG_CONFIG_HOME: join(home, '.config'),
        CLAUDE_CONFIG_DIR: join(home, '.claude'),
        CODEX_HOME: join(home, '.codex'),
        GROK_HOME: join(home, '.grok'),
      };
  Object.assign(env, {
    PORT: '0',
    HOST: '127.0.0.1',
    RELAY_DATA_DIR: dataDir,
    RELAY_DEFAULT_CWD: workDir,
    RELAY_WEB_DIR: WEB_DIR,
    RELAY_KEYRING: 'off',
    RELAY_KEYRING_SERVICE: 'harness-relay-e2e',
    ...homes,
    GIT_AUTHOR_NAME: 'Relay E2E',
    GIT_AUTHOR_EMAIL: 'e2e@example.com',
    GIT_COMMITTER_NAME: 'Relay E2E',
    GIT_COMMITTER_EMAIL: 'e2e@example.com',
    GIT_CONFIG_NOSYSTEM: '1',
    // Git looks for a repository no further up than the test's folder: one around it (a home kept
    // in git, a repository at C:\) is not the working directory's.
    GIT_CEILING_DIRECTORIES: root,
    E2E_FAKE_LOG: fakeLog,
    // The fake CLIs first, found by name as the real ones are; this Node next, for the scripts.
    PATH: [...(o.live ? [] : [o.fakeBinDir]), dirname(process.execPath), env.PATH ?? env.Path ?? ''].join(delimiter),
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
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      // SIGTERM lets it stop its agents and close the database; Windows has no signal to send, so
      // the process ends at once there (the fake CLIs end with their stdin).
      child.kill('SIGTERM');
      await Promise.race([exited, new Promise((r) => setTimeout(r, 15_000))]);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000))]);
    }
    // Windows may hold a file a moment after its process ended; a folder left in the temporary
    // folder is no reason to fail a test. Harness Relay makes some of an open agent's folders in
    // its home read-only (OpenCode's config): those are given back to their owner first.
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    } catch {
      try {
        makeWritable(root);
        rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
      } catch (err) {
        console.warn(`[e2e] could not remove ${root}: ${(err as Error).message}`);
      }
    }
  };
  try {
    return await signIn();
  } catch (err) {
    // A server that did not start, or would not sign the tests in, is not left running.
    await stop();
    throw err;
  }

  async function signIn(): Promise<RelayServer> {
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

    // The CLIs no fake stands in for (Cursor and the open agents) are not installed here, as on CI:
    // a real one on the user's PATH would otherwise be started (Cursor with the sign-in it keeps in
    // the macOS keychain), and what each test sees would depend on what that computer has. Their
    // executable is set to a path that does not exist, before the page asks for any CLI's status.
    // Live runs start the real ones, from the PATH or where E2E_LIVE_BIN_<PROVIDER> says.
    if (!o.live) {
      for (const p of PROVIDERS.filter((x) => !(FAKE_CLIS as readonly string[]).includes(x))) {
        await api(`/api/settings/providers/${p}`, { method: 'PUT', body: { bin: join(root, 'not-installed', p) } });
      }
    }
    for (const [p, bin] of o.live ? bins : []) await api(`/api/settings/providers/${p}`, { method: 'PUT', body: { bin } });

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
      stop,
    };
  }
}

/** Gives the owner write permission on `dir` and every folder under it, never following a link. */
function makeWritable(dir: string): void {
  let st;
  try {
    st = lstatSync(dir);
  } catch {
    return;
  }
  if (!st.isDirectory()) return;
  try {
    chmodSync(dir, (st.mode & 0o777) | 0o700);
  } catch {
    /* not ours to change: rmSync says so */
  }
  for (const name of readdirSync(dir)) makeWritable(join(dir, name));
}

/** A small project to work in: a README, some code and a nested folder (not a git repository: edit mode makes one). */
export function seedProject(dir: string): void {
  mkdirSync(join(dir, 'src', 'lib'), { recursive: true });
  writeFileSync(join(dir, 'README.md'), '# Sample project\n\nA project the end-to-end tests work in.\n');
  writeFileSync(join(dir, 'src', 'hello.ts'), "export function hello(name: string): string {\n  return `Hello, ${name}!`;\n}\n");
  writeFileSync(join(dir, 'src', 'lib', 'math.ts'), 'export const add = (a: number, b: number) => a + b;\n');
}
