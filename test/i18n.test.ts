import { describe, expect, it } from 'vitest';
import { currentLang, isDefaultTitle, parseLang, t, withLang } from '../src/server/i18n';
import { builtinPresets } from '../src/server/presets';
import { LANG_NAMES, browserLang, lastChoice, loadMessages } from '../src/web/i18n';
import { en } from '../src/web/locales/en';
import { zhTW } from '../src/web/locales/zh-TW';

/** Same keys and same list lengths, recursively (types only check the keys). */
function shape(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(shape);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, shape((v as any)[k])]));
  return typeof v;
}

describe('server language', () => {
  it('follows X-Relay-Lang, then Accept-Language, defaulting to zh-TW', () => {
    expect(parseLang('en')).toBe('en');
    expect(parseLang('zh-TW', 'en-US')).toBe('zh-TW');
    expect(parseLang(undefined, 'en-GB,en;q=0.9')).toBe('en');
    expect(parseLang(undefined, 'ja-JP')).toBe('zh-TW');
    expect(parseLang('fr')).toBe('zh-TW');
  });

  it('carries the language through async work started inside a request', async () => {
    expect(currentLang()).toBe('zh-TW');
    const inside = await withLang('en', async () => {
      await new Promise((r) => setTimeout(r, 1));
      return t().busy;
    });
    expect(inside).toMatch(/still replying/);
    expect(t().busy).toMatch(/回覆中/);
  });

  it('has the built-in templates and default titles in both languages', () => {
    expect(builtinPresets('en').map((p) => p.name)).toContain('General-question panel');
    expect(builtinPresets('zh-TW').map((p) => p.name)).toContain('一般問題智囊團');
    expect(builtinPresets('en').map((p) => p.id)).toEqual(builtinPresets('zh-TW').map((p) => p.id));
    expect(isDefaultTitle('New chat')).toBe(true);
    expect(isDefaultTitle('新對話')).toBe(true);
    expect(isDefaultTitle('My chat')).toBe(false);
  });
});

describe('web language', () => {
  it('picks the browser language: any Chinese → 繁體中文, otherwise English', () => {
    expect(browserLang(['zh-TW', 'en'])).toBe('zh-TW');
    expect(browserLang(['zh-CN'])).toBe('zh-TW');
    expect(browserLang(['en-US', 'zh-TW'])).toBe('en');
    expect(browserLang(['ja-JP', 'ko'])).toBe('en');
    expect(browserLang([])).toBe('en');
  });

  it("loads each language's messages when asked, and names each language as its messages do", async () => {
    // The page carries only the language it shows (i18n.tsx), so the switch names them without loading them.
    expect(await loadMessages('en')).toBe(en);
    expect(await loadMessages('zh-TW')).toBe(zhTW);
    expect(LANG_NAMES).toEqual({ en: en.langName, 'zh-TW': zhTW.langName });
  });

  it('shows the language chosen last, though one chosen before it finishes loading after it', async () => {
    const pending = new Map<string, { resolve: () => void; reject: (err: Error) => void }>();
    const load = (lang: string) => new Promise<void>((resolve, reject) => pending.set(lang, { resolve, reject }));
    const shown: string[] = [];
    const choose = lastChoice(load, (lang: string) => shown.push(lang));
    // English, then Chinese at once: Chinese loads first, English after it.
    const english = choose('en');
    const chinese = choose('zh-TW');
    pending.get('zh-TW')!.resolve();
    await chinese;
    pending.get('en')!.resolve();
    await english;
    expect(shown).toEqual(['zh-TW']);
    // The same language twice: once shown, when the second one's load finishes.
    const a = choose('en');
    const first = pending.get('en')!;
    const b = choose('en');
    first.resolve();
    await a;
    expect(shown).toEqual(['zh-TW']);
    pending.get('en')!.resolve();
    await b;
    expect(shown).toEqual(['zh-TW', 'en']);
  });

  it('says when the language chosen cannot be loaded, unless another was chosen after it', async () => {
    const pending = new Map<string, { resolve: () => void; reject: (err: Error) => void }>();
    const load = (lang: string) => new Promise<void>((resolve, reject) => pending.set(lang, { resolve, reject }));
    const shown: string[] = [];
    const choose = lastChoice(load, (lang: string) => shown.push(lang));
    const english = choose('en');
    pending.get('en')!.reject(new Error('404'));
    await expect(english).rejects.toThrow('404');
    // Failing after another choice: nothing to say, and the later one is shown.
    const again = choose('en');
    const chinese = choose('zh-TW');
    pending.get('en')!.reject(new Error('404'));
    await expect(again).resolves.toBeUndefined();
    pending.get('zh-TW')!.resolve();
    await chinese;
    expect(shown).toEqual(['zh-TW']);
  });

  it('has the same messages in both languages', () => {
    expect(shape(en)).toEqual(shape(zhTW));
    expect(en.effortLabel('xhigh')).toBe('Extra high (xhigh)');
    expect(en.effortLabel('high')).toBe('High');
    expect(zhTW.effortLabel('high')).toBe('高（high）');
  });
});

describe("where Settings sends someone whose CLI is not found", () => {
  it("links each CLI to its own website, over HTTPS, with the link's words in both languages", async () => {
    const { PROVIDER_INSTALL_URL, PROVIDERS } = await import('../src/shared/types');
    expect(PROVIDER_INSTALL_URL).toEqual({
      claude: 'https://claude.com/product/claude-code',
      codex: 'https://openai.com/codex/',
      grok: 'https://x.ai/build',
      cursor: 'https://cursor.com/cli',
      antigravity: 'https://antigravity.google/download',
      copilot: 'https://github.com/features/copilot/cli',
      muse: 'https://dev.meta.ai/products/muse-code/',
      opencode: 'https://www.npmjs.com/package/opencode-ai',
      goose: 'https://formulae.brew.sh/formula/block-goose-cli',
      cline: 'https://www.npmjs.com/package/cline',
      openhands: 'https://pypi.org/project/openhands/',
      pi: 'https://www.npmjs.com/package/@earendil-works/pi-coding-agent',
    });
    for (const p of PROVIDERS) expect(new URL(PROVIDER_INSTALL_URL[p]).protocol, p).toBe('https:');
    expect(zhTW.settings.installCli('Grok')).toBe('到官網安裝 Grok');
    expect(en.settings.installCli('Grok')).toBe('Install Grok from its website');
  });
});
