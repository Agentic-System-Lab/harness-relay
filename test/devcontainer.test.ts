import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
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
  const drop = ['CODESPACE_NAME', 'GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN', 'PORT', 'RELAY_ALLOWED_HOSTS'];
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

// Each start runs bash, sed and the stand-ins: more than Vitest's 5 s on a busy system.
describe('the dev container', { timeout: slow(20_000) }, () => {
  it('forwards the port npm start listens on, and runs its own scripts', () => {
    expect(config.forwardPorts).toEqual([DEFAULT_PORT]);
    expect(Object.keys(config.portsAttributes as object)).toEqual([String(DEFAULT_PORT)]);
    expect(config.onCreateCommand).toBe('bash .devcontainer/setup.sh');
    expect(config.postAttachCommand).toBe('bash .devcontainer/start.sh');
  });

  it('gives bubblewrap what it needs, and no more than that', () => {
    expect(config.securityOpt).toEqual(['seccomp=unconfined', 'apparmor=unconfined', 'systempaths=unconfined']);
    expect(config.runArgs).toEqual(['--device=/dev/net/tun']);
    for (const key of ['privileged', 'capAdd', 'mounts', 'init']) expect(config[key], key).toBeUndefined();
    // A feature can ask for more of its own (docker-in-docker runs privileged): only these two.
    expect(Object.keys(config.features as object)).toEqual(['ghcr.io/devcontainers/features/sshd:1', 'ghcr.io/devcontainers/features/github-cli:1']);
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

  // In a codespace, start.sh finds its address in the file Codespaces writes, whatever the environment says.
  it.skipIf(!posix || existsSync(CODESPACES_ENV))('changes nothing outside a codespace', () => {
    const { out } = start(false, {});
    expect(out).toContain(`Sign this browser in (once, within an hour): ${serverLink('ABCD-EF12')}\n`);
    expect(out).not.toContain('https://');
    expect(links('With npm run dev: x\n', {})).toBe('With npm run dev: x\nhosts=\n');
  });
});
