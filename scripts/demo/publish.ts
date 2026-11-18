/**
 * Puts a cut recording where the project shows it: the video and the README animation in
 * docs/media/, the stills from the `poster` mark, the landing page's chapter rail and its video's
 * structured data (published when, how long), and the design guidelines' frame times. Then writes
 * `review.md` next to the recording: the chapters as written and what the agents did, to check the
 * chapter sentences (scripts/demo/chapters.ts) against.
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROVIDER_LABEL, type Conversation, type Provider } from '../../src/shared/types';
import { buildChapters, clock, RAILS, replaceRail } from './chapters';
import { ROOT, stamp, type DemoLang, type Timeline, type TimelineMark } from './common';
import { cutStills } from './stills';

const GUIDELINES = 'site/DESIGN-GUIDELINES.md';

/** The design guidelines with the poster's frame time for `lang` brought up to date. */
export function retimeGuidelines(md: string, lang: DemoLang, at: number): string {
  const re = new RegExp(
    `(Frame at )\\d+:\\d+(?:\\.\\d+)?( of \`docs/media/demo-${lang.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.mp4\`)`,
    'g',
  );
  return md.replace(re, `$1${stamp(at)}$2`);
}

/** Seconds as an ISO 8601 duration, to the second (`PT2M6S`), as structured data writes a video's length. */
export function isoDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error(`Not a video's length: ${seconds}`);
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `PT${h ? `${h}H` : ''}${h || m ? `${m}M` : ''}${s % 60}S`;
}

/**
 * The page with its demo's structured data (the VideoObject in its JSON-LD) brought up to date: when the
 * video was published (left as it is without one: the same video again) and how long it is. Pure; the
 * page has each of the two fields once, or it is refused. With `node`, only the VideoObject whose `@id`
 * ends in `#<node>` (a page with several videos, as the use-cases pages are), which has them once.
 */
export function retimeVideoData(html: string, video: { uploadDate?: string; seconds: number }, node?: string): string {
  const set = (text: string, key: string, value: string | undefined) => {
    const re = new RegExp(`("${key}": )"[^"]*"`, 'g');
    if ((text.match(re) ?? []).length !== 1)
      throw new Error(`The ${node ? `#${node} video's` : "page's"} structured data should have "${key}" once`);
    return value === undefined ? text : text.replace(re, (_whole, field: string) => `${field}${JSON.stringify(value)}`);
  };
  const retime = (text: string) => set(set(text, 'uploadDate', video.uploadDate), 'duration', isoDuration(video.seconds));
  if (node === undefined) return retime(html);
  // The node itself, not a reference to it ({ "@id": … } alone, as the page's own node has): from its
  // opening brace to its closing one (a VideoObject holds no other object).
  const id = new RegExp(`"@id": "[^"]*#${node.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'g');
  const nodes = [...html.matchAll(id)]
    .map((m) => ({ start: html.lastIndexOf('{', m.index), end: html.indexOf('}', m.index) }))
    .filter(({ start, end }) => /"@type": "VideoObject"/.test(html.slice(start, end)));
  if (nodes.length !== 1) throw new Error(`The page's structured data should have one VideoObject #${node}, not ${nodes.length}`);
  const { start, end } = nodes[0]!;
  return html.slice(0, start) + retime(html.slice(start, end)) + html.slice(end);
}

export function publish(dir: string, lang: DemoLang, log: (...a: unknown[]) => void): void {
  const timeline = JSON.parse(readFileSync(join(dir, 'timeline.json'), 'utf8')) as Timeline;
  const conversation = JSON.parse(readFileSync(join(dir, 'conversation.json'), 'utf8')) as Conversation;

  // Everything that can refuse the recording first, so that a refusal leaves nothing half published.
  const poster = timeline.marks.find((m) => m.name === 'poster')?.video ?? timeline.marks.find((m) => m.name === 'q1-plan')?.video;
  if (poster === undefined) throw new Error('No poster mark in the timeline');
  const at = Math.round(poster * 10) / 10;
  const spec = RAILS[lang];
  const { chapters, missing } = buildChapters(lang, spec, timeline);
  const page = join(ROOT, spec.page);
  // A new video is published now; the same video again (publish run once more, after fixing the
  // chapter sentences) keeps the date it was first published on.
  const video = join(ROOT, `docs/media/demo-${lang}.mp4`);
  const same = existsSync(video) && readFileSync(video).equals(readFileSync(join(dir, 'video.mp4')));
  const uploadDate = same ? undefined : new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const html = retimeVideoData(replaceRail(readFileSync(page, 'utf8'), chapters), { uploadDate, seconds: timeline.length });

  copyFileSync(join(dir, 'video.mp4'), video);
  copyFileSync(join(dir, 'animation.webp'), join(ROOT, `docs/media/demo-${lang}.webp`));
  log(`docs/media/demo-${lang}.mp4 and .webp ${same ? 'unchanged' : 'replaced'}`);

  cutStills(lang, at, dir, log);
  const guidelines = join(ROOT, GUIDELINES);
  writeFileSync(guidelines, retimeGuidelines(readFileSync(guidelines, 'utf8'), lang, at));

  writeFileSync(page, html);
  const published = uploadDate ? `published ${uploadDate}` : 'publication date kept';
  log(
    `${spec.page}: ${chapters.length} chapters${missing.length ? ` (left out, no mark: ${missing.join(', ')})` : ''}; video ${isoDuration(timeline.length)}, ${published}`,
  );

  const review = reviewNotes(
    lang,
    timeline,
    conversation,
    chapters.map((c) => `- ${clock(c.t)} **${c.who}**${c.via ? ` (${c.via})` : ''}: ${c.say}`),
    at,
  );
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
  for (const a of approvals)
    out.push(
      `- Approval at ${stamp(a.video)}: ${a.agent} (${label(a.provider)}) asked for \`${oneLine(String(a.detail ?? ''), 200)}\`, declined`,
    );
  if (!approvals.length) out.push('- No approval was asked for (the approval chapter is left out).');
  for (const a of timeline.marks.filter((m) => m.name === 'asked-user'))
    out.push(`- An agent asked the user something at ${stamp(a.video)}; skipped`);
  out.push(`- Search: “${mark('search')?.term ?? '?'}”`, '', '## The replies', '');
  for (const m of conversation.messages) {
    if (m.author.kind !== 'agent') continue;
    const text = m.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('\n');
    out.push(`### ${m.agentName} (${label(m.provider)}), ${m.status}`, '', oneLine(text, 1500), '');
  }
  return out.join('\n') + '\n';
}
