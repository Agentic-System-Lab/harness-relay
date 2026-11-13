// Harness Relay landing page: the download buttons. The page links every button to the releases page;
// this module points each one at its installer in the newest release (never a release candidate: those
// are for trying, and an app that is one offers the next by itself), names the visitor's system on the
// main button, and marks it in the quick start. Its functions are tested in test/site-downloads.test.ts.

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

/**
 * The same installers again, under these ends, for the app's own updates, which download them in place
 * of the ones above (desktop/src/update.ts): GitHub's download counts then tell new installs (INSTALLERS,
 * from this website or the releases page) from updates of an installed app (UPDATE_INSTALLERS). The
 * Release workflow makes the copies (`updateCopyName`) and publishes them in a repository of their own
 * (UPDATES_REPO), so that the releases page lists the installers alone; this website never offers them.
 */
export const UPDATE_INSTALLERS = {
  mac: '-mac-arm64-update.dmg',
  win: '-win-x64-update.exe',
  'win-arm64': '-win-arm64-update.exe',
  linux: '-linux-x86_64-update.AppImage',
  'linux-arm64': '-linux-arm64-update.AppImage',
};

/** The name of an installer's copy for the app's updates, or undefined for a file that is not an installer. */
export function updateCopyName(name) {
  if (typeof name !== 'string') return undefined;
  for (const [system, end] of Object.entries(INSTALLERS)) {
    if (name.endsWith(end)) return name.slice(0, -end.length) + UPDATE_INSTALLERS[system];
  }
  return undefined;
}

/**
 * Where the copies for the app's updates are: each release's under the same tag in the releases of
 * that repository (its README: what it is), published there by the Release workflow before the release
 * itself.
 * The workflow's UPDATES_REPO variable, and RELAY_UPDATES_REPO when the app is built, may name another
 * (desktop/src/updateSource.ts), private too.
 */
export const UPDATES_REPO = 'Agentic-System-Lab/harness-relay-updates';

/** A tag or a file name that stays in its place in a download's path (no `.` or `..`, no `/`). */
const PLAIN_PART = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Where an app's update downloads `installer` (an installer's name) of the release tagged `tag`: its
 * copy (`updateCopyName`) in `repo` (`owner/name`, UPDATES_REPO unless the app was built with another).
 * Undefined for a file that is not an installer.
 */
export function updateCopyUrl(tag, installer, repo = UPDATES_REPO) {
  const copy = updateCopyName(installer);
  if (!copy || typeof tag !== 'string' || !PLAIN_PART.test(tag) || !PLAIN_PART.test(installer)) return undefined;
  // owner/name, a name not all dots (`..` would leave the repository's path).
  if (typeof repo !== 'string' || !/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repo) || /\/\.+$/.test(repo)) return undefined;
  return `https://github.com/${repo}/releases/download/${tag}/${copy}`;
}

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
 * The download mirror the buttons point at, when there is one: a Cloudflare Worker in front of an R2
 * bucket that holds the newest releases' installers (mirror/worker.ts), at /<tag>/<file> as on GitHub.
 * GitHub's own downloads are slow in parts of the world (some 0.25 MB/s in Taiwan, where Cloudflare
 * gives 40 MB/s). The Release workflow uploads each release's installers there before it publishes the
 * release, and for each download it serves the mirror asks GitHub for the installer's first byte, as
 * a download there would, so that GitHub's download counts still count it. Empty: no mirror, and the
 * buttons point at GitHub. An https origin, with no path (docs/developer-guide.md, "Releasing").
 */
export const MIRROR = '';

/** Whether `mirror` is a mirror's address: an https origin as written, no user name, port or path. */
export function isMirror(mirror) {
  if (typeof mirror !== 'string' || !mirror.startsWith('https://')) return false;
  try {
    const parsed = new URL(mirror);
    return parsed.origin === mirror && !parsed.port && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

/**
 * The mirror's address for an installer's address on GitHub (isInstallerUrl): the same tag and file
 * under `mirror`. Undefined for anything else, or without a mirror.
 */
export function mirrorUrl(url, mirror = MIRROR) {
  if (!isMirror(mirror) || !isInstallerUrl(url)) return undefined;
  // /<owner>/<repo>/releases/download/<tag>/<file>
  const [tag, file] = new URL(url).pathname.split('/').slice(5);
  return `${mirror}/${tag}/${file}`;
}

/**
 * Whether the mirror has an installer: a HEAD that it answers itself (200). Not in its bucket, it
 * redirects to GitHub, which is not followed (GitHub would count a HEAD there as a download); not
 * reached, or out of order, it is not used. A HEAD is never counted.
 */
export function mirrorHas(url, fetcher = globalThis.fetch) {
  return Promise.resolve()
    .then(() => fetcher(url, { method: 'HEAD', redirect: 'manual', cache: 'no-store', credentials: 'omit' }))
    .then((res) => res?.status === 200)
    .catch(() => false);
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

/** Whether a release is a release candidate: a pre-release on GitHub, or a version ending in -rc or -rc.N (2026-11-10-rc, 2026-11-10.1-rc.2). */
export function isCandidate(tag, prerelease = false) {
  return Boolean(prerelease) || typeof tag !== 'string' || /-rc(?:\.\d+)?$/.test(tag);
}

/**
 * The newest published release with at least one installer, from GitHub's list of releases (newest
 * first): { tag, installers }, or null when there is none yet (the buttons then keep the releases
 * page). Release candidates are left out, however new (a pre-release, or a version ending in -rc), and
 * so are drafts.
 */
export function newestRelease(releases) {
  if (!Array.isArray(releases)) return null;
  const published = releases
    .filter((r) => r && !r.draft && typeof r.tag_name === 'string' && !isCandidate(r.tag_name, r.prerelease))
    .sort((a, b) => String(b.published_at ?? '').localeCompare(String(a.published_at ?? '')));
  for (const r of published) {
    const installers = installersOf(r);
    if (Object.keys(installers).length) return { tag: r.tag_name, installers };
  }
  return null;
}

// ---------- On the page ----------

export const STORAGE_KEY = 'harness-relay.release';
const FRESH_MS = 10 * 60 * 1000;

/**
 * Points the page's download links at the newest release: at the mirror (MIRROR), once it says it has
 * the visitor's installer, else at GitHub. The page's own words come from data
 * attributes on [data-downloads] (both languages): data-mac / data-win / data-win-arm64 / data-linux
 * / data-linux-arm64 (the main button for each system), data-release (before the version on its line),
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
  mirror = MIRROR,
  hasInstaller = (url) => mirrorHas(url),
} = {}) {
  const root = doc?.querySelector('[data-downloads]');
  if (!root) return Promise.resolve();
  // Chromium tells the processor only when asked (a Windows or Linux computer on Arm).
  return processorHints(nav).then((hints) => wireButtons({ doc, root, nav, hints, storage, fetchJson, now, mirror, hasInstaller }));
}

/** wire(), once the processor hints are known. */
function wireButtons({ doc, root, nav, hints, storage, fetchJson, now, mirror, hasInstaller }) {
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
   * `mirrored`: each installer's link on the mirror instead of GitHub (mirrorTo).
   */
  let shown = null;
  const show = (release, mirrored = false) => {
    if (!release || typeof release.tag !== 'string') return;
    shown = release;
    const href = (found) => (!isInstallerUrl(found?.url) ? RELEASES_PAGE : (mirrored && mirrorUrl(found.url, mirror)) || found.url);
    for (const link of doc.querySelectorAll('[data-download]')) link.setAttribute('href', href(release.installers?.[link.dataset.download]));
    if (primary && system in INSTALLERS) primary.setAttribute('href', href(release.installers?.[system]));
    for (const slot of meta) if (!slot.hasAttribute('data-hero')) slot.textContent = `${words.release} ${release.tag}`;
  };

  /**
   * The links on the mirror, once it answers that it has the visitor's installer (else the first one
   * the release has: the Release workflow uploads them all before it publishes the release). Until
   * then, and whenever it does not, they stay on GitHub. Only for the release still shown by then.
   */
  const mirrorTo = (release) => {
    if (!release || !isMirror(mirror)) return Promise.resolve();
    const urls = Object.entries(release.installers ?? {}).filter(([, found]) => isInstallerUrl(found?.url));
    const asked = (urls.find(([key]) => key === system) ?? urls[0])?.[1];
    if (!asked) return Promise.resolve();
    return Promise.resolve()
      .then(() => hasInstaller(mirrorUrl(asked.url, mirror)))
      .then((has) => {
        if (has === true && shown === release) show(release, true);
      })
      .catch(() => {});
  };

  let saved = null;
  try {
    saved = JSON.parse(store() || 'null');
  } catch {}
  // A release candidate kept by an earlier visit (the page offered them before) is not shown: GitHub is
  // asked again for the newest release.
  const kept = saved?.release;
  const valid = saved && typeof saved.at === 'number' && 'release' in saved && !(kept && isCandidate(kept.tag, kept.prerelease));
  if (valid) show(saved.release);
  // A time in the future is not fresh: it would keep that release for good.
  if (valid && saved.at <= now() && now() - saved.at < FRESH_MS) return mirrorTo(saved.release);
  // The API allows a visitor 60 unauthenticated requests an hour: kept for ten minutes, like the stars.
  return Promise.resolve()
    .then(() => fetchJson(`https://api.github.com/repos/${REPO}/releases?per_page=20`))
    .then((releases) => {
      const release = newestRelease(releases);
      show(release);
      store(JSON.stringify({ release, at: now() }));
      return mirrorTo(release);
    })
    .catch(() => {
      // GitHub can't be reached: the buttons keep the releases page (or the last release seen, on the
      // mirror when it has it).
      return valid ? mirrorTo(shown) : undefined;
    });
}

if (typeof document !== 'undefined') void wire();
