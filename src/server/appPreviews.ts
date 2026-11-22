import { randomBytes } from 'node:crypto';
import { HttpError } from './errors';
import { t } from './i18n';
import { previewFileResponse, previewSnapshot } from './previewFiles';
import { startContainerPreview, type PreviewTerminal } from './previewContainer';
import { PreviewCleanupError, startPreviewRuntime } from './previewRuntime';
import type { PreviewTarget } from './previewTarget';

type Service = Awaited<ReturnType<typeof startPreviewRuntime>> & { terminal?: PreviewTerminal };
interface Session {
  conversation: string;
  address: URL;
  parent: string;
  ticket: string;
  /** Single-use addresses that open its page in a tab of its own, each until its time (see `tab`). */
  tabTickets: Map<string, number>;
  cookie: string;
  cookieMessage: string;
  failedMessage: string;
  controller: AbortController;
  expires: number;
  idle: number;
  pending: Promise<void>;
  service?: Service;
  retryCleanup?: () => Promise<void>;
  closing?: Promise<void>;
  requests: number;
  live?: () => boolean;
  /** The signed-in browser that started it: only that one reads and types into its terminal. */
  browser?: string;
}

/** The member's folder inside its workspace root, both relative to the same working directory. */
function workspaceIn(root: string, folder: string): string {
  const prefix = root ? root + '/' : '';
  if (!folder.startsWith(prefix) || folder.length === prefix.length) throw new HttpError(400, t().previewTarget);
  return folder.slice(prefix.length);
}

const COOKIE = '__Host-relay-preview';
const OPEN = '/.relay-preview/open/';
const IDLE = 30 * 60_000;
const MAX_AGE = 2 * 60 * 60_000;
/** How long the address for a new tab can be opened, and how many may wait at once. */
const TAB_TICKET = 60_000;
const TAB_TICKETS = 8;

function headersFor(parent: string) {
  return new Headers({
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), display-capture=(), usb=(), payment=()',
    'content-security-policy':
      "sandbox allow-scripts allow-forms allow-same-origin; default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'self'; worker-src 'none'; frame-ancestors " +
      parent,
  });
}

function bridge(parent: string): string {
  return (
    '<script>(()=>{const relay=' +
    JSON.stringify(parent) +
    ';addEventListener("message",e=>{if(e.source===parent&&e.origin===relay&&e.data==="relay-preview-reload")location.reload()});let count=0;const report=value=>{if(parent!==window&&count++<50)parent.postMessage({type:"relay-preview-error",message:String(value).slice(0,2048)},' +
    JSON.stringify(parent) +
    ')};addEventListener("error",e=>report(e.message||"Resource failed to load"),true);addEventListener("unhandledrejection",e=>report(e.reason));const original=console.error;console.error=(...args)=>{original.apply(console,args);report(args.join(" "))}})()</script>'
  );
}

function errorPage(session: Session, status = 403, message = session.cookieMessage): Response {
  const headers = headersFor(session.parent);
  headers.set('content-type', 'text/html; charset=utf-8');
  return new Response(
    '<!doctype html><meta charset="utf-8"><p>' +
      message +
      '</p><script>if(parent!==window)parent.postMessage({type:"relay-preview-error",message:' +
      JSON.stringify(message) +
      '},' +
      JSON.stringify(session.parent) +
      ')</script>',
    { status, headers },
  );
}

export class AppPreviews {
  private sessions = new Map<string, Session>();
  private timer?: NodeJS.Timeout;
  private closed = false;

  constructor(
    private owner: string,
    private runtime = startPreviewRuntime,
    private now = Date.now,
    private container: (options: Parameters<typeof startContainerPreview>[0]) => Service = startContainerPreview,
  ) {}

  async start(
    conversation: string,
    target: PreviewTarget,
    address: URL,
    parent: string,
    signal: AbortSignal,
    live?: () => boolean,
    exists?: () => boolean,
    browser?: string,
  ) {
    signal.throwIfAborted();
    const previous = [...this.sessions.values()].find((s) => s.conversation === conversation);
    if (previous) {
      // One the user just stopped may still be removing its containers: the new one waits for that.
      if (previous.closing) await previous.closing.catch(() => {});
      else if (!previous.service && !previous.retryCleanup) throw new HttpError(409, t().previewBusy);
      else await this.stop(conversation);
      if ([...this.sessions.values()].some((s) => s.conversation === conversation)) throw new HttpError(409, t().previewBusy);
    }
    signal.throwIfAborted();
    if (exists && !exists()) throw new HttpError(404, t().conversationNotFound);
    if (this.closed || this.sessions.size >= 4) throw new HttpError(429, t().previewBusy);
    const id = randomBytes(16).toString('hex');
    const session: Session = {
      conversation,
      address,
      parent,
      live,
      browser,
      ticket: randomBytes(32).toString('hex'),
      tabTickets: new Map(),
      cookie: randomBytes(32).toString('hex'),
      cookieMessage: t().previewCookie,
      failedMessage: t().previewServiceFailed,
      controller: new AbortController(),
      expires: this.now() + MAX_AGE,
      idle: this.now() + IDLE,
      pending: Promise.resolve(),
      requests: 0,
    };
    this.sessions.set(id, session);
    if (!this.timer) this.timer = setInterval(() => this.expire(), 60_000).unref();
    const cancel = () => session.controller.abort();
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    session.pending = (async () => {
      const lifetime = session.controller.signal;
      // A workspace member installs and runs from its workspace root's copy, lockfile included.
      const files = await previewSnapshot(target.root, target.npmRoot ?? target.folder, target.mode, lifetime, target.isPrivate);
      lifetime.throwIfAborted();
      if (target.mode === 'static') {
        if (!files.has(target.entry)) throw new HttpError(404, t().previewTarget);
        session.service = { request: async (req) => previewFileResponse(files, req, target.entry), stop: async () => {} };
      } else if (target.mode === 'container') {
        // It answers at once: the build and its services report through the terminal.
        session.service = this.container({
          files,
          executables: files.executables,
          recipe: target.entry,
          signal: lifetime,
          owner: this.owner,
        });
      } else {
        try {
          session.service = await this.runtime({
            files,
            executables: files.executables,
            mode: target.mode,
            ...(target.npmRoot !== undefined && { workspace: workspaceIn(target.npmRoot, target.folder) }),
            signal: lifetime,
            owner: this.owner,
          });
        } catch (error) {
          if (error instanceof PreviewCleanupError) session.retryCleanup = error.stop;
          throw error;
        }
      }
      lifetime.throwIfAborted();
    })();
    try {
      await session.pending;
      if (exists && !exists()) throw new HttpError(404, t().conversationNotFound);
      return {
        id,
        url: new URL(OPEN + session.ticket, address).href,
        origin: address.origin,
        ...(session.service?.terminal ? { terminal: true } : {}),
      };
    } catch (err) {
      await this.stop(conversation, id);
      if (signal.aborted || (err instanceof Error && err.name === 'AbortError')) throw new HttpError(409, t().stopped);
      if (err instanceof HttpError) throw err;
      throw new HttpError(503, (err instanceof Error && err.message.slice(0, 4096)) || t().previewFailed);
    } finally {
      signal.removeEventListener('abort', cancel);
    }
  }

  async stop(conversation: string, id?: string) {
    const found = [...this.sessions].filter(([key, s]) => s.conversation === conversation && (!id || key === id));
    await Promise.all(
      found.map(([key, s]) => {
        if (!s.closing) {
          s.controller.abort();
          s.closing = s.pending
            .catch(() => {})
            .then(() => (s.service ? s.service.stop() : s.retryCleanup?.()))
            .then(() => {
              this.sessions.delete(key);
              if (!this.sessions.size) {
                clearInterval(this.timer);
                this.timer = undefined;
              }
            })
            .finally(() => {
              s.closing = undefined;
            });
        }
        return s.closing;
      }),
    );
  }

  /**
   * A container preview's terminal, for the browser that started it. Using it keeps the preview
   * from expiring as idle, as loading its page does.
   */
  terminal(conversation: string, id: string, browser?: string): PreviewTerminal {
    const s = this.sessions.get(id);
    if (!s || s.conversation !== conversation || s.controller.signal.aborted || s.closing || !s.service?.terminal)
      throw new HttpError(404, t().previewTarget);
    if (s.browser !== browser) throw new HttpError(403, t().previewOrigin);
    s.idle = this.now() + IDLE;
    return s.service.terminal;
  }

  /**
   * A single-use address for the browser that started it to open its page in a tab of its own, good
   * for a minute: the frame's ticket is spent, and a tab gets no cookie the frame was given.
   */
  tab(conversation: string, id: string, browser?: string): string {
    const s = this.sessions.get(id);
    if (!s || s.conversation !== conversation || s.controller.signal.aborted || s.closing || !s.service)
      throw new HttpError(404, t().previewTarget);
    if (s.browser !== browser) throw new HttpError(403, t().previewOrigin);
    const now = this.now();
    for (const [token, until] of s.tabTickets) if (until <= now) s.tabTickets.delete(token);
    if (s.tabTickets.size >= TAB_TICKETS) throw new HttpError(429, t().previewBusy);
    const token = randomBytes(32).toString('hex');
    s.tabTickets.set(token, now + TAB_TICKET);
    s.idle = now + IDLE;
    return new URL(OPEN + token, s.address).href;
  }

  private expire() {
    for (const [id, s] of this.sessions)
      if (s.controller.signal.aborted || Math.min(s.idle, s.expires) <= this.now() || s.live?.() === false)
        void this.stop(s.conversation, id).catch((err) => console.error('[preview] cleanup:', err));
  }

  async close() {
    this.closed = true;
    const stopped = await Promise.allSettled([...this.sessions].map(([id, s]) => this.stop(s.conversation, id)));
    for (const result of stopped)
      if (result.status === 'rejected') console.error('[preview] retry cleanup at next startup:', result.reason);
  }

  /** Only the dedicated preview hostname ever enters this handler, before Relay's API or web routes. */
  async fetch(request: Request, host: string, loopbackPeer = false): Promise<Response> {
    const s = [...this.sessions.values()].find((session) => session.address.host === host);
    if (
      !s ||
      host !== s.address.host ||
      !s.service ||
      s.controller.signal.aborted ||
      s.live?.() === false ||
      Math.min(s.idle, s.expires) <= this.now()
    )
      return new Response(null, { status: 404 });
    const url = new URL(request.url);
    if (url.pathname.startsWith(OPEN)) {
      const token = url.pathname.slice(OPEN.length);
      const frame = Boolean(s.ticket) && token === s.ticket;
      const tab = (s.tabTickets.get(token) ?? 0) > this.now();
      if (request.method !== 'GET' || (!frame && !tab)) return new Response(null, { status: 403 });
      if (frame) s.ticket = '';
      else s.tabTickets.delete(token);
      const headers = headersFor(s.parent);
      headers.set('set-cookie', COOKIE + '=' + s.cookie + '; Path=/; HttpOnly; Secure; SameSite=None; Partitioned');
      headers.set('content-type', 'text/html; charset=utf-8');
      return new Response('<!doctype html><meta charset="utf-8"><script>location.replace("/")</script>', { headers });
    }
    const site = request.headers.get('sec-fetch-site');
    const cookie = request.headers
      .get('cookie')
      ?.split(/;\s*/)
      .includes(COOKIE + '=' + s.cookie);
    // A navigation the user made in this browser, which no other site can make: Firefox reloading the
    // frame, or a reload or the address bar in the page's own tab (see `tab`).
    const userNavigation =
      cookie &&
      site === 'none' &&
      request.method === 'GET' &&
      request.headers.get('sec-fetch-mode') === 'navigate' &&
      ['iframe', 'document'].includes(request.headers.get('sec-fetch-dest') ?? '');
    if (site && site !== 'same-origin' && !userNavigation) return errorPage(s);
    // WebKit omits Secure cookies on plain HTTP *.localhost. The signed-in browser redeems its
    // ticket before it can use the unguessable hostname for same-origin requests over loopback.
    // Remote delivery requires the cookie. Both credentials terminate here.
    const local = loopbackPeer && !s.ticket && site === 'same-origin' && s.address.hostname.endsWith('.localhost');
    if (!cookie && !local) return errorPage(s);
    const origin = request.headers.get('origin');
    if ((origin && origin !== s.address.origin) || (!['GET', 'HEAD'].includes(request.method) && origin !== s.address.origin))
      return new Response(null, { status: 403 });
    if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return new Response(null, { status: 405 });
    if (s.requests >= 12) return new Response(null, { status: 429 });
    s.idle = this.now() + IDLE;
    s.requests++;
    try {
      // The app sees a fixed internal origin, its own URL and ordinary content headers only.
      const headers = new Headers();
      for (const name of ['accept', 'accept-language', 'content-type', 'range', 'if-none-match']) {
        const value = request.headers.get(name);
        if (value) headers.set(name, value);
      }
      const upstream = new URL('http://preview.invalid');
      upstream.pathname = url.pathname;
      upstream.search = url.search;
      const init: RequestInit & { duplex?: 'half' } = {
        method: request.method,
        headers,
        signal: AbortSignal.any([request.signal, s.controller.signal]),
      };
      if (request.body) {
        init.body = request.body;
        init.duplex = 'half';
      }
      const res = await s.service.request(new Request(upstream, init));
      const safe = headersFor(s.parent);
      for (const name of ['content-type', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
        const value = res.headers.get(name);
        if (value) safe.set(name, value);
      }
      const redirect = res.headers.get('location');
      if (redirect && res.status >= 300 && res.status < 400) {
        const next = new URL(redirect, upstream);
        // Build a full same-preview URL, including for paths that start with a double slash.
        if (next.origin !== upstream.origin) return new Response(null, { status: 403, headers: safe });
        next.protocol = s.address.protocol;
        next.host = s.address.host;
        safe.set('location', next.href);
      }
      let body: BodyInit | null = res.body;
      if (request.method === 'HEAD' || [204, 205, 304].includes(res.status)) body = null;
      else if (safe.get('content-type')?.split(';')[0]?.trim().toLowerCase() === 'text/html') {
        const html = await res.text();
        safe.set('content-type', 'text/html; charset=utf-8');
        const doctype = html.match(/^\s*<!doctype\s+html\s*>/i)?.[0] ?? '';
        body = doctype + bridge(s.parent) + html.slice(doctype.length);
      }
      return new Response(body, { status: res.status, headers: safe });
    } catch {
      return request.headers.get('accept')?.includes('text/html')
        ? errorPage(s, 502, s.failedMessage)
        : new Response(null, { status: 502, headers: headersFor(s.parent) });
    } finally {
      s.requests--;
    }
  }
}
