import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/*
 * Which browser the browser tools start: the one `RELAY_BROWSER` names, else Playwright's own Chromium
 * (the newest it downloaded, in `PLAYWRIGHT_BROWSERS_PATH` or its usual cache), else Chrome, Chromium
 * or Edge where their installers put them. Each starts headless with a profile of its own
 * (`session.ts`), never the user's.
 */

export interface FindFs {
  isFile(path: string): boolean;
  list(dir: string): string[];
}

const realFs: FindFs = {
  isFile: (path) => {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  },
  list: (dir) => {
    try {
      return existsSync(dir) ? readdirSync(dir) : [];
    } catch {
      return [];
    }
  },
};

/** Where Playwright keeps the browsers it downloads, on each system. */
function playwrightCache(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string {
  if (env.PLAYWRIGHT_BROWSERS_PATH && env.PLAYWRIGHT_BROWSERS_PATH !== '0') return env.PLAYWRIGHT_BROWSERS_PATH;
  if (platform === 'darwin') return join(home, 'Library', 'Caches', 'ms-playwright');
  if (platform === 'win32') return join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'ms-playwright');
  return join(env.XDG_CACHE_HOME ?? join(home, '.cache'), 'ms-playwright');
}

/** The executable inside one of Playwright's `chromium-<n>` folders, as each system lays it out. */
function playwrightExecutables(dir: string, platform: NodeJS.Platform): string[] {
  if (platform === 'darwin') {
    return ['chrome-mac-arm64', 'chrome-mac-x64', 'chrome-mac'].flatMap((d) => [
      join(dir, d, 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
      join(dir, d, 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
    ]);
  }
  if (platform === 'win32') return [join(dir, 'chrome-win64', 'chrome.exe'), join(dir, 'chrome-win', 'chrome.exe')];
  return [join(dir, 'chrome-linux64', 'chrome'), join(dir, 'chrome-linux', 'chrome')];
}

/** Where the browsers' installers put them. */
function systemBrowsers(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string[] {
  if (platform === 'darwin') {
    const apps = ['Google Chrome.app/Contents/MacOS/Google Chrome', 'Chromium.app/Contents/MacOS/Chromium', 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge'];
    return [...apps.map((a) => join('/Applications', a)), ...apps.map((a) => join(home, 'Applications', a))];
  }
  if (platform === 'win32') {
    const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter((r): r is string => Boolean(r));
    return roots.flatMap((r) => [join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'), join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), join(r, 'Chromium', 'Application', 'chrome.exe')]);
  }
  return ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium', '/usr/bin/microsoft-edge'];
}

/** The browsers to try, in order. */
export function browserCandidates(
  o: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; home?: string; configured?: string; fs?: FindFs } = {},
): string[] {
  const platform = o.platform ?? process.platform;
  const env = o.env ?? process.env;
  const home = o.home ?? homedir();
  const fs = o.fs ?? realFs;
  const cache = playwrightCache(platform, env, home);
  // The newest first: chromium-1254 before chromium-1243.
  const versions = fs
    .list(cache)
    .filter((d) => /^chromium-\d+$/.test(d))
    .sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)));
  // The system's own browser before Playwright's: it is kept up to date (by itself, or with the
  // system's packages), where Playwright's stays the version it was downloaded as, and it opens pages
  // from anywhere.
  return [
    ...(o.configured ? [o.configured] : []),
    ...systemBrowsers(platform, env, home),
    ...versions.flatMap((d) => playwrightExecutables(join(cache, d), platform)),
  ];
}

/** The first browser there is, or undefined. */
export function findBrowser(o: Parameters<typeof browserCandidates>[0] = {}): string | undefined {
  const fs = o.fs ?? realFs;
  return browserCandidates(o).find((p) => fs.isFile(p));
}
