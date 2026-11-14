import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
function stub(name: string, body: string, dir = stubs): void {
  writeFileSync(join(dir, name), `#!/bin/sh\necho "${name} $*" >> "$STUB_CALLS"\n${body}\n`);
  chmodSync(join(dir, name), 0o755);
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

const INSTALLERS = ['https://x.ai/cli/install.sh', 'https://cursor.com/install', 'https://antigravity.google/cli/install.sh', 'https://dev.meta.ai/install.sh'];
const NPM_INSTALL = 'npm install -g @anthropic-ai/claude-code @openai/codex @github/copilot';

/**
 * Stand-ins for what setup.sh runs, each noting its arguments in `STUB_CALLS`:
 * - `sudo` does nothing.
 * - `curl` fetches an installer (the argument that is a URL, into the one after `-o`) that notes it ran
 *   and says so: the first one only once npm has started (it notes `npm not started` if npm has not
 *   within 5 s), the last one leaving `STUB_DONE`. For `STUB_FAILING` it fails instead (once npm is
 *   done, when npm does not wait), and for `STUB_BROKEN` it fetches one that fails.
 * - `npm` notes it started, waits up to 10 s for `STUB_DONE` (unless `STUB_NPM_WAITS` is 0), so that it
 *   is still installing while the installers run, then notes it is done, says so on both its outputs
 *   and exits with `STUB_NPM_STATUS`.
 */
const setupStubs = join(tmp, 'setup-bin');
mkdirSync(setupStubs);
stub('sudo', '', setupStubs);
// mktemp's own, in TMPDIR: macOS's puts a file of no template in its own temporary folder, whatever TMPDIR says.
writeFileSync(join(setupStubs, 'mktemp'), '#!/bin/sh\nexec /usr/bin/mktemp "$TMPDIR/tmp.XXXXXX"\n');
chmodSync(join(setupStubs, 'mktemp'), 0o755);
stub(
  'curl',
  String.raw`url=; out=
while [ $# -gt 0 ]; do
  case "$1" in -o) out=$2; shift ;; https://*) url=$1 ;; esac
  shift
done
if [ "$url" = "$STUB_FAILING" ]; then
  i=0
  while [ "$STUB_NPM_WAITS" = 0 ] && ! grep -qx "npm done" "$STUB_CALLS" && [ $i -lt 50 ]; do sleep 0.1; i=$((i + 1)); done
  exit 22
fi
cat > "$out" <<EOF
if [ "$url" = ${INSTALLERS[0]} ]; then
  i=0
  while [ ! -e "\$STUB_NPM_STARTED" ] && [ \$i -lt 50 ]; do sleep 0.1; i=\$((i + 1)); done
  [ -e "\$STUB_NPM_STARTED" ] || echo "npm not started" >> "\$STUB_CALLS"
fi
echo "ran $url" | tee -a "\$STUB_CALLS"
[ "$url" != "\$STUB_BROKEN" ] || exit 5
[ "$url" != ${INSTALLERS.at(-1)} ] || : > "\$STUB_DONE"
EOF`,
  setupStubs,
);
stub(
  'npm',
  `: > "$STUB_NPM_STARTED"
i=0
while [ "$STUB_NPM_WAITS" != 0 ] && [ ! -e "$STUB_DONE" ] && [ $i -lt 100 ]; do sleep 0.1; i=$((i + 1)); done
echo "npm done" >> "$STUB_CALLS"
echo "added 7 packages in 26s"
echo "npm warn deprecated something" >&2
exit "$STUB_NPM_STATUS"`,
  setupStubs,
);

/**
 * Runs setup.sh as `updateContentCommand` does, with the stand-ins, its temporary files in a folder of its
 * own: what it printed, its exit status, the stand-ins' calls (read when asked), `STUB_DONE`'s path, and
 * the temporary files it left.
 */
function setup(opts: { npmStatus?: number; npmWaits?: boolean; failing?: string; broken?: string } = {}) {
  const at = mkdtempSync(join(tmp, 'setup-'));
  const [calls, done, temp] = [join(at, 'calls'), join(at, 'done'), join(at, 'tmp')];
  mkdirSync(temp);
  writeFileSync(calls, '');
  const r = spawnSync('bash', [join(root, '.devcontainer', 'setup.sh')], {
    cwd: at,
    env: clean({
      HOME: at,
      TMPDIR: temp,
      PATH: `${setupStubs}${delimiter}${process.env.PATH}`,
      STUB_CALLS: calls,
      STUB_DONE: done,
      STUB_NPM_STARTED: join(at, 'npm-started'),
      STUB_NPM_WAITS: opts.npmWaits === false ? '0' : '1',
      STUB_NPM_STATUS: String(opts.npmStatus ?? 0),
      STUB_FAILING: opts.failing ?? '',
      STUB_BROKEN: opts.broken ?? '',
    }),
    encoding: 'utf8',
  });
  return { out: r.stdout, status: r.status, calls: () => readFileSync(calls, 'utf8').trim().split('\n'), done, left: () => readdirSync(temp) };
}
/** The installers that ran, in order. */
const ran = (calls: string[]) => calls.filter((c) => c.startsWith('ran '));

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
    // setup.sh also at each update of a prebuild, which runs onCreateCommand only when it is first made.
    expect(config.onCreateCommand).toBeUndefined();
    expect(config.updateContentCommand).toBe('bash .devcontainer/setup.sh && npm ci && npm run build');
    expect(config.postAttachCommand).toBe('bash .devcontainer/start.sh');
    // After the codespace is made for someone, never in a prebuild (updateContentCommand runs there).
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
    expect(setup).toContain(`\n${NPM_INSTALL} > "$npm_log" 2>&1 &\n`);
    // Their makers' own installers, fetched whole (again after a failure) and given no input.
    for (const url of INSTALLERS) expect(setup).toContain(`\ninstall_with ${url}\n`);
    expect(setup).toContain('curl -fsSL --retry 3 --retry-all-errors "$1" -o "$script"');
    expect(setup).toContain('bash "$script" < /dev/null');
    // Linked from a folder on every PATH: the installers' own folders are on an interactive shell's only.
    expect(setup).toContain('sudo ln -sf "$HOME/.grok/bin/grok" /usr/local/bin/grok');
    expect(setup).toContain('for cli in cursor-agent agy muse; do');
    for (const open of ['opencode', 'goose', 'cline', 'openhands', 'pi-coding-agent']) expect(setup, open).not.toContain(open + '-');
    expect(setup).not.toMatch(/npm install -g[^\n]*(opencode|cline|pi-coding-agent)/);
  });

  it.skipIf(!posix)("installs npm's CLIs while the makers' installers run one after another, and shows npm's output after theirs", () => {
    const r = setup();
    expect(r.status).toBe(0);
    const calls = r.calls();
    expect(calls).toContain(NPM_INSTALL);
    expect(ran(calls)).toEqual(INSTALLERS.map((url) => `ran ${url}`));
    // npm had started before the first installer ran, and was still installing when the last one had.
    expect(calls).not.toContain('npm not started');
    expect(calls.indexOf('npm done')).toBeGreaterThan(calls.indexOf(`ran ${INSTALLERS.at(-1)}`));
    // The sandboxes' packages, the links and the playground.
    expect(calls).toContain('sudo apt-get install -y --no-install-recommends bubblewrap socat ripgrep slirp4netns iproute2 iptables');
    expect(calls.filter((c) => c.startsWith('sudo ln -sf '))).toHaveLength(4);
    expect(calls.some((c) => c.startsWith('sudo install -d ') && c.endsWith(' /workspaces/playground'))).toBe(true);
    // npm's output (both of its streams) in one piece, after the installers'; its log and the installers removed.
    expect(r.out).toBe(`${ran(calls).join('\n')}\nadded 7 packages in 26s\nnpm warn deprecated something\n`);
    expect(r.left()).toEqual([]);
  });

  it.skipIf(!posix)("fails when npm's install fails, once the rest is installed, with what npm said", () => {
    const r = setup({ npmStatus: 3 });
    expect(r.status).toBe(3);
    expect(r.calls()).toContain(`ran ${INSTALLERS.at(-1)}`);
    expect(r.out).toMatch(/\nadded 7 packages in 26s\nnpm warn deprecated something\n$/);
    expect(r.left()).toEqual([]);
  });

  it.skipIf(!posix)("fails when an installer cannot be fetched or fails, and stops npm's install then", async () => {
    const r = setup({ failing: INSTALLERS[1] });
    expect(r.status).toBe(22);
    expect(ran(r.calls())).toEqual([`ran ${INSTALLERS[0]}`]);
    expect(r.out).not.toContain('added 7 packages');
    // Nothing left: npm's log, nor the installer that could not be fetched.
    expect(r.left()).toEqual([]);
    // Stopped: once what it waits for is there, it would be done within a tenth of a second.
    writeFileSync(r.done, '');
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(r.calls()).not.toContain('npm done');

    // An installer that fails: its status, and none after it.
    const broken = setup({ broken: INSTALLERS[2] });
    expect(broken.status).toBe(5);
    expect(ran(broken.calls())).toEqual(INSTALLERS.slice(0, 3).map((url) => `ran ${url}`));
    expect(broken.left()).toEqual([]);

    // npm done already: the installer's status still, not that of stopping npm.
    const early = setup({ failing: INSTALLERS[1], npmWaits: false });
    expect(early.calls()).toContain('npm done');
    expect(early.status).toBe(22);
    expect(early.left()).toEqual([]);
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
