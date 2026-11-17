import { lookup } from 'node:dns/promises';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { BlockList, isIP, isIPv6 } from 'node:net';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { approvalKeys } from '../approvals';
import { CONFIG } from '../config';
import { t, withLang } from '../i18n';
import { attachmentsDir } from '../attachments';
import type { GatewayContext } from '../gateway';
import { runProcess } from '../process';
import { removeTree } from '../fsRemove';
import { isLocalHost, isLoopbackHost } from '../relaySandbox';
import { CdpConnection } from './cdp';
import { BrowserProxy, PROXY_USER, type ProxyRoute } from './proxy';

/*
 * The browser tools' browser: a Chromium (or Chrome, or Edge) of Harness Relay's own, one per
 * conversation, started through `process.ts` so it is tracked and killed on shutdown, headless, with a
 * profile of its own in the data folder (`browser/<conversation>`, removed with the conversation),
 * never the user's. It is driven over its debugging pipe (`cdp.ts`): no port is opened.
 *
 * What it may open: only http and https (and the blank page), never Harness Relay's own ports on this
 * computer nor the link-local and cloud metadata addresses, also by a host name that leads to one (its
 * addresses are looked up first). A page on a host this conversation's browser has not opened yet is
 * asked about (below full access), as a web fetch is (kind `fetch`, keyed by host, so "always allow"
 * holds), also when a click leads there. A host opened in full access without asking is asked about
 * again below full access; a scheduled run opens only hosts always allowed, whatever the browser opened
 * before (`grantsFor()`); a conversation that refuses every request opens none it has not opened. Every other request (frames,
 * images, scripts, what a page or its workers fetch, in its own process or another) pauses too, and
 * goes unless it is one of those never opened. It keeps to one tab: a window the page opens is closed
 * before it loads anything, and the agent told. Downloads, file choosers and dialogs are refused.
 * Calls run one at a time, in the order they came. It closes after `idleMs` without a call.
 *
 * Every connection it makes goes through its own proxy (`proxy.ts`), which connects only to
 * addresses looked up and checked here, with the gate's rules and the same answers: so a name whose
 * address changes after the check (DNS rebinding) reaches nothing it was not checked for, and a
 * WebSocket, which pauses nowhere, is checked when it connects. An address on this computer or the
 * local network is reached only on a host (and port) the conversation's browser opened while it led
 * there: a page cannot reach the user's local services by itself, and a name allowed while it led to
 * the internet that now leads here is refused. WebRTC keeps to the proxy too (no UDP of its own).
 */

/**
 * What a page may do: open without asking, be asked about, or never open (`moved`: a host allowed
 * while it led to the internet that now leads to this computer or the local network).
 */
export type NavigationVerdict = 'allow' | 'ask' | 'block' | 'moved';

/** The private networks (and the shared address space VPNs such as Tailscale use): the local network, to the browser. */
const PRIVATE = new BlockList();
PRIVATE.addSubnet('10.0.0.0', 8, 'ipv4');
PRIVATE.addSubnet('172.16.0.0', 12, 'ipv4');
PRIVATE.addSubnet('192.168.0.0', 16, 'ipv4');
PRIVATE.addSubnet('100.64.0.0', 10, 'ipv4');
PRIVATE.addSubnet('198.18.0.0', 15, 'ipv4');
PRIVATE.addSubnet('fc00::', 7, 'ipv6');

/** Whether an address is on a private network (an IPv4 one written as IPv6, `::ffff:10.0.0.1`, too). */
function privateAddress(a: string): boolean {
  const kind = isIP(a);
  if (!kind) return false;
  try {
    return PRIVATE.check(a, kind === 6 ? 'ipv6' : 'ipv4');
  } catch {
    return false;
  }
}

/**
 * Whether a host leads to this computer or the local network: a loopback name, one of this
 * computer's addresses, a private one, or a name with one of those among its `addresses`.
 */
export function leadsNearby(host: string, addresses: readonly string[], own: readonly string[] = []): boolean {
  const h = host.replace(/^\[|\]$/g, '');
  const list = isIP(h) || isLoopbackHost(h) ? [h] : addresses;
  return list.some((a) => isLoopbackHost(a) || own.some((o) => o.toLowerCase() === a.toLowerCase()) || privateAddress(a));
}

/**
 * Whether the browser may open `raw` in the main frame, given the hosts this conversation's browser
 * opened already and the addresses its host name has (`addresses`): a name is checked as each of its
 * addresses is, so one leading to a metadata address or to Harness Relay is never opened either.
 */
export function navigationVerdict(
  raw: string,
  o: {
    relayPorts: readonly number[];
    own?: readonly string[];
    allowed: ReadonlySet<string>;
    /** Of `allowed`, the hosts allowed while they led to this computer or the local network. */
    nearby?: ReadonlySet<string>;
    addresses?: readonly string[];
  },
): NavigationVerdict {
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
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  for (const h of [host, ...(o.addresses ?? [])]) {
    const onThisComputer = isLoopbackHost(h) || own.some((a) => a.toLowerCase() === h.toLowerCase());
    // Link-local, multicast, the unspecified address, the clouds' metadata services: never.
    if (isLocalHost(h, own) && !onThisComputer) return 'block';
    if (onThisComputer && o.relayPorts.includes(port)) return 'block';
  }
  const key = approvalKeys('fetch', raw)[0];
  if (!key || !o.allowed.has(key)) return 'ask';
  // Allowed while it led to the internet, it now leads here: the user was never asked about that.
  if (o.nearby && !o.nearby.has(key) && leadsNearby(host, o.addresses ?? [], own)) return 'moved';
  return 'allow';
}

/**
 * Whether a connection other than opening a page in the main frame may go (a frame, an image, a
 * script, a fetch, a WebSocket; and every connection, at the proxy): to the internet, unless it is
 * never opened (by `navigationVerdict()`); to this computer or the local network, only to a host the
 * conversation's browser opened while it led there (`nearby`), so a page cannot reach the user's local
 * services by itself. Data and blob addresses never reach the network.
 */
export function requestVerdict(raw: string, o: Parameters<typeof navigationVerdict>[1]): 'allow' | 'block' {
  if (/^(data|blob):/i.test(raw) || raw === 'about:blank' || raw === 'about:srcdoc') return 'allow';
  const verdict = navigationVerdict(raw, o);
  if (verdict === 'block' || verdict === 'moved') return 'block';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'block';
  }
  if (!leadsNearby(url.hostname, o.addresses ?? [], o.own ?? [])) return 'allow';
  const key = approvalKeys('fetch', raw)[0];
  return key && o.nearby?.has(key) ? 'allow' : 'block';
}

/** Why the main frame did not open a page: the user declined, it is never opened, it moved here, or nobody could be asked. */
export type Refusal = { url: string; why: 'declined' | 'blocked' | 'moved' | 'unasked' };

/** What the agent is told about a refused page. */
export function refusalText(r: Refusal): string {
  if (r.why === 'declined') return `The user did not allow opening ${r.url}`;
  if (r.why === 'blocked') return `${r.url} cannot be opened: only http and https pages, not this computer's own Harness Relay or its metadata addresses`;
  if (r.why === 'moved') return `${r.url} now leads to this computer or the local network, not where it led when it was allowed, so it is not opened (a name that changes its address to reach local services)`;
  return `${r.url} is on a host this conversation's browser has not opened, and nobody can be asked now (a scheduled run, or a conversation that refuses requests)`;
}

/** The addresses of a host name (none when it has none, or the lookup takes over 5 seconds). */
async function lookUp(host: string): Promise<string[]> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<string[]>((r) => (timer = setTimeout(() => r([]), 5000)));
  try {
    return await Promise.race([lookup(host, { all: true, verbatim: true }).then((list) => list.map((a) => a.address)), late]);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** A link, button or field of a snapshot, as the user's question about clicking or typing names it. */
export interface PageRef {
  kind: 'link' | 'button' | 'field' | 'select';
  label: string;
  href?: string;
  /** A field's name. */
  name?: string;
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
 * Runs in a world of its own beside the page's (`Page.createIsolatedWorld`), whose script can neither
 * see it nor change the functions it uses: the visible text, and each link, button and field numbered
 * from `start`, in reading order. The elements stay in that world (`__relayRefs`), never marked in the
 * page, so a click or typing goes to the element the snapshot found, whatever the page's script does
 * meanwhile. Numbers go on from one snapshot to the next, so an old one never names another element.
 * Passwords' values are never read.
 */
const SNAPSHOT_SCRIPT = (start: number) => `(() => {
  const MAX = ${SNAPSHOT_MAX};
  const LIMIT = 6000;
  let ref = ${start} - 1;
  let seen = 0;
  const refs = new Map();
  const info = [];
  const out = [];
  const clean = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
  const label = (el) => clean(el.getAttribute('aria-label') || el.innerText || el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('placeholder') || (el.type === 'password' ? '' : el.value)).slice(0, 120);
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
      refs.set(n, el);
      if (tag === 'A') {
        out.push('[' + n + ': link "' + label(el) + '" -> ' + el.href + ']');
        info.push({ ref: n, kind: 'link', label: label(el), href: String(el.href).slice(0, 500) });
      } else if (tag === 'SELECT') {
        out.push('[' + n + ': select' + (el.name ? ' ' + el.name : '') + ' = "' + clean(el.selectedOptions[0] && el.selectedOptions[0].text) + '"; options: ' + Array.from(el.options).slice(0, 30).map((o) => clean(o.text)).join(' | ') + ']');
        info.push({ ref: n, kind: 'select', label: label(el), name: String(el.name || '').slice(0, 100) });
      } else if (field) {
        const type = tag === 'TEXTAREA' ? 'text area' : 'field ' + (el.type || 'text');
        const value = el.type === 'password' ? (el.value ? ' (filled)' : '') : el.type === 'checkbox' || el.type === 'radio' ? (el.checked ? ' checked' : ' not checked') : el.value ? ' value="' + clean(el.value).slice(0, 200) + '"' : '';
        out.push('[' + n + ': ' + type + (el.name ? ' name=' + el.name : '') + (label(el) && label(el) !== clean(el.value) ? ' "' + label(el) + '"' : '') + value + ']');
        info.push({ ref: n, kind: 'field', label: label(el) === clean(el.value) ? '' : label(el), name: String(el.name || '').slice(0, 100) });
      } else {
        out.push('[' + n + ': button "' + label(el) + '"]');
        info.push({ ref: n, kind: 'button', label: label(el) });
      }
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
  globalThis.__relayRefs = refs;
  return { url: location.href, title: document.title, text, cut, refs: info.slice(0, 3000) };
})()`;

/**
 * Where the element numbered `ref` is (its middle, scrolled into view), or why it cannot be clicked:
 * gone, or covered there by another element (one the page laid over it), which a click would reach instead.
 */
const BOX_SCRIPT = (ref: number) => `(() => {
  const el = globalThis.__relayRefs && globalThis.__relayRefs.get(${ref});
  if (!el || !el.isConnected) return { missing: true };
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  const hit = document.elementFromPoint(x, y);
  return { x, y, w: r.width, h: r.height, covered: !hit || !(hit === el || el.contains(hit)) };
})()`;

/** Focus the field numbered `ref` and empty it, or say it is missing. */
const FOCUS_SCRIPT = (ref: number) => `(() => {
  const el = globalThis.__relayRefs && globalThis.__relayRefs.get(${ref});
  if (!el || !el.isConnected) return 'missing';
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
  /** A host name's addresses (tests give their own; else the system's lookup). */
  lookUp?: (host: string) => Promise<string[]>;
}

/** One conversation's browser. */
class BrowserSession {
  /**
   * The hosts its tab opened, by key: whether the user allowed it (`asked`; or an "always allow" did),
   * rather than full access without asking, and whether it led to this computer or the local network
   * then (`nearby`). Which of them a call may use again depends on the call (`grantsFor()`).
   */
  readonly granted = new Map<string, { asked: boolean; nearby: boolean }>();
  /** The hosts the current call opened: it may use them again, whoever it is. */
  readonly callGranted = new Map<string, { nearby: boolean }>();
  /** The password this browser gives the proxy. */
  proxyPassword = '';
  /** The call that may open pages now: whom to ask about a new host. */
  current?: GatewayContext;
  private timer?: NodeJS.Timeout;
  mainFrame = '';
  /** The page the main frame did not open during the current call, and why. */
  denied?: Refusal;
  /** A page the main frame is about to open, waiting for the user's answer: a call waits for it too. */
  gating?: Promise<void>;
  /** The sessions whose requests are gated: the tab's own, and its frames and workers in processes of their own. */
  readonly gated = new Set<string>();
  /** The windows the page opened, being closed: every request of theirs is refused. */
  readonly refused = new Set<string>();
  /** Windows the page opened during the current call, closed: their addresses, when known. */
  popups: string[] = [];
  /** The calls in turn: each starts once the one before it ended. */
  queue: Promise<unknown> = Promise.resolve();
  /** The world the latest snapshot ran in, which holds its elements; gone once the page changes. */
  refsWorld?: number;
  /** The number the next snapshot's first element gets. */
  nextRef = 1;
  /** The latest snapshot's links, buttons and fields, by number. */
  refs = new Map<number, PageRef>();
  /** The conversation it is the browser of. */
  convId = '';

  constructor(
    readonly cdp: CdpConnection,
    readonly sessionId: string,
    /** The tab's own target, which the browser's own auto-attach also reports. */
    readonly targetId: string,
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

  /** Runs `expression` in the world `contextId` (an isolated world of ours), for its value. */
  async evaluateIn<T>(contextId: number, expression: string): Promise<T> {
    const r = await this.send<{ result?: { value?: T }; exceptionDetails?: { text?: string } }>('Runtime.evaluate', { expression, contextId, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? 'The page failed to run the script');
    return r.result?.value as T;
  }

  /** Runs `expression` in the world the latest snapshot ran in, which holds its elements. */
  async inRefsWorld<T>(expression: string): Promise<T> {
    if (this.refsWorld === undefined) throw new Error('There is no snapshot of this page: take one first');
    try {
      return await this.evaluateIn<T>(this.refsWorld, expression);
    } catch (err) {
      // The page went elsewhere (or was reloaded): its world went with it.
      if (/context|Execution context was destroyed/i.test((err as Error).message)) throw new Error('The page changed since the latest snapshot: take a new one');
      throw err;
    }
  }
}

/**
 * What a browser needs of the server's environment to start (where home and the temporary folder
 * are, the language, the time zone, and on Windows the system's folders), and nothing else: no API
 * key, token or proxy setting of the server's reaches it, nor anything a page could learn of them.
 */
const BROWSER_ENV = /^(PATH|HOME|USER|LOGNAME|TMPDIR|TMP|TEMP|LANG|LANGUAGE|LC_[A-Z]+|TZ|XDG_RUNTIME_DIR|FONTCONFIG_PATH|FONTCONFIG_FILE|__CF_USER_TEXT_ENCODING|SYSTEMROOT|SYSTEMDRIVE|WINDIR|USERPROFILE|USERNAME|USERDOMAIN|HOMEDRIVE|HOMEPATH|LOCALAPPDATA|APPDATA|PROGRAMDATA|ALLUSERSPROFILE|PUBLIC|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMW6432|COMMONPROGRAMFILES|COMMONPROGRAMFILES\(X86\)|COMMONPROGRAMW6432|COMSPEC|PATHEXT|OS|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|COMPUTERNAME)$/i;

export function browserEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([k, v]) => v !== undefined && BROWSER_ENV.test(k)));
}

/**
 * The profile's preferences with Chromium's page preloading off (`network_prediction_options` 2,
 * "never"): no prefetch or prerender, which speculation rules and `<link rel=prefetch>` ask of the
 * browser itself, outside the page. They would go through the proxy all the same; this makes no
 * request at all.
 */
function noPreloading(profile: string): void {
  const file = join(profile, 'Default', 'Preferences');
  let prefs: Record<string, unknown> = {};
  try {
    const read = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (read && typeof read === 'object' && !Array.isArray(read)) prefs = read as Record<string, unknown>;
  } catch {
    /* none yet */
  }
  const net = prefs.net && typeof prefs.net === 'object' ? (prefs.net as Record<string, unknown>) : {};
  prefs.net = { ...net, network_prediction_options: 2 };
  mkdirSync(join(profile, 'Default'), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(prefs), { mode: 0o600 });
}

/**
 * The hosts a request in this browser may use again without asking, for the call going on (none
 * between calls but those the user allowed): in full access, all it opened; below it, those the user
 * allowed (or an "always allow" did), not those full access opened without asking; in a scheduled run
 * (`unattended`), only those this call opened, through the same question, which lets only what is
 * always allowed through. And those of them that led to this computer or the local network then.
 */
function grantsFor(s: BrowserSession): { allowed: Set<string>; nearby: Set<string> } {
  const ctx = s.current;
  const allowed = new Set<string>();
  const nearby = new Set<string>();
  for (const [key, g] of s.granted) {
    if (ctx?.permission === 'full' || (g.asked && !ctx?.unattended)) {
      allowed.add(key);
      if (g.nearby) nearby.add(key);
    }
  }
  for (const [key, g] of s.callGranted) {
    allowed.add(key);
    if (g.nearby) nearby.add(key);
  }
  return { allowed, nearby };
}

/** What every gated target pauses: all its requests, and the proxy's question who it is. */
const FETCH_ALL = { patterns: [{ urlPattern: '*', requestStage: 'Request' }], handleAuthRequests: true };

/** Whether a paused request opens a page in the tab's main frame: the one kind that is asked about. */
function isMainDocument(s: BrowserSession, p: Record<string, unknown>, sid: string): boolean {
  return sid === s.sessionId && p.resourceType === 'Document' && p.frameId === s.mainFrame;
}

export class BrowserService {
  private readonly sessions = new Map<string, Promise<BrowserSession>>();
  /** Each conversation's latest snapshot's elements, for the questions about clicking and typing (asked before the call runs). */
  private readonly latestRefs = new Map<string, Map<number, PageRef>>();
  /** The sessions by the password their browser gives the proxy. */
  private readonly byPassword = new Map<string, BrowserSession>();
  private readonly idleMs: number;
  private readonly proxy = new BrowserProxy((password, host, port, secure) => this.route(password, host, port, secure));
  /** Host names' addresses, looked up again after a minute. */
  private readonly addressCache = new Map<string, { at: number; addresses: Promise<string[]> }>();

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
    noPreloading(profile);
    await this.proxy.start();
    const password = this.proxy.issue();
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
      // Everything through the proxy, this computer's addresses too, and no UDP of WebRTC's own around it.
      `--proxy-server=http://127.0.0.1:${this.proxy.port}`,
      '--proxy-bypass-list=<-loopback>',
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      // Chromium's own sandbox cannot start as root (a container, say).
      ...(process.platform === 'linux' && process.getuid?.() === 0 ? ['--no-sandbox'] : []),
      'about:blank',
    ];
    const exited = runProcess({ bin, args, env: browserEnv(process.env), signal: abort.signal, pipes: (write, read) => (pipes = { write, read }) });
    if (!pipes) {
      abort.abort();
      throw new Error('The browser could not be started');
    }
    const cdp = new CdpConnection(pipes.write, pipes.read);
    const stop = () => {
      this.sessions.delete(convId);
      this.latestRefs.delete(convId);
      this.byPassword.delete(password);
      this.proxy.forget(password);
      cdp.close();
      abort.abort();
    };
    const gone = () => {
      this.sessions.delete(convId);
      this.latestRefs.delete(convId);
      this.byPassword.delete(password);
      this.proxy.forget(password);
      cdp.close();
    };
    void exited.then(gone, gone);
    try {
      await cdp.send('Browser.setDownloadBehavior', { behavior: 'deny' }).catch(() => undefined);
      const { targetInfos } = await cdp.send<{ targetInfos: { targetId: string; type: string }[] }>('Target.getTargets');
      let targetId = targetInfos.find((t) => t.type === 'page')?.targetId;
      targetId ??= (await cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' })).targetId;
      const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
      const session = new BrowserSession(cdp, sessionId, targetId, stop, this.idleMs, exited.catch(() => undefined));
      session.proxyPassword = password;
      session.convId = convId;
      this.byPassword.set(password, session);
      session.gated.add(sessionId);
      cdp.on('Fetch.requestPaused', (p: Record<string, unknown>, sid?: string) => {
        if (sid && session.refused.has(sid)) return void cdp.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' }, sid).catch(() => undefined);
        if (!sid || !session.gated.has(sid)) return;
        const gating = this.gate(session, p, sid).finally(() => {
          if (session.gating === gating) session.gating = undefined;
        });
        if (isMainDocument(session, p, sid)) session.gating = gating;
      });
      // The proxy asks each browser to prove itself: only this one's own password, never a site's.
      cdp.on('Fetch.authRequired', (p: Record<string, unknown>, sid?: string) => {
        if (!sid || (!session.gated.has(sid) && !session.refused.has(sid))) return;
        const proxy = (p.authChallenge as { source?: string } | undefined)?.source === 'Proxy' && !session.refused.has(sid);
        const authChallengeResponse = proxy ? { response: 'ProvideCredentials', username: PROXY_USER, password } : { response: 'CancelAuth' };
        void cdp.send('Fetch.continueWithAuth', { requestId: p.requestId, authChallengeResponse }, sid).catch(() => undefined);
      });
      cdp.on('Target.attachedToTarget', (p: Record<string, unknown>) => void this.adopt(session, p));
      cdp.on('Target.detachedFromTarget', (p: Record<string, unknown>) => {
        session.gated.delete(String(p.sessionId));
        session.refused.delete(String(p.sessionId));
      });
      await session.send('Page.enable');
      await session.send('Runtime.enable');
      await session.send('Page.setInterceptFileChooserDialog', { enabled: true }).catch(() => undefined);
      const tree = await session.send<{ frameTree: { frame: { id: string } } }>('Page.getFrameTree');
      session.mainFrame = tree.frameTree.frame.id;
      cdp.on('Page.javascriptDialogOpening', (_p, sid) => {
        if (sid === sessionId) void session.send('Page.handleJavaScriptDialog', { accept: false }).catch(() => undefined);
      });
      await session.send('Fetch.enable', FETCH_ALL);
      // The tab's frames in processes of their own and its workers: each held before it starts, gated, then let go.
      await session.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
      // The browser's other targets: a window the page opens (closed), a service or shared worker (gated).
      await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
      session.touch();
      return session;
    } catch (err) {
      stop();
      throw err;
    }
  }

  /** A host name's addresses, for `navigationVerdict()` (none for an address or a name on this computer). */
  private addresses(raw: string): Promise<string[]> {
    let host: string;
    try {
      const u = new URL(raw);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return Promise.resolve([]);
      host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    } catch {
      return Promise.resolve([]);
    }
    if (!host || isIP(host) || isLoopbackHost(host)) return Promise.resolve([]);
    const now = Date.now();
    const hit = this.addressCache.get(host);
    if (hit && now - hit.at < 60_000) return hit.addresses;
    const addresses = (this.o.lookUp ?? lookUp)(host).catch(() => []);
    this.addressCache.delete(host);
    this.addressCache.set(host, { at: now, addresses });
    if (this.addressCache.size > 500) this.addressCache.delete(this.addressCache.keys().next().value!);
    return addresses;
  }

  /** Harness Relay's own ports, and the browser proxy's: never opened on this computer. */
  private ownPorts(): number[] {
    return [...this.o.relayPorts(), ...(this.proxy.port ? [this.proxy.port] : [])];
  }

  /**
   * Where the proxy may connect a browser's connection to `host`:`port`: refused unless
   * `requestVerdict()` lets it go, else to the addresses it was checked with (this computer's for a
   * loopback name), the same ones the gate's check used.
   */
  private async route(password: string, host: string, port: number, secure: boolean): Promise<ProxyRoute> {
    const s = this.byPassword.get(password);
    if (!s) return { refused: 'not a browser of this server' };
    const name = host.replace(/^\[|\]$/g, '');
    const bracketed = isIPv6(name) ? `[${name}]` : name;
    // A tunnel on port 80 is a ws:// socket's; any other, https's or wss's: keyed as the page's own address is.
    const url = `${secure && port !== 80 ? 'https' : 'http'}://${bracketed}:${port}/`;
    const rules = await this.rules(s, url);
    if (requestVerdict(url, rules) !== 'allow') return { refused: `${url} is not reached from Harness Relay's browser` };
    const addresses = isIP(name) ? [name] : isLoopbackHost(name) ? ['127.0.0.1', '::1'] : [...(rules.addresses ?? [])];
    return addresses.length ? { addresses } : { refused: `${name} has no address` };
  }

  /** What `navigationVerdict()` needs to know of a request in this conversation's browser. */
  private async rules(s: BrowserSession, url: string): Promise<Parameters<typeof navigationVerdict>[1]> {
    return { relayPorts: this.ownPorts(), own: this.o.own?.() ?? [], ...grantsFor(s), addresses: await this.addresses(url) };
  }

  /**
   * A request a page is about to make: opening a page in the tab is let through, asked about or
   * refused; any other goes unless it is never opened.
   */
  private async gate(s: BrowserSession, p: Record<string, unknown>, sid: string): Promise<void> {
    const requestId = String(p.requestId);
    const url = String((p.request as { url?: unknown } | undefined)?.url ?? '');
    const go = (allow: boolean) =>
      (allow ? s.cdp.send('Fetch.continueRequest', { requestId }, sid) : s.cdp.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }, sid)).catch(() => undefined);
    const rules = await this.rules(s, url);
    if (!isMainDocument(s, p, sid)) return void (await go(requestVerdict(url, rules) === 'allow'));
    const verdict = navigationVerdict(url, rules);
    let allow = verdict === 'allow';
    if (verdict === 'block' || verdict === 'moved') s.denied = { url, why: verdict === 'moved' ? 'moved' : 'blocked' };
    if (verdict === 'ask') {
      const ctx = s.current;
      if (ctx?.permission === 'full') allow = true;
      else if (ctx?.ask) {
        const ask = () => ctx.ask!({ kind: 'fetch', detail: url, reason: t().gw.openReason, noLock: true });
        const answer = await (ctx.lang ? withLang(ctx.lang, ask) : ask()).catch(() => ({ allow: false }));
        allow = answer.allow;
        if (!allow) s.denied = { url, why: 'declined' };
      } else s.denied = { url, why: 'unasked' };
    }
    const key = approvalKeys('fetch', url)[0];
    if (allow && key && verdict === 'ask') {
      // Allowed while it leads here: its local service may be reached, also by its own pages and sockets.
      const nearby = leadsNearby(new URL(url).hostname, rules.addresses ?? [], rules.own ?? []);
      s.granted.set(key, { asked: s.current?.permission !== 'full' || Boolean(s.granted.get(key)?.asked), nearby });
      s.callGranted.set(key, { nearby });
    }
    await go(allow);
  }

  /**
   * A target the browser attached, held before it starts: the tab itself (seen by the browser's own
   * auto-attach) and the browser's own parts (its UI, its built-in extensions) are left alone; a
   * window the page opened is closed, every request it makes refused; a frame in a process of its own
   * or a worker is gated as the tab is, then let go.
   */
  private async adopt(s: BrowserSession, p: Record<string, unknown>): Promise<void> {
    const sid = String(p.sessionId ?? '');
    const info = (p.targetInfo ?? {}) as { targetId?: string; type?: string; subtype?: string; url?: string };
    const send = (method: string, params: Record<string, unknown> = {}) => s.cdp.send(method, params, sid).catch(() => undefined);
    const waiting = p.waitingForDebugger === true;
    if (!sid) return;
    if (info.targetId === s.targetId || info.type === 'browser_ui' || /^(chrome|chrome-extension|chrome-untrusted|devtools):/i.test(info.url ?? '')) {
      if (waiting) await send('Runtime.runIfWaitingForDebugger');
      void s.cdp.send('Target.detachFromTarget', { sessionId: sid }).catch(() => undefined);
      return;
    }
    if (info.type === 'page' || info.type === 'tab' || info.type === 'background_page') {
      // A page prerendered for the tab is no window the page opened: closed all the same, unmentioned.
      if (info.subtype !== 'prerender') s.popups.push(info.url && info.url !== 'about:blank' ? info.url : '');
      // A script's window.open() waits for its window to start: it starts, refusing whatever it asks
      // for, and is closed then.
      s.refused.add(sid);
      await send('Fetch.enable', FETCH_ALL);
      if (waiting) await send('Runtime.runIfWaitingForDebugger');
      await s.cdp.send('Target.closeTarget', { targetId: info.targetId }).catch(() => undefined);
      return;
    }
    s.gated.add(sid);
    await send('Fetch.enable', FETCH_ALL);
    await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    if (waiting) await send('Runtime.runIfWaitingForDebugger');
  }

  /**
   * Runs `fn` on the conversation's browser, as the call `ctx` (whom to ask about a new host), once
   * the calls before it ended: the agents of a conversation share its one tab.
   */
  private async with<T>(ctx: GatewayContext, fn: (s: BrowserSession) => Promise<T>): Promise<T> {
    const s = await this.session(ctx.convId);
    const turn = s.queue.then(async () => {
      if (ctx.signal.aborted) throw new Error('The turn ended');
      s.current = ctx;
      s.denied = undefined;
      s.popups = [];
      s.callGranted.clear();
      s.touch();
      try {
        return await fn(s);
      } finally {
        s.current = undefined;
        s.touch();
      }
    });
    s.queue = turn.catch(() => undefined);
    return turn;
  }

  /** What a click or a key did besides the page: a page refused, a window closed. */
  private notes(s: BrowserSession): string[] {
    const out: string[] = [];
    if (s.denied) out.push(`(The page tried to open ${s.denied.url}, which was not allowed: ${refusalText(s.denied)}.)`);
    for (const url of s.popups) {
      out.push(`(The page tried to open ${url ? `${url} in ` : ''}a new window, which was closed: this browser keeps to one tab. Open it with browser_open${url ? '' : ' if you need it'}.)`);
    }
    return out;
  }

  private withNotes(s: BrowserSession, snap: PageSnapshot): PageSnapshot {
    const notes = this.notes(s);
    return notes.length ? { ...snap, text: `${notes.join('\n')}\n\n${snap.text}` } : snap;
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
    if (!here || !before || !(here.url.startsWith('chrome-error:') || here.url === s.denied.url)) return;
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
    const verdict = navigationVerdict(url, { relayPorts: this.ownPorts(), own: this.o.own?.() ?? [], allowed: new Set(), addresses: await this.addresses(url) });
    if (verdict === 'block') throw new Error(refusalText({ url, why: 'blocked' }));
    return this.with(ctx, async (s) => {
      // The answer comes once the page is let through, which may wait for the user's answer.
      const r = await s.send<{ errorText?: string; loaderId?: string }>('Page.navigate', { url }, CONFIG.turnTimeoutMs);
      if (r.errorText) {
        const denied = s.denied;
        await this.backFromRefused(s);
        throw new Error(denied ? refusalText(denied) : `${url} did not open: ${r.errorText}`);
      }
      // No loader: the same page, at another anchor, which loads nothing.
      if (r.loaderId) await this.settle(s, 20_000);
      else await new Promise((done) => setTimeout(done, 200));
      return this.withNotes(s, await this.read(s));
    });
  }

  async snapshot(ctx: GatewayContext): Promise<PageSnapshot> {
    return this.with(ctx, (s) => this.read(s));
  }

  /**
   * The page now, read in a new world of our own, whose elements the clicks and typing that follow
   * use; checked to be what the script gives (the page cannot change it, but a page can be odd).
   */
  private async read(s: BrowserSession): Promise<PageSnapshot> {
    const { executionContextId } = await s.send<{ executionContextId: number }>('Page.createIsolatedWorld', { frameId: s.mainFrame, worldName: 'harness-relay' });
    const raw = await s.evaluateIn<Record<string, unknown> | undefined>(executionContextId, SNAPSHOT_SCRIPT(s.nextRef));
    const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
    const refs = new Map<number, PageRef>();
    for (const r of Array.isArray(raw?.refs) ? (raw.refs as Record<string, unknown>[]) : []) {
      const n = Number(r?.ref);
      const kind = r?.kind;
      if (!Number.isInteger(n) || n < s.nextRef || (kind !== 'link' && kind !== 'button' && kind !== 'field' && kind !== 'select')) continue;
      refs.set(n, { kind, label: str(r.label, 120), ...(r.href ? { href: str(r.href, 500) } : {}), ...(r.name ? { name: str(r.name, 100) } : {}) });
    }
    s.refsWorld = executionContextId;
    s.nextRef = Math.max(s.nextRef, ...refs.keys()) + 1;
    s.refs = refs;
    this.latestRefs.set(s.convId, refs);
    return { url: str(raw?.url, 2000), title: str(raw?.title, 300), text: str(raw?.text, SNAPSHOT_MAX), cut: raw?.cut === true };
  }

  /** What element `ref` of the conversation's latest snapshot is, for the user's question about it; undefined when it is not there. */
  refInfo(convId: string, ref: number): PageRef | undefined {
    return this.latestRefs.get(convId)?.get(ref);
  }

  async click(ctx: GatewayContext, ref: number): Promise<PageSnapshot> {
    return this.with(ctx, async (s) => {
      if (!s.refs.has(ref)) throw new Error(`There is no element ${ref} in the latest snapshot: take a new snapshot`);
      const box = await s.inRefsWorld<{ missing?: boolean; covered?: boolean; x: number; y: number; w: number; h: number }>(BOX_SCRIPT(ref));
      if (box.missing) throw new Error(`There is no element ${ref} on the page now: take a new snapshot`);
      if (!box.w && !box.h) throw new Error(`Element ${ref} is not visible`);
      // A click there would reach what lies over it, not what the user was asked about.
      if (box.covered) throw new Error(`Element ${ref} is covered by another element of the page: not clicked`);
      const nav = s.cdp.waitFor('Page.frameNavigated', 1500, s.sessionId, (p) => (p.frame as { id?: string } | undefined)?.id === s.mainFrame);
      for (const type of ['mousePressed', 'mouseReleased']) {
        await s.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
      }
      // A page the click opens may wait for the user's answer first.
      const navigated = (await nav) || (s.gating ? (await s.gating, Boolean(await s.cdp.waitFor('Page.frameNavigated', 1500, s.sessionId))) : false);
      if (navigated) await this.settle(s, 15_000);
      else await new Promise((r) => setTimeout(r, 400));
      await this.backFromRefused(s);
      return this.withNotes(s, await this.read(s));
    });
  }

  async type(ctx: GatewayContext, ref: number, text: string, submit: boolean): Promise<PageSnapshot> {
    return this.with(ctx, async (s) => {
      if (!s.refs.has(ref)) throw new Error(`There is no element ${ref} in the latest snapshot: take a new snapshot`);
      const focused = await s.inRefsWorld<string>(FOCUS_SCRIPT(ref));
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
      return this.withNotes(s, await this.read(s));
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
    this.latestRefs.delete(convId);
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
    this.proxy.stop();
  }
}
