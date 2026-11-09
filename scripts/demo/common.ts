/** What the demo scripts share: where things are, and the shapes of a recording's files. */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repository. */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Recordings, one folder per language (inside `data/`, so git ignores them). */
export const DEFAULT_OUT = join(ROOT, 'data/demo');

export const DEMO_LANGS = ['en', 'zh-TW'] as const;
export type DemoLang = (typeof DEMO_LANGS)[number];

/** One saved frame (`frames.jsonl`): its file in `frames/` and when it was taken, in seconds. */
export interface FrameEntry {
  file: string;
  ts: number;
}

/**
 * A moment of the recording (`marks.json`), in seconds, with what happened. `fast-start` /
 * `fast-end` enclose the stretches where the agents work (sped up), `skip-start` / `skip-end` (added
 * by hand) the ones to cut out altogether, and `start` / `end` the whole demo.
 */
export interface Mark {
  name: string;
  t: number;
  [extra: string]: unknown;
}

/** A mark's time in the finished video (`timeline.json`). */
export interface TimelineMark {
  name: string;
  video: number;
  [extra: string]: unknown;
}

export interface Timeline {
  /** How much faster than real time the agents' work plays. */
  speed: number;
  /** Seconds. */
  length: number;
  marks: TimelineMark[];
}

/** `m:ss.s`, as the poster sidecars and the design guidelines write a frame's time. */
export function stamp(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(1).padStart(4, '0')}`;
}
