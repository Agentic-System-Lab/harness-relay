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
  // Macs with Apple Silicon only: there is no app for Intel Macs.
  mac: '-mac-arm64.dmg',
  win: '-win-x64.exe',
  'win-arm64': '-win-arm64.exe',
  linux: '-linux-x86_64.AppImage',
  'linux-arm64': '-linux-arm64.AppImage',
};

/** Where the installers are: links to anything else are not used (a forged or broken API answer). */
export const DOWNLOAD_PREFIX = `https://github.com/${REPO}/releases/download/`;

/** A release download's path: /<owner>/<repo>/releases/download/<tag>/<file>, in plain characters. */
const DOWNLOAD_PATH = /^\/[^/]+\/[^/]+\/releases\/download\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/**
 * Whether `url` is an installer's address on GitHub (not a page of another site, nor `javascript:`).
 * It must lead where it says, as written: an address with `..` (or `%2e%2e`), an escape, a user name,
 * a port, a query or a fragment could reach another repository's file while starting the same way.
 */
export function isInstallerUrl(url) {
  if (typeof url !== 'string' || !url.startsWith(DOWNLOAD_PREFIX)) return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const segments = parsed.pathname.split('/');
  return (
    parsed.href === url &&
    parsed.origin === 'https://github.com' &&
    !parsed.username &&
    !parsed.password &&
    !parsed.search &&
    !parsed.hash &&
    DOWNLOAD_PATH.test(parsed.pathname) &&
    !segments.some((part) => part === '.' || part === '..')
  );
}

/**
 * The visitor's system: an installer's key ('mac', 'win', 'win-arm64', 'linux', 'linux-arm64') for
 * the computers with one, 'mobile' for a phone or tablet (iPadOS says it is a Mac, but has touch),
 * else 'other': an Intel Mac (when Chromium's hints say so: Safari and Firefox say "Intel" on every
 * Mac, so a Mac counts as one with Apple Silicon), ChromeOS, BSD, or Linux on 32-bit ARM. The processor comes from the user agent and
 * `navigator.platform` where they tell it (Firefox, Linux), or from Chromium's high-entropy hints
 * (`architecture` 'arm' or 'x86', `bitness`): Chromium says "x64" in its user agent on any Windows
 * and on any Linux. Without a hint, a Windows or Linux computer counts as x64 (Windows 11 on Arm
 * runs the x64 app too; the quick start lists the Arm installers beside it).
 */
export function systemOf({ userAgent = '', platform = '', uaPlatform = '', maxTouchPoints = 0, architecture = '', bitness = '' } = {}) {
  const ua = userAgent.toLowerCase();
  const p = `${uaPlatform} ${platform}`.toLowerCase();
  const said = `${ua} ${p}`;
  // The hint when there is one, else what the user agent or the platform says.
  const hinted = architecture === 'arm' ? (bitness === '32' ? 'arm32' : 'arm64') : architecture === 'x86' ? 'x86' : '';
  const cpu = hinted || (/aarch64|\barm64\b/.test(said) ? 'arm64' : /\barmv?\d|\barm\b/.test(said) ? 'arm32' : 'x86');
  if (/android|iphone|ipad|ipod/.test(ua) || /android|ios|iphone|ipad/.test(p)) return 'mobile';
  if (/mac/.test(p) || /macintosh|mac os x/.test(ua)) return maxTouchPoints > 1 ? 'mobile' : hinted === 'x86' ? 'other' : 'mac';
  if (/win/.test(p) || /windows/.test(ua)) return cpu === 'arm64' ? 'win-arm64' : 'win';
  if (/cros|chrome os|chromeos/.test(p) || /\bcros\b/.test(ua)) return 'other';
  if (/linux/.test(p) || /linux|x11/.test(ua)) return cpu === 'arm64' ? 'linux-arm64' : cpu === 'arm32' ? 'other' : 'linux';
  return 'other';
}

/**
 * The words for `system` in the page's data attributes (`data-mac`, `data-win-arm64`…): dataset
 * names them in camel case (winArm64).
 */
export function wordKey(system) {
  return system.replace(/-(\w)/g, (_, c) => c.toUpperCase());
}

/**
 * Chromium's high-entropy hints about the processor ({ architecture, bitness }), or none where the
 * browser does not give them (Firefox, Safari) or refuses.
 */
export function processorHints(nav) {
  const ask = nav?.userAgentData?.getHighEntropyValues;
  if (typeof ask !== 'function') return Promise.resolve({});
  return Promise.resolve()
    .then(() => ask.call(nav.userAgentData, ['architecture', 'bitness']))
    .then((h) => ({ architecture: typeof h?.architecture === 'string' ? h.architecture : '', bitness: typeof h?.bitness === 'string' ? h.bitness : '' }))
    .catch(() => ({}));
}

/** A release's installers, by system: { url, name } each, for the ones it has. */
export function installersOf(release) {
  const found = {};
  for (const asset of release?.assets ?? []) {
    for (const [system, end] of Object.entries(INSTALLERS)) {
      if (typeof asset?.name === 'string' && asset.name.endsWith(end) && isInstallerUrl(asset.browser_download_url)) {
        found[system] = { url: asset.browser_download_url, name: asset.name };
      }
    }
  }
  return found;
}

/** Whether a release is a release candidate: a pre-release on GitHub, or a version ending in -rc or -rc.N. */
export function isCandidate(tag, prerelease = false) {
  return Boolean(prerelease) || typeof tag !== 'string' || /-rc(?:\.\d+)?$/.test(tag);
}

/**
 * The newest published release with at least one installer, release candidates included, from
 * GitHub's list of releases (newest first, drafts left out): { tag, prerelease, installers }, or null
 * when there is none yet (the buttons then keep the releases page). `prerelease` says whether it is a
 * release candidate, for the version line.
 */
export function newestRelease(releases) {
  if (!Array.isArray(releases)) return null;
  const published = releases
    .filter((r) => r && !r.draft && typeof r.tag_name === 'string')
    .sort((a, b) => String(b.published_at ?? '').localeCompare(String(a.published_at ?? '')));
  for (const r of published) {
    const installers = installersOf(r);
    if (Object.keys(installers).length) return { tag: r.tag_name, prerelease: isCandidate(r.tag_name, r.prerelease), installers };
  }
  return null;
}

// ---------- On the page ----------

export const STORAGE_KEY = 'harness-relay.release';
const FRESH_MS = 10 * 60 * 1000;

/**
 * Points the page's download links at the newest release. The page's own words come from data
 * attributes on [data-downloads] (both languages): data-mac / data-win / data-win-arm64 / data-linux
 * / data-linux-arm64 (the main button for each system), data-rc and data-release (the version line),
 * data-mobile (on a phone). The browser's objects are passed in, so the tests can give fakes.
 */
/** The browser's localStorage, or null where reading it throws (site data blocked: Chrome and Firefox). */
function localStore() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function wire({
  doc = globalThis.document,
  nav = globalThis.navigator,
  storage = localStore(),
  fetchJson = (url) =>
    fetch(url, { headers: { Accept: 'application/vnd.github+json' } }).then((res) =>
      res.ok ? res.json() : Promise.reject(new Error(String(res.status))),
    ),
  now = Date.now,
} = {}) {
  const root = doc?.querySelector('[data-downloads]');
  if (!root) return Promise.resolve();
  // Chromium tells the processor only when asked (a Windows or Linux computer on Arm).
  return processorHints(nav).then((hints) => wireButtons({ doc, root, nav, hints, storage, fetchJson, now }));
}

/** wire(), once the processor hints are known. */
function wireButtons({ doc, root, nav, hints, storage, fetchJson, now }) {
  const words = root.dataset;
  const system = systemOf({
    userAgent: nav?.userAgent,
    platform: nav?.platform,
    uaPlatform: nav?.userAgentData?.platform,
    maxTouchPoints: nav?.maxTouchPoints,
    architecture: hints.architecture,
    bitness: hints.bitness,
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
  if (primary && primaryLabel && system in INSTALLERS && words[wordKey(system)]) primaryLabel.textContent = words[wordKey(system)];
  if (primary && !(system in INSTALLERS)) primary.setAttribute('href', '#start');

  // The line under the main button shows only on a phone: Harness Relay runs on a computer.
  if (system === 'mobile') {
    for (const slot of meta) {
      if (!slot.hasAttribute('data-hero')) continue;
      slot.textContent = words.mobile;
      slot.hidden = false;
    }
  }

  /**
   * `release`: the newest one. With none (null), the buttons keep the releases page and no version
   * shows. A system it has no installer for goes back to the releases page (one shown before, from
   * the release kept from an earlier visit, would be of an older release than the version line says).
   */
  const show = (release) => {
    if (!release || typeof release.tag !== 'string') return;
    for (const link of doc.querySelectorAll('[data-download]')) {
      const found = release.installers?.[link.dataset.download];
      link.setAttribute('href', isInstallerUrl(found?.url) ? found.url : RELEASES_PAGE);
    }
    const mine = release.installers?.[system];
    if (primary && system in INSTALLERS) primary.setAttribute('href', isInstallerUrl(mine?.url) ? mine.url : RELEASES_PAGE);
    const text = `${isCandidate(release.tag, release.prerelease) ? words.rc : words.release} ${release.tag}`;
    for (const slot of meta) if (!slot.hasAttribute('data-hero')) slot.textContent = text;
  };

  let saved = null;
  try {
    saved = JSON.parse(store() || 'null');
  } catch {}
  const valid = saved && typeof saved.at === 'number' && 'release' in saved;
  if (valid) show(saved.release);
  // A time in the future is not fresh: it would keep that release for good.
  if (valid && saved.at <= now() && now() - saved.at < FRESH_MS) return Promise.resolve();
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
