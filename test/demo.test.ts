import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { buildChapters, joinNames, planPhrase, RAILS, renderRail, replaceRail, rounds, teamWho } from '../scripts/demo/chapters';
import type { FrameEntry, Mark, Timeline } from '../scripts/demo/common';
import { ffconcat, MIN_FAST, planCut, TAIL } from '../scripts/demo/cut';
import { retimeGuidelines } from '../scripts/demo/publish';
import { DEMO_PROVIDERS, SCENARIOS } from '../scripts/demo/record';
import { PROVIDER_LABEL } from '../src/shared/types';
import { pngChunks, pngText, swapScreen, withPngText } from '../scripts/demo/stills';

/** Frames every `step` seconds from `from` to `to`. */
function frames(from: number, to: number, step: number): FrameEntry[] {
  const out: FrameEntry[] = [];
  for (let t = from, i = 1; t <= to + 1e-9; t += step, i++) out.push({ file: `${String(i).padStart(6, '0')}.jpg`, ts: t });
  return out;
}

const total = (plan: ReturnType<typeof planCut>) => plan.frames.reduce((s, f) => s + f.duration, 0);
const at = (plan: ReturnType<typeof planCut>, name: string) => plan.timeline.marks.find((m) => m.name === name)?.video;

describe('planCut', () => {
  it('plays a recording without sped-up stretches in real time, with a short tail', () => {
    const plan = planCut(frames(100, 110, 0.5), [{ name: 'start', t: 100 }, { name: 'end', t: 110 }], 120);
    expect(plan.timeline.speed).toBe(1);
    expect(plan.timeline.length).toBeCloseTo(10 + TAIL, 5);
    expect(total(plan)).toBeCloseTo(10 + TAIL, 5);
    expect(at(plan, 'end')).toBe(10);
  });

  it('speeds the agents’ work up so the video lasts about the target', () => {
    const marks: Mark[] = [
      { name: 'start', t: 0 },
      { name: 'fast-start', t: 10 },
      { name: 'fast-end', t: 410 },
      { name: 'q1-plan', t: 412, team: 'Review' },
      { name: 'end', t: 420 },
    ];
    const plan = planCut(frames(0, 420, 0.25), marks, 60);
    // 21.5 s play in real time (10 before, 10 after, the tail), so 400 s of work get 38.5 s.
    expect(plan.timeline.length).toBeCloseTo(60, 1);
    expect(plan.timeline.speed).toBeCloseTo(400 / 38.5, 1);
    expect(at(plan, 'fast-end')).toBeCloseTo(48.5, 1);
    expect(at(plan, 'q1-plan')).toBeCloseTo(50.5, 1);
    expect(plan.timeline.marks.find((m) => m.name === 'q1-plan')?.team).toBe('Review');
    expect(total(plan)).toBeCloseTo(plan.timeline.length, 1);
  });

  it('keeps every sped-up stretch at least MIN_FAST long', () => {
    const marks: Mark[] = [
      { name: 'start', t: 0 },
      { name: 'fast-start', t: 5 },
      { name: 'fast-end', t: 1005 },
      { name: 'fast-start', t: 1010 },
      { name: 'fast-end', t: 1020 },
      { name: 'end', t: 1025 },
    ];
    const plan = planCut(frames(0, 1025, 0.25), marks, 30);
    const times = (name: string) => plan.timeline.marks.filter((m) => m.name === name).map((m) => m.video);
    const [start, end] = [times('fast-start'), times('fast-end')];
    // At the common speed the short stretch would flash by in 0.13 s.
    expect(end[1] - start[1]).toBeCloseTo(MIN_FAST, 1);
    expect(end[0] - start[0]).toBeCloseTo(1000 / plan.timeline.speed, 1);
  });

  it('cuts skipped stretches out, frames and time', () => {
    const marks: Mark[] = [
      { name: 'start', t: 0 },
      { name: 'skip-start', t: 20 },
      { name: 'skip-end', t: 80 },
      { name: 'end', t: 100 },
    ];
    const plan = planCut(frames(0, 100, 1), marks, 120);
    expect(plan.timeline.length).toBeCloseTo(40 + TAIL, 5);
    expect(at(plan, 'end')).toBe(40);
    expect(plan.timeline.marks.map((m) => m.name)).not.toContain('skip-start');
    expect(plan.frames.map((f) => f.file)).not.toContain('000051.jpg'); // the frame at 50 s
  });

  it('refuses a recording that did not finish', () => {
    expect(() => planCut(frames(0, 10, 1), [{ name: 'start', t: 0 }], 120)).toThrow(/end mark/);
  });

  it('lists the frames for FFmpeg, the last one twice so its duration counts', () => {
    const list = ffconcat("/rec/it's/frames", [
      { file: '000001.jpg', duration: 0.5 },
      { file: '000002.jpg', duration: 0.25 },
    ]);
    // The folder's quote quoted for FFmpeg, its separators this system's (`\` on Windows).
    const frame = (file: string) => `file '${join('/rec', "it'\\''s", 'frames', file)}'`;
    expect(list.split('\n')).toEqual(['ffconcat version 1.0', frame('000001.jpg'), 'duration 0.50000', frame('000002.jpg'), 'duration 0.25000', frame('000002.jpg'), '']);
    expect(frame('000001.jpg')).toBe(process.platform === 'win32' ? "file '\\rec\\it'\\''s\\frames\\000001.jpg'" : "file '/rec/it'\\''s/frames/000001.jpg'");
  });
});

/** A timeline with every mark the recorder leaves. */
function timeline(withApproval = true): Timeline {
  const marks = [
    { name: 'start', video: 0 },
    { name: 'group-made', video: 5.7, group: 'Design reviews' },
    { name: 'template-shown', video: 11.2, template: 'Parallel comparison' },
    { name: 'chat-open', video: 15.91 },
    { name: 'q1-plan', video: 24.74 },
    { name: 'poster', video: 26.8 },
    {
      name: 'q1-confirmed',
      video: 31.62,
      source: 'adapted',
      team: 'Relay design review',
      basedOn: 'Three-way debate',
      lead: 'claude',
      mode: 'roundtable',
      rounds: 2,
      agents: [
        ['Proposer', 'claude'],
        ['Pragmatist', 'codex'],
        ['Skeptic', 'grok'],
      ],
    },
    ...(withApproval ? [{ name: 'approval', video: 41.5, agent: 'Skeptic', provider: 'grok', detail: 'node -e …' }] : []),
    { name: 'q1-answered', video: 59.44 },
    { name: 'q1-read', video: 70.88 },
    { name: 'q2-plan', video: 77.91 },
    {
      name: 'q2-confirmed',
      video: 84.81,
      source: 'adapted',
      team: 'README writer',
      basedOn: 'Relay design review',
      lead: 'claude',
      mode: 'roundtable',
      rounds: 1,
      agents: [
        ['Proposer', 'claude'],
        ['Skeptic', 'grok'],
      ],
    },
    { name: 'files', video: 97.4 },
    { name: 'search', video: 113.99, term: 'maxHops' },
    { name: 'end', video: 120.88 },
  ];
  return { speed: 28.2, length: 122.38, marks };
}

describe('chapter rail', () => {
  it('times each chapter by its mark and fills in what the recording decided', () => {
    const { chapters, missing } = buildChapters('en', RAILS.en, timeline());
    expect(missing).toEqual([]);
    expect(chapters.map((c) => c.t)).toEqual([0, 16, 25, 32, 42, 59, 71, 78, 85, 97, 114]);
    expect(chapters[0].say).toBe('Create a group, “Design reviews”, and open a template: teams are designed in templates.');
    expect(chapters[2]).toMatchObject({ kind: 'lead', who: 'Lead agent', av: 'C', tone: 'claude', via: 'Claude Code' });
    expect(chapters[2].say).toBe('Sorts the chat into Design reviews, adapts the Three-way debate template for the question, and says why.');
    expect(chapters[3]).toMatchObject({ kind: 'team', who: 'All three', members: [['P', 'claude'], ['P', 'codex'], ['S', 'grok']] });
    expect(chapters[3].say).toMatch(/^Once you confirm, two rounds:/);
    expect(chapters[4]).toMatchObject({ kind: 'agent', who: '@Skeptic', av: 'S', tone: 'grok', via: 'Grok' });
    expect(chapters[7].say).toBe('Picks a team for it: Proposer and Skeptic, one round. The review team stays until you confirm.');
    expect(chapters[8].who).toBe('Proposer and Skeptic');
    expect(chapters[10].say).toBe('Search for “maxHops” and find the chat by what the agents wrote.');
  });

  it('leaves out a chapter whose mark never came', () => {
    const { chapters, missing } = buildChapters('zh-TW', RAILS['zh-TW'], timeline(false));
    expect(missing).toEqual(['approval']);
    expect(chapters).toHaveLength(RAILS['zh-TW'].chapters.length - 1);
    expect(chapters.some((c) => /\{\w+\}/.test(c.say))).toBe(false);
    expect(chapters[3].who).toBe('三位成員');
    expect(chapters[3].say).toMatch(/^確認後兩輪圓桌/);
  });

  it('words teams, rounds and the lead agent’s choice in both languages', () => {
    expect(joinNames('en', ['A', 'B', 'C'])).toBe('A, B and C');
    expect(joinNames('zh-TW', ['A', 'B', 'C'])).toBe('A、B 與 C');
    expect(teamWho('en', ['A', 'B'])).toBe('A and B');
    expect(teamWho('zh-TW', ['A', 'B', 'C', 'D'])).toBe('四位成員');
    expect(rounds('en', 1)).toBe('one round');
    expect(rounds('zh-TW', 2)).toBe('兩輪');
    expect(planPhrase('en', { name: 'q1-confirmed', video: 0, source: 'template', team: 'Three-way debate' })).toBe('picks the Three-way debate template');
    expect(planPhrase('zh-TW', { name: 'q1-confirmed', video: 0, source: 'custom' })).toBe('為這個問題設計新團隊');
  });

  it('writes the rail as the pages have it, replacing only the rail', () => {
    const { chapters } = buildChapters('en', RAILS.en, timeline());
    const rail = renderRail(chapters);
    expect(rail).toContain('<button class="chapter t-team" type="button" data-t="32">\n                  <time>0:32</time>');
    expect(rail).toContain('><span class="av t-claude">P</span><span class="av t-codex">P</span><span class="av t-grok">S</span></span');
    expect(rail).toContain('<span class="actor"><span class="av av-you" aria-hidden="true"></span><span class="who">You</span></span>');
    expect(rail).toContain('<time>1:54</time>');
    const page = '<p>before</p>\n            <ol class="chapters">\n<li>old</li>\n            </ol>\n<ol><li>other</li></ol>';
    const out = replaceRail(page, chapters);
    expect(out.startsWith('<p>before</p>\n            <ol class="chapters">\n')).toBe(true);
    expect(out).not.toContain('<li>old</li>');
    expect(out.endsWith('</ol>\n<ol><li>other</li></ol>')).toBe(true);
    expect(rail.match(/<li>/g)).toHaveLength(chapters.length);
  });

  it('escapes what goes into the page', () => {
    const rail = renderRail([{ t: 3, kind: 'you', who: 'You', say: 'Search for <b> & more' }]);
    expect(rail).toContain('Search for &lt;b&gt; &amp; more');
  });
});

describe('demo scenario and site', () => {
  it('asks for all three CLIs in both languages, so the first team (and the posters) shows each', () => {
    for (const s of Object.values(SCENARIOS)) {
      for (const cli of ['Claude Code', 'Codex', 'Grok']) expect(s.question).toContain(cli);
    }
    // Only those must be installed and signed in to record it (Cursor is not asked for).
    expect(DEMO_PROVIDERS.map((p) => PROVIDER_LABEL[p])).toEqual(['Claude Code', 'Codex', 'Grok']);
  });

  it('re-times only the language’s poster frame in the design guidelines', () => {
    const md = '| `poster-en.webp` | Frame at 0:27.5 of `docs/media/demo-en.mp4` |\n| `poster-zh-TW.webp` | Frame at 0:22.5 of `docs/media/demo-zh-TW.mp4` |\n';
    const out = retimeGuidelines(md, 'zh-TW', 63.04);
    expect(out).toContain('Frame at 0:27.5 of `docs/media/demo-en.mp4`');
    expect(out).toContain('Frame at 1:03.0 of `docs/media/demo-zh-TW.mp4`');
  });
});

/** A small RGB PNG. */
function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    return Buffer.concat([head, data, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

describe('stills', () => {
  it('records where a PNG came from in a text chunk before its image data, once', async () => {
    const { crc32 } = await import('node:zlib');
    const once = withPngText(png(2, 2), 'impeccable:prompt', 'Origin: first\n');
    const twice = withPngText(once, 'impeccable:prompt', 'Origin: second\n');
    expect(pngText(twice, 'impeccable:prompt')).toBe('Origin: second\n');
    const chunks = pngChunks(twice);
    expect(chunks.map((c) => c.type)).toEqual(['IHDR', 'tEXt', 'IDAT', 'IEND']);
    // Every chunk's CRC is right (the input's were zeros).
    let offset = 8;
    for (const c of chunks) {
      const crc = twice.readUInt32BE(offset + 8 + c.data.length);
      expect(crc).toBe(crc32(twice.subarray(offset + 4, offset + 8 + c.data.length)));
      offset += 12 + c.data.length;
    }
  });

  it('swaps only the social card’s screen: pixels that showed the old poster', () => {
    // A 4×2 card; the screen is the 2×2 box at x = 2, cut off by nothing.
    const card = Buffer.alloc(4 * 2 * 3, 200);
    const old = Buffer.alloc(2 * 2 * 3, 200);
    const next = Buffer.alloc(2 * 2 * 3, 10);
    card[(1 * 4 + 3) * 3] = 0; // something drawn over the screen's corner
    const changed = swapScreen(card, 4, { x: 2, y: 0, w: 2, h: 2 }, old, next);
    expect(changed).toBe(3);
    expect([...card.subarray(0, 6)]).toEqual([200, 200, 200, 200, 200, 200]); // outside the box
    expect(card[(0 * 4 + 2) * 3]).toBe(10);
    expect(card[(1 * 4 + 3) * 3]).toBe(0);
  });
});
