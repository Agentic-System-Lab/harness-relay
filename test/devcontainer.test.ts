import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PORT } from '../src/server/ports';
import { signInLink } from '../src/server/signin';

// The dev container for GitHub Codespaces (.devcontainer/, docs/codespaces.md).

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
/** devcontainer.json is JSON with comments, each a line of its own. */
const config = JSON.parse(read('.devcontainer/devcontainer.json').replace(/^\s*\/\/.*$/gm, '')) as Record<string, unknown>;

/** What `links` in start.sh makes of `input`, with these Codespaces variables. */
function links(input: string, env: Record<string, string>): string {
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !['CODESPACE_NAME', 'GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN', 'PORT', 'RELAY_ALLOWED_HOSTS'].includes(k)),
  );
  return execFileSync('bash', ['-c', 'source .devcontainer/start.sh; links; echo "hosts=${RELAY_ALLOWED_HOSTS:-}"'], {
    cwd: root,
    input,
    env: { ...clean, ...env },
    encoding: 'utf8',
  });
}

const CODESPACES_ENV = '/workspaces/.codespaces/shared/.env';
const codespace = { CODESPACE_NAME: 'demo-x5w', GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: 'app.github.dev' };
const address = `demo-x5w-${DEFAULT_PORT}.app.github.dev`;

describe('the dev container', () => {
  it('forwards the port npm start listens on, and runs its own scripts', () => {
    expect(config.forwardPorts).toEqual([DEFAULT_PORT]);
    expect(Object.keys(config.portsAttributes as object)).toEqual([String(DEFAULT_PORT)]);
    expect(config.onCreateCommand).toBe('bash .devcontainer/setup.sh');
    expect(config.postAttachCommand).toBe('bash .devcontainer/start.sh');
  });

  it('gives bubblewrap what it needs, and no more than that', () => {
    expect(config.securityOpt).toEqual(['seccomp=unconfined', 'apparmor=unconfined', 'systempaths=unconfined']);
    expect(config.runArgs).toEqual(['--device=/dev/net/tun']);
    expect(config.privileged).toBeUndefined();
    expect(config.capAdd).toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')("points the server's sign-in link at the codespace's address, with its code beside it", () => {
    const out = links(`Harness Relay API listening on http://127.0.0.1:${DEFAULT_PORT}\nSign this browser in (once, within an hour): ${signInLink('ABCD-EF12', { host: '127.0.0.1', port: DEFAULT_PORT })}\n`, codespace);
    expect(out).toBe(
      `Harness Relay API listening on http://127.0.0.1:${DEFAULT_PORT}\n` +
        `Sign this browser in (once, within an hour): https://${address}/#code=ABCD-EF12\n` +
        '  (or type this code on the sign-in page: ABCD-EF12)\n' +
        `hosts=${address}\n`,
    );
  });

  it.skipIf(process.platform === 'win32')("rewrites npm run login's link too, without Vite's", () => {
    const login = read('scripts/login.ts');
    expect(login).toContain('`With npm run dev: ${');
    expect(login).toContain('`Or type the code on the sign-in page: ${code}`');
    const link = signInLink('WXYZ-9876', { host: '127.0.0.1', port: DEFAULT_PORT });
    const dev = signInLink('WXYZ-9876', { host: '127.0.0.1', port: DEFAULT_PORT, dev: true });
    const out = links(`Sign a browser in (once, within ten minutes): ${link}\nWith npm run dev: ${dev}\nOr type the code on the sign-in page: WXYZ-9876\n`, codespace);
    expect(out).toBe(`Sign a browser in (once, within ten minutes): https://${address}/#code=WXYZ-9876\n  (or type this code on the sign-in page: WXYZ-9876)\nhosts=${address}\n`);
  });

  it.skipIf(process.platform === 'win32')('keeps the hosts already allowed', () => {
    expect(links('', { ...codespace, RELAY_ALLOWED_HOSTS: 'my-computer.tail1234.ts.net' })).toBe(`hosts=${address},my-computer.tail1234.ts.net\n`);
  });

  // In a codespace, start.sh finds its address in the file Codespaces writes, whatever the environment says.
  it.skipIf(process.platform === 'win32' || existsSync(CODESPACES_ENV))('changes nothing outside a codespace', () => {
    const line = `Sign this browser in (once, within an hour): ${signInLink('ABCD-EF12', { host: '127.0.0.1', port: DEFAULT_PORT })}\n`;
    expect(links(line, {})).toBe(`${line}hosts=\n`);
  });
});
