/**
 * Records the README and landing-page demo again (`npm run demo`). See "Recording the demo" in
 * docs/developer-guide.md.
 *
 *   npm run demo                         record both languages, cut them, publish them
 *   npm run demo -- record --lang en     only one step, or one language
 *   npm run demo -- record --dry         check the UI flow up to the open chat, without agents
 *
 * Steps (all three when none is named):
 *   record   build the UI, start Harness Relay on its own port and data folder, run the demo in a
 *            headless browser with the real CLIs (both languages at once, about half an hour)
 *   cut      frames → video.mp4 (1600×1000, 24 fps, the agents' work sped up), animation.webp
 *            (880×550, 8 fps) and timeline.json (each mark's time in the video)
 *   publish  copy the videos into docs/media/, re-cut the posters, screenshots and social cards from
 *            the poster mark, re-time the site's chapter rails and the design guidelines' frame
 *            times, and write review.md: what the agents did, to check the chapter texts against
 *
 * Options: --lang en|zh-TW (repeatable; default both), --out <dir> (default data/demo), --port <n>
 * (default 8791; the second language gets the next), --length <seconds> (default 120), --wait
 * <minutes> per agent step (default 25), --no-build, --dry.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { removeTree } from '../../src/server/fsRemove';
import { DEFAULT_OUT, DEMO_LANGS, ROOT, type DemoLang } from './common';
import { checkProviders, record, startServer } from './record';

const STEPS = ['record', 'cut', 'publish'] as const;
type Step = (typeof STEPS)[number];

interface Options {
  steps: Step[];
  langs: DemoLang[];
  out: string;
  port: number;
  length: number;
  wait: number;
  build: boolean;
  dry: boolean;
}

function parse(argv: string[]): Options {
  const o: Options = { steps: [], langs: [], out: DEFAULT_OUT, port: 8791, length: 120, wait: 25, build: true, dry: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if ((STEPS as readonly string[]).includes(a)) o.steps.push(a as Step);
    else if (a === '--lang') {
      for (const l of value().split(',')) {
        if (!(DEMO_LANGS as readonly string[]).includes(l)) throw new Error(`--lang: ${l} is not one of ${DEMO_LANGS.join(', ')}`);
        o.langs.push(l as DemoLang);
      }
    } else if (a === '--out') o.out = resolve(value());
    else if (a === '--port') o.port = Number(value());
    else if (a === '--length') o.length = Number(value());
    else if (a === '--wait') o.wait = Number(value());
    else if (a === '--no-build') o.build = false;
    else if (a === '--dry') o.dry = true;
    else if (a === '--help' || a === '-h') {
      console.log(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*\*\n?/, '').replace(/^ \* ?/gm, ''));
      process.exit(0);
    } else throw new Error(`Unknown argument: ${a} (try --help)`);
  }
  if (!o.steps.length) o.steps = o.dry ? ['record'] : [...STEPS];
  if (!o.langs.length) o.langs = [...DEMO_LANGS];
  return o;
}

/** Fails early, with what to install, when a tool a step needs is missing. */
function requireTools(steps: Step[]): void {
  const need = new Set<string>();
  if (steps.includes('cut') || steps.includes('publish')) need.add('ffmpeg');
  if (steps.includes('cut')) need.add('img2webp');
  if (steps.includes('publish')) need.add('cwebp');
  const missing = [...need].filter((t) => spawnSync('which', [t]).status !== 0);
  if (missing.length) throw new Error(`Missing ${missing.join(', ')}: install FFmpeg and libwebp (macOS: brew install ffmpeg webp).`);
}

const logger = (lang: DemoLang) => (...a: unknown[]) => console.log(new Date().toTimeString().slice(0, 8), `[${lang}]`, ...a);

async function recordOne(o: Options, lang: DemoLang, port: number): Promise<void> {
  const log = logger(lang);
  const dir = join(o.out, lang);
  // The last recording's server is gone, so its folders get their owner's permissions back first:
  // the open agents' homes hold read-only config folders, which a plain rmSync cannot remove.
  removeTree(dir, { restore: true });
  if (existsSync(dir)) throw new Error(`Could not remove the last recording in ${dir}`);
  mkdirSync(dir, { recursive: true });
  const server = await startServer(port, join(dir, 'relay-data'), join(dir, 'server.log'));
  log('Harness Relay on', server.base);
  try {
    await checkProviders(server.base, log);
    const frames = await record({ lang, outDir: dir, port, dry: o.dry, waitLimitMin: o.wait }, server.base, log);
    log(o.dry ? `dry run done: ${frames} frames, the open chat in ${join(dir, 'dry.png')}` : `recorded ${frames} frames in ${dir}`);
  } finally {
    await server.stop();
  }
}

async function main(): Promise<void> {
  const o = parse(process.argv.slice(2));
  requireTools(o.steps);
  if (o.steps.includes('record')) {
    if (o.build) {
      console.log('Building the UI…');
      const r = spawnSync(join(ROOT, 'node_modules/.bin/vite'), ['build', '--logLevel', 'warn'], { cwd: ROOT, stdio: 'inherit' });
      if (r.status !== 0) throw new Error('vite build failed');
    } else if (!existsSync(join(ROOT, 'dist/web/index.html'))) throw new Error('The UI is not built: drop --no-build.');
    // Both languages at once, each with its own server.
    const results = await Promise.allSettled(o.langs.map((lang, i) => recordOne(o, lang, o.port + i)));
    const failed = results.flatMap((r, i) => (r.status === 'rejected' ? [`${o.langs[i]}: ${r.reason instanceof Error ? r.reason.stack : r.reason}`] : []));
    if (failed.length) throw new Error(`Recording failed\n${failed.join('\n')}`);
  }
  if (o.dry) return;
  if (o.steps.includes('cut') || o.steps.includes('publish')) {
    const { cutRecording } = await import('./cut');
    const { publish } = await import('./publish');
    for (const lang of o.langs) {
      const dir = join(o.out, lang);
      if (o.steps.includes('cut')) cutRecording(dir, o.length, logger(lang));
      if (o.steps.includes('publish')) publish(dir, lang, logger(lang));
    }
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
