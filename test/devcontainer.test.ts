import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { MIRROR, REPO } from '../site/assets/downloads.js';
import { DEFAULT_HOST, DEFAULT_PORT } from '../src/server/ports';
import { signInLink } from '../src/server/signin';
import { slow } from './timeouts';

// The dev container for GitHub Codespaces (.devcontainer/, docs/codespaces.md). The scripts run in bash,
// which the Windows runners do not have as Linux's: skipped there.

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
/** devcontainer.json is JSON with comments, each a line of its own. */
const config = JSON.parse(read('.devcontainer/devcontainer.json').replace(/^\s*\/\/.*$/gm, '')) as Record<string, unknown>;

const posix = process.platform !== 'win32';
const tmp = mkdtempSync(join(tmpdir(), 'relay-devcontainer-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** The environment without what Codespaces, an earlier test or the user's shell set for start.sh. */
function clean(env: Record<string, string>): NodeJS.ProcessEnv {
  const drop = ['CODESPACES', 'CODESPACE_NAME', 'GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN', 'GITHUB_REPOSITORY', 'PORT', 'RELAY_ALLOWED_HOSTS', 'DO_NOT_TRACK'];
  return { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !drop.includes(k))), ...env };
}

/** What `links` in start.sh makes of `input`, with these Codespaces variables. */
function links(input: string, env: Record<string, string>): string {
  return execFileSync('bash', ['-c', 'source .devcontainer/start.sh; links; echo "hosts=${RELAY_ALLOWED_HOSTS:-}"'], { cwd: root, input, env: clean(env), encoding: 'utf8' });
}

const CODESPACES_ENV = '/workspaces/.codespaces/shared/.env';
const codespace = { CODESPACE_NAME: 'demo-x5w', GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: 'app.github.dev' };
const address = `demo-x5w-${DEFAULT_PORT}.app.github.dev`;
/** The server's own sign-in link, as it prints it on the address it listens on by default. */
const serverLink = (code: string) => signInLink(code, { host: DEFAULT_HOST, port: DEFAULT_PORT });

/**
 * Stand-ins for `curl` (exits 0 when `STUB_RUNNING` says a server runs) and `npm` (`npm start` prints
 * what the server prints at start, on both its outputs; `npm run --silent login` what scripts/login.ts
 * prints), each noting its arguments in `STUB_CALLS`. Made once: macOS looks a new program over the first
 * time it runs.
 */
const stubs = join(tmp, 'bin');
mkdirSync(stubs);
function stub(name: string, body: string): void {
  writeFileSync(join(stubs, name), `#!/bin/sh\necho "${name} $*" >> "$STUB_CALLS"\n${body}\n`);
  chmodSync(join(stubs, name), 0o755);
}
stub('curl', '[ "$STUB_RUNNING" = 1 ] && exit 0 || exit 7');
stub(
  'npm',
  `case "$*" in
  start)
    echo "Harness Relay API listening on http://${DEFAULT_HOST}:${DEFAULT_PORT}"
    echo "[secrets] system keyring unavailable" >&2
    echo "Sign this browser in (once, within an hour): ${serverLink('ABCD-EF12')}" ;;
  "run --silent login")
    echo "Sign a browser in (once, within ten minutes): ${serverLink('WXYZ-9876')}"
    echo "With npm run dev: ${signInLink('WXYZ-9876', { host: DEFAULT_HOST, port: DEFAULT_PORT, dev: true })}"
    echo "Or type the code on the sign-in page: WXYZ-9876" ;;
  *) exit 9 ;;
esac`,
);

/** Runs start.sh as `postAttachCommand` does, with the stand-ins: what it printed, and their arguments. */
function start(running: boolean, env: Record<string, string>): { out: string; calls: string[] } {
  const calls = join(mkdtempSync(join(tmp, 'run-')), 'calls');
  const out = execFileSync('bash', [join(root, '.devcontainer', 'start.sh')], {
    cwd: tmp,
    env: clean({ ...env, PATH: `${stubs}${delimiter}${process.env.PATH}`, STUB_RUNNING: running ? '1' : '0', STUB_CALLS: calls }),
    encoding: 'utf8',
  });
  return { out, calls: readFileSync(calls, 'utf8').trim().split('\n') };
}

/**
 * A checkout as count.sh needs it (its scripts and the module that names the mirror and the repository),
 * on `branch`, in a folder of its own, so that its mark goes there: count.sh run in it as
 * `postCreateCommand` runs it, with a stand-in for `curl` that succeeds unless `fails`. What it printed,
 * curl's arguments, and whether it left its mark.
 */
function counter(branch = 'latest-release', downloads = read('site/assets/downloads.js')) {
  const at = mkdtempSync(join(tmp, 'checkout-'));
  for (const path of ['.devcontainer/count.sh', '.devcontainer/codespace.sh']) {
    mkdirSync(join(at, path, '..'), { recursive: true });
    writeFileSync(join(at, path), read(path));
  }
  mkdirSync(join(at, 'site', 'assets'), { recursive: true });
  writeFileSync(join(at, 'site', 'assets', 'downloads.js'), downloads);
  execFileSync('git', ['init', '-q', '-b', branch], { cwd: at });
  const curl = join(at, 'bin', 'curl');
  mkdirSync(join(at, 'bin'));
  writeFileSync(curl, '#!/bin/sh\necho "curl $*" >> "$STUB_CALLS"\n[ "$STUB_FAILS" = 1 ] && exit 22 || exit 0\n');
  chmodSync(curl, 0o755);
  const calls = join(at, 'calls');
  return (env: Record<string, string>, fails = false) => {
    writeFileSync(calls, '');
    const out = execFileSync('bash', [join(at, '.devcontainer', 'count.sh')], {
      cwd: tmp,
      env: clean({ ...env, PATH: `${join(at, 'bin')}${delimiter}${process.env.PATH}`, STUB_CALLS: calls, STUB_FAILS: fails ? '1' : '0' }),
      encoding: 'utf8',
    });
    return { out, calls: readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean), marked: existsSync(join(at, 'data', 'codespace-counted')) };
  };
}
const COUNT = `curl -fsS -o /dev/null --connect-timeout 3 --max-time 5 -X POST ${MIRROR}/codespaces`;
/** A codespace the README's and the website's links make: this repository's, on the newest release's branch. */
const LINKED = { CODESPACES: 'true', GITHUB_REPOSITORY: REPO };

// Each start runs bash, sed and the stand-ins: more than Vitest's 5 s on a busy system.
describe('the dev container', { timeout: slow(20_000) }, () => {
  it('forwards the port npm start listens on, and runs its own scripts', () => {
    expect(config.forwardPorts).toEqual([DEFAULT_PORT]);
    expect(Object.keys(config.portsAttributes as object)).toEqual([String(DEFAULT_PORT)]);
    expect(config.onCreateCommand).toBe('bash .devcontainer/setup.sh');
    expect(config.postAttachCommand).toBe('bash .devcontainer/start.sh');
    // After the codespace is made for someone, never in a prebuild (onCreateCommand and
    // updateContentCommand run there).
    expect(config.postCreateCommand).toBe('bash .devcontainer/count.sh');
    // The create page asks for no secrets (recommended secrets): API keys and DO_NOT_TRACK are set on GitHub, if at all.
    expect(config.secrets).toBeUndefined();
  });

  it('gives bubblewrap what it needs, and no more than that', () => {
    expect(config.securityOpt).toEqual(['seccomp=unconfined', 'apparmor=unconfined', 'systempaths=unconfined']);
    expect(config.runArgs).toEqual(['--device=/dev/net/tun']);
    for (const key of ['privileged', 'capAdd', 'mounts', 'init']) expect(config[key], key).toBeUndefined();
    // A feature can ask for more of its own (docker-in-docker runs privileged): only these two.
    expect(Object.keys(config.features as object)).toEqual(['ghcr.io/devcontainers/features/sshd:1', 'ghcr.io/devcontainers/features/github-cli:1']);
  });

  it('installs the seven agent CLIs that are not open source, where the server finds them, and no open-source agent', () => {
    const setup = read('.devcontainer/setup.sh');
    expect(setup).toContain('npm install -g @anthropic-ai/claude-code @openai/codex @github/copilot\n');
    // Their makers' own installers, fetched whole and given no input.
    for (const url of ['https://x.ai/cli/install.sh', 'https://cursor.com/install', 'https://antigravity.google/cli/install.sh', 'https://dev.meta.ai/install.sh']) {
      expect(setup).toContain(`install_with ${url}\n`);
    }
    expect(setup).toContain('bash "$script" < /dev/null');
    // Linked from a folder on every PATH: the installers' own folders are on an interactive shell's only.
    expect(setup).toContain('sudo ln -sf "$HOME/.grok/bin/grok" /usr/local/bin/grok');
    expect(setup).toContain('for cli in cursor-agent agy muse; do');
    for (const open of ['opencode', 'goose', 'cline', 'openhands', 'pi-coding-agent']) expect(setup, open).not.toContain(open + '-');
    expect(setup).not.toMatch(/npm install -g[^\n]*(opencode|cline|pi-coding-agent)/);
  });

  it.skipIf(!posix)("starts the server with the codespace's address allowed, and its sign-in link on that address", () => {
    const { out, calls } = start(false, codespace);
    expect(out).toBe(
      'Starting Harness Relay. Stop it with Ctrl+C; start it again with: bash .devcontainer/start.sh\n' +
        `Harness Relay API listening on http://${DEFAULT_HOST}:${DEFAULT_PORT}\n` +
        // What the server says on stderr is shown too.
        '[secrets] system keyring unavailable\n' +
        `Sign this browser in (once, within an hour): https://${address}/#code=ABCD-EF12\n` +
        '  (or type this code on the sign-in page: ABCD-EF12)\n',
    );
    // It asked the server's own address whether one runs there already, on a route that needs no sign-in.
    expect(calls).toEqual([`curl -fsS -o /dev/null --max-time 2 http://${DEFAULT_HOST}:${DEFAULT_PORT}/api/auth`, 'npm start']);
  });

  it.skipIf(!posix)('prints another link on that address when the server runs already, without Vite\'s', () => {
    const { out, calls } = start(true, codespace);
    expect(out).toBe(
      'Harness Relay is running already.\n' +
        `Sign a browser in (once, within ten minutes): https://${address}/#code=WXYZ-9876\n` +
        '  (or type this code on the sign-in page: WXYZ-9876)\n',
    );
    expect(calls.at(-1)).toBe('npm run --silent login');
    // What scripts/login.ts prints is what the stand-in prints.
    const login = read('scripts/login.ts');
    expect(login).toContain('`Sign a browser in (once, within ten minutes): ${signInLink(');
    expect(login).toContain('`With npm run dev: ${');
    expect(login).toContain('`Or type the code on the sign-in page: ${code}`');
  });

  it.skipIf(!posix)('keeps the hosts already allowed', () => {
    expect(links('', { ...codespace, RELAY_ALLOWED_HOSTS: 'my-computer.tail1234.ts.net' })).toBe(`hosts=${address},my-computer.tail1234.ts.net\n`);
  });

  it.skipIf(!posix)("reads the codespace's name from Codespaces' file in a shell without its profile, and only the names it asks for", () => {
    const dir = join(tmp, 'codespaces');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, '.env');
    writeFileSync(file, 'CODESPACE_NAME=old\nGITHUB_TOKEN=ghu_secret\nCODESPACE_NAME=demo-x5w\n');
    const ask = (name: string, env: Record<string, string> = {}) =>
      execFileSync('bash', ['-c', `source .devcontainer/start.sh; codespace_var ${name} "$F"`], { cwd: root, env: clean({ ...env, F: file }), encoding: 'utf8' });
    // Its last line for the name, as the profile that sources it would leave it.
    expect(ask('CODESPACE_NAME')).toBe('demo-x5w');
    // The environment first.
    expect(ask('CODESPACE_NAME', { CODESPACE_NAME: 'from-env' })).toBe('from-env');
    expect(ask('GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN')).toBe('');
  });

  it.skipIf(!posix)('counts a codespace once, at the mirror, with nothing in the request', () => {
    const run = counter();
    const first = run(LINKED);
    expect(first.calls).toEqual([COUNT]);
    expect(first.out).toBe('');
    expect(first.marked).toBe(true);
    // Not again, when it is rebuilt: the mark is in data/, which a rebuild keeps with /workspaces.
    expect(run(LINKED).calls).toEqual([]);
    expect(read('.gitignore')).toMatch(/^\/?data\/?$/m);
  });

  it.skipIf(!posix)('tries again at the next rebuild when the mirror could not count it, and never fails the codespace', () => {
    const run = counter();
    const failed = run(LINKED, true);
    expect(failed.calls).toEqual([COUNT]);
    expect(failed.out).toBe('');
    expect(failed.marked).toBe(false);
    expect(run(LINKED).calls).toEqual([COUNT]);
  });

  it.skipIf(!posix)('leaves it uncounted with DO_NOT_TRACK set, and says so', () => {
    for (const value of ['1', 'true', 'yes']) {
      const r = counter()({ ...LINKED, DO_NOT_TRACK: value });
      expect(r.calls, value).toEqual([]);
      expect(r.out, value).toBe('DO_NOT_TRACK is set: this codespace is not counted.\n');
      expect(r.marked, value).toBe(false);
    }
    // 0, or empty, is not set.
    for (const value of ['0', '']) expect(counter()({ ...LINKED, DO_NOT_TRACK: value }).calls, value).toEqual([COUNT]);
  });

  it.skipIf(!posix)("counts only what the links make: not a fork's codespace, nor one on another branch, nor without a mirror", () => {
    for (const repo of ['someone/harness-relay', '']) expect(counter()({ CODESPACES: 'true', GITHUB_REPOSITORY: repo }).calls, repo).toEqual([]);
    for (const branch of ['main', 'my-fix']) expect(counter(branch)(LINKED).calls, branch).toEqual([]);
    // The branch is the one the Release workflow moves to each release.
    expect(read('.github/workflows/release.yml')).toMatch(/^ {2}CODESPACES_BRANCH: latest-release$/m);
    // MIRROR emptied: no mirror to count at.
    const none = read('site/assets/downloads.js').replace(/^export const MIRROR = '[^']*';$/m, "export const MIRROR = '';");
    expect(none).toContain("export const MIRROR = '';");
    const r = counter('latest-release', none)(LINKED);
    expect(r.calls).toEqual([]);
    expect(r.marked).toBe(false);
  });

  it('counts at the mirror the website names', () => {
    expect(MIRROR).toMatch(/^https:\/\/[^/]+$/);
    expect(read('.devcontainer/count.sh')).toContain(`import { MIRROR, REPO } from './site/assets/downloads.js'`);
  });

  // In a codespace, Codespaces' file says it is one, whatever the environment says.
  it.skipIf(!posix || existsSync(CODESPACES_ENV))('counts nothing outside a codespace (a dev container on your own computer)', () => {
    for (const env of [{}, { CODESPACES: 'false' }] as Record<string, string>[]) {
      const r = counter()(env);
      expect(r.calls).toEqual([]);
      expect(r.out).toBe('');
      expect(r.marked).toBe(false);
    }
  });

  // In a codespace, start.sh finds its address in the file Codespaces writes, whatever the environment says.
  it.skipIf(!posix || existsSync(CODESPACES_ENV))('changes nothing outside a codespace', () => {
    const { out } = start(false, {});
    expect(out).toContain(`Sign this browser in (once, within an hour): ${serverLink('ABCD-EF12')}\n`);
    expect(out).not.toContain('https://');
    expect(links('With npm run dev: x\n', {})).toBe('With npm run dev: x\nhosts=\n');
  });
});
