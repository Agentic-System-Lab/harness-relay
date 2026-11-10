import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { INSTALLERS, installersOf, isInstallerUrl, newestRelease, RELEASES_PAGE, sizeLabel, STORAGE_KEY, systemOf, wire } from '../site/assets/downloads.js';

const UA = {
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  win: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  linux: 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  android: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
  chromeos: 'Mozilla/5.0 (X11; CrOS x86_64 16000.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
};

describe("the visitor's system", () => {
  it('is read from the browser', () => {
    expect(systemOf({ userAgent: UA.mac, platform: 'MacIntel' })).toBe('mac');
    expect(systemOf({ userAgent: UA.win, platform: 'Win32', uaPlatform: 'Windows' })).toBe('win');
    expect(systemOf({ userAgent: UA.linux, platform: 'Linux x86_64' })).toBe('linux');
    expect(systemOf({ userAgent: UA.mac, uaPlatform: 'macOS' })).toBe('mac');
  });

  it('is a phone or tablet for iPhone, Android and an iPad that says it is a Mac', () => {
    expect(systemOf({ userAgent: UA.iphone, platform: 'iPhone' })).toBe('mobile');
    expect(systemOf({ userAgent: UA.android, platform: 'Linux armv81', uaPlatform: 'Android' })).toBe('mobile');
    expect(systemOf({ userAgent: UA.mac, platform: 'MacIntel', maxTouchPoints: 5 })).toBe('mobile');
  });

  it('is another system for Linux on ARM, which the x64 AppImage does not run on', () => {
    expect(systemOf({ userAgent: 'Mozilla/5.0 (X11; Linux aarch64; rv:140.0) Gecko/20100101 Firefox/140.0', platform: 'Linux aarch64' })).toBe('other');
  });

  it('is Windows on Arm too: browsers report it as x64, and Windows 11 runs the x64 app (the card says so)', () => {
    const arm = 'Mozilla/5.0 (Windows NT 10.0; ARM64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
    expect(systemOf({ userAgent: arm, platform: 'Win32', uaPlatform: 'Windows' })).toBe('win');
    for (const page of ['site/index.html', 'site/zh-TW/index.html']) {
      expect(readFileSync(page, 'utf8'), page).toMatch(/Windows 10[^<]*x64[^<]*Arm[^<]*Windows 11/);
    }
  });

  it('is another system for ChromeOS or nothing known', () => {
    expect(systemOf({ userAgent: UA.chromeos, platform: 'Linux x86_64', uaPlatform: 'Chrome OS' })).toBe('other');
    expect(systemOf({ userAgent: UA.chromeos })).toBe('other');
    expect(systemOf({})).toBe('other');
  });
});

/** A release as GitHub's API lists it. */
const release = (tag: string, o: { prerelease?: boolean; draft?: boolean; at?: string; files?: string[] } = {}) => ({
  tag_name: tag,
  prerelease: o.prerelease ?? tag.includes('-rc'),
  draft: o.draft ?? false,
  published_at: o.at ?? `${tag.slice(0, 10)}T10:00:00Z`,
  assets: (o.files ?? ['mac-universal.dmg', 'win-x64.exe', 'linux-x86_64.AppImage']).map((f, i) => ({
    name: `Harness-Relay-${tag}-${f}`,
    size: 122_529_273 + i,
    browser_download_url: `https://github.com/Agentic-System-Lab/harness-relay/releases/download/${tag}/Harness-Relay-${tag}-${f}`,
  })),
});

describe('the newest release', () => {
  it('includes release candidates, which GitHub’s "latest" link would skip', () => {
    const newest = newestRelease([release('2026-11-12-rc'), release('2026-11-10')]);
    expect(newest?.tag).toBe('2026-11-12-rc');
    expect(newest?.prerelease).toBe(true);
    expect(newest?.installers.mac?.url).toBe(
      'https://github.com/Agentic-System-Lab/harness-relay/releases/download/2026-11-12-rc/Harness-Relay-2026-11-12-rc-mac-universal.dmg',
    );
  });

  it('goes by the time it was published, and leaves out drafts and releases without installers', () => {
    const list = [
      release('2026-11-10-rc.1', { at: '2026-11-10T09:00:00Z' }),
      release('2026-11-10', { at: '2026-11-10T12:00:00Z', prerelease: false }),
      release('2026-11-11-rc', { draft: true }),
      release('2026-11-11-rc', { at: '2026-11-11T08:00:00Z', files: ['notes.txt'] }),
    ];
    expect(newestRelease(list)).toMatchObject({ tag: '2026-11-10', prerelease: false });
  });

  it('is none when there is no release yet, or the answer is not a list', () => {
    expect(newestRelease([])).toBeNull();
    expect(newestRelease({ message: 'API rate limit exceeded' })).toBeNull();
    expect(newestRelease(null)).toBeNull();
  });

  it('finds each system’s installer by the end of its name, and skips the others', () => {
    const found = installersOf(release('2026-11-10-rc', { files: ['mac-universal.dmg', 'mac-universal.dmg.blockmap', 'mac-arm64.dmg', 'linux-x86_64.AppImage', 'win-arm64.exe'] }));
    expect(Object.keys(found).sort()).toEqual(['linux', 'mac']);
    expect(found.linux?.name).toBe('Harness-Relay-2026-11-10-rc-linux-x86_64.AppImage');
  });

  it('shows sizes in megabytes', () => {
    expect(sizeLabel(122_529_273)).toBe('123 MB');
    expect(sizeLabel(10)).toBe('1 MB');
    expect(sizeLabel(undefined)).toBe('');
  });
});

describe('the download buttons and the Release workflow', () => {
  it('look for the names the workflow gives the installers', () => {
    const workflow = readFileSync('.github/workflows/release.yml', 'utf8');
    // Harness-Relay-${env.RELAY_VERSION}-${os}-${arch}.${ext}, with electron-builder's os and arch names.
    expect(workflow).toContain("-c.artifactName='Harness-Relay-${env.RELAY_VERSION}-${os}-${arch}.${ext}'");
    expect(INSTALLERS).toEqual({ mac: '-mac-universal.dmg', win: '-win-x64.exe', linux: '-linux-x86_64.AppImage' });
    expect(workflow).toMatch(/target: --mac dmg --universal/);
    expect(workflow).toMatch(/target: --win nsis --x64/);
    expect(workflow).toMatch(/target: --linux AppImage --x64/);
  });

  it('point at the releases page on both pages until the newest installers are known', () => {
    for (const page of ['site/index.html', 'site/zh-TW/index.html']) {
      const html = readFileSync(page, 'utf8');
      for (const system of ['mac', 'win', 'linux']) {
        expect(html, `${page} ${system}`).toMatch(new RegExp(`<a [^>]*href="${RELEASES_PAGE}"[^>]*data-download="${system}"`));
      }
      expect(html, page).toMatch(new RegExp(`<a [^>]*href="${RELEASES_PAGE}"[^>]*data-download-primary`));
      expect(html, page).toContain('<script type="module" src="');
      for (const word of ['data-mac=', 'data-win=', 'data-linux=', 'data-rc=', 'data-release=', 'data-mobile=']) {
        expect(html, `${page} ${word}`).toContain(word);
      }
    }
  });
});

describe('the installers’ addresses', () => {
  it('are only GitHub release downloads of this repository', () => {
    expect(isInstallerUrl('https://github.com/Agentic-System-Lab/harness-relay/releases/download/2026-11-10-rc/x.dmg')).toBe(true);
    for (const url of ['javascript:alert(1)', 'https://evil.example/x.dmg', 'https://github.com/someone/else/releases/download/x.dmg', 'https://github.com/Agentic-System-Lab/harness-relay/releases/download/a b', undefined, 42]) {
      expect(isInstallerUrl(url), String(url)).toBe(false);
    }
    const forged = release('2026-11-10-rc');
    forged.assets[0]!.browser_download_url = 'javascript:alert(1)';
    expect(Object.keys(installersOf(forged)).sort()).toEqual(['linux', 'win']);
  });

  it('lead where they say: no dot segments, escapes, query or fragment that could reach another repository', () => {
    const base = 'https://github.com/Agentic-System-Lab/harness-relay/releases/download/';
    for (const url of [
      `${base}../../../../evil/x/releases/download/v/a.dmg`,
      `${base}%2e%2e/%2e%2e/%2e%2e/%2e%2e/evil/x/releases/download/v/a.dmg`,
      `${base}v/..`,
      `${base}v/a.dmg?redirect=https://evil.example`,
      `${base}v/a.dmg#x`,
      `${base}v/a%20b.dmg`,
      `${base}v`,
      `${base}v/sub/a.dmg`,
    ]) {
      expect(isInstallerUrl(url), url).toBe(false);
    }
    expect(isInstallerUrl(`${base}2026-11-10.1/Harness-Relay-2026-11-10.1-win-x64.exe`)).toBe(true);
  });
});

/** Just enough of a page for wire(): elements found by the attributes they have. */
class El {
  attrs: Record<string, string> = {};
  dataset: Record<string, string> = {};
  classes = new Set<string>();
  classList = { add: (c: string) => void this.classes.add(c) };
  textContent = '';
  hidden = false;
  constructor(
    attrs: Record<string, string>,
    public children: El[] = [],
  ) {
    for (const [k, v] of Object.entries(attrs)) this.setAttribute(k, v);
  }
  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
    if (k.startsWith('data-')) this.dataset[k.slice(5).replace(/-(\w)/g, (_, c: string) => c.toUpperCase())] = v;
  }
  hasAttribute(k: string) {
    return k in this.attrs;
  }
  matches(selector: string) {
    return this.hasAttribute(selector.replace(/^\[|\]$/g, ''));
  }
  querySelector(selector: string): El | null {
    return this.children.find((c) => c.matches(selector)) ?? null;
  }
}

function page() {
  const words = { 'data-mac': 'Download for macOS', 'data-win': 'Download for Windows', 'data-linux': 'Download for Linux', 'data-rc': 'Release candidate', 'data-release': 'Release', 'data-mobile': 'Runs on a computer.' };
  const label = new El({ 'data-download-label': '' });
  label.textContent = 'Download Harness Relay';
  const el = {
    root: new El({ 'data-downloads': '', ...words }),
    primary: new El({ 'data-download-primary': '', href: RELEASES_PAGE }, [label]),
    label,
    hero: new El({ 'data-release-meta': '', 'data-hero': '' }),
    line: new El({ 'data-release-meta': '' }),
    cards: Object.fromEntries(['mac', 'win', 'linux'].map((s) => [s, new El({ 'data-download': s, href: RELEASES_PAGE }, [new El({ 'data-size': '' })])])) as Record<string, El>,
  };
  el.hero.hidden = true;
  const all = [el.root, el.primary, el.hero, el.line, ...Object.values(el.cards)];
  const doc = { querySelector: (sel: string) => all.find((e) => e.matches(sel)) ?? null, querySelectorAll: (sel: string) => all.filter((e) => e.matches(sel)) };
  return { el, doc };
}

function memoryStorage() {
  const data = new Map<string, string>();
  return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
}

const MAC = { userAgent: UA.mac, platform: 'MacIntel' };

describe('the download buttons on the page', () => {
  it("point at the newest release's installers, name the visitor's system and mark its card", async () => {
    const { el, doc } = page();
    const storage = memoryStorage();
    let calls = 0;
    await wire({ doc, nav: MAC, storage, fetchJson: async () => (calls++, [release('2026-11-10-rc')]), now: () => 1000 });
    expect(calls).toBe(1);
    expect(el.label.textContent).toBe('Download for macOS');
    expect(el.primary.attrs.href).toMatch(/Harness-Relay-2026-11-10-rc-mac-universal\.dmg$/);
    expect(el.cards.win!.attrs.href).toMatch(/-win-x64\.exe$/);
    expect(el.cards.mac!.classes.has('is-yours')).toBe(true);
    expect(el.cards.win!.classes.has('is-yours')).toBe(false);
    expect(el.cards.mac!.children[0]!.textContent).toBe('123 MB');
    expect(el.line.textContent).toBe('Release candidate 2026-11-10-rc');
    // The line under the main button stays hidden on a computer.
    expect(el.hero.hidden).toBe(true);
    expect(el.hero.textContent).toBe('');
    expect(JSON.parse(storage.data.get(STORAGE_KEY)!)).toMatchObject({ at: 1000, release: { tag: '2026-11-10-rc' } });
  });

  it('use the release kept for ten minutes without asking GitHub again, and ask again after', async () => {
    const storage = memoryStorage();
    storage.setItem(STORAGE_KEY, JSON.stringify({ release: newestRelease([release('2026-11-09')]), at: 0 }));
    let calls = 0;
    const fetchJson = async () => (calls++, [release('2026-11-10')]);
    const first = page();
    await wire({ doc: first.doc, nav: MAC, storage, fetchJson, now: () => 9 * 60_000 });
    expect(calls).toBe(0);
    expect(first.el.line.textContent).toBe('Release 2026-11-09');
    const later = page();
    await wire({ doc: later.doc, nav: MAC, storage, fetchJson, now: () => 11 * 60_000 });
    expect(calls).toBe(1);
    expect(later.el.line.textContent).toBe('Release 2026-11-10');
  });

  it('send a phone to the quick start, with the line saying it runs on a computer', async () => {
    const { el, doc } = page();
    await wire({ doc, nav: { userAgent: UA.iphone, platform: 'iPhone', maxTouchPoints: 5 }, storage: memoryStorage(), fetchJson: async () => [release('2026-11-10-rc')], now: () => 0 });
    expect(el.primary.attrs.href).toBe('#start');
    expect(el.label.textContent).toBe('Download Harness Relay');
    expect(el.hero.hidden).toBe(false);
    expect(el.hero.textContent).toBe('Runs on a computer.');
    expect(Object.values(el.cards).some((c) => c.classes.has('is-yours'))).toBe(false);
    // The quick start still offers every installer.
    expect(el.cards.linux!.attrs.href).toMatch(/\.AppImage$/);
  });

  it('keep the releases page when GitHub cannot be reached, has no release, or answers with links elsewhere', async () => {
    for (const fetchJson of [
      async () => Promise.reject(new Error('403')),
      async () => [],
      async () => {
        const forged = release('2026-11-10-rc');
        for (const a of forged.assets) a.browser_download_url = 'javascript:alert(1)';
        return [forged];
      },
    ]) {
      const { el, doc } = page();
      await wire({ doc, nav: MAC, storage: memoryStorage(), fetchJson, now: () => 0 });
      expect(el.primary.attrs.href).toBe(RELEASES_PAGE);
      for (const card of Object.values(el.cards)) expect(card.attrs.href).toBe(RELEASES_PAGE);
      expect(el.line.textContent).toBe('');
    }
  });

  it('ask GitHub again when the kept release is dated in the future (else it would be kept for good)', async () => {
    const storage = memoryStorage();
    storage.setItem(STORAGE_KEY, JSON.stringify({ release: newestRelease([release('2026-11-09')]), at: 1e15 }));
    let calls = 0;
    const { el, doc } = page();
    await wire({ doc, nav: MAC, storage, fetchJson: async () => (calls++, [release('2026-11-10')]), now: () => 60_000 });
    expect(calls).toBe(1);
    expect(el.line.textContent).toBe('Release 2026-11-10');
  });

  it("send a system the newer release has no installer for back to the releases page, not to an older release's", async () => {
    const storage = memoryStorage();
    storage.setItem(STORAGE_KEY, JSON.stringify({ release: newestRelease([release('2026-11-09')]), at: 0 }));
    const newer = release('2026-11-10');
    newer.assets = newer.assets.filter((a) => !a.name.endsWith('.AppImage'));
    const linux = { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)', platform: 'Linux x86_64' };
    const { el, doc } = page();
    await wire({ doc, nav: linux, storage, fetchJson: async () => [newer], now: () => 60 * 60_000 });
    expect(el.line.textContent).toBe('Release 2026-11-10');
    expect(el.cards.linux!.attrs.href).toBe(RELEASES_PAGE);
    expect(el.cards.linux!.children[0]!.textContent).toBe('');
    expect(el.primary.attrs.href).toBe(RELEASES_PAGE);
    expect(el.cards.mac!.attrs.href).toMatch(/2026-11-10-mac-universal\.dmg$/);
  });

  it('still name the system and mark its card when the browser refuses site data', async () => {
    const { el, doc } = page();
    const blocked = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('SecurityError');
      },
    };
    await wire({ doc, nav: MAC, storage: blocked, fetchJson: async () => [release('2026-11-10')], now: () => 0 });
    expect(el.label.textContent).toBe('Download for macOS');
    expect(el.primary.attrs.href).toMatch(/mac-universal\.dmg$/);
    // Reading localStorage itself throws there (Chrome, Firefox): the page's own default.
    const before = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('SecurityError');
      },
    });
    try {
      const again = page();
      await wire({ doc: again.doc, nav: MAC, fetchJson: async () => [release('2026-11-10')], now: () => 0 });
      expect(again.el.primary.attrs.href).toMatch(/mac-universal\.dmg$/);
    } finally {
      if (before) Object.defineProperty(globalThis, 'localStorage', before);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });

  it('ignore a kept release whose links go elsewhere', async () => {
    const storage = memoryStorage();
    storage.setItem(STORAGE_KEY, JSON.stringify({ release: { tag: 'x', prerelease: false, installers: { mac: { url: 'javascript:alert(1)' } } }, at: 0 }));
    const { el, doc } = page();
    await wire({ doc, nav: MAC, storage, fetchJson: async () => Promise.reject(new Error('offline')), now: () => 60_000 });
    expect(el.primary.attrs.href).toBe(RELEASES_PAGE);
    expect(el.cards.mac!.attrs.href).toBe(RELEASES_PAGE);
  });

  it('do nothing on a page without download buttons', async () => {
    await wire({ doc: { querySelector: () => null, querySelectorAll: () => [] }, nav: MAC, storage: memoryStorage(), fetchJson: async () => [], now: () => 0 });
  });
});
