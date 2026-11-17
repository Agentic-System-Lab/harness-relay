/**
 * Puts a cut use-case recording where the website shows it: the video and its poster in
 * site/assets/media/use-cases/, the chapter rail in the use case's section of the use-cases page, and its
 * video's structured data (published when, how long). Then writes `review.md` next to the recording: the
 * chapters as written and what the agents did, to check the chapter sentences (cases.ts) against.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROVIDER_LABEL, type Conversation, type Provider } from '../../../src/shared/types';
import { buildChapters, clock, replaceRail, type RailSpec } from '../chapters';
import { ROOT, stamp, type DemoLang, type Timeline } from '../common';
import { isoDuration, retimeVideoData } from '../publish';
import type { UseCase } from './cases';

/** The use-cases page of each language, from the repository root. */
export const USE_CASE_PAGES: Record<DemoLang, string> = { en: 'site/use-cases/index.html', 'zh-TW': 'site/zh-TW/use-cases/index.html' };

/** Where a use case's video and poster are, from the repository root. */
export const useCaseMedia = (slug: string, lang: DemoLang) => ({
  video: `site/assets/media/use-cases/${slug}-${lang}.mp4`,
  poster: `site/assets/media/use-cases/${slug}-${lang}.webp`,
});

/** A use case's rail, as `buildChapters` takes it. */
export function useCaseRail(uc: UseCase, lang: DemoLang): RailSpec {
  return {
    page: USE_CASE_PAGES[lang],
    you: lang === 'en' ? 'You' : '你',
    lead: lang === 'en' ? 'Lead agent' : '首席 agent',
    chapters: uc.rail[lang],
  };
}

/** When the poster's frame is, in the video: the use case's poster mark (or its fallback) and offset, inside the video. */
export function posterTime(uc: UseCase, timeline: Timeline): number {
  const mark = timeline.marks.find((m) => m.name === uc.poster.at) ?? timeline.marks.find((m) => m.name === uc.poster.fallback);
  if (!mark) throw new Error(`No ${uc.poster.at} or ${uc.poster.fallback} mark in the timeline`);
  const offset = mark.name === uc.poster.at ? uc.poster.offset : 1;
  return Math.round(Math.min(Math.max(0, mark.video + offset), timeline.length - 0.5) * 10) / 10;
}

export function publishUseCase(dir: string, uc: UseCase, lang: DemoLang, log: (...a: unknown[]) => void): void {
  const timeline = JSON.parse(readFileSync(join(dir, 'timeline.json'), 'utf8')) as Timeline;
  const conversation = existsSync(join(dir, 'conversation.json'))
    ? (JSON.parse(readFileSync(join(dir, 'conversation.json'), 'utf8')) as Conversation)
    : undefined;

  // Everything that can refuse the recording first, so that a refusal leaves nothing half published.
  const at = posterTime(uc, timeline);
  const spec = useCaseRail(uc, lang);
  const { chapters, missing } = buildChapters(lang, spec, timeline);
  const page = join(ROOT, spec.page);
  const media = useCaseMedia(uc.slug, lang);
  const video = join(ROOT, media.video);
  // A new video is published now; the same video again keeps the date it was first published on.
  const same = existsSync(video) && readFileSync(video).equals(readFileSync(join(dir, 'video.mp4')));
  const uploadDate = same ? undefined : new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const html = retimeVideoData(
    replaceRail(readFileSync(page, 'utf8'), chapters, uc.slug),
    { uploadDate, seconds: timeline.length },
    `${uc.slug}-video`,
  );

  mkdirSync(join(ROOT, 'site/assets/media/use-cases'), { recursive: true });
  copyFileSync(join(dir, 'video.mp4'), video);
  log(`${media.video} ${same ? 'unchanged' : 'replaced'}`);

  // The poster, and where it came from.
  const frame = join(dir, 'poster.png');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', at.toFixed(3), '-i', video, '-frames:v', '1', frame]);
  const poster = join(ROOT, media.poster);
  execFileSync('cwebp', ['-quiet', '-q', '80', frame, '-o', poster]);
  rmSync(frame);
  const sidecar = {
    prompt: `Origin: frame at ${stamp(at)} of ${media.video} (Harness Relay's own use-case recording), extracted with ffmpeg, encoded with cwebp -q 80.\n`,
    createdAt: new Date().toISOString(),
  };
  writeFileSync(`${poster}.json`, JSON.stringify(sidecar, null, 2) + '\n');
  log(`${media.poster}: frame at ${stamp(at)}`);

  writeFileSync(page, html);
  log(
    `${spec.page} #${uc.slug}: ${chapters.length} chapters${missing.length ? ` (left out, no mark: ${missing.join(', ')})` : ''}; video ${isoDuration(timeline.length)}, ${uploadDate ? `published ${uploadDate}` : 'publication date kept'}`,
  );

  const notes = existsSync(join(dir, 'notes.json')) ? (JSON.parse(readFileSync(join(dir, 'notes.json'), 'utf8')) as string[]) : [];
  writeFileSync(
    join(dir, 'review.md'),
    reviewNotes(
      uc,
      lang,
      timeline,
      conversation,
      chapters.map((c) => `- ${clock(c.t)} **${c.who}**${c.via ? ` (${c.via})` : ''}: ${c.say}`),
      at,
      notes,
    ),
  );
  log(`check the chapter texts against ${join(dir, 'review.md')}`);
}

const label = (p: unknown) => PROVIDER_LABEL[p as Provider] ?? String(p);
const oneLine = (s: string, max: number) => {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};

/** What happened in the recording, next to the chapters written for it. */
function reviewNotes(
  uc: UseCase,
  lang: DemoLang,
  timeline: Timeline,
  conversation: Conversation | undefined,
  chapters: string[],
  poster: number,
  notes: string[],
): string {
  const out = [
    `# Use case review: ${uc.slug}, ${lang}`,
    '',
    `Video ${clock(Math.round(timeline.length))}, the agents' work sped up ×${timeline.speed}. Poster: frame at ${stamp(poster)}.`,
    '',
    `## Chapters, as written into ${USE_CASE_PAGES[lang]}`,
    '',
    ...chapters,
    '',
    '## What happened',
    '',
  ];
  const team = timeline.marks.find((m) => m.name === 'q1-confirmed');
  if (team) {
    const agents = ((team.agents as [string, Provider][] | undefined) ?? []).map(([n, p]) => `${n} (${label(p)})`).join(', ');
    out.push(
      `- Team at ${stamp(team.video)}: “${team.team}” (${team.source}${team.basedOn ? `, from ${team.basedOn}` : ''}), ${team.mode}, ${team.rounds} round(s): ${agents}`,
    );
    if (team.reason) out.push(`  - Reason: ${oneLine(String(team.reason), 600)}`);
  } else out.push('- No team was confirmed');
  for (const m of timeline.marks) {
    if (['start', 'end', 'fast-start', 'fast-end', 'q1-confirmed'].includes(m.name)) continue;
    const { name, video, ...extra } = m;
    const facts = Object.keys(extra).length ? ` ${oneLine(JSON.stringify(extra), 300)}` : '';
    out.push(`- ${stamp(video)} ${name}${facts}`);
  }
  for (const n of notes) out.push(`- ${n}`);
  out.push('', '## The replies', '');
  for (const m of conversation?.messages ?? []) {
    if (m.author.kind !== 'agent') continue;
    const text = m.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('\n');
    out.push(`### ${m.agentName} (${label(m.provider)}), ${m.status}`, '', oneLine(text, 1500), '');
  }
  return out.join('\n') + '\n';
}
