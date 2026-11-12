/**
 * One Harness Relay server for one test: `src/server/index.ts` with the built UI, on a free port,
 * with everything it keeps in a temporary folder of its own (data, the CLIs' homes, a home folder,
 * the default working directory), the fake CLIs first on its PATH and the OS credential store off.
 * Beside it runs the test's fake model endpoint (`FakeEndpoint`), which is set up as a model backend,
 * and the open agents' default model is one of its models, so they are ready to run. The CLIs whose
 * fake is not written yet (`NOT_YET_FAKED`), or those a test names (`missingClis`), are not installed
 * there. Nothing of the user's own Harness Relay, CLIs or keychain is read or changed.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { OPEN_PROVIDERS, PROVIDERS, type Provider } from '../../src/shared/types';
import { fakeBin, NOT_YET_FAKED } from './fake-cli';
import { ROOT, SERVER_ENTRY, WEB_DIR } from './paths';

/**
 * What a fake CLI wrote to its log (E2E_FAKE_LOG): a start, or a prompt it got; or a start of the fake
 * folder dialog or the fake gh. A fake inside Harness Relay's own sandbox sends its lines to the fake
 * endpoint, which adds them to the same file a moment later: read them after the turn has `settled()`.
 */
export interface FakeLogEntry {
  /** The CLI, by provider id (`cursor` for `cursor-agent`, `antigravity` for `agy`). */
  cli: Provider | 'zenity' | 'gh';
  pid: number;
  at: number;
  /** Sent from inside Harness Relay's own sandbox, where the fake could not write the log itself. */
  sandboxed?: boolean;
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
  /** With `mcpEnv`: the URL of each server among them that the CLI was given as an HTTP server, by server. */
  mcpHttp?: Record<string, string>;
  /**
   * A start: the CLI's home it runs in, its account's (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GROK_HOME`,
   * Cursor's account folder, Antigravity's `.gemini` folder; for an open agent the folder of its state it
   * keeps its sessions in): the fake module's `home()`.
   */
  home?: string;
  /** A start: whether it was given an API key (`ANTHROPIC_API_KEY`, `XAI_API_KEY`, `CURSOR_API_KEY`, `GEMINI_API_KEY`; Codex: `CODEX_API_KEY`, `OPENAI_API_KEY`, else the one `codex login --with-api-key` kept in its home; each agent module's `apiKey()`): the one the test expects (`E2E_EXPECTED_API_KEY` in `serverEnv`), another, or none (null). */
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

/**
 * The test's fake model endpoint, a small HTTP server of its own: Harness Relay's endpoint `e2e`
 * (Settings → Model backends) with its models, unless the test asks for none (`openBackend: false`).
 * No model answers there: it lists its models (`GET /v1/models`), and takes the log lines of fakes
 * that run in Harness Relay's own sandbox (`POST /e2e-log`), the run's backend being the one host
 * the sandbox lets a run reach.
 */
export interface FakeEndpoint {
  /** Its base URL, as the endpoint's: `http://127.0.0.1:<port>/v1`. */
  url: string;
  /** The endpoint's id in Harness Relay, its models' prefix (`e2e/e2e-model`). */
  id: 'e2e';
  /** Its models, the first the open agents' default. */
  models: string[];
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
  /** The test's fake model endpoint. */
  fakeEndpoint: FakeEndpoint;
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
  /**
   * The CLIs not installed in this server: their executable is set to a path that does not exist.
   * By default the CLIs whose fake is not written yet (`NOT_YET_FAKED`). Not in live runs.
   */
  missingClis?: readonly Provider[];
  /**
   * Whether the fake endpoint is set up as a model backend and the open agents' default model is its
   * first (default true): they are ready to run. False leaves them installed but not ready. Not in live runs.
   */
  openBackend?: boolean;
  /** Whether OpenHands may use a terminal in Harness Relay's own sandbox (default true; macOS needs it below full access). Not in live runs. */
  sandboxTerminal?: boolean;
}

const STARTUP_MS = 60_000;

/**
 * The longest a test server's data folder may be on each system (in bytes), for Harness Relay's own
 * sandbox to have room for its sockets in it: `HOST_TMP_MAX` of src/server/relaySandbox.ts, less
 * `/srt/` and the host folder's six hex digits (`test/e2e-fakes.test.ts` checks that they agree).
 */
export const DATA_DIR_MAX: Partial<Record<NodeJS.Platform, number>> = { darwin: 70, linux: 61 };

/**
 * The folder test servers' folders are made in: E2E_TMP_DIR, else `/tmp` on macOS and Linux, whose
 * path is short enough for the relay sandbox's sockets (macOS's own temporary folder is not), else
 * Windows' temporary folder. Refused when a data folder there would be too long for the sandbox.
 */
function testRootBase(): string {
  const chosen = process.env.E2E_TMP_DIR;
  const base = chosen || (process.platform === 'win32' ? tmpdir() : '/tmp');
  if (chosen && !existsSync(chosen)) throw new Error(`E2E_TMP_DIR names a folder that does not exist: ${chosen}`);
  const max = DATA_DIR_MAX[process.platform];
  if (max !== undefined) {
    // The real path, as the server sees it (/tmp is /private/tmp on macOS), with mkdtemp's six characters.
    const data = join(realpathSync.native(base), 'relay-e2e-XXXXXX', 'data');
    const bytes = Buffer.byteLength(data);
    if (bytes > max) {
      throw new Error(
        `The tests' temporary folder ${base} is too deep for Harness Relay's own sandbox: a test's data folder there (${data}) takes ${bytes} bytes, ` +
          `and its sockets leave room for ${max} on this system. Set E2E_TMP_DIR to a folder with a shorter path.`,
      );
    }
  }
  return base;
}

/** The fake endpoint's models (`FakeEndpoint`). */
const FAKE_MODELS = ['e2e-model', 'e2e-model-mini'];

/** Starts the fake endpoint, which adds the log lines it is sent to `log`. */
async function startFakeEndpoint(log: string): Promise<{ endpoint: FakeEndpoint; logUrl: string; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    if (req.method === 'POST' && path === '/e2e-log') {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        let entry: unknown;
        try {
          entry = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          entry = undefined;
        }
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return void res.writeHead(400).end();
        appendFileSync(log, JSON.stringify(entry) + '\n');
        res.writeHead(204).end();
      });
      return;
    }
    if (req.method === 'GET' && path === '/v1/models') {
      const data = FAKE_MODELS.map((id) => ({ id, object: 'model', created: 0, owned_by: 'e2e' }));
      return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ object: 'list', data }));
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    endpoint: { url: `${origin}/v1`, id: 'e2e', models: [...FAKE_MODELS] },
    logUrl: `${origin}/e2e-log`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export async function startRelay(o: StartOptions): Promise<RelayServer> {
  if (!existsSync(join(WEB_DIR, 'index.html'))) throw new Error(`The UI is not built in ${WEB_DIR}: run \`npm run build\`.`);
  const notInstalled = o.missingClis ?? NOT_YET_FAKED;
  if (!o.live) {
    // Without its fakes, the server would find the real CLIs and gh on the PATH: refuse to start.
    const exe = process.platform === 'win32' ? '.exe' : '';
    const wanted = [...PROVIDERS.filter((p) => !notInstalled.includes(p)).map(fakeBin), `gh${exe}`];
    const missing = wanted.map((name) => join(o.fakeBinDir, name)).filter((bin) => !existsSync(bin));
    if (missing.length) throw new Error(`The fake CLIs are missing (${missing.join(', ')}): run the tests again to build them.`);
    // In use as long as servers start with it, so that a run of a changed script leaves it alone.
    const now = new Date();
    utimesSync(o.fakeBinDir, now, now);
  }
  // The real path: /tmp is a link on macOS (/tmp → /private/tmp), Windows' temporary folder may be a
  // short 8.3 name (RUNNER~1), and the server shows real paths. Harness Relay's own sandbox, which the
  // open agents run in below full access, needs a short data folder path on macOS and Linux.
  const root = realpathSync.native(mkdtempSync(join(testRootBase(), 'relay-e2e-')));
  const dataDir = join(root, 'data');
  const home = join(root, 'home');
  const workDir = join(root, 'work');
  const fakeLog = join(root, 'fake-cli.jsonl');
  const xdg = { config: join(home, '.config'), data: join(home, '.local', 'share'), state: join(home, '.local', 'state'), cache: join(home, '.cache') };
  for (const d of [dataDir, home, join(home, '.claude'), join(home, '.codex'), join(home, '.grok'), join(home, '.gemini'), ...Object.values(xdg)]) mkdirSync(d, { recursive: true });
  seedProject(workDir);
  const fake = await startFakeEndpoint(fakeLog);

  const bins = Object.entries(process.env).flatMap(([k, v]) => {
    const m = /^E2E_LIVE_BIN_([A-Z]+)$/.exec(k);
    return m && v ? [[m[1]!.toLowerCase(), v] as const] : [];
  });
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Claude Code's nesting variables (when the tests run inside a Claude Code session), the runner's
  // own, and the developer's own Harness Relay settings (limits, a voice folder): none of them is the
  // server's business. A spec that needs one sets it (`serverEnv`).
  for (const k of Object.keys(env)) if (/^(CLAUDECODE|CLAUDE_CODE_|PLAYWRIGHT_|PW_|TEST_|E2E_|RELAY_|FORCE_COLOR$)/.test(k)) delete env[k];
  // Nor the user's own Cursor or Antigravity sign-in by key or Google's credentials, Cursor's folder,
  // credential store or launcher name, or the user's own XDG folders (set to the test's below); live
  // runs sign in as the user does.
  const OWN = /^(CURSOR_API_KEY|CURSOR_AUTH_TOKEN|CURSOR_CONFIG_DIR|CURSOR_INVOKED_AS|AGENT_CLI_CREDENTIAL_STORE|NO_OPEN_BROWSER|GEMINI_API_KEY|AGY_ADC_AUTH|GOOGLE_APPLICATION_CREDENTIALS|GOOGLE_CLOUD_PROJECT|ANTIGRAVITY_.*|XDG_DATA_HOME|XDG_STATE_HOME|XDG_CACHE_HOME)$/;
  if (!o.live) for (const k of Object.keys(env)) if (OWN.test(k)) delete env[k];
  // Nor, outside live runs, the developer's credentials: should a real CLI or gh ever be found
  // instead of a fake (a fake build removed under a run), it finds no key or token to reach a service with.
  if (!o.live) for (const k of Object.keys(env)) if (/^(ANTHROPIC_|OPENAI_|XAI_|GROK_|CODEX_|GH_|GITHUB_TOKEN$|GITHUB_ENTERPRISE_TOKEN$)|_(API_KEY|TOKEN|SECRET|SECRET_ACCESS_KEY|ACCESS_KEY_ID)$/i.test(k)) delete env[k];
  const homes = o.live
    ? {}
    : {
        HOME: home,
        USERPROFILE: home,
        XDG_CONFIG_HOME: xdg.config,
        XDG_DATA_HOME: xdg.data,
        XDG_STATE_HOME: xdg.state,
        XDG_CACHE_HOME: xdg.cache,
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
    // Where a fake in Harness Relay's own sandbox sends its log lines (lib/log.cjs).
    E2E_FAKE_LOG_URL: fake.logUrl,
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
    await fake.close();
    // Harness Relay makes some of an open agent's folders in its home read-only (OpenCode's config,
    // made when the page asks for the models). Node 24 on macOS cannot empty them and calls that
    // ENOTEMPTY, which rmSync retries (15 s with the retries below, on each test that opened the app), so the
    // first try has none: when it fails, those folders are given back to their owner, then the rest is
    // removed with retries, since Windows may hold a file a moment after its process ended. A folder
    // left in the temporary folder is no reason to fail a test.
    try {
      rmSync(root, { recursive: true, force: true });
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

    // The CLIs a test leaves out, and those whose fake is not written yet, are not installed here: their
    // executable is set to a path that does not exist, before the page asks for any CLI's status. (The
    // fake ones say they are not written yet; and should a real one be found, it would be started with
    // whatever sign-in it keeps, and what each test sees would depend on what that computer has.)
    // Then the fake endpoint becomes a model backend and its first model the open agents' default, so
    // that they are ready to run, and OpenHands may use a terminal in Harness Relay's own sandbox.
    // Live runs start the real CLIs, from the PATH or where E2E_LIVE_BIN_<PROVIDER> says.
    if (!o.live) {
      for (const p of notInstalled) await api(`/api/settings/providers/${p}`, { method: 'PUT', body: { bin: join(root, 'not-installed', p) } });
      if (o.openBackend !== false) {
        const e = fake.endpoint;
        await api(`/api/backends/endpoints/${e.id}`, { method: 'PUT', body: { name: 'E2E', baseUrl: e.url, models: e.models } });
        for (const p of OPEN_PROVIDERS) await api(`/api/settings/providers/${p}/accounts/default`, { method: 'PUT', body: { defaultModel: `${e.id}/${e.models[0]}` } });
      }
      if (o.sandboxTerminal !== false) await api('/api/settings/providers/openhands', { method: 'PUT', body: { sandboxTerminal: true } });
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
      fakeEndpoint: fake.endpoint,
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
