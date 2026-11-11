// What the server says about itself, for a problem report (the sidebar's "Report a problem"): which
// Harness Relay this is, and on what. Nothing that names the user or their files.

import { arch, platform, release } from 'node:os';
import type { AboutInfo } from '../shared/types';
import { runProcess } from './process';
import { RELAY_ROOT } from './protect';

/** Set in the desktop app's server bundle (desktop/scripts/build.ts); not defined when run from source. */
declare const __RELAY_VERSION__: string | undefined;

/** The version the desktop app was built as (a release, or a `-dev` build of the day), if it was. */
export function bundledVersion(): string | undefined {
  return typeof __RELAY_VERSION__ === 'string' && __RELAY_VERSION__ ? __RELAY_VERSION__ : undefined;
}

/** The version shown: the one the app was built as, else the checkout's commit (`npm start`). */
export function versionText(bundled: string | undefined, commit: string | undefined): string {
  if (bundled) return bundled;
  return commit ? `source (${commit})` : 'source';
}

/** The checkout's commit, short, when Harness Relay runs from a git checkout. */
async function commit(): Promise<string | undefined> {
  try {
    const r = await runProcess({ bin: 'git', args: ['rev-parse', '--short', 'HEAD'], cwd: RELAY_ROOT, env: { ...process.env }, timeoutMs: 5_000 });
    const sha = r.stdout.trim();
    return r.code === 0 && /^[0-9a-f]{4,40}$/.test(sha) ? sha : undefined;
  } catch {
    return undefined;
  }
}

let version: Promise<string> | undefined;

/** This server's version, asked once (the commit does not change while it runs). */
export function relayVersion(): Promise<string> {
  const bundled = bundledVersion();
  version ??= bundled ? Promise.resolve(bundled) : commit().then((sha) => versionText(undefined, sha));
  return version;
}

export async function aboutInfo(desktop: boolean, getVersion: () => Promise<string> = relayVersion): Promise<AboutInfo> {
  return { version: await getVersion(), desktop, os: `${platform()} ${release()} (${arch()})`, node: process.version };
}
