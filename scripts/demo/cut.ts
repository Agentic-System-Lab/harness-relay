/**
 * Cuts a recording into the demo video. The stretches where the agents work (`fast-start` …
 * `fast-end`) are sped up, all at the same speed, so the video lasts about `target` seconds;
 * everything else plays in real time. Stretches between `skip-start` and `skip-end` marks (added to
 * `marks.json` by hand, when the recorder waited for nothing) are cut out.
 *
 * Writes into the recording's folder: `video.mp4` (1600×1000, 24 fps, H.264), `animation.webp`
 * (880×550, 8 fps, for the READMEs) and `timeline.json` (each mark's time in the video).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FrameEntry, Mark, Timeline } from './common';

/** The shortest a sped-up stretch may get, in video seconds. */
export const MIN_FAST = 1.6;
/** Seconds kept after the `end` mark. */
export const TAIL = 1.5;

export interface CutPlan {
  /** Each frame and how long it shows, in video seconds (frames that would show for no time are left out). */
  frames: { file: string; duration: number }[];
  timeline: Timeline;
  /** Seconds of the recording, and how many of them were sped up. */
  real: number;
  realFast: number;
}

/** Pairs of `<kind>-start` / `<kind>-end` marks, as (start, end) times. */
function stretches(marks: Mark[], kind: string): [number, number][] {
  const out: [number, number][] = [];
  let open: number | undefined;
  for (const m of marks) {
    if (m.name === `${kind}-start`) open = m.t;
    else if (m.name === `${kind}-end` && open !== undefined) {
      out.push([open, m.t]);
      open = undefined;
    }
  }
  return out;
}

/** When each frame shows, and when each mark falls, in a video of about `target` seconds. Pure. */
export function planCut(allFrames: FrameEntry[], allMarks: Mark[], target: number): CutPlan {
  const byName = (name: string) => allMarks.find((m) => m.name === name)?.t;
  const t0 = byName('start');
  const tEnd = byName('end');
  if (t0 === undefined || tEnd === undefined) throw new Error('The recording has no start or end mark: it did not finish.');

  // Skipped stretches: their frames dropped, their time taken out.
  const skips = stretches(allMarks, 'skip');
  const skipped = (t: number) => skips.some(([a, b]) => a <= t && t < b);
  const realTime = (t: number) => t - skips.reduce((sum, [a, b]) => sum + (t > a ? Math.min(b, t) - a : 0), 0);
  const end = realTime(tEnd + TAIL);
  const frames = allFrames
    .filter((f) => f.ts >= t0 && f.ts <= tEnd + TAIL + 1 && !skipped(f.ts))
    .map((f) => ({ ...f, ts: realTime(f.ts) }));
  if (!frames.length) throw new Error('The recording has no frames between its start and end marks.');
  const marks = allMarks.filter((m) => m.name !== 'skip-start' && m.name !== 'skip-end').map((m) => ({ ...m, t: realTime(m.t) }));

  // Sped-up stretches, each at the same speed, none shorter than MIN_FAST.
  const fast = stretches(marks, 'fast');
  const realFast = fast.reduce((sum, [a, b]) => sum + b - a, 0);
  const normal = end - t0 - realFast;
  const budget = Math.max(target - normal, MIN_FAST * fast.length);
  const speed = realFast ? Math.max(1, realFast / budget) : 1;
  const out = fast.map(([a, b]) => Math.max(Math.min(MIN_FAST, b - a), (b - a) / speed));

  /** Real time → video time. */
  const videoTime = (t: number): number => {
    let v = 0;
    let prev = t0;
    for (let i = 0; i < fast.length; i++) {
      const [a, b] = fast[i];
      if (t <= a) break;
      v += a - prev;
      if (t < b) return v + ((t - a) / (b - a)) * out[i];
      v += out[i];
      prev = b;
    }
    return v + (t - prev);
  };

  const length = videoTime(end);
  const shown = frames.map((f, i) => ({ file: f.file, duration: (i + 1 < frames.length ? videoTime(frames[i + 1].ts) : length) - videoTime(f.ts) }));
  const round = (x: number) => Math.round(x * 100) / 100;
  return {
    frames: shown.filter((f) => f.duration > 0),
    timeline: {
      speed: Math.round(speed * 10) / 10,
      length: round(length),
      marks: marks.map(({ name, t, ...extra }) => ({ name, video: round(videoTime(t)), ...extra })),
    },
    real: end - t0,
    realFast,
  };
}

/** An FFmpeg concat list showing each frame for its time. */
export function ffconcat(framesDir: string, frames: CutPlan['frames']): string {
  const q = (file: string) => `file '${join(framesDir, file).replaceAll("'", "'\\''")}'`;
  const lines = ['ffconcat version 1.0'];
  for (const f of frames) lines.push(q(f.file), `duration ${f.duration.toFixed(5)}`);
  // The concat demuxer drops the last entry's duration unless the file is listed once more.
  if (frames.length) lines.push(q(frames[frames.length - 1].file));
  return lines.join('\n') + '\n';
}

const mb = (file: string) => `${(statSync(file).size / 1e6).toFixed(1)} MB`;

/** Cuts `<dir>` (a recording) into its video, animation and timeline. */
export function cutRecording(dir: string, target: number, log: (...a: unknown[]) => void): Timeline {
  const frames = readFileSync(join(dir, 'frames.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as FrameEntry);
  const marks = JSON.parse(readFileSync(join(dir, 'marks.json'), 'utf8')) as Mark[];
  const plan = planCut(frames, marks, target);
  writeFileSync(join(dir, 'timeline.json'), JSON.stringify(plan.timeline, null, 1) + '\n');
  log(`speed ×${plan.timeline.speed}, ${plan.timeline.length.toFixed(1)} s (recorded ${plan.real.toFixed(0)} s, ${plan.realFast.toFixed(0)} s of it sped up)`);
  for (const m of plan.timeline.marks) {
    if (!m.name.startsWith('fast-')) log(`  ${Math.floor(m.video / 60)}:${(m.video % 60).toFixed(1).padStart(4, '0')}  ${m.name}`);
  }

  const list = join(dir, 'frames.ffconcat');
  writeFileSync(list, ffconcat(join(dir, 'frames'), plan.frames));
  const mp4 = join(dir, 'video.mp4');
  execFileSync('ffmpeg', [
    ...['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list],
    ...['-vf', 'fps=24,format=yuv420p', '-c:v', 'libx264', '-preset', 'slow', '-crf', '24', '-profile:v', 'high'],
    ...['-movflags', '+faststart', '-an', mp4],
  ]);

  // The README animation: 880×550 at 8 fps, lossy WebP.
  const pngs = join(dir, 'animation-frames');
  rmSync(pngs, { recursive: true, force: true });
  mkdirSync(pngs);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', mp4, '-vf', 'fps=8,scale=880:550:flags=lanczos', join(pngs, '%05d.png')]);
  const webp = join(dir, 'animation.webp');
  const files = readdirSync(pngs).sort().map((f) => join(pngs, f));
  execFileSync('img2webp', ['-loop', '0', '-lossy', '-q', '62', '-m', '4', '-d', '125', ...files, '-o', webp], { stdio: 'ignore' });
  rmSync(pngs, { recursive: true, force: true });
  log(`video.mp4 ${mb(mp4)}, animation.webp ${mb(webp)}`);
  return plan.timeline;
}
