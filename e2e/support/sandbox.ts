/**
 * Whether Harness Relay's own sandbox can work on this computer, as far as the tests can tell
 * before a server tries it: `e2e/global-setup.ts` asks once and tells the workers
 * (`E2E_RELAY_SANDBOX`), for `support/clis.ts`.
 */
import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

/** A program on the system's folders or the PATH, as the server looks for the sandbox's (`relaySandboxTools`). */
function findProgram(name: string): string | undefined {
  const dirs = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', ...(process.env.PATH ?? '').split(delimiter).filter((d) => isAbsolute(d))];
  for (const dir of dirs) {
    const path = join(dir, name);
    try {
      if (!statSync(path).isFile()) continue;
      accessSync(path, constants.X_OK);
      return path;
    } catch {
      // not here
    }
  }
  return undefined;
}

/**
 * Whether Harness Relay's own sandbox, which the open agents run in below full access, can work
 * here: `ok`, or why not. What it needs before it starts (`platformRefusal` in
 * src/server/relaySandbox.ts): macOS's sandbox-exec; on Linux bubblewrap, socat and ripgrep, and a
 * bubblewrap that may make its namespaces (Ubuntu's AppArmor may forbid it). Each server still
 * checks it for real before its first sandboxed run.
 */
export function relaySandboxHere(): string {
  if (process.platform === 'win32') return 'Harness Relay has no sandbox of its own on Windows: the open agents run with full access only';
  if (process.platform === 'darwin') return existsSync('/usr/bin/sandbox-exec') ? 'ok' : 'macOS has no /usr/bin/sandbox-exec';
  if (process.platform !== 'linux') return `Harness Relay's own sandbox does not run on ${process.platform}`;
  const tools = { bwrap: 'bubblewrap (bwrap)', socat: 'socat', rg: 'ripgrep (rg)' };
  const missing = Object.entries(tools).filter(([bin]) => !findProgram(bin));
  if (missing.length) return `${missing.map(([, what]) => what).join(', ')} not installed`;
  const tried = spawnSync(findProgram('bwrap')!, ['--ro-bind', '/', '/', 'true'], { encoding: 'utf8', timeout: 15_000 });
  if (tried.status !== 0) return `bubblewrap cannot make its namespaces here: ${(tried.stderr || String(tried.error ?? `exit ${tried.status}`)).trim().slice(-300)}`;
  return 'ok';
}
