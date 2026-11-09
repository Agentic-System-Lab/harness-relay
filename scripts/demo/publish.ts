/**
 * Puts a cut recording where the project shows it: the video and the README animation in
 * docs/media/, the stills from the `poster` mark, the landing page's chapter rail and the design
 * guidelines' frame times. Then writes `review.md` next to the recording: the chapters as written
 * and what the agents did, to check the chapter sentences (scripts/demo/chapters.ts) against.
 */
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROVIDER_LABEL, type Conversation, type Provider } from '../../src/shared/types';
import { buildChapters, clock, RAILS, replaceRail } from './chapters';
import { ROOT, stamp, type DemoLang, type Timeline, type TimelineMark } from './common';
import { cutStills } from './stills';

const GUIDELINES = 'site/DESIGN-GUIDELINES.md';

/** The design guidelines with the poster's frame time for `lang` brought up to date. */
export function retimeGuidelines(md: string, lang: DemoLang, at: number): string {
  const re = new RegExp(`(Frame at )\\d+:\\d+(?:\\.\\d+)?( of \`docs/media/demo-${lang.replace('-', '\\-')}\\.mp4\`)`, 'g');
  return md.replace(re, `$1${stamp(at)}$2`);
}

export function publish(dir: string, lang: DemoLang, log: (...a: unknown[]) => void): void {
  const timeline = JSON.parse(readFileSync(join(dir, 'timeline.json'), 'utf8')) as Timeline;
  const conversation = JSON.parse(readFileSync(join(dir, 'conversation.json'), 'utf8')) as Conversation;

  copyFileSync(join(dir, 'video.mp4'), join(ROOT, `docs/media/demo-${lang}.mp4`));
  copyFileSync(join(dir, 'animation.webp'), join(ROOT, `docs/media/demo-${lang}.webp`));
  log(`docs/media/demo-${lang}.mp4 and .webp replaced`);

  const poster = timeline.marks.find((m) => m.name === 'poster')?.video ?? timeline.marks.find((m) => m.name === 'q1-plan')?.video;
  if (poster === undefined) throw new Error('No poster mark in the timeline');
  const at = Math.round(poster * 10) / 10;
  cutStills(lang, at, dir, log);
  const guidelines = join(ROOT, GUIDELINES);
  writeFileSync(guidelines, retimeGuidelines(readFileSync(guidelines, 'utf8'), lang, at));

  const spec = RAILS[lang];
  const { chapters, missing } = buildChapters(lang, spec, timeline);
  const page = join(ROOT, spec.page);
  writeFileSync(page, replaceRail(readFileSync(page, 'utf8'), chapters));
  log(`${spec.page}: ${chapters.length} chapters${missing.length ? ` (left out, no mark: ${missing.join(', ')})` : ''}`);

  const review = reviewNotes(lang, timeline, conversation, chapters.map((c) => `- ${clock(c.t)} **${c.who}**${c.via ? ` (${c.via})` : ''}: ${c.say}`), at);
  writeFileSync(join(dir, 'review.md'), review);
  log(`check the chapter texts against ${join(dir, 'review.md')}`);
}

const label = (p: unknown) => PROVIDER_LABEL[p as Provider] ?? String(p);
const oneLine = (s: string, max: number) => {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};

/** What happened in the recording, next to the chapters written for it. */
function reviewNotes(lang: DemoLang, timeline: Timeline, conversation: Conversation, chapters: string[], poster: number): string {
  const mark = (name: string): TimelineMark | undefined => timeline.marks.find((m) => m.name === name);
  const out = [
    `# Demo review: ${lang}`,
    '',
    `Video ${clock(Math.round(timeline.length))}, the agents' work sped up ×${timeline.speed}. Poster and stills: frame at ${stamp(poster)}.`,
    '',
    `## Chapters, as written into ${RAILS[lang].page}`,
    '',
    ...chapters,
    '',
    '## What happened',
    '',
  ];
  for (const q of ['q1', 'q2']) {
    const m = mark(`${q}-confirmed`);
    if (!m) {
      out.push(`- ${q}: no team was confirmed`);
      continue;
    }
    const agents = ((m.agents as [string, Provider][] | undefined) ?? []).map(([n, p]) => `${n} (${label(p)})`).join(', ');
    const based = m.basedOn ? `, from ${m.basedOn}` : '';
    out.push(`- ${q} at ${stamp(m.video)}: “${m.team}” (${m.source}${based}), ${m.mode}, ${m.rounds} round(s): ${agents}`);
    if (m.reason) out.push(`  - Reason: ${oneLine(String(m.reason), 600)}`);
  }
  const approvals = timeline.marks.filter((m) => m.name === 'approval');
  for (const a of approvals) out.push(`- Approval at ${stamp(a.video)}: ${a.agent} (${label(a.provider)}) asked for \`${oneLine(String(a.detail ?? ''), 200)}\`, declined`);
  if (!approvals.length) out.push('- No approval was asked for (the approval chapter is left out).');
  for (const a of timeline.marks.filter((m) => m.name === 'asked-user')) out.push(`- An agent asked the user something at ${stamp(a.video)}; skipped`);
  out.push(`- Search: “${mark('search')?.term ?? '?'}”`, '', '## The replies', '');
  for (const m of conversation.messages) {
    if (m.author.kind !== 'agent') continue;
    const text = m.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('\n');
    out.push(`### ${m.agentName} (${label(m.provider)}), ${m.status}`, '', oneLine(text, 1500), '');
  }
  return out.join('\n') + '\n';
}
