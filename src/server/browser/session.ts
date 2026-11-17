import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { approvalKeys } from '../approvals';
import { CONFIG } from '../config';
import { attachmentsDir } from '../attachments';
import type { GatewayContext } from '../gateway';
import { runProcess } from '../process';
import { removeTree } from '../fsRemove';
import { isLocalHost, isLoopbackHost } from '../relaySandbox';
import { CdpConnection } from './cdp';

/*
 * The browser tools' browser: a Chromium (or Chrome, or Edge) of Harness Relay's own, one per
 * conversation, started through `process.ts` so it is tracked and killed on shutdown, headless, with a
 * profile of its own in the data folder (`browser/<conversation>`, removed with the conversation),
 * never the user's. It is driven over its debugging pipe (`cdp.ts`): no port is opened.
 *
 * What it may open: only http and https (and the blank page), never Harness Relay's own ports on this
 * computer nor the link-local and cloud metadata addresses. A page on a host this conversation's
 * browser has not opened yet is asked about (below full access), as a web fetch is (kind `fetch`,
 * keyed by host, so "always allow" holds), also when a click leads there; in a run that refuses
 * approvals only hosts always allowed open. Frames inside a page load without asking. Downloads,
 * file choosers and dialogs are refused. It closes after `idleMs` without a call.
 */

/** What a page may do: open without asking, be asked about, or never open. */
export type NavigationVerdict = 'allow' | 'ask' | 'block';

/** Whether the browser may open `raw` in the main frame, given the hosts this conversation's browser opened already. */
export function navigationVerdict(raw: string, o: { relayPorts: readonly number[]; own?: readonly string[]; allowed: ReadonlySet<string> }): NavigationVerdict {
  if (raw === 'about:blank') return 'allow';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'block';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'block';
  if (url.username || url.password) return 'block';
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const own = o.own ?? [];
  const onThisComputer = isLoopbackHost(host) || own.some((a) => a.toLowerCase() === host.toLowerCase());
  // Link-local, multicast, the unspecified address, the clouds' metadata services: never.
  if (isLocalHost(host, own) && !onThisComputer) return 'block';
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  if (onThisComputer && o.relayPorts.includes(port)) return 'block';
  const key = approvalKeys('fetch', raw)[0];
  return key && o.allowed.has(key) ? 'allow' : 'ask';
}

/** The page as the agent reads it: its address, title and text, with numbered links, buttons and fields. */
export interface PageSnapshot {
  url: string;
  title: string;
  text: string;
  /** The text was longer and was cut. */
  cut: boolean;
}

/** Longest snapshot text: about what a page's main content needs. */
export const SNAPSHOT_MAX = 20_000;

/**
 * Runs in the page: the visible text, and each link, button and field numbered (`data-relay-ref`), in
 * reading order. Numbers start again at each snapshot. Passwords' values are never read.
 */
const SNAPSHOT_SCRIPT = `(() => {
  const MAX = ${SNAPSHOT_MAX};
  const LIMIT = 6000;
  let ref = 0;
  let seen = 0;
  for (const e of document.querySelectorAll('[data-relay-ref]')) e.removeAttribute('data-relay-ref');
  const out = [];
  const clean = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
  const label = (el) => clean(el.getAttribute('aria-label') || el.innerText || el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('placeholder') || el.value).slice(0, 120);
  const visible = (el) => {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0 || el.children.length > 0;
  };
  const BLOCK = new Set(['P', 'DIV', 'LI', 'TR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'NAV', 'MAIN', 'BR', 'TABLE', 'UL', 'OL', 'FORM', 'BLOCKQUOTE', 'PRE']);
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'CANVAS', 'IFRAME']);
  const walk = (node) => {
    if (seen++ > LIMIT) return;
    if (node.nodeType === 3) {
      const t = clean(node.textContent);
      if (t) out.push(t);
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node;
    const tag = el.tagName;
    if (SKIP.has(tag) || !visible(el)) return;
    const role = el.getAttribute('role');
    const field = tag === 'TEXTAREA' || tag === 'SELECT' || (tag === 'INPUT' && el.type !== 'hidden');
    const clickable = (tag === 'A' && el.href) || tag === 'BUTTON' || role === 'button' || role === 'link' || role === 'checkbox' || role === 'tab' || role === 'menuitem';
    if (field || clickable) {
      const n = ++ref;
      el.setAttribute('data-relay-ref', String(n));
      if (tag === 'A') out.push('[' + n + ': link "' + label(el) + '" -> ' + el.href + ']');
      else if (tag === 'SELECT') out.push('[' + n + ': select' + (el.name ? ' ' + el.name : '') + ' = "' + clean(el.selectedOptions[0] && el.selectedOptions[0].text) + '"; options: ' + Array.from(el.options).slice(0, 30).map((o) => clean(o.text)).join(' | ') + ']');
      else if (field) {
        const type = tag === 'TEXTAREA' ? 'text area' : 'field ' + (el.type || 'text');
        const value = el.type === 'password' ? (el.value ? ' (filled)' : '') : el.type === 'checkbox' || el.type === 'radio' ? (el.checked ? ' checked' : ' not checked') : el.value ? ' value="' + clean(el.value).slice(0, 200) + '"' : '';
        out.push('[' + n + ': ' + type + (el.name ? ' name=' + el.name : '') + (label(el) && label(el) !== clean(el.value) ? ' "' + label(el) + '"' : '') + value + ']');
      } else out.push('[' + n + ': button "' + label(el) + '"]');
      if (!field && tag !== 'DIV') return;
    }
    if (BLOCK.has(tag)) out.push('\\n');
    for (const c of el.childNodes) walk(c);
    if (BLOCK.has(tag)) out.push('\\n');
  };
  walk(document.body || document.documentElement);
  let text = out.join(' ').replace(/[ \\t]*\\n[ \\t\\n]*/g, '\\n').replace(/\\n{3,}/g, '\\n\\n').trim();
  const cut = text.length > MAX;
  if (cut) text = text.slice(0, MAX);
  return { url: location.href, title: document.title, text, cut };
})()`;

/** Where the element numbered `ref` is (its middle, scrolled into view), or why it cannot be clicked. */
const BOX_SCRIPT = (ref: number) => `(() => {
  const el = document.querySelector('[data-relay-ref="${ref}"]');
  if (!el) return { missing: true };
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
})()`;

/** Focus the field numbered `ref` and empty it, or say it is missing. */
const FOCUS_SCRIPT = (ref: number) => `(() => {
  const el = document.querySelector('[data-relay-ref="${ref}"]');
  if (!el) return 'missing';
  el.scrollIntoView({ block: 'center' });
  el.focus();
  if ('value' in el && el.type !== 'checkbox' && el.type !== 'radio') { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); }
  return document.activeElement === el ? 'ok' : 'not focusable';
})()`;

export interface BrowserServiceOptions {
  /** The data folder: each conversation's profile is `browser/<conversation>` there. */
  dataDir: string;
  /** The browser to start, or undefined when none is found. */
  executable: () => string | undefined;
  /** Harness Relay's own ports, which it never opens. */
  relayPorts: () => readonly number[];
  /** This computer's own addresses. */
  own?: () => readonly string[];
  idleMs?: number;
}

/** One conversation's browser. */
class BrowserSession {
  readonly allowed = new Set<string>();
  /** The call that may open pages now: whom to ask about a new host. */
  current?: GatewayContext;
  private timer?: NodeJS.Timeout;
  mainFrame = '';
  denied?: string;
  /** A page the main frame is about to open, waiting for the user's answer: a call waits for it too. */
  gating?: Promise<void>;

  constructor(
    readonly cdp: CdpConnection,
    readonly sessionId: string,
    readonly stop: () => void,
    private idleMs: number,
    /** Settles once the browser's process has ended. */
    readonly exited: Promise<unknown>,
  ) {}

  touch(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.stop(), this.idleMs);
    this.timer.unref();
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    return this.cdp.send<T>(method, params, this.sessionId, timeoutMs);
  }

  async evaluate<T>(expression: string): Promise<T> {
    const r = await this.send<{ result?: { value?: T }; exceptionDetails?: { text?: string } }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? 'The page failed to run the script');
    return r.result?.value as T;
  }
}

export class BrowserService {
  private readonly sessions = new Map<string, Promise<BrowserSession>>();
  private readonly idleMs: number;

  constructor(private o: BrowserServiceOptions) {
    this.idleMs = o.idleMs ?? 10 * 60_000;
  }

  /** Why the browser tools cannot be used now, or undefined. */
  unavailable(): string | undefined {
    return this.o.executable() ? undefined : 'no Chromium, Chrome or Edge was found: install one, or set RELAY_BROWSER to it';
  }

  private profile(convId: string): string {
    return join(this.o.dataDir, 'browser', convId.replace(/[^A-Za-z0-9_-]/g, '_'));
  }

  /** The conversation's browser, started when it has none. */
  private session(convId: string): Promise<BrowserSession> {
    let s = this.sessions.get(convId);
    if (!s) {
      s = this.launch(convId);
      this.sessions.set(convId, s);
      s.catch(() => this.sessions.delete(convId));
    }
    return s;
  }

  private async launch(convId: string): Promise<BrowserSession> {
    const bin = this.o.executable();
    if (!bin) throw new Error(this.unavailable());
    const profile = this.profile(convId);
    mkdirSync(profile, { recursive: true, mode: 0o700 });
    const abort = new AbortController();
    let pipes: { write: Duplex; read: Duplex } | undefined;
    const args = [
      '--headless=new',
      '--remote-debugging-pipe',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-default-apps',
      '--disable-sync',
      '--mute-audio',
      '--password-store=basic',
      '--use-mock-keychain',
      '--window-size=1280,900',
      // Chromium's own sandbox cannot start as root (a container, say).
      ...(process.platform === 'linux' && process.getuid?.() === 0 ? ['--no-sandbox'] : []),
      'about:blank',
    ];
    const exited = runProcess({ bin, args, env: { ...process.env }, signal: abort.signal, pipes: (write, read) => (pipes = { write, read }) });
    if (!pipes) {
      abort.abort();
      throw new Error('The browser could not be started');
    }
    const cdp = new CdpConnection(pipes.write, pipes.read);
    const stop = () => {
      this.sessions.delete(convId);
      cdp.close();
      abort.abort();
    };
    void exited.then(
      () => (this.sessions.delete(convId), cdp.close()),
      () => (this.sessions.delete(convId), cdp.close()),
    );
    try {
      await cdp.send('Browser.setDownloadBehavior', { behavior: 'deny' }).catch(() => undefined);
      const { targetInfos } = await cdp.send<{ targetInfos: { targetId: string; type: string }[] }>('Target.getTargets');
      let targetId = targetInfos.find((t) => t.type === 'page')?.targetId;
      targetId ??= (await cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' })).targetId;
      const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
      const session = new BrowserSession(cdp, sessionId, stop, this.idleMs, exited.catch(() => undefined));
      await session.send('Page.enable');
      await session.send('Runtime.enable');
      await session.send('Page.setInterceptFileChooserDialog', { enabled: true }).catch(() => undefined);
      const tree = await session.send<{ frameTree: { frame: { id: string } } }>('Page.getFrameTree');
      session.mainFrame = tree.frameTree.frame.id;
      cdp.on('Page.javascriptDialogOpening', (_p, sid) => {
        if (sid === sessionId) void session.send('Page.handleJavaScriptDialog', { accept: false }).catch(() => undefined);
      });
      await session.send('Fetch.enable', { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }] });
      cdp.on('Fetch.requestPaused', (p: Record<string, unknown>, sid?: string) => {
        if (sid !== sessionId) return;
        const gating = this.gate(session, p).finally(() => {
          if (session.gating === gating) session.gating = undefined;
        });
        if (p.frameId === session.mainFrame) session.gating = gating;
      });
      session.touch();
      return session;
    } catch (err) {
      stop();
      throw err;
    }
  }

  /** A document the page is about to load: let it, ask the user, or refuse it. */
  private async gate(s: BrowserSession, p: Record<string, unknown>): Promise<void> {
    const requestId = String(p.requestId);
    const url = String((p.request as { url?: unknown } | undefined)?.url ?? '');
    const main = p.frameId === s.mainFrame;
    const verdict = navigationVerdict(url, { relayPorts: this.o.relayPorts(), own: this.o.own?.() ?? [], allowed: s.allowed });
    let allow = verdict === 'allow' || (verdict === 'ask' && !main);
    if (verdict === 'ask' && main) {
      const ctx = s.current;
      if (ctx?.permission === 'full') allow = true;
      else if (ctx?.ask) {
        const answer = await ctx.ask({ kind: 'fetch', detail: url, reason: 'Open this page in its own browser' }).catch(() => ({ allow: false }));
        allow = answer.allow;
        if (!allow) s.denied = url;
      } else s.denied = url;
    }
    if (allow && main) {
      const key = approvalKeys('fetch', url)[0];
      if (key) s.allowed.add(key);
    }
    if (!allow && verdict === 'block') s.denied = url;
    await (allow ? s.send('Fetch.continueRequest', { requestId }) : s.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' })).catch(() => undefined);
  }

  /** Runs `fn` on the conversation's browser, as the call `ctx` (whom to ask about a new host). */
  private async with<T>(ctx: GatewayContext, fn: (s: BrowserSession) => Promise<T>): Promise<T> {
    const s = await this.session(ctx.convId);
    s.current = ctx;
    s.denied = undefined;
    s.touch();
    try {
      return await fn(s);
    } finally {
      s.current = undefined;
      s.touch();
    }
  }

  /**
   * After a page the user declined (or one never allowed), Chromium shows its error page in its place:
   * go back to the page it was on, so the agent carries on from there.
   */
  private async backFromRefused(s: BrowserSession): Promise<void> {
    if (!s.denied) return;
    const h = await s.send<{ currentIndex: number; entries: { id: number; url: string }[] }>('Page.getNavigationHistory').catch(() => undefined);
    const here = h?.entries[h.currentIndex];
    const before = h && h.currentIndex > 0 ? h.entries[h.currentIndex - 1] : undefined;
    if (!here || !before || !(here.url.startsWith('chrome-error:') || here.url === s.denied)) return;
    // A page restored from the back-forward cache fires no load event: stopped loading says it is there.
    const loaded = Promise.race([s.cdp.waitFor('Page.loadEventFired', 5000, s.sessionId), s.cdp.waitFor('Page.frameStoppedLoading', 5000, s.sessionId)]);
    await s.send('Page.navigateToHistoryEntry', { entryId: before.id }).catch(() => undefined);
    await loaded;
  }

  /** Waits for the page to finish loading (or `ms`), then a moment for what it draws. */
  private async settle(s: BrowserSession, ms: number): Promise<void> {
    await s.cdp.waitFor('Page.loadEventFired', ms, s.sessionId);
    await new Promise((r) => setTimeout(r, 300));
  }

  async open(ctx: GatewayContext, url: string): Promise<PageSnapshot> {
    const verdict = navigationVerdict(url, { relayPorts: this.o.relayPorts(), own: this.o.own?.() ?? [], allowed: new Set() });
    if (verdict === 'block') throw new Error(`${url} cannot be opened: only http and https pages, not this computer's own Harness Relay or its metadata addresses`);
    return this.with(ctx, async (s) => {
      // The answer comes once the page is let through, which may wait for the user's answer.
      const r = await s.send<{ errorText?: string }>('Page.navigate', { url }, CONFIG.turnTimeoutMs);
      if (r.errorText) {
        const denied = s.denied;
        await this.backFromRefused(s);
        throw new Error(denied ? `The user did not allow opening ${denied}` : `${url} did not open: ${r.errorText}`);
      }
      await this.settle(s, 20_000);
      return this.read(s);
    });
  }

  async snapshot(ctx: GatewayContext): Promise<PageSnapshot> {
    return this.with(ctx, (s) => this.read(s));
  }

  private read(s: BrowserSession): Promise<PageSnapshot> {
    return s.evaluate<PageSnapshot>(SNAPSHOT_SCRIPT);
  }

  async click(ctx: GatewayContext, ref: number): Promise<PageSnapshot> {
    return this.with(ctx, async (s) => {
      const box = await s.evaluate<{ missing?: boolean; x: number; y: number; w: number; h: number }>(BOX_SCRIPT(ref));
      if (box.missing) throw new Error(`There is no element ${ref} on the page now: take a new snapshot`);
      if (!box.w && !box.h) throw new Error(`Element ${ref} is not visible`);
      const nav = s.cdp.waitFor('Page.frameNavigated', 1500, s.sessionId, (p) => (p.frame as { id?: string } | undefined)?.id === s.mainFrame);
      for (const type of ['mousePressed', 'mouseReleased']) {
        await s.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
      }
      // A page the click opens may wait for the user's answer first.
      const navigated = (await nav) || (s.gating ? (await s.gating, Boolean(await s.cdp.waitFor('Page.frameNavigated', 1500, s.sessionId))) : false);
      if (navigated) await this.settle(s, 15_000);
      else await new Promise((r) => setTimeout(r, 400));
      await this.backFromRefused(s);
      const snap = await this.read(s);
      return s.denied ? { ...snap, text: `(The page tried to open ${s.denied}, which was not allowed.)\n\n${snap.text}` } : snap;
    });
  }

  async type(ctx: GatewayContext, ref: number, text: string, submit: boolean): Promise<PageSnapshot> {
    return this.with(ctx, async (s) => {
      const focused = await s.evaluate<string>(FOCUS_SCRIPT(ref));
      if (focused === 'missing') throw new Error(`There is no element ${ref} on the page now: take a new snapshot`);
      if (focused !== 'ok') throw new Error(`Element ${ref} cannot be typed into`);
      await s.send('Input.insertText', { text });
      if (submit) {
        const nav = s.cdp.waitFor('Page.frameNavigated', 2000, s.sessionId, (p) => (p.frame as { id?: string } | undefined)?.id === s.mainFrame);
        const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
        await s.send('Input.dispatchKeyEvent', { type: 'keyDown', ...key, text: '\r' });
        await s.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
        if ((await nav) || (s.gating && (await s.gating, true))) await this.settle(s, 15_000);
      }
      await new Promise((r) => setTimeout(r, 200));
      await this.backFromRefused(s);
      const snap = await this.read(s);
      return s.denied ? { ...snap, text: `(The page tried to open ${s.denied}, which was not allowed.)\n\n${snap.text}` } : snap;
    });
  }

  /** A PNG of the page (the visible part, or all of it, up to a height), saved where the chat shows it. */
  async screenshot(ctx: GatewayContext, fullPage: boolean): Promise<{ path: string; data: string }> {
    return this.with(ctx, async (s) => {
      let clip: Record<string, number> | undefined;
      if (fullPage) {
        const m = await s.send<{ cssContentSize?: { width: number; height: number } }>('Page.getLayoutMetrics');
        const size = m.cssContentSize;
        if (size) clip = { x: 0, y: 0, width: Math.min(size.width, 1600), height: Math.min(size.height, 6000), scale: 1 };
      }
      const { data } = await s.send<{ data: string }>('Page.captureScreenshot', { format: 'png', ...(clip ? { clip, captureBeyondViewport: true } : {}) });
      const dir = attachmentsDir(ctx.convId);
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `browser-${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
      writeFileSync(path, Buffer.from(data, 'base64'));
      return { path, data };
    });
  }

  /** Close the conversation's browser (it went idle, or the conversation is deleted: then its profile goes too). */
  async close(convId: string, removeProfile = false): Promise<void> {
    const s = this.sessions.get(convId);
    this.sessions.delete(convId);
    const session = s && (await s.catch(() => undefined));
    if (session) {
      session.stop();
      // Its profile is still being written while it shuts down.
      await Promise.race([session.exited, new Promise((r) => setTimeout(r, 10_000).unref())]);
    }
    if (removeProfile) removeTree(this.profile(convId));
  }

  closeAll(): void {
    for (const id of [...this.sessions.keys()]) void this.close(id);
  }
}
