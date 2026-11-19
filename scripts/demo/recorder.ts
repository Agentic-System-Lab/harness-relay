/**
 * What every recording shares (`npm run demo` and `npm run use-cases`): Harness Relay started on its own
 * port and data folder, signed in as a browser would be, and a session that drives it in a headless
 * browser the way a person would, with a drawn cursor. A frame is saved 24 times a second, 4 while the
 * agents work (`cut.ts` speeds those stretches up), and every step leaves a mark (`marks.json`) that the
 * cut, the stills and the chapter rails are timed by.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, createWriteStream, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Locator, type Page } from 'playwright-core';
import { AuthStore, CODE_TTL_MS } from '../../src/server/auth';
import { openDatabase } from '../../src/server/db';
import { AUTH_KEY_HEADER } from '../../src/shared/auth';
import type { ChatMessage, Conversation, ConversationSummary, Provider, ProviderStatus, TeamPlan } from '../../src/shared/types';
import { ROOT, type DemoLang, type FrameEntry, type Mark } from './common';

/** The browser's viewport, and the scale frames are saved at (1600×1000). */
export const VIEW = { width: 1280, height: 800, scale: 1.25 };
const FPS = 24;
/** Frames a second while the agents work. */
const FAST_FPS = 4;

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const now = () => Date.now() / 1000;

export type Log = (...a: unknown[]) => void;

// --- The server ---------------------------------------------------------------------------------

export interface DemoServer {
  base: string;
  stop(): Promise<void>;
}

/**
 * Starts Harness Relay (API + built UI) with its own data folder; `cwd` is the default working
 * directory (this repository unless given), `env` adds to the server's environment.
 */
export async function startServer(
  port: number,
  dataDir: string,
  logFile: string,
  o: { cwd?: string; env?: Record<string, string> } = {},
): Promise<DemoServer> {
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
    env: {
      ...process.env,
      ...o.env,
      PORT: String(port),
      RELAY_DATA_DIR: dataDir,
      RELAY_DEFAULT_CWD: o.cwd ?? ROOT,
      // Never the OS credential store: what a recording saves (a stand-in mail account's password) stays in
      // its own database, encrypted, and goes with it; nothing of it lands beside your own Harness Relay's keys.
      RELAY_KEYRING: 'off',
      RELAY_KEYRING_SERVICE: 'harness-relay-demo',
    },
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
  // The recorder's own requests come from a signed-in browser too: its cookie and key.
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ code: signInCode(base) }),
  });
  if (!login.ok) throw new Error(`Could not sign the recorder in: ${login.status} ${await login.text()}`);
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

/** Each recording server's data folder, and the cookie and key its requests sign in with. */
const dataDirs = new Map<string, string>();
const signedIn = new Map<string, { cookie: string; key: string }>();

/** A one-time code that signs a browser in to the recording's server (made in its database, as `npm run login` does). */
export function signInCode(base: string): string {
  const db = openDatabase(join(dataDirs.get(base)!, 'relay.db'));
  try {
    return new AuthStore(db).createCode(CODE_TTL_MS.device).code;
  } finally {
    db.close();
  }
}

/** A request to the recording's server, signed in; a body makes it a POST (or `method`). */
export async function api<T>(base: string, path: string, body?: unknown, method?: 'POST' | 'PUT' | 'DELETE'): Promise<T> {
  const auth = signedIn.get(base);
  const signed: Record<string, string> = auth ? { cookie: auth.cookie, [AUTH_KEY_HEADER]: auth.key } : {};
  const request = () =>
    fetch(base + path, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: body === undefined ? signed : { ...signed, 'content-type': 'application/json', origin: base },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  // A dropped loopback connection while polling a long turn need not discard its footage.
  // Only reads are safe to repeat: the server may already have acted on a write.
  let r: Response;
  for (let attempt = 0; ; attempt++) {
    try {
      r = await request();
      break;
    } catch (error) {
      if (body !== undefined || method || attempt >= 5) throw error;
      await sleep(1000);
    }
  }
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return (await r.json()) as T;
}

// The languages' servers share Grok's trust file. Let one write and verify its entry before the next
// server reads the file, or a failed verification can restore a copy without the other folder.
let grokTrustCheck = Promise.resolve();

/** These CLIs installed and signed in, and Grok trusting `cwd` (it asks otherwise, and the recording would stop there). */
export async function checkProviders(base: string, log: Log, providers: readonly Provider[], cwd = ROOT): Promise<void> {
  const all = (await api<ProviderStatus[]>(base, '/api/providers?refresh=1')).filter((p) => providers.includes(p.provider));
  const missing = providers.filter((p) => {
    const s = all.find((x) => x.provider === p);
    return !s || !s.installed || s.auth.loggedIn === false;
  });
  for (const p of all)
    log('provider', p.provider, p.version ?? '', p.installed ? (p.auth.loggedIn === false ? 'not signed in' : 'ready') : 'not installed');
  if (missing.length) throw new Error(`The recording needs these CLIs, installed and signed in: ${missing.join(', ')}`);
  if (!providers.includes('grok')) return;
  const check = grokTrustCheck.then(async () => {
    const trust = await api<{ folder: string; trusted?: boolean }>(base, '/api/providers/grok/folder-trust', { cwd });
    if (trust.trusted === false) {
      log('Grok does not trust', trust.folder, 'yet: trusting it, as `grok --trust` would');
      await api(base, '/api/providers/grok/folder-trust', { cwd, trust: true, folder: trust.folder });
    }
  });
  grokTrustCheck = check.catch(() => {});
  return check;
}

// --- A recording session ------------------------------------------------------------------------

/**
 * What a request beyond the permission gets while the agents work: shown at normal speed, then
 * declined (the demo: read-only stays read-only), or allowed (for good in the chat when the card
 * offers it), the first one shown at normal speed and the rest answered without slowing down.
 */
export type ApprovalPolicy = 'decline' | 'allow';

export interface Session {
  page: Page;
  base: string;
  lang: DemoLang;
  log: Log;
  /** Leaves a mark at this moment. */
  mark(name: string, extra?: Record<string, unknown>): void;
  moveTo(x: number, y: number, ms?: number): Promise<void>;
  moveClick(target: string | Locator, o?: { after?: number; ms?: number; timeout?: number }): Promise<void>;
  typeSlow(text: string, delay?: number): Promise<void>;
  /** Types the question into the chat's message box and sends it. */
  ask(text: string): Promise<void>;
  scrollMessages(dy: number, ms: number): Promise<void>;
  /** Scrolls the chat (smoothly) until the element is near the top, `offset` pixels below it. */
  scrollToElement(target: Locator, ms?: number, offset?: number): Promise<void>;
  /** Saves frames at the agents' pace (sped up in the cut) while on. */
  setFast(on: boolean): void;
  conversation(id: string): Promise<Conversation>;
  summary(id: string): Promise<ConversationSummary | undefined>;
  agentReplies(c: Conversation): number;
  /**
   * Waits, sped up, until `done()`; answers approvals on the way, and the agents' questions with `answer`
   * (typed into the message box, as a person would), or skips them without one.
   */
  waitWork(id: string, done: (s: ConversationSummary | undefined) => Promise<boolean>, o?: WaitOptions): Promise<void>;
  /** The lead agent designs the team: shows its card, then confirms it. `poster` leaves the poster mark on it. */
  designAndConfirm(id: string, label: string, o?: { poster?: boolean }): Promise<TeamPlan | undefined>;
  /** Waits until the team has given at least `replies` replies in all and its run (and a lead review) stays over. */
  waitAnswered(id: string, label: string, replies: number, o?: WaitOptions): Promise<void>;
}

export interface WaitOptions {
  /** What to answer an agent's question with (the first one; any after it is skipped). */
  answer?: string;
}

export interface SessionOptions {
  lang: DemoLang;
  outDir: string;
  /** Minutes to wait for each step the agents take before going on anyway. */
  waitLimitMin?: number;
  approvals?: ApprovalPolicy;
  /** The label of the button that skips an agent's question. */
  skip: RegExp;
}

/**
 * Opens the app signed in at `startHash`, starts saving frames, runs `drive` and saves the last
 * frame. Returns the number of frames saved. Written to `outDir`: `frames/*.jpg`, `frames.jsonl`
 * (each frame's time) and `marks.json`.
 */
export async function recordSession(
  opts: SessionOptions,
  base: string,
  log: Log,
  startHash: string,
  ready: string,
  drive: (s: Session) => Promise<void>,
): Promise<number> {
  const { lang, outDir } = opts;
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
    const moveClick: Session['moveClick'] = async (target, o = {}) => {
      const el = (typeof target === 'string' ? page.locator(target) : target).first();
      await el.waitFor({ state: 'visible', timeout: o.timeout ?? 30_000 });
      await el.scrollIntoViewIfNeeded({ timeout: o.timeout ?? 30_000 });
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
    const scrollToElement: Session['scrollToElement'] = async (target, ms = 1600, offset = 24) => {
      const handle = await target.first().elementHandle();
      if (!handle) return;
      await handle.evaluate(smoothScrollTo, { ms, offset });
    };
    const ask = async (text: string) => {
      await moveClick('.composer-row textarea', { after: 250 });
      await typeSlow(text);
      await sleep(500);
      await page.keyboard.press('Enter');
    };

    let approvalsShown = 0;
    const waitWork: Session['waitWork'] = async (id, done, wo = {}) => {
      let answer = wo.answer;
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
        if (desc !== last) (log('state', desc), (last = desc));
        // Waiting is an approval, or an outbox item (which waits for the user but holds no turn up).
        const asked = s?.waiting ? pendingApproval(await conversation(id)) : undefined;
        if (asked) {
          const card = page.locator('.approval-card').last();
          const first = approvalsShown++ === 0;
          if (opts.approvals === 'allow' && !first) {
            // Answered without slowing down: the first one showed how.
            log('approval allowed', JSON.stringify(asked ?? {}));
            const always = card.locator('.approval-actions .ghost:not(.approval-deny)');
            await ((await always.count()) ? always : card.locator('.approval-actions .primary'))
              .first()
              .click({ timeout: 10_000 })
              .catch(() => {});
            await sleep(700);
            continue;
          }
          // Shown at normal speed, then answered.
          setFast(false);
          await card.scrollIntoViewIfNeeded({ timeout: 10_000 }).catch(() => {});
          mark('approval', asked);
          await sleep(2500);
          // A card answered meanwhile (by Harness Relay itself, or a turn that ended) is gone: go on.
          try {
            if (opts.approvals === 'allow') {
              const always = card.locator('.approval-actions .ghost:not(.approval-deny)');
              await moveClick((await always.count()) ? always : card.locator('.approval-actions .primary'), {
                after: 1200,
                timeout: 10_000,
              });
              mark('approval-allowed');
            } else {
              await moveClick(page.locator('.approval-card .approval-deny').last(), { after: 1200, timeout: 10_000 });
              mark('approval-declined');
            }
          } catch (e) {
            log('WARNING: could not answer the approval:', (e as Error).message.split('\n')[0]);
          }
          setFast(true);
          continue;
        }
        if (s?.asking && !s.running) {
          setFast(false);
          const by = [...(await conversation(id)).messages].reverse().find((m) => m.asked);
          mark('asked-user', { agent: by?.agentName, provider: by?.provider });
          if (answer) {
            // The question, then the answer typed into the message box and sent.
            const question = page.locator('[id^="ask-"]').last();
            await question.scrollIntoViewIfNeeded({ timeout: 10_000 }).catch(() => {});
            await sleep(3000);
            await ask(answer);
            mark('answered-user', { answer });
            answer = undefined;
            await sleep(1500);
          } else await moveClick(page.locator('.composer-actions button', { hasText: opts.skip }), { after: 1000 });
          setFast(true);
          continue;
        }
        if (await done(s)) break;
        await sleep(700);
      }
      setFast(false);
    };

    const designAndConfirm: Session['designAndConfirm'] = async (id, label, o = {}) => {
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
      if (o.poster) mark('poster');
      await sleep(1500);
      await page.locator('.plan-confirm').last().scrollIntoViewIfNeeded({ timeout: 30_000 });
      await sleep(1500);
      const plan = [...(await conversation(id)).messages].reverse().find((m) => m.plan?.status === 'ready')?.plan;
      log(
        label,
        'plan',
        plan?.source,
        plan?.name,
        plan?.settings?.mode,
        plan?.settings?.rounds,
        plan?.agents?.map((a) => `${a.name}/${a.provider}`).join(' '),
      );
      log(label, 'reason', plan?.reason);
      await moveClick('.plan-confirm .primary', { after: 900 });
      mark(`${label}-confirmed`, planFacts(plan));
      return plan;
    };

    const waitAnswered: Session['waitAnswered'] = async (id, label, replies, wo) => {
      mark(`${label}-answering`);
      let quiet = 0;
      await waitWork(
        id,
        async (s) => {
          if (s?.running || s?.confirmTeam || s?.asking) return ((quiet = 0), false);
          const c = await conversation(id);
          if (s?.waiting && pendingApproval(c)) return ((quiet = 0), false);
          if (c.messages.some((m) => m.review?.status === 'reviewing')) return ((quiet = 0), false);
          quiet++;
          const enough = agentReplies(c) >= replies;
          // Over with fewer replies than expected (one failed, or the team was smaller): go on after a while.
          if (!enough && quiet === 40) log(`WARNING: ${label}: the run is over with fewer than ${replies} replies; going on`);
          return (enough && quiet >= 3) || quiet >= 40;
        },
        wo,
      );
      mark(`${label}-answered`);
    };

    // Signed in by a sign-in link, as a person would be; then to where the recording starts.
    await page.goto(`${base}/#code=${signInCode(base)}`);
    await page.waitForSelector('.home-hero');
    await page.evaluate((hash) => (window.location.hash = hash), startHash);
    await page.waitForSelector(ready);
    await sleep(500);
    startCapture();
    mark('start');

    await drive({
      page,
      base,
      lang,
      log,
      mark,
      moveTo,
      moveClick,
      typeSlow,
      ask,
      scrollMessages,
      scrollToElement,
      setFast,
      conversation,
      summary,
      agentReplies,
      waitWork,
      designAndConfirm,
      waitAnswered,
    });

    mark('end');
    await stopCapture();
    await shoot(false); // one last frame, so the ending holds
    return n;
  } finally {
    await browser.close();
  }
}

/** Replies the first round of a team gives (relay: its leader only). */
export function firstRound(plan: TeamPlan | undefined): number {
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

async function smoothScrollTo(el: Element, { ms, offset }: { ms: number; offset: number }): Promise<void> {
  const list = el.closest('.messages');
  if (!list) return el.scrollIntoView({ block: 'start' });
  const start = list.scrollTop;
  const target = Math.max(
    0,
    Math.min(list.scrollHeight - list.clientHeight, start + el.getBoundingClientRect().top - list.getBoundingClientRect().top - offset),
  );
  const t0 = performance.now();
  await new Promise<void>((resolve) => {
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / ms);
      list.scrollTop = start + (target - start) * (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2);
      if (k < 1) requestAnimationFrame(step);
      else resolve();
    };
    requestAnimationFrame(step);
  });
}

/** Scrolls the file browser's code preview (smoothly) so that the first line holding `needle` is a third of the way down. */
export async function scrollCodeTo(needle: string): Promise<void> {
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
