import { describe, expect, it } from 'vitest';
import { REPORT_SCREENSHOT_LIMITS, type AboutInfo, type ProviderStatus } from '../src/shared/types';
import { en } from '../src/web/locales/en';
import { zhTW } from '../src/web/locales/zh-TW';
import {
  EMPTY_REPORT,
  GMAIL_MAX,
  MAILTO_MAX,
  REPORT_EMAIL,
  fitLink,
  gmailUrl,
  infoLines,
  mailtoUrl,
  reportBody,
  reportReady,
  reportSubject,
  reportText,
  screenshotProblem,
  type ReportDraft,
} from '../src/web/report';

const about: AboutInfo = { version: '2026-11-10', desktop: true, os: 'darwin 25.6.0 (arm64)', node: 'v24.1.0' };
const status = (provider: ProviderStatus['provider'], installed: boolean, version?: string): ProviderStatus => ({
  provider,
  installed,
  bin: `/Users/someone/bin/${provider}`,
  version,
  auth: { loggedIn: true, account: 'someone@example.com' },
  usingStoredApiKey: false,
});
const providers = [status('claude', true, '2.1.3 (Claude Code)'), status('codex', false), status('grok', true)];
const draft = (d: Partial<ReportDraft> = {}): ReportDraft => ({ ...EMPTY_REPORT, description: 'It froze after I pressed Send.', ...d });

describe('infoLines', () => {
  it('names the version, how it runs, the system, the browser, each CLI and the language', () => {
    expect(infoLines({ about, providers, userAgent: 'Mozilla/5.0 Test', lang: 'en' }, en)).toEqual([
      'Harness Relay: 2026-11-10 · desktop app',
      'OS: darwin 25.6.0 (arm64)',
      'Node.js: v24.1.0',
      'Browser: Mozilla/5.0 Test',
      'Claude Code: 2.1.3 (Claude Code)',
      'Codex: not installed',
      'Grok: installed',
      'Language: en',
    ]);
  });

  it("never names the user's files or accounts", () => {
    const text = infoLines({ about, providers, userAgent: '', lang: 'en' }, en).join('\n');
    expect(text).not.toContain('/Users/someone');
    expect(text).not.toContain('someone@example.com');
  });

  it('goes without what the server could not say, in the UI language', () => {
    expect(infoLines({ providers: [], userAgent: '', lang: 'zh-TW' }, zhTW)).toEqual(['介面語言：zh-TW']);
    expect(infoLines({ about: { ...about, desktop: false, version: 'source (92449c7)' }, providers: [], userAgent: '', lang: 'zh-TW' }, zhTW)[0]).toBe(
      'Harness Relay：source (92449c7) · 網頁版',
    );
  });
});

describe('the mail', () => {
  it('needs a description, not a subject', () => {
    expect(reportReady(draft({ description: '  \n ' }))).toBe(false);
    expect(reportReady(draft({ subject: '' }))).toBe(true);
  });

  it('takes its subject from what was typed, else the first line of the description', () => {
    expect(reportSubject(draft({ subject: '  Frozen   chat ', kind: 'bug' }), en)).toBe('[Harness Relay] Problem: Frozen chat');
    expect(reportSubject(draft({ description: '\nFirst line\nSecond line', kind: 'idea' }), en)).toBe('[Harness Relay] Idea: First line');
    expect(reportSubject(draft({ description: '中'.repeat(80) }), zhTW)).toBe(`[Harness Relay] 問題：${'中'.repeat(60)}…`);
  });

  it('holds the description, its kind and the details, then says where screenshots go', () => {
    const info = ['OS: darwin'];
    expect(reportBody(draft({ kind: 'other' }), info, en)).toBe(
      'It froze after I pressed Send.\n\n---\nType: Other\nOS: darwin\n\n(Drag screenshots into this mail.)',
    );
  });

  it('links to the screenshots uploaded, in place of saying where to drag them', () => {
    const gist = 'https://gist.github.com/someone/f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff';
    expect(reportBody(draft({ kind: 'bug' }), ['OS: darwin'], en, gist)).toBe(
      `It froze after I pressed Send.\n\n---\nType: Problem\nOS: darwin\n\nScreenshots: ${gist}`,
    );
    expect(reportBody(draft(), [], zhTW, gist)).toContain(`截圖：${gist}`);
    expect(reportBody(draft(), [], zhTW, gist)).not.toContain(zhTW.report.mail.screenshots);
  });

  it('can be copied whole, with where it goes', () => {
    expect(reportText(REPORT_EMAIL, 'S', 'B', en)).toBe(`To: ${REPORT_EMAIL}\nSubject: S\n\nB`);
  });
});

describe('screenshots', () => {
  const { maxFiles, maxBytes } = REPORT_SCREENSHOT_LIMITS;
  it('takes PNG, JPEG, GIF and WebP images up to the limits', () => {
    for (const type of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) expect(screenshotProblem({ type, size: 1000 }, 0)).toBeUndefined();
    expect(screenshotProblem({ type: 'image/png', size: maxBytes }, maxFiles - 1)).toBeUndefined();
  });

  it('says why one cannot be added: one too many first, then its kind, then its size', () => {
    expect(screenshotProblem({ type: 'image/png', size: 1 }, maxFiles)).toBe('tooMany');
    expect(screenshotProblem({ type: 'application/pdf', size: maxBytes + 1 }, 0)).toBe('notImage');
    expect(screenshotProblem({ type: 'image/svg+xml', size: 1 }, 0)).toBe('notImage');
    expect(screenshotProblem({ type: '', size: 1 }, 0)).toBe('notImage');
    expect(screenshotProblem({ type: 'image/png', size: maxBytes + 1 }, 0)).toBe('tooLarge');
  });
});

describe('mail links', () => {
  it('encode the subject and the text, with CRLF line breaks in a mailto link', () => {
    expect(mailtoUrl(REPORT_EMAIL, 'A & B?', 'one\ntwo')).toBe(`mailto:${REPORT_EMAIL}?subject=A%20%26%20B%3F&body=one%0D%0Atwo`);
    expect(gmailUrl(REPORT_EMAIL, '問題', 'one\ntwo')).toBe(
      `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(REPORT_EMAIL)}&su=%E5%95%8F%E9%A1%8C&body=one%0Atwo`,
    );
  });

  it('carry the whole report when it fits', () => {
    const make = (s: string, b: string) => mailtoUrl(REPORT_EMAIL, s, b);
    expect(fitLink(make, 'S', 'short', 'PASTE', MAILTO_MAX)).toEqual({ url: make('S', 'short'), cut: false });
  });

  it('say to paste a report too long for them, and stay short enough', () => {
    const make = (s: string, b: string) => mailtoUrl(REPORT_EMAIL, s, b);
    const body = '當機了'.repeat(200);
    const link = fitLink(make, 'S', body, 'PASTE', MAILTO_MAX);
    expect(link).toEqual({ url: make('S', 'PASTE'), cut: true });
    // A Gmail link takes more.
    expect(fitLink((s, b) => gmailUrl(REPORT_EMAIL, s, b), 'S', body, 'PASTE', GMAIL_MAX).cut).toBe(false);
  });

  it('shorten the subject when even the note does not fit, whole characters at a time', () => {
    const make = (s: string, b: string) => mailtoUrl(REPORT_EMAIL, s, b);
    const link = fitLink(make, '🐛'.repeat(300), 'x'.repeat(3000), 'PASTE', 500);
    expect(link.cut).toBe(true);
    expect(link.url.length).toBeLessThanOrEqual(500);
    const subject = decodeURIComponent(/subject=([^&]*)/.exec(link.url)![1]!);
    expect(subject.endsWith('…')).toBe(true);
    expect(subject).not.toContain('�');
    expect([...subject.slice(0, -1)].every((c) => c === '🐛')).toBe(true);
  });
});
