/**
 * Records one language of the demo with the real CLIs.
 *
 * It starts Harness Relay on its own port with an empty data folder (the chat's working directory is
 * this repository), then drives it in a headless browser the way a person would, with a drawn
 * cursor: a new group, a template, a new chat and a question, the lead agent's team, the answers, a
 * follow-up question with a team of its own, the chat's files and a search. A frame is saved 24 times
 * a second, 4 while the agents work (`cut.ts` speeds those stretches up), and every step leaves a
 * mark (`marks.json`) that the cut, the stills and the chapter rail are timed by.
 *
 * Written to `<out>/`: `frames/*.jpg`, `frames.jsonl` (each frame's time), `marks.json`,
 * `conversation.json` (the whole chat, to check the chapter texts against) and `server.log`.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, createWriteStream, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Locator } from 'playwright-core';
import { AuthStore, CODE_TTL_MS } from '../../src/server/auth';
import { openDatabase } from '../../src/server/db';
import { AUTH_KEY_HEADER } from '../../src/shared/auth';
import type { Conversation, ConversationSummary, ChatMessage, Provider, ProviderStatus, TeamPlan } from '../../src/shared/types';
import { ROOT, type DemoLang, type FrameEntry, type Mark } from './common';

/** What is typed and clicked, per language. */
interface Scenario {
  newGroup: RegExp;
  groupName: string;
  /** The built-in template opened to show where teams are designed. */
  template: string;
  /** Names all three CLIs, so the lead agent's first team has one of each (the posters show it). */
  question: string;
  followup: string;
  files: RegExp;
  search: RegExp;
  skip: RegExp;
  /** Searched for when the agents wrote none of the identifiers in SEARCH_WORDS. */
  searchFallback: string;
}

export const SCENARIOS: Record<DemoLang, Scenario> = {
  en: {
    newGroup: /New group/,
    groupName: 'Design reviews',
    template: 'Three-way debate',
    question:
      'Is relay mode a good design? Have Claude Code, Codex and Grok review how agents hand off to each other in this repository, and tell me what to change first.',
    followup: 'Thanks. Now write a short note for the README that explains relay mode to new users.',
    files: /^Files$/,
    search: /^Search$/,
    skip: /Skip/,
    searchFallback: 'hand-off',
  },
  'zh-TW': {
    newGroup: /新群組/,
    groupName: '設計評審',
    template: '三方辯論',
    question: '接力模式的設計好嗎？請 Claude Code、Codex 和 Grok 一起看這個 repository 裡 agent 之間怎麼交棒，告訴我最先該改哪裡。',
    followup: '謝謝。接著幫我寫一段放在 README 的簡短說明，向新使用者介紹接力模式。',
    files: /^檔案$/,
    search: /^搜尋$/,
    skip: /略過/,
    searchFallback: '交棒',
  },
};

/** Words only the agents would write (identifiers from the code they read): the first one they used is searched for. */
const SEARCH_WORDS = ['maxHops', 'parseMentions', 'hopsLeft', 'takePause'];

/** The browser's viewport, and the scale frames are saved at (1600×1000). */
const VIEW = { width: 1280, height: 800, scale: 1.25 };
const FPS = 24;
/** Frames a second while the agents work. */
const FAST_FPS = 4;

export interface RecordOptions {
  lang: DemoLang;
  outDir: string;
  port: number;
  /** Stop once the chat is open, before anything is asked: checks the UI flow without running agents. */
  dry?: boolean;
  /** Minutes to wait for each step the agents take before going on anyway. */
  waitLimitMin?: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const now = () => Date.now() / 1000;

// --- The server ---------------------------------------------------------------------------------

export interface DemoServer {
  base: string;
  stop(): Promise<void>;
}

/** Starts Harness Relay (API + built UI) with its own data folder; this repository is the default working directory. */
export async function startServer(port: number, dataDir: string, logFile: string): Promise<DemoServer> {
  mkdirSync(dataDir, { recursive: true });
  const base = `http://127.0.0.1:${port}`;
  const busy = await fetch(`${base}/api/auth`).then(
    () => true,
    () => false,
  );
  if (busy) throw new Error(`Port ${port} is already in use: choose another with --port.`);
  const log = createWriteStream(logFile);
  const child: ChildProcess = spawn(join(ROOT, 'node_modules/.bin/tsx'), ['src/server/index.ts'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), RELAY_DATA_DIR: dataDir, RELAY_DEFAULT_CWD: ROOT },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  const until = Date.now() + 30_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`The server exited (${child.exitCode}); see ${logFile}`);
    const ok = await fetch(`${base}/api/auth`).then(
      (r) => r.ok,
      () => false,
    );
    if (ok) break;
    if (Date.now() > until) throw new Error(`The server did not start in 30 s; see ${logFile}`);
    await sleep(300);
  }
  dataDirs.set(base, dataDir);
  // The demo's own requests come from a signed-in browser too: its cookie and key.
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ code: signInCode(base) }),
  });
  if (!login.ok) throw new Error(`Could not sign the demo in: ${login.status} ${await login.text()}`);
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
  signedIn.set(base, { cookie, key: ((await login.json()) as { key: string }).key });
  return {
    base,
    async stop() {
      if (child.exitCode === null) child.kill('SIGTERM');
      await Promise.race([exited, sleep(15_000)]);
      log.end();
    },
  };
}

/** Each demo server's data folder, and the cookie and key its requests sign in with. */
const dataDirs = new Map<string, string>();
const signedIn = new Map<string, { cookie: string; key: string }>();

/** A one-time code that signs a browser in to the demo's server (made in its database, as `npm run login` does). */
function signInCode(base: string): string {
  const db = openDatabase(join(dataDirs.get(base)!, 'relay.db'));
  try {
    return new AuthStore(db).createCode(CODE_TTL_MS.device).code;
  } finally {
    db.close();
  }
}

async function api<T>(base: string, path: string, body?: unknown): Promise<T> {
  const auth = signedIn.get(base);
  const signed: Record<string, string> = auth ? { cookie: auth.cookie, [AUTH_KEY_HEADER]: auth.key } : {};
  const r = await fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? signed : { ...signed, 'content-type': 'application/json', origin: base },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return (await r.json()) as T;
}

/** The CLIs the demo's first question asks for, one member each. */
export const DEMO_PROVIDERS: readonly Provider[] = ['claude', 'codex', 'grok'];

/** Those CLIs installed and signed in, and Grok trusting this repository (it asks otherwise, and the demo would stop there). */
export async function checkProviders(base: string, log: (...a: unknown[]) => void): Promise<void> {
  // The CLIs its questions name (Cursor is not among them).
  const all = (await api<ProviderStatus[]>(base, '/api/providers?refresh=1')).filter((p) => DEMO_PROVIDERS.includes(p.provider));
  const missing = all.filter((p) => !p.installed || p.auth.loggedIn === false);
  for (const p of all) log('provider', p.provider, p.version ?? '', p.installed ? (p.auth.loggedIn === false ? 'not signed in' : 'ready') : 'not installed');
  if (missing.length) throw new Error(`The demo needs all three CLIs, installed and signed in: ${missing.map((p) => p.provider).join(', ')}`);
  const trust = await api<{ folder: string; trusted?: boolean }>(base, '/api/providers/grok/folder-trust', { cwd: ROOT });
  if (trust.trusted === false) {
    log('Grok does not trust', trust.folder, 'yet: trusting it, as `grok --trust` would');
    await api(base, '/api/providers/grok/folder-trust', { cwd: ROOT, trust: true, folder: trust.folder });
  }
}

// --- Recording ----------------------------------------------------------------------------------

/** Records one language. Returns the number of frames saved. */
export async function record(opts: RecordOptions, base: string, log: (...a: unknown[]) => void): Promise<number> {
  const { lang, outDir } = opts;
  const L = SCENARIOS[lang];
  const limitMin = opts.waitLimitMin ?? 25;
  const framesDir = join(outDir, 'frames');
  rmSync(framesDir, { recursive: true, force: true });
  mkdirSync(framesDir, { recursive: true });
  const frameLog = join(outDir, 'frames.jsonl');
  writeFileSync(frameLog, '');
  const marks: Mark[] = [];
  const mark = (name: string, extra: Record<string, unknown> = {}) => {
    marks.push({ name, t: now(), ...extra });
    writeFileSync(join(outDir, 'marks.json'), JSON.stringify(marks, null, 1) + '\n');
    log('mark', name, Object.keys(extra).length ? JSON.stringify(extra) : '');
  };
  const get = <T>(path: string) => api<T>(base, path);
  const conversation = (id: string) => get<Conversation>(`/api/conversations/${id}`);
  const summary = async (id: string) => (await get<ConversationSummary[]>('/api/conversations')).find((c) => c.id === id);
  const agentReplies = (c: Conversation) => c.messages.filter((m) => m.author.kind === 'agent' && m.status !== 'streaming').length;

  const browser = await chromium.launch({ executablePath: process.env.DEMO_CHROME || undefined });
  try {
    const context = await browser.newContext({
      viewport: { width: VIEW.width, height: VIEW.height },
      deviceScaleFactor: VIEW.scale,
      colorScheme: 'light',
      locale: lang === 'en' ? 'en-US' : 'zh-TW',
    });
    // tsx keeps function names with an `__name()` helper that exists only in Node: functions run
    // in the page need it too.
    await context.addInitScript({ content: 'globalThis.__name = (f) => f;' });
    // Skip the guided tour, pick the language, and draw a cursor (headless browsers draw none).
    await context.addInitScript((lang: string) => {
      localStorage.setItem('relay:onboarded', '99');
      localStorage.setItem('relay:lang', lang);
      const add = () => {
        if (document.getElementById('demo-cursor')) return;
        const c = document.createElement('div');
        c.id = 'demo-cursor';
        c.innerHTML =
          '<svg width="18" height="24" viewBox="0 0 18 24"><path d="M1 1 L1 19 L5.5 14.8 L8.6 22 L11.6 20.7 L8.6 13.7 L14.6 13.7 Z" fill="#111" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>';
        Object.assign(c.style, {
          position: 'fixed',
          left: '0',
          top: '0',
          zIndex: '2147483647',
          pointerEvents: 'none',
          transform: 'translate(-40px,-40px)',
          transition: 'scale 120ms',
          transformOrigin: '1px 1px',
        });
        document.body.appendChild(c);
        addEventListener('mousemove', (e) => (c.style.transform = `translate(${e.clientX}px,${e.clientY}px)`), true);
        addEventListener('mousedown', () => (c.style.scale = '0.85'), true);
        addEventListener('mouseup', () => (c.style.scale = '1'), true);
      };
      if (document.body) add();
      else addEventListener('DOMContentLoaded', add);
    }, lang);

    const page = await context.newPage();
    page.on('dialog', (d) => void d.accept());
    const cdp = await context.newCDPSession(page);

    // Frames: screenshots in a loop (headless screencast frames come out cropped at this scale).
    let fast = false;
    let n = 0;
    let lastSaved = 0;
    const shoot = async (optimizeForSpeed: boolean) => {
      const r = await cdp
        .send('Page.captureScreenshot', {
          format: 'jpeg',
          quality: 86,
          optimizeForSpeed,
          clip: { x: 0, y: 0, width: VIEW.width, height: VIEW.height, scale: VIEW.scale },
        })
        .catch(() => null);
      if (!r) return;
      const file = `${String(++n).padStart(6, '0')}.jpg`;
      writeFileSync(join(framesDir, file), Buffer.from(r.data, 'base64'));
      const entry: FrameEntry = { file, ts: now() };
      appendFileSync(frameLog, JSON.stringify(entry) + '\n');
    };
    let capturing = false;
    let capture = Promise.resolve();
    const startCapture = () => {
      capturing = true;
      capture = (async () => {
        while (capturing && browser.isConnected()) {
          const t = now();
          if (t - lastSaved < 1 / (fast ? FAST_FPS : FPS)) {
            await sleep(4);
            continue;
          }
          lastSaved = t;
          await shoot(true);
        }
      })();
    };
    const stopCapture = async () => {
      capturing = false;
      await capture;
    };
    const setFast = (on: boolean) => {
      if (on === fast) return;
      fast = on;
      mark(on ? 'fast-start' : 'fast-end');
    };

    // Pointer and keyboard, at a person's pace.
    const moveTo = (x: number, y: number, ms = 550) => page.mouse.move(x, y, { steps: Math.max(8, Math.round(ms / 16)) });
    const moveClick = async (target: string | Locator, o: { after?: number; ms?: number; timeout?: number } = {}) => {
      const el = (typeof target === 'string' ? page.locator(target) : target).first();
      await el.waitFor({ state: 'visible', timeout: o.timeout ?? 30_000 });
      await el.scrollIntoViewIfNeeded();
      const box = await el.boundingBox();
      if (!box) throw new Error(`Not on screen: ${String(target)}`);
      await moveTo(box.x + box.width / 2, box.y + box.height / 2, o.ms ?? 600);
      await sleep(180);
      await page.mouse.down();
      await sleep(90);
      await page.mouse.up();
      await sleep(o.after ?? 350);
    };
    const typeSlow = (text: string, delay = 38) => page.keyboard.type(text, { delay });
    const scrollMessages = (dy: number, ms: number) => page.evaluate(smoothScroll, { selector: '.messages', dy, ms });
    const ask = async (text: string) => {
      await moveClick('.composer-row textarea', { after: 250 });
      await typeSlow(text);
      await sleep(500);
      await page.keyboard.press('Enter');
    };

    /** Waits, sped up, until `done()`; shows and declines approvals, and skips the agents' questions, on the way. */
    const waitWork = async (id: string, done: (s: ConversationSummary | undefined) => Promise<boolean>) => {
      setFast(true);
      const until = Date.now() + limitMin * 60_000;
      let last = '';
      for (;;) {
        if (Date.now() > until) {
          log(`WARNING: still waiting after ${limitMin} min; going on`);
          break;
        }
        const s = await summary(id);
        const desc = JSON.stringify({ r: s?.running, w: s?.waiting, a: s?.asking, c: s?.confirmTeam, s: s?.sorting, st: s?.lastStatus });
        if (desc !== last) log('state', desc), (last = desc);
        if (s?.waiting) {
          // Shown at normal speed, then declined: read-only stays read-only.
          setFast(false);
          const card = page.locator('.approval-card').last();
          await card.scrollIntoViewIfNeeded().catch(() => {});
          const asked = pendingApproval(await conversation(id));
          mark('approval', asked ?? {});
          await sleep(2500);
          await moveClick(page.locator('.approval-card .approval-deny').last(), { after: 1200 });
          mark('approval-declined');
          setFast(true);
          continue;
        }
        if (s?.asking && !s.running) {
          setFast(false);
          mark('asked-user');
          await moveClick(page.locator('.composer-actions button', { hasText: L.skip }), { after: 1000 });
          setFast(true);
          continue;
        }
        if (await done(s)) break;
        await sleep(700);
      }
      setFast(false);
    };

    /** The lead agent designs the team: shows its card, then confirms it. */
    const designAndConfirm = async (id: string, label: string): Promise<TeamPlan | undefined> => {
      mark(`${label}-designing`);
      await waitWork(id, async (s) => Boolean(s?.confirmTeam) && !s?.running);
      await page.locator('.plan-card.awaiting').last().waitFor({ timeout: 60_000 });
      mark(`${label}-plan`);
      // The card from its top, then its confirm row.
      await page.evaluate(() => {
        const el = [...document.querySelectorAll('.plan-card.awaiting')].pop();
        el?.scrollIntoView({ block: 'start' });
        const list = document.querySelector('.messages');
        if (list) list.scrollTop -= 20;
      });
      await sleep(2000);
      if (label === 'q1') mark('poster'); // the first team, all three agents on the card
      await sleep(1500);
      await page.locator('.plan-confirm').last().scrollIntoViewIfNeeded();
      await sleep(1500);
      const plan = [...(await conversation(id)).messages].reverse().find((m) => m.plan?.status === 'ready')?.plan;
      log(label, 'plan', plan?.source, plan?.name, plan?.settings?.mode, plan?.settings?.rounds, plan?.agents?.map((a) => `${a.name}/${a.provider}`).join(' '));
      log(label, 'reason', plan?.reason);
      await moveClick('.plan-confirm .primary', { after: 900 });
      mark(`${label}-confirmed`, planFacts(plan));
      return plan;
    };

    /** Waits until the team has given at least `replies` replies in all and its run stays over. */
    const waitAnswered = async (id: string, label: string, replies: number) => {
      mark(`${label}-answering`);
      let quiet = 0;
      await waitWork(id, async (s) => {
        if (s?.running || s?.waiting || s?.confirmTeam || s?.asking) return (quiet = 0), false;
        quiet++;
        const enough = agentReplies(await conversation(id)) >= replies;
        // Over with fewer replies than expected (one failed, or the team was smaller): go on after a while.
        if (!enough && quiet === 40) log(`WARNING: ${label}: the run is over with fewer than ${replies} replies; going on`);
        return (enough && quiet >= 3) || quiet >= 40;
      });
      mark(`${label}-answered`);
    };

    // --- The demo ---------------------------------------------------------------------------------
    // Signed in by a sign-in link, as a person would be; the app then opens on a new chat.
    await page.goto(`${base}/#code=${signInCode(base)}`);
    await page.waitForSelector('.new-chat-page .preset-card');
    await sleep(500);
    startCapture();
    mark('start');
    await moveTo(700, 420, 300);
    await sleep(1500);

    // A group to sort chats into.
    await moveClick(page.getByRole('button', { name: L.newGroup }), { after: 400 });
    await typeSlow(L.groupName, 60);
    await sleep(400);
    await page.keyboard.press('Enter');
    await sleep(1200);
    mark('group-made', { group: L.groupName });

    // Templates are where teams are designed: open one.
    await moveClick(page.locator('.preset-card', { hasText: L.template }).locator('.preset-main'), { after: 600 });
    await page.waitForSelector('.modal.template-editor');
    await sleep(1800);
    await page.evaluate(async () => {
      const body = document.querySelector('.template-editor-body');
      for (let i = 0; i < 40 && body; i++) {
        body.scrollTop += 6;
        await new Promise((r) => setTimeout(r, 16));
      }
    });
    await sleep(1500);
    mark('template-shown', { template: L.template });
    await moveClick(page.locator('.template-editor-foot .ghost'), { after: 700 });

    // Start the chat and ask straight away.
    await moveClick('.start-bar .primary', { after: 900 });
    await page.waitForURL(/#\/c\//);
    const id = decodeURIComponent(/#\/c\/([^/?]+)/.exec(page.url())?.[1] ?? '');
    log('conversation', id);
    await sleep(1200);
    mark('chat-open');
    if (opts.dry) {
      await stopCapture();
      await page.screenshot({ path: join(outDir, 'dry.png') });
      mark('end');
      return n;
    }

    await ask(L.question);
    mark('asked', { question: L.question });
    const first = await designAndConfirm(id, 'q1');
    await waitAnswered(id, 'q1', firstRound(first));
    await sleep(800);
    // Read the answers: up through the last replies, then back down.
    await scrollMessages(-900, 2600);
    await sleep(1800);
    await scrollMessages(500, 2200);
    await sleep(1500);
    await scrollMessages(2000, 1500);
    await sleep(1000);
    mark('q1-read');

    // A new question gets a team of its own. (Replies counted before it is asked: once its team is
    // confirmed, the first reply is already being written.)
    const before = agentReplies(await conversation(id));
    await ask(L.followup);
    mark('followup-asked', { question: L.followup });
    const second = await designAndConfirm(id, 'q2');
    await waitAnswered(id, 'q2', before + firstRound(second));
    await sleep(800);
    await scrollMessages(-500, 2000);
    await sleep(2200);
    await scrollMessages(2000, 1200);
    await sleep(1000);
    mark('q2-read');

    // The code they discussed, in the chat's working directory.
    mark('files');
    await moveClick(page.getByRole('button', { name: L.files }), { after: 900 });
    await page.waitForSelector('.file-browser');
    for (const name of ['src', 'server', 'orchestrator.ts']) {
      await moveClick(page.locator('.file-list .file-name', { hasText: new RegExp(`^${name.replace('.', '\\.')}$`) }), { after: 700 });
    }
    await sleep(1200);
    // Relay mode's hand-off (`if (mode === 'relay')`), a third of the way down the preview.
    await page.evaluate(scrollCodeTo, "if (mode === 'relay')");
    await sleep(3500);
    mark('files-shown');
    await page.keyboard.press('Escape');
    await sleep(800);

    // Find the chat again by what the agents wrote.
    await moveClick(page.getByRole('button', { name: L.search }), { after: 500 });
    const said = (await conversation(id)).messages
      .filter((m) => m.author.kind === 'agent')
      .flatMap((m) => m.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])))
      .join('\n');
    const term = SEARCH_WORDS.find((w) => said.includes(w)) ?? L.searchFallback;
    mark('search', { term });
    await typeSlow(term, 90);
    await sleep(1800);
    await moveClick(page.locator('.search-hit .conv-link').first(), { after: 1500 });
    await sleep(2000);
    mark('end');

    await stopCapture();
    await shoot(false); // one last frame, so the ending holds
    writeFileSync(join(outDir, 'conversation.json'), JSON.stringify(await conversation(id), null, 1) + '\n');
    return n;
  } finally {
    await browser.close();
  }
}

/** Replies the first round of a team gives (relay: its leader only). */
function firstRound(plan: TeamPlan | undefined): number {
  return plan?.settings?.mode === 'relay' ? 1 : (plan?.agents?.length ?? 1);
}

/** What the chapter rail and the review notes need to know about a team. */
function planFacts(plan: TeamPlan | undefined): Record<string, unknown> {
  return {
    source: plan?.source,
    team: plan?.name,
    basedOn: plan?.basedOn?.name,
    lead: plan?.lead?.provider,
    mode: plan?.settings?.mode,
    rounds: plan?.settings?.rounds,
    agents: plan?.agents?.map((a) => [a.name, a.provider] as [string, Provider]),
    reason: plan?.reason,
  };
}

/** The agent whose approval is pending, and what it asked for. */
function pendingApproval(c: Conversation): { agent?: string; provider?: Provider; detail?: string } | undefined {
  for (const m of [...c.messages].reverse() as ChatMessage[]) {
    for (const p of m.parts) {
      if (p.type === 'approval' && p.status === 'pending') return { agent: m.agentName, provider: m.provider, detail: p.detail ?? p.tool };
    }
  }
  return undefined;
}

// Run in the page (no closures over this module).

async function smoothScroll({ selector, dy, ms }: { selector: string; dy: number; ms: number }): Promise<void> {
  const el = document.querySelector(selector);
  if (!el) return;
  const start = el.scrollTop;
  const t0 = performance.now();
  await new Promise<void>((resolve) => {
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / ms);
      el.scrollTop = start + dy * (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2);
      if (k < 1) requestAnimationFrame(step);
      else resolve();
    };
    requestAnimationFrame(step);
  });
}

async function scrollCodeTo(needle: string): Promise<void> {
  const text = document.querySelector('.file-browser .code-text');
  const lines = document.querySelector<HTMLElement>('.file-browser .code-lines');
  if (!text || !lines) return;
  const all = (text.textContent ?? '').split('\n');
  const at = all.findIndex((l) => l.includes(needle));
  if (at < 0) return;
  let scroller = text.parentElement;
  while (scroller && !(scroller.scrollHeight > scroller.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(scroller).overflowY))) {
    scroller = scroller.parentElement;
  }
  if (!scroller) return;
  const box = scroller;
  const lineHeight = lines.getBoundingClientRect().height / all.length;
  const target = Math.max(0, lines.offsetTop + at * lineHeight - box.clientHeight / 3);
  const from = box.scrollTop;
  const t0 = performance.now();
  await new Promise<void>((resolve) => {
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / 1600);
      box.scrollTop = from + (target - from) * (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2);
      if (k < 1) requestAnimationFrame(step);
      else resolve();
    };
    requestAnimationFrame(step);
  });
}

