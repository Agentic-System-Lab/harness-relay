import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildChapters, replaceRail } from '../scripts/demo/chapters';
import type { Timeline } from '../scripts/demo/common';
import { retimeVideoData } from '../scripts/demo/publish';
import { USE_CASES, useCase } from '../scripts/demo/use-cases/cases';
import { posterTime, replaceLinks, useCaseLinks, useCaseRail } from '../scripts/demo/use-cases/publish';
import { shareUpTo } from '../scripts/demo/use-cases/share';
import { parseEvents } from '../src/server/connectors/caldav';
import { PROVIDERS, type ChatMessage } from '../src/shared/types';
import {
  BOOKS_OPENING,
  CALL_TITLE,
  COMPETITORS,
  ME,
  NEW_STRINGS,
  REP,
  addReminderStrings,
  bakeryBooks,
  billSplit,
  checkoutAlert,
  checkoutService,
  competitorPage,
  competitorUrl,
  fernwayStrings,
  interviews,
  launchBrief,
  renewalCalendar,
  renewalCall,
  renewalMailbox,
  renewals,
  signupScreens,
  studioLaterMail,
  studioMailbox,
  vendorContract,
} from '../scripts/demo/use-cases/workspaces';
import { slow } from './timeouts';

// The website's use cases (`npm run use-cases`, scripts/demo/use-cases/): what each recording types, where it
// runs, how its chapters read, and the pieces of publishing them that are pure. Nothing here records: the
// recordings need the real CLIs.

const LANGS = ['en', 'zh-TW'] as const;
const dirs: string[] = [];
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), 'use-case-'));
  dirs.push(dir);
  return dir;
};
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const git = (dir: string, args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();

/** A timeline with every mark a use case's chapters start at, five seconds apart, and its team. */
function timelineFor(slug: string): Timeline {
  const uc = useCase(slug);
  const chapters = LANGS.flatMap((l) => uc.rail[l]);
  const teams = [...new Set(['q1', ...chapters.flatMap((c) => (c.team ? [c.team] : []))])].map((t) => `${t}-confirmed`);
  const names = [...new Set([...teams, ...chapters.map((c) => c.at)])];
  const team = {
    source: 'adapted',
    team: 'Team',
    basedOn: 'Parallel comparison',
    lead: 'claude',
    mode: 'parallel',
    rounds: 1,
    agents: [
      ['Claude', 'claude'],
      ['Codex', 'codex'],
      ['Grok', 'grok'],
    ],
  };
  const marks = names.map((name, i) => ({
    name,
    video: i * 5,
    ...(teams.includes(name) ? team : {}),
    ...(name === 'approval' || name === 'asked-user' ? { agent: 'Checker', provider: 'grok' } : {}),
    ...(['diff', 'apply', 'redline'].includes(name) ? { agent: 'Codex', provider: 'codex' } : {}),
  }));
  return { speed: 3, length: 120, marks };
}

/** A CSV line's fields, a quoted one unquoted. */
function csvFields(line: string): string[] {
  const out: string[] = [];
  let at = 0;
  while (at <= line.length) {
    if (line[at] === '"') {
      let end = at + 1;
      let text = '';
      for (;;) {
        const quote = line.indexOf('"', end);
        if (line[quote + 1] === '"') {
          text += line.slice(end, quote + 1);
          end = quote + 2;
          continue;
        }
        text += line.slice(end, quote);
        at = quote + 2;
        break;
      }
      out.push(text);
    } else {
      const comma = line.indexOf(',', at);
      const end = comma < 0 ? line.length : comma;
      out.push(line.slice(at, end));
      at = end + 1;
    }
  }
  return out;
}

describe('the use cases', () => {
  it('are twelve, each with a slug of its own, the CLIs it needs and what it types in both languages', () => {
    expect(USE_CASES.map((u) => u.slug)).toEqual([
      'fix-a-bug',
      'product-spec',
      'launch-copy',
      'reconcile-accounts',
      'collect-payments',
      'call-brief',
      'literature-review',
      'write-a-quiz',
      'contract-review',
      'triage-an-alert',
      'design-review',
      'translate-strings',
    ]);
    for (const uc of USE_CASES) {
      expect(uc.slug, uc.slug).toMatch(/^[a-z]+(-[a-z]+)*$/);
      expect(uc.providers.length, uc.slug).toBeGreaterThan(0);
      expect(
        uc.providers.every((p) => PROVIDERS.includes(p)),
        uc.slug,
      ).toBe(true);
      expect(Object.keys(uc.text['zh-TW']), uc.slug).toEqual(Object.keys(uc.text.en));
      for (const lang of LANGS)
        for (const text of Object.values(uc.text[lang])) expect(text.trim().length, `${uc.slug} ${lang}`).toBeGreaterThan(40);
      expect(uc.length, uc.slug).toBeGreaterThanOrEqual(45);
      expect(uc.length, uc.slug).toBeLessThanOrEqual(90);
    }
    expect(() => useCase('nope')).toThrow(/No use case nope/);
  });

  it('check, before they record, each CLI that what they ask names', () => {
    const names = { claude: 'Claude Code', codex: 'Codex', grok: 'Grok', antigravity: 'Antigravity', copilot: 'Copilot' } as const;
    for (const uc of USE_CASES) {
      for (const lang of LANGS) {
        const said = Object.values(uc.text[lang]).join(' ');
        for (const [p, name] of Object.entries(names)) {
          if (said.includes(name)) expect(uc.providers, `${uc.slug} ${lang}: ${name}`).toContain(p);
        }
      }
    }
    // Their agents need Harness Relay's browser or mail tools, which Grok gets in full access only.
    expect(useCase('launch-copy').providers).toEqual(['claude', 'codex']);
    expect(useCase('collect-payments').providers).toEqual(['claude', 'codex']);
    // The call brief's Grok gets no tools there: it argues from what the others found.
    expect(useCase('call-brief').providers).toEqual(['claude', 'codex', 'grok']);
    expect(useCase('translate-strings').providers).toEqual(['antigravity', 'copilot', 'claude']);
    // What each one quotes on the page: the question, or an automation's message.
    for (const uc of USE_CASES) for (const lang of LANGS) expect(uc.text[lang].question ?? uc.text[lang].message, uc.slug).toBeTruthy();
  });

  it('have the same chapters in both languages, every placeholder filled in from the recording', () => {
    for (const uc of USE_CASES) {
      expect(
        uc.rail['zh-TW'].map((c) => c.at),
        uc.slug,
      ).toEqual(uc.rail.en.map((c) => c.at));
      // Every chapter starts at a mark the recording leaves; a poster mark is one of them, or its fallback.
      expect([...uc.rail.en.map((c) => c.at), 'q1-answered'], uc.slug).toContain(uc.poster.at);
      for (const lang of LANGS) {
        const { chapters, missing } = buildChapters(lang, useCaseRail(uc, lang), timelineFor(uc.slug));
        expect(missing, `${uc.slug} ${lang}`).toEqual([]);
        expect(chapters.length, `${uc.slug} ${lang}`).toBe(uc.rail[lang].length);
        for (const c of chapters) expect(c.say, `${uc.slug} ${lang}`).not.toMatch(/[{}]/);
        // A sentence starts with a capital in English.
        if (lang === 'en') for (const c of chapters) expect(c.say, uc.slug).toMatch(/^[A-Z“]/);
      }
    }
    const fix = buildChapters('en', useCaseRail(useCase('fix-a-bug'), 'en'), timelineFor('fix-a-bug')).chapters;
    expect(fix.find((c) => c.say.startsWith('Open the smallest'))?.say).toBe('Open the smallest fix’s diff, @Codex’s.');
    expect(fix.find((c) => c.kind === 'lead')?.say).toMatch(
      /^Adapts the Parallel comparison template for the question: Claude, Codex and Grok,/,
    );
  });

  it('refuse a chapter whose mark does not say what it names', () => {
    const t = timelineFor('fix-a-bug');
    t.marks = t.marks.map((m) => (m.name === 'diff' ? { name: 'diff', video: m.video } : m));
    expect(() => buildChapters('en', useCaseRail(useCase('fix-a-bug'), 'en'), t)).toThrow(/No agent on the diff mark/);
  });

  it('take the poster from their mark, or the answers when it never came, inside the video', () => {
    const uc = useCase('reconcile-accounts');
    const t: Timeline = {
      speed: 3,
      length: 70,
      marks: [
        { name: 'q1-answered', video: 40 },
        { name: 'review', video: 50 },
      ],
    };
    expect(posterTime(uc, t)).toBe(50 + uc.poster.offset);
    expect(posterTime(uc, { ...t, marks: [{ name: 'q1-answered', video: 40 }] })).toBe(41);
    expect(posterTime(uc, { ...t, length: 51, marks: [{ name: 'review', video: 50 }] })).toBe(50.5);
    expect(() => posterTime(uc, { ...t, marks: [] })).toThrow(/No review or q1-answered mark/);
  });
});

describe('sharing a use case', () => {
  const reply = (id: string, status: ChatMessage['status']) => ({ id, author: { kind: 'agent' }, status }) as unknown as ChatMessage;
  const user = (id: string) => ({ id, author: { kind: 'user' }, status: 'done' }) as unknown as ChatMessage;

  it('shares the whole conversation, review and notes after the replies included, unless its last reply did not finish', () => {
    const note = (id: string) => ({ id, author: { kind: 'system' }, status: 'done' }) as unknown as ChatMessage;
    expect(shareUpTo({ messages: [user('u'), reply('a', 'done'), reply('b', 'done')] })).toBeUndefined();
    expect(shareUpTo({ messages: [user('u'), reply('a', 'done'), note('review')] })).toBeUndefined();
    // A reply still running when the recording ended (stopped since) is left out, with what came after it.
    expect(shareUpTo({ messages: [user('u'), reply('a', 'done'), reply('b', 'error')] })).toBe('a');
    expect(shareUpTo({ messages: [user('u'), reply('a', 'done'), reply('b', 'streaming'), note('n')] })).toBe('a');
    expect(shareUpTo({ messages: [user('u')] })).toBeUndefined();
  });

  it('links the conversation as shared, with how many files went along, and the attached files as GitHub shows them', () => {
    const share = { url: 'https://gistpreview.github.io/?abc123', files: 2, attachments: ['notes.md', '銀行對帳單 10月.csv'] };
    const en = useCaseLinks('reconcile-accounts', 'en', share, 14);
    expect(en).toBe(
      [
        '<ul class="usecase-links">',
        '                <li><a href="https://gistpreview.github.io/?abc123">Read the whole conversation</a>, as Harness Relay’s Share made it, with the 2 files its replies link to.</li>',
        '                <li>Attached to the question: <a href="https://github.com/Agentic-System-Lab/harness-relay/blob/main/site/assets/media/use-cases/files/reconcile-accounts/en/notes.md">notes.md</a>, <a href="https://github.com/Agentic-System-Lab/harness-relay/blob/main/site/assets/media/use-cases/files/reconcile-accounts/en/%E9%8A%80%E8%A1%8C%E5%B0%8D%E5%B8%B3%E5%96%AE%2010%E6%9C%88.csv">銀行對帳單 10月.csv</a>.</li>',
        '              </ul>',
      ].join('\n'),
    );
    const zh = useCaseLinks('fix-a-bug', 'zh-TW', { ...share, files: 1, attachments: [] }, 0);
    expect(zh).toBe(
      '<ul class="usecase-links">\n  <li><a href="https://gistpreview.github.io/?abc123">看完整對話</a>：Harness Relay 的「分享」做出的頁面，附上回覆連到的 1 個檔案。</li>\n</ul>',
    );
    expect(useCaseLinks('fix-a-bug', 'en', { ...share, files: 1, attachments: [] }, 0)).toContain('with the file its replies link to.');
    expect(useCaseLinks('fix-a-bug', 'en', { ...share, files: 0, attachments: [] }, 0)).toContain('as Harness Relay’s Share made it.</li>');
  });

  it('puts the links under what was asked in its own section, and replaces them there the next time', () => {
    const page = [
      '<section id="a">',
      '              <blockquote>A</blockquote>',
      '</section>',
      '<section id="b">',
      '              <blockquote>B</blockquote>',
      '</section>',
    ].join('\n');
    const links = (text: string) => (indent: number) =>
      `<ul class="usecase-links">\n${' '.repeat(indent + 2)}<li>${text}</li>\n${' '.repeat(indent)}</ul>`;
    const once = replaceLinks(page, 'b', links('one'));
    expect(once).toContain(
      '<blockquote>B</blockquote>\n              <ul class="usecase-links">\n                <li>one</li>\n              </ul>\n</section>',
    );
    expect(once).toContain('<blockquote>A</blockquote>\n</section>');
    const twice = replaceLinks(once, 'b', links('two'));
    expect(twice).toBe(once.replace('<li>one</li>', '<li>two</li>'));
    expect(() => replaceLinks(page, 'c', links('x'))).toThrow(/no element with the id c/);
  });
});

describe('publishing a use case', () => {
  const page = [
    '<script type="application/ld+json">',
    '{ "@graph": [',
    '  { "@type": "WebPage", "video": [{ "@id": "https://x/#a-video" }, { "@id": "https://x/#b-video" }] },',
    '  { "@type": "VideoObject", "@id": "https://x/#a-video", "uploadDate": "2026-01-01T00:00:00Z", "duration": "PT1M0S" },',
    '  { "@type": "VideoObject", "@id": "https://x/#b-video", "uploadDate": "2026-01-02T00:00:00Z", "duration": "PT2M0S" }',
    '] }',
    '</script>',
    '<section id="a">',
    '              <ol class="chapters">',
    '              </ol>',
    '</section>',
    '<section id="b">',
    '          <ol class="chapters">',
    '<li>old</li>',
    '          </ol>',
    '</section>',
  ].join('\n');

  it('brings only its own video’s structured data up to date, never the reference to it', () => {
    const out = retimeVideoData(page, { uploadDate: '2026-11-18T01:02:03Z', seconds: 75.4 }, 'b-video');
    expect(out).toContain('"@id": "https://x/#b-video", "uploadDate": "2026-11-18T01:02:03Z", "duration": "PT1M15S"');
    expect(out).toContain('"@id": "https://x/#a-video", "uploadDate": "2026-01-01T00:00:00Z", "duration": "PT1M0S"');
    expect(out.replace('2026-11-18T01:02:03Z', '2026-01-02T00:00:00Z').replace('PT1M15S', 'PT2M0S')).toBe(page);
    // The same video again keeps its date.
    expect(retimeVideoData(page, { seconds: 120 }, 'a-video')).toContain('"uploadDate": "2026-01-01T00:00:00Z", "duration": "PT2M0S"');
    expect(() => retimeVideoData(page, { seconds: 60 }, 'c-video')).toThrow(/one VideoObject #c-video, not 0/);
  });

  it('writes its chapters into its own section, as indented as the list was', () => {
    const { chapters } = buildChapters('en', useCaseRail(useCase('fix-a-bug'), 'en'), timelineFor('fix-a-bug'));
    const out = replaceRail(page, chapters, 'b');
    expect(out).not.toContain('<li>old</li>');
    // Section a's list is left empty, section b's has the chapters, two spaces in from its own.
    expect(out).toContain('<section id="a">\n              <ol class="chapters">\n              </ol>');
    expect(out).toContain('<section id="b">\n          <ol class="chapters">\n            <li>\n              <button class="chapter"');
    expect(out).toMatch(/<\/li>\n {10}<\/ol>\n<\/section>$/);
    expect(() => replaceRail(page, chapters, 'c')).toThrow(/no element with the id c/);
  });
});

describe('the use cases’ workspaces', { timeout: slow(30_000) }, () => {
  it('bill-split: a git repository whose tests fail, as the bug fix needs', () => {
    const dir = join(scratch(), 'bill-split');
    billSplit(dir);
    expect(git(dir, ['log', '--format=%s'])).toBe('Split a bill evenly among friends');
    expect(git(dir, ['status', '--porcelain'])).toBe('');
    // TAP, as every Node.js prints it (from Node.js 23 a run without a terminal prints the spec summary by default).
    const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap'], { cwd: dir, encoding: 'utf8' });
    expect(run.status).not.toBe(0);
    expect(run.stdout).toMatch(/# pass 3\b/);
    expect(run.stdout).toMatch(/# fail 3\b/);
  });

  it('the interviews: five, the same files in both languages, two kinds of customer', () => {
    const [en, zh] = [interviews('en'), interviews('zh-TW')];
    expect(Object.keys(en)).toHaveLength(5);
    expect(Object.keys(zh)).toEqual(Object.keys(en));
    for (const text of [...Object.values(en), ...Object.values(zh)]) expect(text).toMatch(/^# .+\n\n.*2026/);
    expect(Object.values(en).join('\n')).toMatch(/caf[eé]/i);
    expect(Object.values(en).join('\n')).toMatch(/clinic/i);
  });

  it('the launch: a brief that links each competitor’s pricing page, each page its own', () => {
    for (const lang of LANGS) {
      const brief = launchBrief(lang, 4321)['LAUNCH.md']!;
      for (const c of COMPETITORS) {
        expect(brief, lang).toContain(competitorUrl(c, 4321));
        const page = competitorPage(lang, c);
        expect(page, `${lang} ${c}`).toMatch(/^<!doctype html>/);
        expect(page, `${lang} ${c}`).not.toMatch(/<script/i);
      }
    }
    expect(competitorUrl('wavecut', 4321)).toBe('http://wavecut.localhost:4321/pricing');
  });

  it('the books: a bank statement and a ledger that reconcile once the four differences are found', () => {
    for (const lang of LANGS) {
      const [bankFile, ledgerFile] = Object.values(bakeryBooks(lang));
      const rows = (text: string) => text.trim().split('\n').slice(1).map(csvFields);
      const bank = rows(bankFile!);
      const ledger = rows(ledgerFile!);
      const cents = (v: string) => Math.round(Number(v) * 100);
      // The statement's balance runs from the opening one.
      let balance = cents(bank[0]![3]!);
      for (const r of bank.slice(1)) {
        balance += cents(r[2]!);
        expect(cents(r[3]!), `${lang} ${r.join(',')}`).toBe(balance);
      }
      const book = ledger.reduce((n, r) => n + cents(r[4]!), 0);
      expect(cents(bank[0]![3]!), lang).toBe(Math.round(BOOKS_OPENING[lang] * 100));
      // Bank + deposit in transit − outstanding cheque = book − bank fees + the duplicate − the swapped digits.
      const d =
        lang === 'en'
          ? { transit: 3280.5, cheque: 620, fees: 35 + 268.42, twice: 1840, swapped: 36 }
          : { transit: 32805, cheque: 6200, fees: 350 + 2684, twice: 18400, swapped: 360 };
      const adjustedBank = balance + cents(String(d.transit)) - cents(String(d.cheque));
      const adjustedBook = book - cents(String(d.fees)) + cents(String(d.twice)) - cents(String(d.swapped));
      expect(adjustedBank, lang).toBe(adjustedBook);
      expect(balance, lang).not.toBe(book);
    }
  });

  it('the studio’s mail: three before the first run, two more before the second, all on made-up domains', () => {
    for (const lang of LANGS) {
      const mail = [...studioMailbox(lang), ...studioLaterMail(lang)];
      expect(mail.map((m) => m.uid)).toEqual([1, 2, 3, 4, 5]);
      for (const m of mail) {
        const text = Buffer.from(m.raw, 'latin1').toString('utf8');
        expect(text, lang).toMatch(new RegExp(`^Date: .+\\r\\nFrom: .+ <[^>]+\\.example>\\r\\nTo: .+ <${ME.address}>\\r\\nSubject: `));
        for (const address of text.match(/[\w.-]+@[\w.-]+/g) ?? []) expect(address, lang).toMatch(/\.example$/);
      }
    }
  });

  it('the renewal: four mails before the call, all on made-up domains, and the calendar before and when it is near', () => {
    const now = Date.now();
    for (const lang of LANGS) {
      const mail = renewalMailbox(lang);
      expect(mail.map((m) => m.uid)).toEqual([1, 2, 3, 4]);
      for (const m of mail) {
        const text = Buffer.from(m.raw, 'latin1').toString('utf8');
        expect(text, lang).toMatch(new RegExp(`^Date: .+\\r\\nFrom: .+ <[^>]+\\.example>\\r\\nTo: .+ <${REP.address}>\\r\\n`));
        for (const address of text.match(/[\w.-]+@[\w.-]+/g) ?? []) expect(address, lang).toMatch(/\.example$/);
      }
      expect(Object.keys(renewals(lang)).sort()).toEqual([
        'PRICING.md',
        'accounts/harbor-pine-usage.csv',
        'accounts/harbor-pine.md',
        'accounts/kestrel-labs.md',
      ]);
      // Before: the last review with the customer, weeks ago, and an internal meeting soon, no customer call.
      const before = renewalCalendar(lang).flatMap(parseEvents);
      expect(before).toHaveLength(2);
      const [qbr, internal] = before;
      expect(qbr!.summary, lang).toContain(CALL_TITLE[lang]);
      expect(qbr!.at!, lang).toBeLessThan(now - 30 * 86_400_000);
      expect(qbr!.description, lang).toBeTruthy();
      expect(internal!.summary, lang).not.toContain(CALL_TITLE[lang]);
      expect(internal!.at! - now, lang).toBeLessThan(30 * 60_000);
      // Then the call, less than half an hour away, with the customer's two people.
      const [call] = parseEvents(renewalCall(lang));
      expect(call!.summary, lang).toContain(CALL_TITLE[lang]);
      expect(call!.at! - now, lang).toBeGreaterThanOrEqual(24 * 60_000 - 1000);
      expect(call!.at! - now, lang).toBeLessThanOrEqual(29 * 60_000 + 1000);
      expect(
        call!.attendees.filter((a) => a.endsWith('@harborpine.example')),
        lang,
      ).toHaveLength(2);
      for (const e of [...before, call!]) for (const a of e.attendees) expect(a, lang).toMatch(/\.example$/);
    }
  });

  it('fernway-app: the strings in three languages, committed, each translation with the same keys, placeholders and tags', () => {
    const tokens = (s: string) => (s.match(/\{[^{}]*\}|<\/?\w+>/g) ?? []).sort();
    for (const lang of LANGS) {
      const dir = join(scratch(), `fernway-${lang}`);
      fernwayStrings(dir, lang);
      expect(git(dir, ['ls-files']).split('\n')).toEqual([
        'GLOSSARY.md',
        'README.md',
        'locales/en.json',
        'locales/ja.json',
        'locales/zh-TW.json',
      ]);
      expect(git(dir, ['status', '--porcelain'])).toBe('');
      const read = (l: string) => JSON.parse(readFileSync(join(dir, `locales/${l}.json`), 'utf8')) as Record<string, string>;
      const en = read('en');
      for (const l of ['zh-TW', 'ja']) {
        const t = read(l);
        expect(Object.keys(t), l).toEqual(Object.keys(en));
        for (const k of Object.keys(en)) expect(tokens(t[k]!), `${l} ${k}`).toEqual(tokens(en[k]!));
      }
      // You add the new screen's strings: en.json alone changes, the old strings as they were.
      addReminderStrings(dir);
      expect(git(dir, ['status', '--porcelain'])).toBe('M locales/en.json');
      const added = read('en');
      expect(Object.keys(added)).toHaveLength(Object.keys(en).length + NEW_STRINGS);
      expect(added).toMatchObject(en);
      expect(Object.values(added).some((v) => v.includes('plural'))).toBe(true);
    }
  });

  it('vendor-contract: the draft and the playbook, committed as they came', () => {
    const dir = join(scratch(), 'vendor-contract');
    vendorContract(dir, 'en');
    expect(git(dir, ['ls-files']).split('\n')).toEqual(['contract.md', 'playbook.md']);
    expect(git(dir, ['status', '--porcelain'])).toBe('');
    expect(readFileSync(join(dir, 'contract.md'), 'utf8')).toContain('three months');
  });

  it('checkout-service: errors only after the deploy, the log in time order, and the alert it fires', () => {
    const dir = join(scratch(), 'checkout-service');
    checkoutService(dir, 'en');
    const logs = join(dir, 'logs');
    const file = execFileSync('ls', [logs], { encoding: 'utf8' }).trim();
    const lines = readFileSync(join(logs, file), 'utf8').trim().split('\n');
    const times = lines.map((l) => Date.parse(l.split(' ')[0]!));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    const deploy = lines.findIndex((l) => l.includes('v2.31.0 starting'));
    expect(deploy).toBeGreaterThan(0);
    expect(lines.slice(0, deploy).some((l) => l.includes('ERROR'))).toBe(false);
    expect(lines.slice(deploy).filter((l) => l.includes('pool')).length).toBeGreaterThan(5);
    expect(readFileSync(join(dir, 'DEPLOYS.md'), 'utf8')).toContain('v2.31.0');
    expect(checkoutAlert()).toMatchObject({ alert: 'CheckoutErrorRate', status: 'firing' });
  });

  it('the sign-up screens: three pages, the same in both languages but for their words', () => {
    const [en, zh] = [signupScreens('en'), signupScreens('zh-TW')];
    expect(Object.keys(en)).toHaveLength(3);
    expect(Object.keys(zh)).toHaveLength(3);
    for (const html of [...Object.values(en), ...Object.values(zh)]) expect(html).not.toMatch(/<script|https?:/i);
  });
});
