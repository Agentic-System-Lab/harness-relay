/**
 * Records the website's use cases again (`npm run use-cases`). See "Recording the use cases" in
 * docs/developer-guide.md.
 *
 *   npm run use-cases                                  record, cut and publish all five, both languages
 *   npm run use-cases -- record --case fix-a-bug       one step, one use case (repeatable), or one language
 *   npm run use-cases -- record --dry                  check each start page and setup, without agents
 *
 * Steps (all three when none is named):
 *   record   build the UI, then for each use case and language: make its working directory fresh, start
 *            Harness Relay on its own port and data folder, set up what it needs (the stand-in mail
 *            servers' accounts), and run it in a headless browser with the real CLIs. The languages of
 *            a use case record at once; the use cases one after another (`--parallel <n>` for more)
 *   cut      frames → video.mp4 (1280×800, 24 fps, the agents' work sped up) and timeline.json
 *   publish  copy the videos into site/assets/media/use-cases/, cut each poster, re-time the chapter
 *            rails on the use-cases pages, write each video's publication date and length into their
 *            structured data, and write review.md: what the agents did, to check the chapters against
 *
 * Options: --case <slug> (repeatable; default all), --lang en|zh-TW (repeatable; default both), --out
 * <dir> (default data/use-cases), --root <dir> (the working directories and servers' data, default
 * /tmp/hr-demo: short, and outside this repository), --port <n> (default 8800), --wait <minutes> per
 * agent step (default 25), --parallel <n> (use cases recorded at once, default 1), --no-build, --dry.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { removeTree } from '../../../src/server/fsRemove';
import { DEMO_LANGS, ROOT, type DemoLang } from '../common';
import { api, checkProviders, recordSession, sleep, startServer, type Log } from '../recorder';
import { USE_CASES, useCase, type UseCase } from './cases';

const STEPS = ['record', 'cut', 'publish'] as const;
type Step = (typeof STEPS)[number];

interface Options {
  steps: Step[];
  cases: UseCase[];
  langs: DemoLang[];
  out: string;
  root: string;
  port: number;
  wait: number;
  parallel: number;
  build: boolean;
  dry: boolean;
}

function parse(argv: string[]): Options {
  const o: Options = {
    steps: [],
    cases: [],
    langs: [],
    out: join(ROOT, 'data/use-cases'),
    root: '/tmp/hr-demo',
    port: 8800,
    wait: 25,
    parallel: 1,
    build: true,
    dry: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if ((STEPS as readonly string[]).includes(a)) o.steps.push(a as Step);
    else if (a === '--case') for (const slug of value().split(',')) o.cases.push(useCase(slug));
    else if (a === '--lang') {
      for (const l of value().split(',')) {
        if (!(DEMO_LANGS as readonly string[]).includes(l)) throw new Error(`--lang: ${l} is not one of ${DEMO_LANGS.join(', ')}`);
        o.langs.push(l as DemoLang);
      }
    } else if (a === '--out') o.out = resolve(value());
    else if (a === '--root') o.root = resolve(value());
    else if (a === '--port') o.port = Number(value());
    else if (a === '--wait') o.wait = Number(value());
    else if (a === '--parallel') o.parallel = Number(value());
    else if (a === '--no-build') o.build = false;
    else if (a === '--dry') o.dry = true;
    else if (a === '--help' || a === '-h') {
      console.log(
        readFileSync(new URL(import.meta.url), 'utf8')
          .split('*/')[0]
          .replace(/^\/\*\*\n?/, '')
          .replace(/^ \* ?/gm, ''),
      );
      process.exit(0);
    } else throw new Error(`Unknown argument: ${a} (try --help)`);
  }
  for (const [name, n] of [
    ['--port', o.port],
    ['--wait', o.wait],
    ['--parallel', o.parallel],
  ] as const) {
    if (!Number.isInteger(n) || n < 1) throw new Error(`${name} needs a whole number, 1 or more`);
  }
  if (!o.steps.length) o.steps = o.dry ? ['record'] : [...STEPS];
  if (!o.cases.length) o.cases = [...USE_CASES];
  if (!o.langs.length) o.langs = [...DEMO_LANGS];
  return o;
}

const logger =
  (slug: string, lang: DemoLang): Log =>
  (...a: unknown[]) =>
    console.log(new Date().toTimeString().slice(0, 8), `[${slug} ${lang}]`, ...a);

/** Each use case and language has a port of its own, so that any of them can record beside the others. */
const portFor = (o: Options, uc: UseCase, lang: DemoLang) => o.port + USE_CASES.indexOf(uc) * DEMO_LANGS.length + DEMO_LANGS.indexOf(lang);

async function recordOne(o: Options, uc: UseCase, lang: DemoLang): Promise<void> {
  const log = logger(uc.slug, lang);
  const dir = join(o.out, uc.slug, lang);
  // The open agents' homes would hold read-only folders: their owner's permissions back first.
  removeTree(dir, { restore: true });
  mkdirSync(dir, { recursive: true });
  const work = join(o.root, lang);
  mkdirSync(work, { recursive: true });
  const dataDir = join(work, `.relay-${uc.slug}`);
  removeTree(dataDir, { restore: true });
  if (existsSync(dataDir)) throw new Error(`Could not remove the last recording's data in ${dataDir}`);
  const prepared = await uc.prepare(lang, work);
  try {
    const server = await startServer(portFor(o, uc, lang), dataDir, join(dir, 'server.log'), { cwd: prepared.cwd });
    log('Harness Relay on', server.base, 'in', prepared.cwd);
    try {
      await checkProviders(server.base, log, uc.providers, prepared.cwd);
      await uc.setup?.(server.base, prepared, lang);
      let id = '';
      const frames = await recordSession(
        { lang, outDir: dir, waitLimitMin: o.wait, approvals: uc.approvals, skip: lang === 'en' ? /Skip/ : /略過/ },
        server.base,
        log,
        uc.start.hash,
        uc.start.ready,
        async (s) => {
          if (o.dry) {
            await sleep(800);
            await s.page.screenshot({ path: join(dir, 'dry.png') });
            return;
          }
          id = await uc.drive(s, prepared);
        },
      );
      if (id)
        writeFileSync(join(dir, 'conversation.json'), JSON.stringify(await api(server.base, `/api/conversations/${id}`), null, 1) + '\n');
      writeFileSync(join(dir, 'notes.json'), JSON.stringify(prepared.notes?.() ?? [], null, 1) + '\n');
      log(o.dry ? `dry run done: the start page in ${join(dir, 'dry.png')}` : `recorded ${frames} frames in ${dir}`);
    } finally {
      await server.stop();
    }
  } finally {
    await prepared.close?.();
  }
}

/** Runs `jobs` at most `n` at a time; every job runs, and the failures are reported together. */
async function limited(n: number, jobs: (() => Promise<void>)[]): Promise<string[]> {
  const failed: string[] = [];
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++]!;
      await job().catch((e: unknown) => failed.push(e instanceof Error ? (e.stack ?? e.message) : String(e)));
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, jobs.length) }, worker));
  return failed;
}

async function main(): Promise<void> {
  const o = parse(process.argv.slice(2));
  if (o.steps.includes('cut') || o.steps.includes('publish')) {
    const missing = ['ffmpeg', 'cwebp'].filter((t) => spawnSync('which', [t]).status !== 0);
    if (missing.length) throw new Error(`Missing ${missing.join(', ')}: install FFmpeg and libwebp (macOS: brew install ffmpeg webp).`);
  }
  if (o.steps.includes('record')) {
    if (o.build) {
      console.log('Building the UI…');
      const r = spawnSync(join(ROOT, 'node_modules/.bin/vite'), ['build', '--logLevel', 'warn'], { cwd: ROOT, stdio: 'inherit' });
      if (r.status !== 0) throw new Error('vite build failed');
    } else if (!existsSync(join(ROOT, 'dist/web/index.html'))) throw new Error('The UI is not built: drop --no-build.');
    // A use case's languages at once (each with its own server), `parallel` use cases at a time.
    const failed = await limited(
      o.parallel,
      o.cases.map((uc) => async () => {
        const results = await Promise.allSettled(o.langs.map((lang) => recordOne(o, uc, lang)));
        const errors = results.flatMap((r, i) =>
          r.status === 'rejected' ? [`${uc.slug} ${o.langs[i]}: ${r.reason instanceof Error ? r.reason.stack : r.reason}`] : [],
        );
        if (errors.length) throw new Error(errors.join('\n'));
      }),
    );
    if (failed.length) throw new Error(`Recording failed\n${failed.join('\n')}`);
  }
  if (o.dry) return;
  if (o.steps.includes('cut') || o.steps.includes('publish')) {
    const { cutRecording } = await import('../cut');
    const { publishUseCase } = await import('./publish');
    for (const uc of o.cases) {
      for (const lang of o.langs) {
        const dir = join(o.out, uc.slug, lang);
        const log = logger(uc.slug, lang);
        if (o.steps.includes('cut')) cutRecording(dir, uc.length, log, { size: [1280, 800], crf: 27, animation: false });
        if (o.steps.includes('publish')) publishUseCase(dir, uc, lang, log);
      }
    }
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
