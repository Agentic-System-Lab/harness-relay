import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildChapters, replaceRail } from '../scripts/demo/chapters';
import type { Timeline } from '../scripts/demo/common';
import { retimeVideoData } from '../scripts/demo/publish';
import { USE_CASES, useCase } from '../scripts/demo/use-cases/cases';
import { posterTime, useCaseRail } from '../scripts/demo/use-cases/publish';
import { billSplit, calendar, mailbox, pocketBudget, tickets } from '../scripts/demo/use-cases/workspaces';
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
  const names = [...new Set(['q1-confirmed', ...LANGS.flatMap((l) => uc.rail[l].map((c) => c.at))])];
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
    ...(name === 'q1-confirmed' ? team : {}),
    ...(name === 'approval' ? { agent: 'Checker', provider: 'grok' } : {}),
    ...(name === 'diff' || name === 'apply' ? { agent: 'Codex', provider: 'codex' } : {}),
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
  it('are five, each with a slug of its own, the CLIs it needs and what it types in both languages', () => {
    expect(USE_CASES.map((u) => u.slug)).toEqual(['fix-a-bug', 'research', 'release-notes', 'analyze-data', 'morning-briefing']);
    for (const uc of USE_CASES) {
      expect(uc.slug, uc.slug).toMatch(/^[a-z]+(-[a-z]+)*$/);
      expect(uc.providers.length, uc.slug).toBeGreaterThan(0);
      expect(
        uc.providers.every((p) => ['claude', 'codex', 'grok'].includes(p)),
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
    const names = { claude: 'Claude Code', codex: 'Codex', grok: 'Grok' } as const;
    for (const uc of USE_CASES) {
      for (const lang of LANGS) {
        const said = Object.values(uc.text[lang]).join(' ');
        for (const [p, name] of Object.entries(names)) {
          if (said.includes(name)) expect(uc.providers, `${uc.slug} ${lang}: ${name}`).toContain(p);
        }
      }
    }
    // The briefing's agents need Harness Relay's mail and calendar tools, which Grok gets in full access only.
    expect(useCase('morning-briefing').providers).toEqual(['claude', 'codex']);
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
    const uc = useCase('analyze-data');
    const t: Timeline = {
      speed: 3,
      length: 70,
      marks: [
        { name: 'q1-answered', video: 40 },
        { name: 'chart', video: 50 },
      ],
    };
    expect(posterTime(uc, t)).toBe(50 + uc.poster.offset);
    expect(posterTime(uc, { ...t, marks: [{ name: 'q1-answered', video: 40 }] })).toBe(41);
    expect(posterTime(uc, { ...t, length: 51, marks: [{ name: 'chart', video: 50 }] })).toBe(50.5);
    expect(() => posterTime(uc, { ...t, marks: [] })).toThrow(/No chart or q1-answered mark/);
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

  it('pocket-budget: the commits since v1.3.0 that the release notes are written from', () => {
    const dir = join(scratch(), 'pocket-budget');
    pocketBudget(dir);
    expect(git(dir, ['tag']).split('\n')).toEqual(['v1.2.0', 'v1.3.0']);
    const since = git(dir, ['log', '--format=%s', 'v1.3.0..HEAD']).split('\n');
    expect(since).toHaveLength(10);
    expect(since[0]).toBe('Set the version to 1.4.0');
    expect(since.at(-1)).toBe('Add --month to the report command, to report one month only');
    expect(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))).toMatchObject({ version: '1.4.0', engines: { node: '>=20' } });
    expect(git(dir, ['show', 'v1.3.0:package.json'])).toContain('"version": "1.3.0"');
    // Each commit changed something, by the three people named, at its own time.
    expect(new Set(git(dir, ['log', '--format=%an']).split('\n'))).toEqual(new Set(['Ana Lima', 'Ken Watanabe', 'Mei Chen']));
    expect(
      git(dir, ['log', '--format=%H', '--diff-filter=d', '--name-only', 'v1.3.0..HEAD']).split('\n').filter(Boolean).length,
    ).toBeGreaterThan(20);
  });

  it('the tickets: the same every time, in both languages, with the quarter’s story in them', () => {
    expect(tickets('en')).toBe(tickets('en'));
    const rows = (lang: (typeof LANGS)[number]) => tickets(lang).trim().split('\n').map(csvFields);
    const [en, zh] = [rows('en'), rows('zh-TW')];
    expect(en[0]).toEqual(['id', 'opened_at', 'area', 'channel', 'priority', 'subject', 'first_response_hours', 'resolved']);
    expect(zh[0]).toEqual(en[0]);
    expect(en.length).toBe(zh.length);
    expect(en.length).toBeGreaterThan(300);
    for (const r of [...en, ...zh]) expect(r).toHaveLength(8);
    // The same tickets: the numbers and dates agree, only the words differ.
    for (let i = 1; i < en.length; i++) {
      for (const col of [0, 1, 3, 4, 6, 7]) expect(zh[i]![col], `${i} ${col}`).toBe(en[i]![col]);
    }
    const billing = (from: string, to: string) => en.filter((r) => r[2] === 'Billing' && r[1]! >= from && r[1]! < to).length;
    // Four weeks before the invoice layout shipped, four weeks after: at least twice as many.
    expect(billing('2026-08-18', '2026-09-15')).toBeGreaterThan(2 * billing('2026-07-21', '2026-08-18'));
    expect(en.slice(1).every((r) => r[1]! >= '2026-07-01' && r[1]! < '2026-10-01')).toBe(true);
  });

  it('the mailbox and calendar: six mails and seven events, made up, in each language', () => {
    for (const lang of LANGS) {
      const mail = mailbox(lang);
      expect(mail.map((m) => m.uid)).toEqual([1, 2, 3, 4, 5, 6]);
      for (const m of mail) {
        const text = Buffer.from(m.raw, 'latin1').toString('utf8');
        expect(text, lang).toMatch(
          /^Date: .+\r\nFrom: .+ <[^>]+@([a-z]+\.)?example(\.com)?>\r\nTo: Alex Rivera <alex@example\.com>\r\nSubject: /,
        );
        expect(text, lang).toContain('\r\nContent-Type: text/plain; charset=utf-8\r\n');
        // Every address is on example.com or a .example domain, which nobody owns.
        for (const address of text.match(/[\w.-]+@[\w.-]+/g) ?? []) expect(address, lang).toMatch(/@([\w-]+\.)?example(\.com)?$/);
      }
      const events = calendar(lang);
      expect(events).toHaveLength(7);
      for (const e of events)
        expect(e, lang).toMatch(/^BEGIN:VCALENDAR\r\n[\s\S]*DTSTART:\d{8}T\d{6}Z\r\nDTEND:\d{8}T\d{6}Z\r\nSUMMARY:.+\r\n/);
    }
  });
});
