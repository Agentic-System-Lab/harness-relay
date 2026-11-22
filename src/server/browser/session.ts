import { lookup } from 'node:dns/promises';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isIP, isIPv6 } from 'node:net';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { approvalKeys } from '../approvals';
import { CONFIG } from '../config';
import { t, withLang } from '../i18n';
import { attachmentsDir } from '../attachments';
import { dataLine, type GatewayContext } from '../gateway';
import { runProcess } from '../process';
import { removeTree } from '../fsRemove';
import { relayBrowserDir } from '../protect';
import { isLocalHost, isLoopbackHost, isPrivateAddress } from '../relaySandbox';
import { HANDOVER_LIMITS, type HandoverMode, type HandoverWindowAt } from '../../shared/types';
import { CdpConnection } from './cdp';
import {
  HANDOVER_UNASKED,
  Handovers,
  SELECTION_SCRIPT,
  USER_BROWSERS_MAX,
  UserBrowserError,
  cardUrl,
  handoverOutcome,
  inputCalls,
  ownerVerdict,
  type HandoverTicket,
  type OwnerPage,
  type HandoverWake,
} from './handover';
import { BrowserProxy, PROXY_USER, type ProxyRoute } from './proxy';

/*
 * The browser tools' browser: a Chromium (or Chrome, or Edge) of Harness Relay's own, one per
 * conversation, started through `process.ts` so it is tracked and killed on shutdown, headless (but for a
 * hand-over's window, `handover.ts`: the same arguments without `--headless=new`), with a profile of its
 * own in the data folder (`browser/<conversation>`, removed with the conversation), never the user's. It
 * is driven over its debugging pipe (`cdp.ts`): no port is opened.
 *
 * What it may open: only http and https (and the blank page), never Harness Relay's own ports on this
 * computer nor the link-local and cloud metadata addresses, also by a host name that leads to one (its
 * addresses are looked up first). A page on a host this conversation's browser has not opened yet is
 * asked about (below full access), as a web fetch is (kind `fetch`, keyed by host, so "always allow"
 * holds), also when a click leads there. A host opened in full access without asking is asked about
 * again below full access; a scheduled run opens only hosts always allowed, whatever the browser opened
 * before (`grantsFor()`); a conversation that refuses every request opens none it has not opened. Every other request (frames,
 * images, scripts, what a page or its workers fetch, in its own process or another) pauses too, and
 * goes unless it is one of those never opened. It keeps to one tab: a window the page opens is held
 * before it starts where the browser holds it (Google Chrome sometimes lets a script's window make its
 * first request first: like every connection, it goes through the proxy), refused every request, and
 * closed, and the agent told. Downloads, file choosers and dialogs are refused.
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
export type NavigationVerdict = 'allow' | 'ask' | 'block' | 'moved' | 'mixed';

/**
 * Whether a host leads to this computer or the local network: a loopback name, one of this
 * computer's addresses, a private one, or a name with one of those among its `addresses`.
 */
export function leadsNearby(host: string, addresses: readonly string[], own: readonly string[] = []): boolean {
  const h = host.replace(/^\[|\]$/g, '');
  const list = isIP(h) || isLoopbackHost(h) ? [h] : addresses;
  return list.some((a) => isLoopbackHost(a) || own.some((o) => o.toLowerCase() === a.toLowerCase()) || isPrivateAddress(a));
}

/** Whether a name's addresses lead both to the internet and to this computer or the local network. */
function mixedAddresses(addresses: readonly string[], own: readonly string[]): boolean {
  const near = addresses.map((a) => leadsNearby(a, [], own));
  return near.some(Boolean) && near.some((n) => !n);
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
  // A name with addresses both on the internet and here: allowed as one, its page could reach the
  // other (a connection falls back from one address to the next), so it is never opened.
  if (!isIP(host) && mixedAddresses(o.addresses ?? [], own)) return 'mixed';
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
  if (verdict === 'block' || verdict === 'moved' || verdict === 'mixed') return 'block';
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
export type Refusal = { url: string; why: 'declined' | 'blocked' | 'moved' | 'mixed' | 'unasked' };

/** What the agent is told about a refused page. */
export function refusalText(r: Refusal): string {
  if (r.why === 'declined') return `The user did not allow opening ${r.url}`;
  if (r.why === 'blocked')
    return `${r.url} cannot be opened: only http and https pages, not this computer's own Harness Relay or its metadata addresses`;
  if (r.why === 'mixed')
    return `${r.url} leads both to the internet and to this computer or the local network, so it is not opened: a page there could reach local services`;
  if (r.why === 'moved')
    return `${r.url} now leads to this computer or the local network, not where it led when it was allowed, so it is not opened (a name that changes its address to reach local services)`;
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
  /** How long a page's server may take to answer (`PAGE_ANSWER_MS`; tests give a shorter one). */
  answerMs?: number;
  /** A host name's addresses (tests give their own; else the system's lookup). */
  lookUp?: (host: string) => Promise<string[]>;
  /** How long a host name's addresses are kept before they are looked up again (a minute; tests give a shorter time). */
  addressMs?: number;
  /** Where a hand-over's window opens, or undefined when this computer cannot show one (`handoverWindowAt()`). */
  windowAt?: () => HandoverWindowAt | undefined;
  /** How long the user has to start a hand-over, then to hand it back (`HANDOVER_LIMITS`; tests give shorter ones). */
  handoverMs?: { start: number; use: number };
  /** How many browsers for the user alone may be open at once (`USER_BROWSERS_MAX`; tests give fewer). */
  userBrowsersMax?: number;
  /**
   * Tests only: a hand-over's window started headless, with the window's rules (its own tabs closed, the
   * browser's own pages sent back), so that they run where no window may open.
   */
  windowHeadless?: boolean;
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
  /**
   * The call going on (`with()`): its questions about a host the main frame would open that wait for the
   * user's answer, time its page's server is not given (`answerClock()`). A question a call that ended
   * left waiting counts for no call after it.
   */
  call: { asking: number } = { asking: 0 };
  /** The page the main frame did not open during the current call, and why. */
  denied?: Refusal;
  /** The sessions whose requests are gated: the tab's own, and its frames and workers in processes of their own. */
  readonly gated = new Set<string>();
  /** The windows the page opened, being closed: every request of theirs is refused. */
  readonly refused = new Set<string>();
  /** Windows the page opened during the current call, closed: their addresses, when known. */
  popups: string[] = [];
  /** The world the latest snapshot ran in, which holds its elements; gone once the page changes. */
  refsWorld?: number;
  /** The number the next snapshot's first element gets. */
  nextRef = 1;
  /** The latest snapshot's links, buttons and fields, by number. */
  refs = new Map<number, PageRef>();
  /** The conversation it is the browser of. */
  convId = '';
  /** It runs with a window, for a hand-over (`handover.ts`): a tab the user opens is closed too. */
  windowed = false;
  /** It was stopped (or its process ended): nothing starts its idle time again. */
  stopped = false;
  /** During a hand-over's screencast: told of a window the page opened (closed), and of a page refused. */
  onPopup?: (url: string) => void;
  onRefused?: (r: Refusal) => void;
  /**
   * A browser for the user alone (`openForUser()`): no agent drives or reads it, and nobody is asked
   * about its hosts (`ownerVerdict()`).
   */
  owner?: 'user';
  /**
   * Of a browser for the user alone (`ownerVerdict()`): the page the user typed in its address bar (or the
   * card's they confirmed, or one of theirs Back or Forward goes to), for opening that page alone (cleared
   * once the tab shows it); the page its tab shows; and the pages the gate let its tab open, by the address
   * each was let through at (its last redirect's), which the tab is about to show (`top` once it does).
   * Each as the user opened it: where it led then.
   */
  typed?: TypedPage;
  top?: OwnerPage;
  readonly openings = new Map<string, OwnerPage>();
  /**
   * The addresses of the openings the gate refused lately, whose error pages are still to commit: such a
   * commit, late on a slow computer, is that refusal's, and takes neither what the user typed since nor
   * the opening the gate let through since at the same address (`refusedCommit()`).
   */
  readonly refusedOpenings: { at: string; until: number }[] = [];
  /** Back or Forward going to a page of the user's (`entries`): the page it shows, should the browser restore it from memory. */
  restoring?: OwnerPage;
  /**
   * The pages its tab showed, by their history entry's id: Back and Forward open one of them here as the
   * user opened it (`typed`), never an address a page was refused, which its history keeps too.
   */
  readonly entries = new Map<number, OwnerPage>();
  /** The address of the page its tab shows (`top`), without its fragment. */
  shown?: string;
  /**
   * The tunnel of an https page the gate let its tab open as the user typed it (`typed`), by its origin,
   * once and for a moment at most (`until`): at the proxy every other tunnel is checked as a page's own
   * request is (a WebSocket the page still shown opens meanwhile, which the gate never sees). An http
   * page's request is told by its own address (`openings`).
   */
  pass?: { tunnel: string; until: number };
  /** The page to open again before the next call (a hand-over's window a turn's end cut short), as that call. */
  resume?: string;

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

  /** Calls going on and questions waiting on this browser: it is not idle while there are any. */
  private holds = 0;

  /** Starts counting the idle time again (`idleMs`), unless something holds the browser. */
  touch(): void {
    clearTimeout(this.timer);
    if (this.holds > 0 || this.stopped) return;
    this.timer = setTimeout(() => this.stop(), this.idleMs);
    this.timer.unref();
  }

  /** A call goes on, or waits for the user's answer: the browser does not close meanwhile, however long it takes. */
  hold(): void {
    this.holds++;
    clearTimeout(this.timer);
  }

  /** What `hold()` held is over: the idle time counts from now. */
  release(): void {
    this.holds = Math.max(0, this.holds - 1);
    this.touch();
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    return this.cdp.send<T>(method, params, this.sessionId, timeoutMs);
  }

  /** Runs `expression` in the world `contextId` (an isolated world of ours), for its value. */
  async evaluateIn<T>(contextId: number, expression: string): Promise<T> {
    const r = await this.send<{ result?: { value?: T }; exceptionDetails?: { text?: string } }>('Runtime.evaluate', {
      expression,
      contextId,
      returnByValue: true,
      awaitPromise: true,
    });
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
      if (/context|Execution context was destroyed/i.test((err as Error).message))
        throw new Error('The page changed since the latest snapshot: take a new one');
      throw err;
    }
  }
}

/**
 * What a browser needs of the server's environment to start (where home and the temporary folder
 * are, the language, the time zone, and on Windows the system's folders), and nothing else: no API
 * key, token or proxy setting of the server's reaches it, nor anything a page could learn of them.
 */
const BROWSER_ENV =
  /^(PATH|HOME|USER|LOGNAME|TMPDIR|TMP|TEMP|LANG|LANGUAGE|LC_[A-Z]+|TZ|XDG_RUNTIME_DIR|FONTCONFIG_PATH|FONTCONFIG_FILE|__CF_USER_TEXT_ENCODING|SYSTEMROOT|SYSTEMDRIVE|WINDIR|USERPROFILE|USERNAME|USERDOMAIN|HOMEDRIVE|HOMEPATH|LOCALAPPDATA|APPDATA|PROGRAMDATA|ALLUSERSPROFILE|PUBLIC|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMW6432|COMMONPROGRAMFILES|COMMONPROGRAMFILES\(X86\)|COMMONPROGRAMW6432|COMSPEC|PATHEXT|OS|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|COMPUTERNAME)$/i;

export function browserEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([k, v]) => v !== undefined && BROWSER_ENV.test(k)));
}

/**
 * The environment a conversation's browser starts with: `browserEnv()`'s, and on Linux its config and
 * cache folders inside its profile. There Chromium keeps its crash reports under
 * `$XDG_CONFIG_HOME/<browser>` (`~/.config/google-chrome`, say) whatever `--user-data-dir` says: the
 * folder of the user's own browser, which Harness Relay's must never write in. On macOS and Windows
 * they go in the profile already.
 */
export function launchEnv(
  env: NodeJS.ProcessEnv,
  profile: string,
  platform: NodeJS.Platform = process.platform,
  o: { window?: boolean } = {},
): NodeJS.ProcessEnv {
  const out = browserEnv(env);
  if (platform === 'win32' || platform === 'darwin') return out;
  // A window (a hand-over, `handover.ts`) needs the display the server's session has, and nothing more of it.
  const display = o.window
    ? Object.fromEntries(['DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY'].flatMap((k) => (env[k] ? [[k, env[k]]] : [])))
    : {};
  return { ...out, ...display, XDG_CONFIG_HOME: join(profile, 'config'), XDG_CACHE_HOME: join(profile, 'cache') };
}

/**
 * What a conversation's browser starts with: the arguments it always has, and with `window` (a
 * hand-over, `handover.ts`) the same but `--headless=new`, so that the same profile opens in a window
 * on the computer Harness Relay runs on; everything through its proxy all the same, this computer's
 * addresses too, and no UDP of WebRTC's own around it. It opens the blank page: a page is opened over
 * the debugging pipe once the gate holds every request (`launch()`).
 */
export function launchArgs(o: {
  profile: string;
  proxyPort: number;
  window?: boolean;
  platform?: NodeJS.Platform;
  /** The server runs as root (a container, say), where Chromium's own sandbox cannot start. */
  root?: boolean;
}): string[] {
  const platform = o.platform ?? process.platform;
  return [
    ...(o.window ? [] : ['--headless=new']),
    '--remote-debugging-pipe',
    `--user-data-dir=${o.profile}`,
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
    `--proxy-server=http://127.0.0.1:${o.proxyPort}`,
    '--proxy-bypass-list=<-loopback>',
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    ...(platform === 'linux' && o.root ? ['--no-sandbox'] : []),
    // A window on Linux: on Wayland where the session has it, else on X11.
    ...(o.window && platform === 'linux' ? ['--ozone-platform-hint=auto'] : []),
    'about:blank',
  ];
}

/**
 * The site permissions a page could ask for (Chromium's content settings, as its profile's preferences
 * name them): blocked by default in every browser of Harness Relay's, and whatever a site was allowed (in
 * a hand-over's window, through its page info) taken back each time the browser starts, so that a grant the
 * user gave there never reaches the agents' headless browser. The clipboard's is reading it; writing (a
 * page's Copy button) stays as Chromium has it.
 */
export const BLOCKED_SITE_PERMISSIONS = [
  'geolocation',
  'notifications',
  'media_stream_camera',
  'media_stream_mic',
  'midi_sysex',
  'clipboard',
  'sensors',
  'usb_guard',
  'serial_guard',
  'hid_guard',
  'bluetooth_guard',
  'bluetooth_scanning',
  'file_system_write_guard',
  'idle_detection',
  'window_placement',
  'local_fonts',
  'protocol_handlers',
  'payment_handler',
  'automatic_downloads',
  'vr',
  'ar',
  'keyboard_lock',
  'pointer_lock',
  'captured_surface_control',
] as const;

/**
 * The same permissions as Chromium's DevTools protocol names them (`Browser.setPermission`): denied for
 * every site of a browser of Harness Relay's as it starts, whatever its profile says.
 */
export const DENIED_PERMISSIONS = [
  'geolocation',
  'notifications',
  'camera',
  'microphone',
  'midi',
  'clipboard-read',
  'accelerometer',
  'gyroscope',
  'magnetometer',
  'ambient-light-sensor',
  'idle-detection',
  'window-management',
  'local-fonts',
  'display-capture',
  'keyboard-lock',
  'pointer-lock',
] as const;

/**
 * The profile's preferences: Chromium's page preloading off (`network_prediction_options` 2, "never"):
 * no prefetch or prerender, which speculation rules and `<link rel=prefetch>` ask of the browser itself,
 * outside the page (they would go through the proxy all the same; this makes no request at all). The site
 * permissions blocked, and those a site was given taken back (`BLOCKED_SITE_PERMISSIONS`). And for a
 * hand-over's window (`handover.ts`), where the user types into pages: no password manager or autofill
 * keeping what they type in the profile, no signing in to the browser itself, and no search suggestions
 * sending what is typed in the address bar.
 */
export function profilePrefs(prefs: Record<string, unknown>): Record<string, unknown> {
  const obj = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
  const profile = obj(prefs.profile);
  const settings = obj(profile.content_settings);
  const exceptions = obj(settings.exceptions);
  return {
    ...prefs,
    net: { ...obj(prefs.net), network_prediction_options: 2 },
    credentials_enable_service: false,
    credentials_enable_autosignin: false,
    profile: {
      ...profile,
      password_manager_enabled: false,
      default_content_setting_values: {
        ...obj(profile.default_content_setting_values),
        ...Object.fromEntries(BLOCKED_SITE_PERMISSIONS.map((k) => [k, 2])),
      },
      content_settings: {
        ...settings,
        exceptions: { ...exceptions, ...Object.fromEntries(BLOCKED_SITE_PERMISSIONS.map((k) => [k, {}])) },
      },
    },
    autofill: { ...obj(prefs.autofill), profile_enabled: false, credit_card_enabled: false },
    signin: { ...obj(prefs.signin), allowed: false },
    search: { ...obj(prefs.search), suggest_enabled: false },
  };
}

/** Writes the profile's preferences (`profilePrefs()`), keeping the rest of what the browser wrote there. */
function writePrefs(profile: string): void {
  const file = join(profile, 'Default', 'Preferences');
  let prefs: Record<string, unknown> = {};
  try {
    const read = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (read && typeof read === 'object' && !Array.isArray(read)) prefs = read as Record<string, unknown>;
  } catch {
    /* none yet */
  }
  mkdirSync(join(profile, 'Default'), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(profilePrefs(prefs)), { mode: 0o600 });
}

/**
 * What a conversation's browser carries from one start to the next during a hand-over (into its window,
 * and out of it again), in memory only: the hosts it opened, its cookies (a restart loses the session's,
 * which a sign-in often sets), and the page it was on.
 */
interface Carry {
  granted: Map<string, { asked: boolean; nearby: boolean }>;
  cookies?: Record<string, unknown>[];
  url?: string;
}

/** Cookies as `Storage.getCookies` gives them, as `Storage.setCookies` takes them. */
export function cookieParams(list: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  return list
    .filter((c) => typeof c.name === 'string' && typeof c.value === 'string' && typeof c.domain === 'string')
    .map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: typeof c.path === 'string' ? c.path : '/',
      secure: c.secure === true,
      httpOnly: c.httpOnly === true,
      ...(typeof c.sameSite === 'string' ? { sameSite: c.sameSite } : {}),
      ...(c.session !== true && typeof c.expires === 'number' && c.expires > 0 ? { expires: c.expires } : {}),
      ...(typeof c.priority === 'string' ? { priority: c.priority } : {}),
      ...(typeof c.sourceScheme === 'string' ? { sourceScheme: c.sourceScheme } : {}),
      ...(typeof c.sourcePort === 'number' ? { sourcePort: c.sourcePort } : {}),
      ...(c.partitionKey && typeof c.partitionKey === 'object' ? { partitionKey: c.partitionKey } : {}),
    }));
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

/**
 * How long a page's server may take to answer, counted from when the page is asked for (`Page.navigate`,
 * or the main frame starting to load after a click or a key): finding its addresses and connecting count
 * too, but not the time a question about its host waits for the user's answer, which may be as long as
 * the turn lasts.
 */
export const PAGE_ANSWER_MS = 2 * 60_000;

/**
 * Counts the time the tab's page is given to answer: `ms` of it, not counting the time a question of the
 * call's about a host waits for the user (`call.asking`), looked at every second at most. `over` once it
 * has had them.
 */
function answerClock(call: { asking: number }, ms: number): { done: Promise<void>; over: () => boolean; stop: () => void } {
  let used = 0;
  let last = Date.now();
  let over = false;
  let timer: NodeJS.Timeout | undefined;
  const done = new Promise<void>((resolve) => {
    const tick = () => {
      const now = Date.now();
      if (call.asking === 0) used += now - last;
      last = now;
      if (used >= ms) return void ((over = true), resolve());
      timer = setTimeout(tick, Math.min(1000, ms - used));
      timer.unref?.();
    };
    timer = setTimeout(tick, Math.min(1000, ms));
    timer.unref?.();
  });
  return { done, over: () => over, stop: () => clearTimeout(timer) };
}

/** What the agent is told of a page whose server did not answer in time (`answerClock()`). */
const silentText = (ms: number) => `did not answer in ${Math.round(ms / 1000)} seconds, and was stopped`;

/**
 * `answer` (a page being opened), unless the turn ends first or the page's server takes longer than
 * `ms` to answer (`answerClock()`): then the tab stops loading, and the call fails. A page whose server
 * never answers would otherwise hold the conversation's browser, and every later call waiting for it,
 * for as long as a turn may last (`with()`). Its answer, should it come, goes unheard.
 */
async function untilAnswered<T>(s: BrowserSession, signal: AbortSignal, ms: number, url: string, answer: Promise<T>): Promise<T> {
  answer.catch(() => undefined);
  let off = () => {};
  const ended = new Promise<never>((_, reject) => {
    const end = () => reject(new Error('The turn ended'));
    if (signal.aborted) return end();
    signal.addEventListener('abort', end, { once: true });
    off = () => signal.removeEventListener('abort', end);
  });
  const clock = answerClock(s.call, ms);
  const silent = clock.done.then((): never => {
    throw new Error(`${url} ${silentText(ms)}`);
  });
  try {
    return await Promise.race([answer, ended, silent]);
  } catch (err) {
    if (signal.aborted || clock.over()) await s.send('Page.stopLoading').catch(() => undefined);
    throw err;
  } finally {
    off();
    clock.stop();
  }
}

/** How soon a hand-over's window that is gone never reached the user (no display it could open on, say). */
const WINDOW_QUICK_EXIT_MS = 5000;

/**
 * Why a request of a browser for the user alone does not go (`ownerVerdict()`), or undefined when it does:
 * never what no browser of Harness Relay's opens, and to this computer or the local network only to the
 * host of its tab's page, or (`typed`: the opening of a page in its tab that the user typed, `typedFor()`)
 * the one they typed, each while its name leads where it led when the user opened it.
 */
function ownerRefusal(
  s: BrowserSession,
  url: string,
  rules: Parameters<typeof navigationVerdict>[1],
  typed?: OwnerPage,
): Refusal['why'] | undefined {
  if (/^(data|blob):/i.test(url) || url === 'about:blank' || url === 'about:srcdoc') return undefined;
  const verdict = navigationVerdict(url, { ...rules, allowed: new Set(), nearby: new Set() });
  if (verdict === 'block') return 'blocked';
  if (verdict === 'mixed') return 'mixed';
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return 'blocked';
  }
  const nearby = leadsNearby(host, rules.addresses ?? [], rules.own ?? []);
  const key = approvalKeys('fetch', url)[0];
  const why = ownerVerdict({ nearby, key, addresses: rules.addresses ?? [], top: s.top, ...(typed ? { typed } : {}) });
  return why === 'allow' ? undefined : why;
}

/**
 * What the user typed, as a browser for the user alone opens it (`typed`): the page (`OwnerPage`), the
 * address they typed (`url`), and the gate's id for the last request it let through for it (`request`),
 * whose redirects are its own, and that request's address (`last`).
 */
type TypedPage = OwnerPage & { url: string; request?: string; last?: string };

/** How long a refused opening's error page may take to commit, and be told for that refusal's. */
const REFUSED_COMMIT_MS = 10_000;

/** Notes a main-frame opening the gate refused at `url` (`refusedOpenings`). */
function noteRefused(s: BrowserSession, url: string): void {
  const now = Date.now();
  const kept = s.refusedOpenings.filter((r) => r.until > now).slice(-19);
  s.refusedOpenings.splice(0, s.refusedOpenings.length, ...kept, { at: addressOf(url), until: now + REFUSED_COMMIT_MS });
}

/** Whether an error page committing at `at` is that of an opening the gate refused (taken off the list then). */
function refusedCommit(s: BrowserSession, at: string): boolean {
  const now = Date.now();
  const i = s.refusedOpenings.findIndex((r) => r.at === at && r.until > now);
  if (i === -1) return false;
  s.refusedOpenings.splice(i, 1);
  return true;
}

/** `page` as the user typed it at `url`. */
const typedAt = (page: OwnerPage, url: string): TypedPage => ({
  key: page.key,
  nearby: page.nearby,
  addresses: page.addresses,
  url: noFragment(new URL(url).href),
});

/** Whether `url` is the address `typed` names: the same, or its https form (Chromium upgrading it). */
function sameAddress(url: string, typed: string): boolean {
  try {
    const a = new URL(url);
    const b = new URL(typed);
    const scheme = a.protocol === b.protocol || (a.protocol === 'https:' && b.protocol === 'http:');
    return scheme && a.hostname === b.hostname && a.port === b.port && a.pathname === b.pathname && a.search === b.search;
  } catch {
    return false;
  }
}

/**
 * Whether the main frame's request the gate paused (`p`) is the opening the user typed: a redirect of the
 * last request it let through for it, or a GET of the very address they typed. Not another page's request
 * to that host, a link or a script's (`location = …`) while the page they typed loads, or once it never
 * showed (a 204, a download).
 */
function typedFor(typed: TypedPage | undefined, url: string, p: Record<string, unknown>): TypedPage | undefined {
  if (!typed) return undefined;
  if (typeof p.redirectedRequestId === 'string') return p.redirectedRequestId === typed.request ? typed : undefined;
  const method = (p.request as { method?: unknown } | undefined)?.method;
  return (method === undefined || method === 'GET') && sameAddress(url, typed.url) ? typed : undefined;
}

/** How long the connection of a page a browser for the user alone opens as typed may take to reach the proxy (`pass`). */
const PASS_MS = 30_000;

/** `url` without its fragment, as a request and the history give it. */
const noFragment = (url: string) => url.replace(/#.*$/s, '');

/** `url` as the gate and the commits compare addresses: parsed again, without its fragment. */
function addressOf(url: string): string {
  try {
    return noFragment(new URL(url).href);
  } catch {
    return noFragment(url);
  }
}

/**
 * A page the gate lets a browser for the user alone's tab open: kept as the user opened it, by its address
 * (`openings`, the tab's `top` once it shows it). Here, as the page shown's own (its host, as that page was
 * opened) or as the one the user typed; and then, when only what they typed lets it go, its connection at
 * the proxy (`pass`).
 */
function noteOpening(
  s: BrowserSession,
  url: string,
  rules: Parameters<typeof navigationVerdict>[1],
  request: string,
  typed?: TypedPage,
): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return;
  }
  const key = approvalKeys('fetch', url)[0];
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !key) return;
  const addresses = [...(rules.addresses ?? [])];
  const at = addressOf(u.href);
  const open = (page: OwnerPage) => {
    s.openings.delete(at);
    s.openings.set(at, page);
    if (s.openings.size > 20) s.openings.delete(s.openings.keys().next().value!);
  };
  if (!leadsNearby(u.hostname, addresses, rules.own ?? [])) return open({ key, nearby: false, addresses });
  if (s.top && ownerVerdict({ nearby: true, key, addresses, top: s.top }) === 'allow') return open(s.top);
  if (!typed) return;
  open({ key: typed.key, nearby: typed.nearby, addresses: typed.addresses });
  typed.request = request;
  typed.last = at;
  if (u.protocol === 'https:') s.pass = { tunnel: u.origin, until: Date.now() + PASS_MS };
}

/**
 * Whether the proxy connects a browser for the user alone's connection (`tunnel`: a CONNECT, which https,
 * wss and ws use; `request`: an http request's address): as a request of its tab's page (`ownerRefusal()`,
 * not as a page being opened: a WebSocket, which the gate never sees, opened by the page still shown while
 * another loads), or as the connection of a page the gate let its tab open: an http one's request at its
 * own address (`openings`, until the tab shows it; the gate decided it, whatever page the tab shows by the
 * time it connects), an https one the user typed by its tunnel, once (`pass`).
 */
function ownerRoutes(
  s: BrowserSession,
  url: string,
  rules: Parameters<typeof navigationVerdict>[1],
  tunnel: boolean,
  request?: string,
): boolean {
  if (!ownerRefusal(s, url, rules)) return true;
  if (request !== undefined) {
    // The gate sees each http request, and a socket never comes this way; its name still where it led.
    const page = s.openings.get(addressOf(request));
    return Boolean(page) && !ownerRefusal(s, url, rules, page);
  }
  const pass = s.pass;
  if (!tunnel || !pass || pass.until < Date.now() || pass.tunnel !== new URL(url).origin || ownerRefusal(s, url, rules, s.typed))
    return false;
  s.pass = undefined;
  return true;
}

/**
 * Whether a WebSocket of a browser for the user alone to `url`, here, goes when its handshake comes: from the
 * page its tab shows then (its `origin`), to that page's own host as it was opened (`ownerRefusal()`).
 */
function ownerSocket(s: BrowserSession, url: string, rules: Parameters<typeof navigationVerdict>[1], origin?: string): boolean {
  const from = origin && /^https?:\/\//i.test(origin) ? approvalKeys('fetch', origin)[0] : undefined;
  return Boolean(from) && from === s.top?.key && !ownerRefusal(s, url, rules);
}

/**
 * Keeps which history entry the tab's page is (`entries`), for Back and Forward: the entry whose address
 * is the page's own (`shown`), never another the history gives while it has not caught up yet (an
 * address a page was refused, say).
 */
async function noteEntry(s: BrowserSession): Promise<void> {
  const top = s.top;
  const shown = s.shown;
  if (s.owner !== 'user' || !top || !shown) return;
  const h = await s
    .send<{ currentIndex: number; entries: { id: number; url: string }[] }>('Page.getNavigationHistory')
    .catch(() => undefined);
  const here = h?.entries[h.currentIndex];
  if (!here || s.top !== top || s.shown !== shown || noFragment(here.url) !== shown) return;
  s.entries.delete(here.id);
  s.entries.set(here.id, top);
  if (s.entries.size > 200) s.entries.delete(s.entries.keys().next().value!);
}

/** A tab's frames, as `Page.getFrameTree` gives them. */
interface FrameTree {
  frame: { id: string };
  childFrames?: FrameTree[];
}

/** The address of the tab's page now ('' when it cannot be told). */
async function pageUrl(s: BrowserSession): Promise<string> {
  const h = await s.send<{ currentIndex: number; entries: { url: string }[] }>('Page.getNavigationHistory').catch(() => undefined);
  return h?.entries[h.currentIndex]?.url ?? '';
}

/** `url` when it is a web page's (http or https), the only kind a browser opened again goes back to. */
const webUrl = (url: string) => (/^https?:\/\//i.test(url) ? url : undefined);

/** The note the user wrote to the agent, trimmed and cut to `HANDOVER_LIMITS.noteMax`; none for an empty one. */
const clipNote = (note?: string) => (note?.trim() ? note.trim().slice(0, HANDOVER_LIMITS.noteMax) : undefined);

/** Every cookie of the browser's profile, or undefined when it cannot say (it is closing). */
async function cookiesOf(s: BrowserSession): Promise<Record<string, unknown>[] | undefined> {
  const r = await s.cdp.send<{ cookies?: unknown }>('Storage.getCookies', {}, undefined, 5000).catch(() => undefined);
  return Array.isArray(r?.cookies) ? (r.cookies as Record<string, unknown>[]) : undefined;
}

/** Sets cookies a hand-over carried over: all at once, else one by one, leaving out one the browser refuses. */
async function setCookies(cdp: CdpConnection, cookies: readonly Record<string, unknown>[]): Promise<void> {
  const params = cookieParams(cookies);
  if (!params.length) return;
  const all = await cdp.send('Storage.setCookies', { cookies: params }, undefined, 5000).then(
    () => true,
    () => false,
  );
  if (!all) for (const c of params) await cdp.send('Storage.setCookies', { cookies: [c] }, undefined, 5000).catch(() => undefined);
}

/** The screencast panel's Back, Forward and Reload, in the tab. */
async function history(s: BrowserSession, to: 'back' | 'forward' | 'reload'): Promise<void> {
  if (to === 'reload') return void (await s.send('Page.reload').catch(() => undefined));
  const h = await s
    .send<{ currentIndex: number; entries: { id: number; url: string }[] }>('Page.getNavigationHistory')
    .catch(() => undefined);
  const entry = h?.entries[h.currentIndex + (to === 'back' ? -1 : 1)];
  if (!entry) return;
  // In a browser for the user alone, Back and Forward are the user's: a page of theirs there opens again as
  // they opened it (`entries`), as if typed; an address a page was refused, which the history keeps too, does
  // not (nor does Reload, on its error page: it is the tab's own page's request, and that page has no host).
  if (s.owner === 'user') {
    const page = s.entries.get(entry.id);
    s.typed = page?.nearby ? typedAt(page, entry.url) : undefined;
    s.restoring = page;
  }
  await s.send('Page.navigateToHistoryEntry', { entryId: entry.id }).catch(() => undefined);
}

export class BrowserService {
  private readonly sessions = new Map<string, Promise<BrowserSession>>();
  /** Each conversation's latest snapshot's elements, for the questions about clicking and typing (asked before the call runs). */
  private readonly latestRefs = new Map<string, Map<number, PageRef>>();
  /** The sessions by the password their browser gives the proxy. */
  private readonly byPassword = new Map<string, BrowserSession>();
  private readonly idleMs: number;
  private readonly answerMs: number;
  private readonly proxy = new BrowserProxy((password, host, port, secure, request) => this.route(password, host, port, secure, request));
  /** Host names' addresses, looked up again after a minute. */
  private readonly addressCache = new Map<string, { at: number; addresses: Promise<string[]> }>();
  /**
   * Each conversation's calls in turn: each starts once the one before it ended, whichever browser it then
   * finds (a hand-over's window closes the one before it, and opens another).
   */
  private readonly queues = new Map<string, Promise<unknown>>();
  /** What a conversation's next browser starts with (`Carry`), while a hand-over moves it into a window or out of one. */
  private readonly carried = new Map<string, Carry>();
  /** The hand-overs going on, which the routes reach. */
  readonly handovers = new Handovers();
  /** The browsers for the user alone, by their id (their hand-over's): in none of the conversations' sessions. */
  private readonly forUser = new Map<string, { convId: string; s: BrowserSession; ticket: HandoverTicket; ended: Promise<void> }>();
  /** Browsers for the user alone being started: their places are taken at once, so that two at a time cannot pass the limit. */
  private opening = 0;
  private readonly handoverMs: { start: number; use: number };

  constructor(private o: BrowserServiceOptions) {
    this.idleMs = o.idleMs ?? 10 * 60_000;
    this.answerMs = o.answerMs ?? PAGE_ANSWER_MS;
    this.handoverMs = o.handoverMs ?? { start: HANDOVER_LIMITS.startMinutes * 60_000, use: HANDOVER_LIMITS.useMinutes * 60_000 };
    // Its profiles' folder, a protected path from the first turn on (`relayBrowserDir`).
    mkdirSync(relayBrowserDir(o.dataDir), { recursive: true, mode: 0o700 });
    // The browsers for the user alone a stopped server left (none runs yet): their profiles go.
    removeTree(this.userProfiles());
  }

  /** Where the browsers for the user alone keep their throwaway profiles: none of a conversation's. */
  private userProfiles(): string {
    return join(relayBrowserDir(this.o.dataDir), 'user');
  }

  /**
   * Keeps the conversation's browser open while the user is asked about a click or a key (before the
   * call runs): returns what ends it. A browser not started yet has nothing to keep.
   */
  hold(convId: string): () => void {
    const started = this.sessions.get(convId);
    if (!started) return () => undefined;
    let over = false;
    let held: BrowserSession | undefined;
    void started.then(
      (s) => {
        if (over) return;
        held = s;
        s.hold();
      },
      () => undefined,
    );
    return () => {
      over = true;
      held?.release();
      held = undefined;
    };
  }

  /** Why the browser tools cannot be used now, or undefined. */
  unavailable(): string | undefined {
    return this.o.executable() ? undefined : 'no Chromium, Chrome or Edge was found: install one, or set RELAY_BROWSER to it';
  }

  private profile(convId: string): string {
    return join(relayBrowserDir(this.o.dataDir), convId.replace(/[^A-Za-z0-9_-]/g, '_'));
  }

  /** The conversation's browser, started when it has none (with `window`, in a window: a hand-over's). */
  private session(convId: string, o: { window?: boolean } = {}): Promise<BrowserSession> {
    let s = this.sessions.get(convId);
    if (!s) {
      const started: Promise<BrowserSession> = this.launch(convId, o, () => this.sessions.get(convId) === started);
      s = started;
      this.sessions.set(convId, started);
      started.catch(() => {
        if (this.sessions.get(convId) === started) this.sessions.delete(convId);
      });
    }
    return s;
  }

  /**
   * Starts a conversation's browser, with what a hand-over carries into it (`carried`). `mine`: whether it
   * is still the conversation's (a hand-over's window replaced it, say), so that it ending takes nothing
   * of the one after it.
   */
  private async launch(
    convId: string,
    o: { window?: boolean; profile?: string; owner?: 'user' },
    mine: () => boolean,
  ): Promise<BrowserSession> {
    const bin = this.o.executable();
    if (!bin) throw new Error(this.unavailable());
    // A browser for the user alone carries nothing of the conversation's, and keeps its own profile.
    const carry = o.owner ? undefined : this.carried.get(convId);
    if (!o.owner) this.carried.delete(convId);
    const profile = o.profile ?? this.profile(convId);
    mkdirSync(profile, { recursive: true, mode: 0o700 });
    writePrefs(profile);
    await this.proxy.start();
    const password = this.proxy.issue();
    const abort = new AbortController();
    let pipes: { write: Duplex; read: Duplex } | undefined;
    const args = launchArgs({
      profile,
      proxyPort: this.proxy.port,
      window: o.window && !this.o.windowHeadless,
      root: process.getuid?.() === 0,
    });
    const exited = runProcess({
      bin,
      args,
      env: launchEnv(process.env, profile, process.platform, { window: o.window }),
      signal: abort.signal,
      pipes: (write, read) => (pipes = { write, read }),
    });
    if (!pipes) {
      abort.abort();
      if (carry) this.carried.set(convId, carry);
      throw new Error('The browser could not be started');
    }
    const cdp = new CdpConnection(pipes.write, pipes.read);
    let session: BrowserSession | undefined;
    const gone = () => {
      if (session) session.stopped = true;
      if (mine()) {
        this.sessions.delete(convId);
        this.latestRefs.delete(convId);
      }
      this.byPassword.delete(password);
      this.proxy.forget(password);
      cdp.close();
    };
    const stop = () => {
      gone();
      abort.abort();
    };
    void exited.then(gone, gone);
    try {
      // A browser that never answers (one that cannot start here) fails the call now, not after each of the
      // calls below has had its own time.
      await cdp.send('Browser.getVersion');
      await cdp.send('Browser.setDownloadBehavior', { behavior: 'deny' }).catch(() => undefined);
      // No site gets a device, the location, notifications or the clipboard's contents, whatever its profile says.
      for (const name of DENIED_PERMISSIONS)
        await cdp.send('Browser.setPermission', { permission: { name }, setting: 'denied' }).catch(() => undefined);
      // What a hand-over carried over: the cookies (the session's, which a restart loses, among them).
      if (carry?.cookies?.length) await setCookies(cdp, carry.cookies);
      const { targetInfos } = await cdp.send<{ targetInfos: { targetId: string; type: string }[] }>('Target.getTargets');
      let targetId = targetInfos.find((t) => t.type === 'page')?.targetId;
      targetId ??= (await cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' })).targetId;
      const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
      session = new BrowserSession(
        cdp,
        sessionId,
        targetId,
        stop,
        this.idleMs,
        exited.catch(() => undefined),
      );
      session.proxyPassword = password;
      session.convId = convId;
      session.windowed = Boolean(o.window);
      if (o.owner) session.owner = o.owner;
      // A window a turn's end cut short: the next call opens again the page it was on (`with()`).
      if (carry?.url) session.resume = carry.url;
      for (const [key, g] of carry?.granted ?? []) session.granted.set(key, g);
      const s = session;
      this.byPassword.set(password, s);
      s.gated.add(sessionId);
      cdp.on('Fetch.requestPaused', (p: Record<string, unknown>, sid?: string) => {
        if (sid && s.refused.has(sid))
          return void cdp.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' }, sid).catch(() => undefined);
        if (!sid || !s.gated.has(sid)) return;
        // A request the gate could not decide is refused, never left waiting (its page would never load).
        void this.gate(s, p, sid).catch(() =>
          cdp.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' }, sid).catch(() => undefined),
        );
      });
      // The proxy asks each browser to prove itself: only this one's own password, never a site's.
      cdp.on('Fetch.authRequired', (p: Record<string, unknown>, sid?: string) => {
        if (!sid || (!s.gated.has(sid) && !s.refused.has(sid))) return;
        const proxy = (p.authChallenge as { source?: string } | undefined)?.source === 'Proxy' && !s.refused.has(sid);
        const authChallengeResponse = proxy
          ? { response: 'ProvideCredentials', username: PROXY_USER, password }
          : { response: 'CancelAuth' };
        void cdp.send('Fetch.continueWithAuth', { requestId: p.requestId, authChallengeResponse }, sid).catch(() => undefined);
      });
      cdp.on('Target.attachedToTarget', (p: Record<string, unknown>) => void this.adopt(s, p));
      // The page its tab shows (a browser for the user alone's requests here go only to its host), as the
      // user opened it (`opening`, or a page of theirs Back restored from memory), else as a page that led to
      // the internet; and the opening the user typed done with. Not the tab's first, blank page, which may
      // come after the opening was asked for.
      cdp.on('Page.frameNavigated', (p: Record<string, unknown>, sid?: string) => {
        const frame = p.frame as { parentId?: string; url?: string; unreachableUrl?: string } | undefined;
        if (sid !== sessionId || !frame || frame.parentId) return;
        const url = frame.url ?? '';
        if (url === 'about:blank') return void ((s.top = undefined), (s.shown = undefined));
        // What this commit is of: a page, or the error page of an address that did not open. Only the
        // opening the user typed ends what they typed: on a slow computer the page before (or the error
        // page of one refused before) may commit once they typed another, which still opens.
        const failed = typeof frame.unreachableUrl === 'string' ? addressOf(frame.unreachableUrl) : undefined;
        const at = failed ?? addressOf(url);
        // The error page of an opening the gate refused (committing late, once the user typed that same
        // address and the gate let it through): that refusal's, which ends nothing of the user's opening.
        const refused = failed !== undefined && refusedCommit(s, failed);
        if (!refused && s.typed?.last === at) s.typed = s.pass = undefined;
        const key = failed === undefined && /^https?:/i.test(url) ? approvalKeys('fetch', url)[0] : undefined;
        // The page let through at this address, else (an address put another way) the latest of its host's.
        const opening = refused ? undefined : (s.openings.get(at) ?? [...s.openings.values()].reverse().find((o) => o.key === key));
        if (!refused) s.openings.delete(at);
        const restoring = s.restoring;
        s.restoring = undefined;
        s.top = !key
          ? undefined
          : opening?.key === key
            ? opening
            : restoring?.key === key
              ? restoring
              : { key, nearby: false, addresses: [] };
        s.shown = key ? noFragment(url) : undefined;
        void noteEntry(s);
      });
      // Which history entry it is, once the history has caught up (`noteEntry()`); a page's own new address
      // (`history.pushState()`) an entry too.
      cdp.on('Page.navigatedWithinDocument', (p: Record<string, unknown>, sid?: string) => {
        if (sid !== sessionId || p.frameId !== s.mainFrame || !s.top) return;
        const url = String(p.url ?? '');
        if (approvalKeys('fetch', url)[0] === s.top.key) s.shown = noFragment(url);
        void noteEntry(s);
      });
      cdp.on('Page.domContentEventFired', (_p: Record<string, unknown>, sid?: string) => {
        if (sid === sessionId) void noteEntry(s);
      });
      cdp.on('Page.frameStoppedLoading', (p: Record<string, unknown>, sid?: string) => {
        if (sid === sessionId && p.frameId === s.mainFrame) void noteEntry(s);
      });
      cdp.on('Target.detachedFromTarget', (p: Record<string, unknown>) => {
        s.gated.delete(String(p.sessionId));
        s.refused.delete(String(p.sessionId));
      });
      await s.send('Page.enable');
      await s.send('Runtime.enable');
      await s.send('Page.setInterceptFileChooserDialog', { enabled: true }).catch(() => undefined);
      const tree = await s.send<{ frameTree: { frame: { id: string } } }>('Page.getFrameTree');
      s.mainFrame = tree.frameTree.frame.id;
      cdp.on('Page.javascriptDialogOpening', (_p, sid) => {
        if (sid === sessionId) void s.send('Page.handleJavaScriptDialog', { accept: false }).catch(() => undefined);
      });
      await s.send('Fetch.enable', FETCH_ALL);
      // The tab's frames in processes of their own and its workers: each held before it starts, gated, then let go.
      await s.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
      // The browser's other targets: a window the page opens (closed), a service or shared worker (gated).
      await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
      s.touch();
      return s;
    } catch (err) {
      stop();
      if (carry) this.carried.set(convId, carry);
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
    if (hit && now - hit.at < (this.o.addressMs ?? 60_000)) return hit.addresses;
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
   * Where the proxy may connect a browser's connection to `host`:`port` (`secure`: a CONNECT tunnel;
   * `request`: an http request's address): refused unless `requestVerdict()` lets it go (in a browser for
   * the user alone, `ownerRoutes()`), else to the addresses it was checked with (this computer's for a
   * loopback name), the same ones the gate's check used.
   */
  private async route(password: string, host: string, port: number, secure: boolean, request?: string): Promise<ProxyRoute> {
    const s = this.byPassword.get(password);
    if (!s) return { refused: 'not a browser of this server' };
    const name = host.replace(/^\[|\]$/g, '');
    const bracketed = isIPv6(name) ? `[${name}]` : name;
    // A tunnel on port 80 is a ws:// socket's; any other, https's or wss's: keyed as the page's own address is.
    const url = `${secure && port !== 80 ? 'https' : 'http'}://${bracketed}:${port}/`;
    const rules = await this.rules(s, url);
    // A browser for the user alone: here only to its own page's host, or once for the page the user is opening (`ownerRoutes()`).
    const refused = s.owner === 'user' ? !ownerRoutes(s, url, rules, secure, request) : requestVerdict(url, rules) !== 'allow';
    if (refused) return { refused: `${url} is not reached from Harness Relay's browser` };
    const addresses = isIP(name) ? [name] : isLoopbackHost(name) ? ['127.0.0.1', '::1'] : [...(rules.addresses ?? [])];
    if (!addresses.length) return { refused: `${name} has no address` };
    // A browser for the user alone's WebSocket here: only its tab's page's own, by the origin its handshake
    // gives, when it gets there (not one the page before it opened, connecting once another page is shown).
    if (s.owner === 'user' && leadsNearby(name, rules.addresses ?? [], rules.own ?? []))
      return { addresses, socket: (origin) => ownerSocket(s, url, rules, origin) };
    return { addresses };
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
      (allow
        ? s.cdp.send('Fetch.continueRequest', { requestId }, sid)
        : s.cdp.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }, sid)
      ).catch(() => undefined);
    const rules = await this.rules(s, url);
    // A browser for the user alone: nobody asked, and a request here only to the host of its own page (`ownerVerdict()`).
    if (s.owner === 'user') {
      const main = isMainDocument(s, p, sid);
      const typed = main ? typedFor(s.typed, url, p) : undefined;
      const why = ownerRefusal(s, url, rules, typed);
      if (main && why) {
        s.denied = { url, why };
        noteRefused(s, url);
        s.onRefused?.(s.denied);
      }
      if (main && !why) noteOpening(s, url, rules, requestId, typed);
      return void (await go(!why));
    }
    if (!isMainDocument(s, p, sid)) return void (await go(requestVerdict(url, rules) === 'allow'));
    const verdict = navigationVerdict(url, rules);
    let allow = verdict === 'allow';
    if (verdict === 'block' || verdict === 'moved' || verdict === 'mixed')
      s.denied = { url, why: verdict === 'block' ? 'blocked' : verdict };
    if (verdict === 'ask') {
      const ctx = s.current;
      // The question says when the page is on this computer or the local network: allowing it lets its pages reach there.
      const nearby = leadsNearby(new URL(url).hostname, rules.addresses ?? [], rules.own ?? []);
      if (ctx?.permission === 'full') allow = true;
      else if (ctx?.ask) {
        const ask = () =>
          ctx.ask!({ kind: 'fetch', detail: url, reason: nearby ? t().gw.openNearbyReason : t().gw.openReason, noLock: true });
        // The page's server is not waited for meanwhile (`answerClock()`): counted on the call that asks.
        const call = s.call;
        call.asking++;
        let answer: { allow: boolean };
        try {
          answer = await (ctx.lang ? withLang(ctx.lang, ask) : ask()).catch(() => ({ allow: false }));
        } finally {
          call.asking--;
        }
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
    // A hand-over's screencast says so in its panel.
    if (!allow && s.denied?.url === url) s.onRefused?.(s.denied);
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
    // In a hand-over's window, a tab the user opens (Chromium's new tab page, its settings, history or
    // downloads, a window of another profile) is no part of the browser's own: closed, as a page's window
    // is. Its own UI (`*.top-chrome`) and DevTools stay.
    const usersTab =
      s.windowed &&
      (info.type === 'page' || info.type === 'tab') &&
      /^(chrome|chrome-untrusted):\/\//i.test(info.url ?? '') &&
      !/^chrome(-untrusted)?:\/\/[^/]*\.top-chrome\//i.test(info.url ?? '');
    if (
      info.targetId === s.targetId ||
      (!usersTab && (info.type === 'browser_ui' || /^(chrome|chrome-extension|chrome-untrusted|devtools):/i.test(info.url ?? '')))
    ) {
      if (waiting) await send('Runtime.runIfWaitingForDebugger');
      void s.cdp.send('Target.detachFromTarget', { sessionId: sid }).catch(() => undefined);
      return;
    }
    if (info.type === 'page' || info.type === 'tab' || info.type === 'background_page') {
      // A page prerendered for the tab is no window the page opened: closed all the same, unmentioned.
      if (info.subtype !== 'prerender') {
        const url = info.url && info.url !== 'about:blank' && !usersTab ? info.url : '';
        s.popups.push(url);
        s.onPopup?.(url);
      }
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
  private async with<T>(ctx: GatewayContext, fn: (s: BrowserSession) => Promise<T>, o: { navigates?: boolean } = {}): Promise<T> {
    const before = this.queues.get(ctx.convId) ?? Promise.resolve();
    const turn = before.then(async () => {
      if (ctx.signal.aborted) throw new Error('The turn ended');
      const s = await this.session(ctx.convId);
      const resume = s.resume;
      s.resume = undefined;
      s.current = ctx;
      s.call = { asking: 0 };
      s.denied = undefined;
      s.popups = [];
      s.callGranted.clear();
      // Held for the whole call, also while the user is asked about a host (as long as the turn lasts).
      s.hold();
      try {
        // The page a hand-over's window was on, opened again as this call (its hosts, its questions), unless the call opens another.
        if (resume && !o.navigates) {
          await this.goTo(s, ctx, resume).catch(() => undefined);
          // A page it was refused there is no note of this call's.
          s.denied = undefined;
          s.popups = [];
        }
        return await fn(s);
      } finally {
        s.current = undefined;
        s.release();
      }
    });
    const tail = turn.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(ctx.convId, tail);
    void tail.then(() => {
      if (this.queues.get(ctx.convId) === tail) this.queues.delete(ctx.convId);
    });
    return turn;
  }

  /** What a click or a key did besides the page: a page refused, a window closed. */
  private notes(s: BrowserSession): string[] {
    const out: string[] = [];
    if (s.denied) out.push(`(The page tried to open ${s.denied.url}, which was not allowed: ${refusalText(s.denied)}.)`);
    for (const url of s.popups) {
      out.push(
        `(The page tried to open ${url ? `${url} in ` : ''}a new window, which was closed: this browser keeps to one tab. Open it with browser_open${url ? '' : ' if you need it'}.)`,
      );
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
    const h = await s
      .send<{ currentIndex: number; entries: { id: number; url: string }[] }>('Page.getNavigationHistory')
      .catch(() => undefined);
    const here = h?.entries[h.currentIndex];
    const before = h && h.currentIndex > 0 ? h.entries[h.currentIndex - 1] : undefined;
    if (!here || !before || !(here.url.startsWith('chrome-error:') || here.url === s.denied.url)) return;
    // A page restored from the back-forward cache fires no load event: stopped loading says it is there.
    const loaded = Promise.race([
      s.cdp.waitFor('Page.loadEventFired', 5000, s.sessionId),
      s.cdp.waitFor('Page.frameStoppedLoading', 5000, s.sessionId),
    ]);
    await s.send('Page.navigateToHistoryEntry', { entryId: before.id }).catch(() => undefined);
    await loaded;
  }

  /** Waits for the page to finish loading (or `ms`), then a moment for what it draws. */
  private async settle(s: BrowserSession, ms: number): Promise<void> {
    await s.cdp.waitFor('Page.loadEventFired', ms, s.sessionId);
    await new Promise((r) => setTimeout(r, 300));
  }

  /**
   * Runs `input` (a click, Enter) and waits for the page it opens, if it opens one. A page starts
   * loading at once (within `startMs`), but the user may be asked about its host first, and its server
   * may answer later: so it waits, while the user is asked for as long as the turn lasts and then for
   * its server up to `answerMs`, until the new page is there (then until it has loaded, at most 15 s)
   * or the main frame stops loading without one (a download, an answer with no page, a page refused).
   * Watching only for the new page to be there, as before, read a page whose server took longer than
   * that to answer before it had come. Resolves with whether a new page is there. Once the turn ends
   * (`signal`), or the page's server has had `answerMs` (`answerClock()`), the tab stops loading and
   * the call fails, as `open()`'s does: the page on its way would hold the tab (a snapshot of it waits
   * for it), and the calls after it.
   */
  private async afterInput(s: BrowserSession, startMs: number, signal: AbortSignal, input: () => Promise<void>): Promise<boolean> {
    const seen = { started: false, navigated: false, stopped: false, loaded: false };
    const waiting: (() => void)[] = [];
    const main = (id: unknown) => id === s.mainFrame;
    const mark = (k: keyof typeof seen, matches: (p: Record<string, unknown>) => boolean) => (p: Record<string, unknown>, sid?: string) => {
      if (sid !== s.sessionId || !matches(p)) return;
      seen[k] = true;
      for (const w of waiting.splice(0)) w();
    };
    const handlers: [string, (p: Record<string, unknown>, sid?: string) => void][] = [
      ['Page.frameStartedLoading', mark('started', (p) => main(p.frameId))],
      ['Page.frameNavigated', mark('navigated', (p) => main((p.frame as { id?: string } | undefined)?.id))],
      ['Page.frameStoppedLoading', mark('stopped', (p) => main(p.frameId))],
      ['Page.loadEventFired', mark('loaded', () => true)],
    ];
    const until = async (done: () => boolean, ms: number): Promise<boolean> => {
      const end = Date.now() + ms;
      while (!done()) {
        const left = end - Date.now();
        if (left <= 0 || signal.aborted || s.cdp.isClosed) return done();
        // Woken by the page's next event, else in a second: then it goes from `waiting`, which would
        // otherwise grow by one a second for as long as the user takes to answer about a host.
        await new Promise<void>((resolve) => {
          const wake = () => (clearTimeout(timer), resolve());
          const timer = setTimeout(
            () => {
              const i = waiting.indexOf(wake);
              if (i >= 0) waiting.splice(i, 1);
              resolve();
            },
            Math.min(left, 1000),
          );
          waiting.push(wake);
        });
      }
      return true;
    };
    const stop = async (why: string): Promise<never> => {
      await s.send('Page.stopLoading').catch(() => undefined);
      throw new Error(why);
    };
    const ended = () => stop('The turn ended');
    for (const [event, on] of handlers) s.cdp.on(event, on);
    try {
      await input();
      const started = await until(() => seen.started || seen.navigated, startMs);
      if (signal.aborted) return await ended();
      if (!started) return false;
      // As long as the user takes to answer about its host, then what its server is given (`answerMs`).
      const clock = answerClock(s.call, this.answerMs);
      try {
        await until(() => seen.navigated || seen.stopped || clock.over(), CONFIG.turnTimeoutMs);
      } finally {
        clock.stop();
      }
      if (signal.aborted) return await ended();
      if (!seen.navigated && !seen.stopped && clock.over()) return await stop(`The page it opened ${silentText(this.answerMs)}`);
      if (!seen.navigated) return false;
      await until(() => seen.loaded || seen.stopped, 15_000);
      if (signal.aborted) return await ended();
      await new Promise((r) => setTimeout(r, 300));
      return true;
    } finally {
      for (const [event, on] of handlers) s.cdp.off(event, on);
    }
  }

  /** Refuses a page that is never opened (another scheme, Harness Relay's own ports, a metadata address) before any call waits for the browser. */
  private async refuseBlocked(url: string): Promise<void> {
    const verdict = navigationVerdict(url, {
      relayPorts: this.ownPorts(),
      own: this.o.own?.() ?? [],
      allowed: new Set(),
      addresses: await this.addresses(url),
    });
    if (verdict === 'block') throw new Error(refusalText({ url, why: 'blocked' }));
  }

  /**
   * Opens `url` in the tab, as the call `ctx`: the answer comes once the page is let through, which may
   * wait for the user's answer (as long as the turn lasts), and its server answers (`answerMs`).
   */
  private async goTo(s: BrowserSession, ctx: GatewayContext, url: string): Promise<void> {
    const r = await untilAnswered(
      s,
      ctx.signal,
      this.answerMs,
      url,
      s.send<{ errorText?: string; loaderId?: string }>('Page.navigate', { url }, CONFIG.turnTimeoutMs),
    );
    if (r.errorText) {
      const denied = s.denied;
      await this.backFromRefused(s);
      throw new Error(denied ? refusalText(denied) : `${url} did not open: ${r.errorText}`);
    }
    // No loader: the same page, at another anchor, which loads nothing.
    if (r.loaderId) await this.settle(s, 20_000);
    else await new Promise((done) => setTimeout(done, 200));
  }

  async open(ctx: GatewayContext, url: string): Promise<PageSnapshot> {
    await this.refuseBlocked(url);
    return this.with(
      ctx,
      async (s) => {
        await this.goTo(s, ctx, url);
        return this.withNotes(s, await this.read(s));
      },
      { navigates: true },
    );
  }

  async snapshot(ctx: GatewayContext): Promise<PageSnapshot> {
    return this.with(ctx, (s) => this.read(s));
  }

  /**
   * The page now, read in a new world of our own, whose elements the clicks and typing that follow
   * use; checked to be what the script gives (the page cannot change it, but a page can be odd).
   */
  private async read(s: BrowserSession): Promise<PageSnapshot> {
    const { executionContextId } = await s.send<{ executionContextId: number }>('Page.createIsolatedWorld', {
      frameId: s.mainFrame,
      worldName: 'harness-relay',
    });
    const raw = await s.evaluateIn<Record<string, unknown> | undefined>(executionContextId, SNAPSHOT_SCRIPT(s.nextRef));
    const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
    const refs = new Map<number, PageRef>();
    for (const r of Array.isArray(raw?.refs) ? (raw.refs as Record<string, unknown>[]) : []) {
      const n = Number(r?.ref);
      const kind = r?.kind;
      if (!Number.isInteger(n) || n < s.nextRef || (kind !== 'link' && kind !== 'button' && kind !== 'field' && kind !== 'select'))
        continue;
      refs.set(n, {
        kind,
        label: str(r.label, 120),
        ...(r.href ? { href: str(r.href, 500) } : {}),
        ...(r.name ? { name: str(r.name, 100) } : {}),
      });
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
      const box = await s.inRefsWorld<{ missing?: boolean; covered?: boolean; x: number; y: number; w: number; h: number }>(
        BOX_SCRIPT(ref),
      );
      if (box.missing) throw new Error(`There is no element ${ref} on the page now: take a new snapshot`);
      if (!box.w && !box.h) throw new Error(`Element ${ref} is not visible`);
      // A click there would reach what lies over it, not what the user was asked about.
      if (box.covered) throw new Error(`Element ${ref} is covered by another element of the page: not clicked`);
      const navigated = await this.afterInput(s, 1500, ctx.signal, async () => {
        for (const type of ['mousePressed', 'mouseReleased']) {
          await s.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
        }
      });
      if (!navigated) await new Promise((r) => setTimeout(r, 400));
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
        const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
        await this.afterInput(s, 2000, ctx.signal, async () => {
          await s.send('Input.dispatchKeyEvent', { type: 'keyDown', ...key, text: '\r' });
          await s.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
        });
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
      const { data } = await s.send<{ data: string }>('Page.captureScreenshot', {
        format: 'png',
        ...(clip ? { clip, captureBeyondViewport: true } : {}),
      });
      // Only the user's account may read it, as the attached files.
      const dir = attachmentsDir(ctx.convId);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const path = join(dir, `browser-${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
      writeFileSync(path, Buffer.from(data, 'base64'), { mode: 0o600 });
      return { path, data };
    });
  }

  /**
   * Hands the open page to the user (`browser_hand_over`; with `url`, that page is opened first), as the
   * call `ctx`, which waits meanwhile, and so do the conversation's other browser calls (its queue). The
   * card in the reply (`ctx.handoverCard`) says why (`reason`, the agent's words), where the window would
   * open, and that what the user signs in to stays in this chat's browser; the user starts it in a window
   * or as a screencast, or declines. Returns only how it ended and the user's note (`handoverOutcome()`).
   * Refused where nobody can be asked: a run nobody watches, a conversation that refuses requests.
   */
  async handOver(
    ctx: GatewayContext,
    reason: string,
    url?: string,
    /** Whether the CLI stopped waiting for the call (its own time limit): the hand-over ends then too. */
    gone?: () => boolean,
  ): Promise<{ text: string; isError?: boolean }> {
    const card = ctx.handoverCard;
    if (!card || ctx.unattended || !ctx.ask) return { text: HANDOVER_UNASKED, isError: true };
    if (url) await this.refuseBlocked(url);
    const limits = this.handoverMs;
    return this.with(ctx, async (s) => {
      // The browser the call ends with, when a window replaced the one it began with: the call's to let go,
      // before the call ends and the next one finds it.
      let live: BrowserSession | undefined;
      try {
        if (url) await this.goTo(s, ctx, url);
        const at = this.o.windowAt?.();
        const modes: HandoverMode[] = at ? ['window', 'screencast'] : ['screencast'];
        const ticket = this.handovers.create(ctx.convId, modes);
        const page = cardUrl(await pageUrl(s));
        const shown = card({
          type: 'handover',
          id: ticket.id,
          reason: dataLine(reason).trim().slice(0, 1000),
          ...(page ? { url: page } : {}),
          modes,
          ...(at ? { windowAt: at } : {}),
          status: 'pending',
          deadline: Date.now() + limits.start,
        });
        const minutes = { start: Math.round(limits.start / 60_000), use: Math.round(limits.use / 60_000) };
        try {
          const answer = await ticket.wait(limits.start, ctx.signal, gone);
          if (answer.action !== 'start') {
            const note = answer.action === 'cancel' ? clipNote(answer.note) : undefined;
            shown.update(
              answer.action === 'cancel'
                ? { status: 'declined', ...(note ? { note } : {}), deadline: undefined }
                : {
                    status: 'expired',
                    ended: answer.action === 'turn' ? 'turn' : answer.action === 'gone' ? 'gone' : 'timeout',
                    deadline: undefined,
                  },
            );
            if (answer.action === 'turn') throw new Error('The turn ended');
            return handoverOutcome({
              end: answer.action === 'cancel' ? { ...answer, note } : answer,
              started: false,
              page: 'kept',
              minutes,
            });
          }
          ticket.status = 'active';
          shown.update({ status: 'active', mode: answer.mode, deadline: Date.now() + limits.use });
          let end: HandoverWake;
          let where: 'kept' | 'reopened' | 'closed' = 'kept';
          try {
            if (answer.mode === 'screencast') end = await this.screencast(s, ticket, ctx.signal, limits.use, gone);
            else {
              const r = await this.inWindow(s, ticket, ctx, limits.use, gone);
              end = r.end;
              where = r.page;
              live = r.session;
            }
          } catch (err) {
            // The browser could not be shown (its screencast would not start, say): the card says so.
            end = { action: 'failed', error: (err as Error).message };
          }
          // The browser ended under the screencast: the page is gone with it (one whose screencast would not
          // start is still open, as the user left it).
          if (end.action === 'failed' && answer.mode === 'screencast' && s.stopped) where = 'closed';
          const note = end.action === 'done' || end.action === 'cancel' ? clipNote(end.note) : undefined;
          shown.update({
            status: end.action === 'done' || end.action === 'closed' ? 'done' : end.action === 'cancel' ? 'cancelled' : 'expired',
            ...(note ? { note } : {}),
            ...(end.action === 'timeout' || end.action === 'turn' || end.action === 'gone' || end.action === 'failed'
              ? { ended: end.action }
              : {}),
            deadline: undefined,
          });
          if (end.action === 'turn') throw new Error('The turn ended');
          return handoverOutcome({
            end: end.action === 'done' || end.action === 'cancel' ? { ...end, note } : end,
            started: true,
            page: where,
            minutes,
          });
        } finally {
          this.handovers.remove(ticket);
        }
      } finally {
        if (live && live !== s) {
          live.current = undefined;
          live.release();
        }
      }
    });
  }

  /**
   * The screencast (`Page.startScreencast`): each frame to the panel's watchers (acknowledged at once:
   * a watcher that falls behind gets the latest only), with the page's address, the windows it opened and
   * the pages refused; the user's input into the tab, laid out to the panel's size, until they hand it
   * back, cancel, the time runs out (`ms`) or the turn ends. Then the page is as the user left it, at the
   * size the agents' calls have.
   */
  private async screencast(
    s: BrowserSession,
    ticket: HandoverTicket,
    signal: AbortSignal,
    ms: number,
    gone?: () => boolean,
  ): Promise<HandoverWake> {
    let frame = { width: 1280, height: 900 };
    let size: { width: number; height: number; scale: number } | undefined;
    const start = () =>
      s.send('Page.startScreencast', {
        format: 'jpeg',
        quality: 70,
        everyNthFrame: 1,
        ...(size ? { maxWidth: Math.round(size.width * size.scale), maxHeight: Math.round(size.height * size.scale) } : {}),
      });
    const location = () => void this.location(s, ticket);
    const handlers: [string, (p: Record<string, unknown>, sid?: string) => void][] = [
      [
        'Page.screencastFrame',
        (p, sid) => {
          if (sid !== s.sessionId) return;
          void s.send('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => undefined);
          const m = (p.metadata ?? {}) as { deviceWidth?: number; deviceHeight?: number };
          if (m.deviceWidth && m.deviceHeight) frame = { width: m.deviceWidth, height: m.deviceHeight };
          ticket.emit({ type: 'frame', data: String(p.data ?? ''), width: Math.round(frame.width), height: Math.round(frame.height) });
        },
      ],
      ['Page.frameNavigated', (p, sid) => sid === s.sessionId && !(p.frame as { parentId?: string } | undefined)?.parentId && location()],
      ['Page.navigatedWithinDocument', (p, sid) => sid === s.sessionId && p.frameId === s.mainFrame && location()],
      // Again once the page is there: the history a page's commit is told with may not have caught up yet.
      ['Page.domContentEventFired', (_p, sid) => sid === s.sessionId && location()],
      ['Page.frameStoppedLoading', (p, sid) => sid === s.sessionId && p.frameId === s.mainFrame && location()],
    ];
    for (const [event, on] of handlers) s.cdp.on(event, on);
    s.onPopup = (url) => ticket.emit({ type: 'notice', kind: 'popup', ...(url ? { url } : {}) });
    s.onRefused = (r) => ticket.emit({ type: 'notice', kind: 'refused', url: r.url });
    // One event after another, as the user did them.
    let inputs = Promise.resolve();
    /** The hand-over is over: what still waits of the user's input reaches the page no more (the next call has it). */
    let over = false;
    ticket.screen = {
      input: (events) =>
        (inputs = inputs.then(async () => {
          for (const e of events) {
            if (over) return;
            if (e.type === 'viewport') {
              size = { width: e.width, height: e.height, scale: Math.min(e.scale ?? 1, 2) };
              await s
                .send('Emulation.setDeviceMetricsOverride', {
                  width: e.width,
                  height: e.height,
                  deviceScaleFactor: size.scale,
                  mobile: false,
                })
                .catch(() => undefined);
              await s.send('Page.stopScreencast').catch(() => undefined);
              await start().catch(() => undefined);
            } else if (e.type === 'navigate') {
              // As the agents' own pages are: never another scheme, Harness Relay or a metadata address;
              // a host the chat's browser has not opened asks (below full access), the gate's question.
              try {
                await this.refuseBlocked(e.url);
                // In a browser for the user alone, an address they typed may be on this computer or the local
                // network, while it leads where it did when they typed it; one a page offered (a window it
                // opened: "Open it here") may not, nor what they typed before.
                if (s.owner === 'user') {
                  const page = e.typed ? await this.ownerPage(e.url) : undefined;
                  s.typed = undefined;
                  if (page) await this.leaveFor(s, page, e.url);
                  s.typed = page && typedAt(page, e.url);
                }
                void s.send('Page.navigate', { url: e.url }, CONFIG.turnTimeoutMs).catch(() => undefined);
              } catch {
                ticket.emit({ type: 'notice', kind: 'refused', url: e.url });
              }
            } else if (e.type === 'history') await history(s, e.to);
            else for (const c of inputCalls(e, frame)) await s.send(c.method, c.params).catch(() => undefined);
          }
        })),
    };
    void s.exited.then(() => ticket.wake({ action: 'failed', error: 'the browser closed' }));
    try {
      await start();
      await this.location(s, ticket);
      return await ticket.wait(ms, signal, gone);
    } finally {
      ticket.screen = undefined;
      over = true;
      s.onPopup = undefined;
      s.onRefused = undefined;
      for (const [event, on] of handlers) s.cdp.off(event, on);
      // What the user did last reaches the page, unless it takes long (a browser that stopped answering).
      await Promise.race([inputs.catch(() => undefined), new Promise((r) => setTimeout(r, 5000).unref())]);
      await s.send('Page.stopScreencast').catch(() => undefined);
      if (size) await s.send('Emulation.clearDeviceMetricsOverride').catch(() => undefined);
    }
  }

  /** Tells the screencast's watchers where the page is, and whether it can go back or forward (when that changed). */
  private async location(s: BrowserSession, ticket: HandoverTicket): Promise<void> {
    const h = await s.send<{ currentIndex: number; entries: { url: string }[] }>('Page.getNavigationHistory').catch(() => undefined);
    const here = h?.entries[h.currentIndex];
    if (!h || !here) return;
    const at = { url: here.url, back: h.currentIndex > 0, forward: h.currentIndex < h.entries.length - 1 };
    const last = ticket.location;
    if (last && last.url === at.url && last.back === at.back && last.forward === at.forward) return;
    ticket.emit({ type: 'location', ...at });
  }

  /**
   * The hand-over in a window: the headless browser closes and the same profile opens in a window on the
   * computer Harness Relay runs on, with the same proxy, gate and rules (`launchArgs()` without
   * `--headless=new`), its cookies and the hosts it opened carried over (`carried`), at the page it was
   * on. Until the user hands it back, closes the window, cancels, the time runs out (`ms`) or the turn
   * ends; a page of the browser's own (its settings, flags, history) or the computer's files is not kept
   * open in the tab (it goes back to the page before), and a tab the user opens is closed (`adopt()`).
   * Then the window closes, and the browser opens again without one at the page the window was on, with
   * what the user signed in to; once the turn has ended, at the next call instead.
   */
  private async inWindow(
    s: BrowserSession,
    ticket: HandoverTicket,
    ctx: GatewayContext,
    ms: number,
    gone?: () => boolean,
  ): Promise<{ end: HandoverWake; page: 'kept' | 'reopened' | 'closed'; session: BrowserSession | undefined }> {
    const convId = ctx.convId;
    const callGranted = new Map(s.callGranted);
    let lastWeb = webUrl(await pageUrl(s));
    let cookies = await cookiesOf(s);
    this.carried.set(convId, { granted: new Map(s.granted), cookies, url: lastWeb });
    await this.shut(convId);
    let w: BrowserSession;
    try {
      w = await this.session(convId, { window: true });
    } catch (err) {
      return { end: { action: 'failed', error: (err as Error).message }, page: 'closed', session: undefined };
    }
    w.current = ctx;
    for (const [k, g] of callGranted) w.callGranted.set(k, g);
    w.hold();
    // A window that is gone within seconds never reached the user (no display it could open on, say): not handed back.
    const openedAt = Date.now();
    const closed = (): HandoverWake =>
      Date.now() - openedAt < WINDOW_QUICK_EXIT_MS
        ? { action: 'failed', error: 'the window closed as soon as it opened' }
        : { action: 'closed' };
    const handlers: [string, (p: Record<string, unknown>, sid?: string) => void][] = [
      [
        // The tab closed: the user closed the window (or the browser).
        'Target.detachedFromTarget',
        (p) => p.sessionId === w.sessionId && ticket.wake(closed()),
      ],
      [
        'Page.frameNavigated',
        (p, sid) => {
          const f = p.frame as { parentId?: string; url?: string; urlFragment?: string; unreachableUrl?: string } | undefined;
          if (sid !== w.sessionId || !f || f.parentId) return;
          const u = `${f.url ?? ''}${f.urlFragment ?? ''}`;
          if (/^https?:/i.test(u)) return void (lastWeb = u);
          if (u === 'about:blank') return;
          // The error page of a web page refused or not reached stays; one of a file the gate refused goes back too.
          if (/^chrome-error:/i.test(u) && (!f.unreachableUrl || /^https?:/i.test(f.unreachableUrl))) return;
          void w.send('Page.navigate', { url: lastWeb ?? 'about:blank' }).catch(() => undefined);
        },
      ],
      [
        'Page.loadEventFired',
        (_p, sid) => {
          if (sid === w.sessionId) void cookiesOf(w).then((c) => (cookies = c ?? cookies));
        },
      ],
    ];
    for (const [event, on] of handlers) w.cdp.on(event, on);
    void w.exited.then(() => ticket.wake(closed()));
    // What the user signs in to, now and then: the window may close before it is asked once more.
    const keep = setInterval(() => void cookiesOf(w).then((c) => (cookies = c ?? cookies)), 5000);
    keep.unref();
    let end: HandoverWake;
    try {
      if (lastWeb) void w.send('Page.navigate', { url: lastWeb }, CONFIG.turnTimeoutMs).catch(() => undefined);
      await w.send('Page.bringToFront').catch(() => undefined);
      end = await ticket.wait(ms, ctx.signal, gone);
    } finally {
      clearInterval(keep);
      for (const [event, on] of handlers) w.cdp.off(event, on);
    }
    cookies = (await cookiesOf(w)) ?? cookies;
    // Once the turn is over (or its caller gone), the next call opens it again, at the page the window was
    // on (`resume`); until then, the call does.
    const later = end.action === 'turn' || end.action === 'gone';
    this.carried.set(convId, { granted: new Map(w.granted), cookies, ...(later && lastWeb ? { url: lastWeb } : {}) });
    w.current = undefined;
    w.release();
    await this.shut(convId);
    if (later) return { end, page: 'closed', session: undefined };
    let h: BrowserSession;
    try {
      h = await this.session(convId);
    } catch {
      return { end, page: 'closed', session: undefined };
    }
    h.current = ctx;
    for (const [k, g] of callGranted) h.callGranted.set(k, g);
    h.hold();
    if (!lastWeb) return { end, page: 'closed', session: h };
    try {
      await this.goTo(h, ctx, lastWeb);
      return { end, page: 'reopened', session: h };
    } catch {
      return { end, page: 'closed', session: h };
    }
  }

  /**
   * Opens a browser for the user alone (B2, for a page that shows a secret): a Chromium of Harness Relay's
   * own with a throwaway profile (`browser/user/<id>`, never a conversation's), shown as a screencast
   * through the hand-over's panel and routes. No agent drives or reads it: no gateway call reaches it, as
   * it is in none of the conversations' sessions, and what it opens is never granted to a chat's browser.
   * Every connection goes through the proxy and its checks; nobody is asked about a host
   * (`ownerVerdict()`). At `url` when given (the card's address, which the user chose to open). It closes,
   * and its profile goes, when the user closes it, after `HANDOVER_LIMITS.useMinutes`, when the
   * conversation is deleted, or at shutdown (a stopped server's are removed at the next start); then
   * `onEnd`. Returns its id.
   */
  async openForUser(convId: string, o: { url?: string; nearbyConfirmed?: boolean; onEnd?: () => void } = {}): Promise<string> {
    const missing = this.unavailable();
    if (missing) throw new UserBrowserError('unavailable', missing);
    const max = this.o.userBrowsersMax ?? USER_BROWSERS_MAX;
    // Its place taken before anything waits, so that two opened at once cannot both pass the limit.
    if (this.forUser.size + this.opening >= max) throw new UserBrowserError('busy', `at most ${max} at once`);
    this.opening++;
    let ticket: HandoverTicket | undefined;
    let s: BrowserSession;
    let profile: string;
    try {
      const typed = o.url ? await this.userAddress(o.url, o.nearbyConfirmed) : undefined;
      ticket = this.handovers.create(convId, ['screencast']);
      ticket.mode = 'screencast';
      ticket.status = 'active';
      profile = join(this.userProfiles(), ticket.id);
      s = await this.launch(`user:${ticket.id}`, { profile, owner: 'user' }, () => false);
      if (typed && o.url) s.typed = typedAt(typed, o.url);
    } catch (err) {
      this.opening--;
      if (ticket) {
        this.handovers.remove(ticket);
        removeTree(join(this.userProfiles(), ticket.id));
      }
      throw err;
    }
    // No idle time: it closes when the user closes it, or at its time limit.
    s.hold();
    const t = ticket;
    const ended = (async () => {
      try {
        if (o.url) void s.send('Page.navigate', { url: o.url }, CONFIG.turnTimeoutMs).catch(() => undefined);
        // No turn to end it: the user, its time limit, the conversation's deletion (`endAll()`) or shutdown.
        await this.screencast(s, t, new AbortController().signal, this.handoverMs.use);
      } catch {
        /* it ends all the same */
      } finally {
        this.forUser.delete(t.id);
        this.handovers.remove(t);
        s.release();
        s.stop();
        await Promise.race([s.exited, new Promise((r) => setTimeout(r, 10_000).unref())]);
        removeTree(profile);
        o.onEnd?.();
      }
    })();
    this.forUser.set(t.id, { convId, s, ticket: t, ended });
    this.opening--;
    return t.id;
  }

  /**
   * An address a browser for the user alone is opened at (a secrets card's): never one no browser of
   * Harness Relay's opens; one that leads to this computer or the local network only once the user
   * confirmed it, having seen it whole (`UserBrowserError('nearby')` until then), and then as if typed
   * (`typed`, which `ownerVerdict()` takes). Returns that page, or undefined for one on the internet.
   */
  private async userAddress(url: string, confirmed?: boolean): Promise<OwnerPage | undefined> {
    await this.refuseBlocked(url).catch((err: Error) => {
      throw new UserBrowserError('refused', err.message);
    });
    const page = await this.ownerPage(url);
    if (!page?.nearby) return undefined;
    if (!confirmed) throw new UserBrowserError('nearby', url);
    return page;
  }

  /**
   * Before a browser for the user alone opens an https page here as typed, whose connection the proxy lets
   * through once by its origin alone (`pass`): the tab shows the blank page first, so that no page still
   * shown can take that connection with a wss:// socket of its own (TLS, which the proxy does not read).
   * An http one's connection is told by its own address, and a ws:// socket by its handshake's origin.
   */
  private async leaveFor(s: BrowserSession, page: OwnerPage, url: string): Promise<void> {
    if (!page.nearby || !/^https:/i.test(url) || (await pageUrl(s)) === 'about:blank') return;
    const blank = s.cdp.waitFor('Page.frameNavigated', 5000, s.sessionId, (p) => {
      const frame = p.frame as { parentId?: string; url?: string } | undefined;
      return !frame?.parentId && frame?.url === 'about:blank';
    });
    await s.send('Page.navigate', { url: 'about:blank' }).catch(() => undefined);
    await blank;
  }

  /** `url`'s page as the user opens it now (`OwnerPage`): where it leads, by the addresses its name has. */
  private async ownerPage(url: string): Promise<OwnerPage | undefined> {
    const key = approvalKeys('fetch', url)[0];
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      return undefined;
    }
    if (!key || !/^https?:/i.test(url)) return undefined;
    const addresses = await this.addresses(url);
    return { key, nearby: leadsNearby(host, addresses, this.o.own?.() ?? []), addresses };
  }

  /** Whether `url` leads to this computer or the local network (its host, or the addresses its name has). */
  async leadsHere(url: string): Promise<boolean> {
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      return false;
    }
    return leadsNearby(host, await this.addresses(url), this.o.own?.() ?? []);
  }

  async navigateForUser(convId: string, id: string, url: string, o: { nearbyConfirmed?: boolean } = {}): Promise<void> {
    const u = this.forUser.get(id);
    if (!u || u.convId !== convId) throw new UserBrowserError('gone', 'it closed');
    const typed = await this.userAddress(url, o.nearbyConfirmed);
    // Another site: what the user typed before opens nothing more.
    u.s.typed = undefined;
    if (typed) await this.leaveFor(u.s, typed, url);
    u.s.typed = typed && typedAt(typed, url);
    void u.s.send('Page.navigate', { url }, CONFIG.turnTimeoutMs).catch(() => undefined);
  }

  /** Whether it is open, and not closing (just after Close, the card opens another). */
  userBrowserOpen(convId: string, id: string): boolean {
    const u = this.forUser.get(id);
    return u?.convId === convId && u.ticket.status === 'active';
  }

  /**
   * What the user selected on the page of their browser `id` (`SELECTION_SCRIPT`, in the main frame, then
   * in the frames of the same process), read over the debugging pipe in a world of our own, which the
   * page's script cannot see; '' for nothing. Kept in the server: the caller stores it and sends none of it on.
   */
  async selectionOf(convId: string, id: string): Promise<string> {
    const u = this.forUser.get(id);
    if (!u || u.convId !== convId) throw new UserBrowserError('gone', 'it closed');
    const tree = await u.s.send<{ frameTree: FrameTree }>('Page.getFrameTree').catch(() => undefined);
    const frames: string[] = [];
    const walk = (t: FrameTree | undefined) => {
      if (!t) return;
      frames.push(t.frame.id);
      for (const c of t.childFrames ?? []) walk(c);
    };
    walk(tree?.frameTree);
    for (const frameId of frames.length ? frames : [u.s.mainFrame]) {
      const world = await u.s
        .send<{ executionContextId: number }>('Page.createIsolatedWorld', { frameId, worldName: 'harness-relay-selection' })
        .catch(() => undefined);
      if (!world) continue;
      const text = await u.s.evaluateIn<unknown>(world.executionContextId, SELECTION_SCRIPT).catch(() => '');
      if (typeof text === 'string' && text.trim()) return text;
    }
    return '';
  }

  async closeForUser(convId: string, id: string): Promise<void> {
    const u = this.forUser.get(id);
    if (!u || u.convId !== convId) return;
    if (u.ticket.status === 'active') u.ticket.status = 'ending';
    u.ticket.wake({ action: 'done' });
    await u.ended;
  }

  /** Closes the conversation's browser as Chromium closes itself (its cookies and preferences written), then waits for it to end. */
  private async shut(convId: string): Promise<void> {
    const s = await this.sessions.get(convId)?.catch(() => undefined);
    if (s && !s.stopped) {
      // It ends before it would answer: its end is what to wait for.
      void s.cdp.send('Browser.close', {}, undefined, 5000).catch(() => undefined);
      await Promise.race([s.exited, new Promise((r) => setTimeout(r, 5000).unref())]);
    }
    await this.close(convId);
  }

  /** Close the conversation's browser (it went idle, or the conversation is deleted: then its profile goes too). */
  async close(convId: string, removeProfile = false): Promise<void> {
    if (removeProfile) {
      this.handovers.endAll(convId);
      this.carried.delete(convId);
    }
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
    for (const u of this.forUser.values()) u.ticket.wake({ action: 'turn' });
    this.proxy.stop();
  }
}
