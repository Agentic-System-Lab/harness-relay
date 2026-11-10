// Harness Relay landing page: the download buttons. The page links every button to the releases page;
// this module points each one at its installer in the newest release (release candidates included:
// GitHub's "latest release" link skips pre-releases), names the visitor's system on the main button,
// and marks it in the quick start. Its functions are tested in test/site-downloads.test.ts.

export const REPO = 'Agentic-System-Lab/harness-relay';
export const RELEASES_PAGE = `https://github.com/${REPO}/releases`;

/**
 * The end of each installer's file name: the Release workflow names them
 * Harness-Relay-<version>-<os>-<arch>.<ext> (.github/workflows/release.yml).
 */
export const INSTALLERS = {
  // One app for Apple Silicon and Intel Macs: a browser cannot tell them apart (Safari says "Intel"
  // on both), so there is nothing to choose.
  mac: '-mac-universal.dmg',
  win: '-win-x64.exe',
  linux: '-linux-x86_64.AppImage',
};

/** Where the installers are: links to anything else are not used (a forged or broken API answer). */
export const DOWNLOAD_PREFIX = `https://github.com/${REPO}/releases/download/`;

/** Whether `url` is an installer's address on GitHub (not a page of another site, nor `javascript:`). */
export function isInstallerUrl(url) {
  return typeof url === 'string' && url.startsWith(DOWNLOAD_PREFIX) && !/[\s"'<>]/.test(url);
}

/**
 * The visitor's system: 'mac', 'win' or 'linux' for the computers with an installer, 'mobile' for a
 * phone or tablet (iPadOS says it is a Mac, but has touch), else 'other': ChromeOS, BSD, or Linux on
 * ARM, which the x64 AppImage does not run on (when the browser says so).
 */
export function systemOf({ userAgent = '', platform = '', uaPlatform = '', maxTouchPoints = 0 } = {}) {
  const ua = userAgent.toLowerCase();
  const p = `${uaPlatform} ${platform}`.toLowerCase();
  if (/android|iphone|ipad|ipod/.test(ua) || /android|ios|iphone|ipad/.test(p)) return 'mobile';
  if (/mac/.test(p) || /macintosh|mac os x/.test(ua)) return maxTouchPoints > 1 ? 'mobile' : 'mac';
  if (/win/.test(p) || /windows/.test(ua)) return 'win';
  if (/cros|chrome os|chromeos/.test(p) || /\bcros\b/.test(ua)) return 'other';
  if (/linux/.test(p) || /linux|x11/.test(ua)) return /aarch64|arm/.test(`${ua} ${p}`) ? 'other' : 'linux';
  return 'other';
}

/** A release's installers, by system: { url, name, size } each, for the ones it has. */
export function installersOf(release) {
  const found = {};
  for (const asset of release?.assets ?? []) {
    for (const [system, end] of Object.entries(INSTALLERS)) {
      if (typeof asset?.name === 'string' && asset.name.endsWith(end) && isInstallerUrl(asset.browser_download_url)) {
        found[system] = { url: asset.browser_download_url, name: asset.name, size: asset.size };
      }
    }
  }
  return found;
}

/**
 * The newest published release with at least one installer, from GitHub's list of releases (newest
 * first, drafts left out): { tag, prerelease, installers }, or null when there is none yet.
 */
export function newestRelease(releases) {
  if (!Array.isArray(releases)) return null;
  const published = releases
    .filter((r) => r && !r.draft && typeof r.tag_name === 'string')
    .sort((a, b) => String(b.published_at ?? '').localeCompare(String(a.published_at ?? '')));
  for (const r of published) {
    const installers = installersOf(r);
    if (Object.keys(installers).length) return { tag: r.tag_name, prerelease: Boolean(r.prerelease), installers };
  }
  return null;
}

/** "122 MB" (decimal megabytes, as the systems show file sizes). */
export function sizeLabel(bytes) {
  return Number.isFinite(bytes) && bytes > 0 ? `${Math.max(1, Math.round(bytes / 1e6))} MB` : '';
}

// ---------- On the page ----------

export const STORAGE_KEY = 'harness-relay.release';
const FRESH_MS = 10 * 60 * 1000;

/**
 * Points the page's download links at the newest release. The page's own words come from data
 * attributes on [data-downloads] (both languages): data-mac / data-win / data-linux (the main button
 * for each system), data-rc and data-release (the version line), data-mobile (on a phone). The
 * browser's objects are passed in, so the tests can give fakes.
 */
export function wire({
  doc = globalThis.document,
  nav = globalThis.navigator,
  storage = globalThis.localStorage,
  fetchJson = (url) =>
    fetch(url, { headers: { Accept: 'application/vnd.github+json' } }).then((res) =>
      res.ok ? res.json() : Promise.reject(new Error(String(res.status))),
    ),
  now = Date.now,
} = {}) {
  const root = doc?.querySelector('[data-downloads]');
  if (!root) return Promise.resolve();
  const words = root.dataset;
  const system = systemOf({
    userAgent: nav?.userAgent,
    platform: nav?.platform,
    uaPlatform: nav?.userAgentData?.platform,
    maxTouchPoints: nav?.maxTouchPoints,
  });
  const store = (value) => {
    try {
      if (value === undefined) return storage?.getItem(STORAGE_KEY) ?? null;
      storage?.setItem(STORAGE_KEY, value);
    } catch {}
    return null;
  };

  const primary = doc.querySelector('[data-download-primary]');
  const primaryLabel = primary?.querySelector('[data-download-label]');
  const meta = [...doc.querySelectorAll('[data-release-meta]')];
  // Mark the visitor's system in the quick start, and name it on the main button.
  for (const card of doc.querySelectorAll('[data-download]')) {
    if (card.dataset.download === system) card.classList.add('is-yours');
  }
  if (primary && primaryLabel && system in INSTALLERS && words[system]) primaryLabel.textContent = words[system];
  if (primary && !(system in INSTALLERS)) primary.setAttribute('href', '#start');

  // The line under the main button shows only on a phone: Harness Relay runs on a computer.
  if (system === 'mobile') {
    for (const slot of meta) {
      if (!slot.hasAttribute('data-hero')) continue;
      slot.textContent = words.mobile;
      slot.hidden = false;
    }
  }

  /** `release`: the newest one. With none (null), the buttons keep the releases page and no version shows. */
  const show = (release) => {
    if (!release || typeof release.tag !== 'string') return;
    for (const link of doc.querySelectorAll('[data-download]')) {
      const found = release.installers?.[link.dataset.download];
      if (!isInstallerUrl(found?.url)) continue;
      link.setAttribute('href', found.url);
      const size = link.querySelector('[data-size]');
      if (size) size.textContent = sizeLabel(found.size);
    }
    const mine = release.installers?.[system];
    if (primary && isInstallerUrl(mine?.url)) primary.setAttribute('href', mine.url);
    const text = `${release.prerelease ? words.rc : words.release} ${release.tag}`;
    for (const slot of meta) if (!slot.hasAttribute('data-hero')) slot.textContent = text;
  };

  let saved = null;
  try {
    saved = JSON.parse(store() || 'null');
  } catch {}
  const valid = saved && typeof saved.at === 'number' && 'release' in saved;
  if (valid) show(saved.release);
  if (valid && now() - saved.at < FRESH_MS) return Promise.resolve();
  // The API allows a visitor 60 unauthenticated requests an hour: kept for ten minutes, like the stars.
  return Promise.resolve()
    .then(() => fetchJson(`https://api.github.com/repos/${REPO}/releases?per_page=20`))
    .then((releases) => {
      const release = newestRelease(releases);
      show(release);
      store(JSON.stringify({ release, at: now() }));
    })
    .catch(() => {
      // GitHub can't be reached: the buttons keep the releases page (or the last release seen).
    });
}

if (typeof document !== 'undefined') void wire();
