import { WATCH_LIMITS, type ScheduleTrigger } from '../shared/types';
import type { ConnectorStore } from './connectors/accounts';
import { IdleRefusedError, ImapClient, ImapLoginError, quote, type ImapResponse } from './connectors/imap';
import { HttpError } from './errors';

/*
 * IMAP IDLE (RFC 2177) for the automations that start when a new mail arrives: one connection for
 * each mail account and folder that automations which are on wait for, waiting there, so that the
 * mail server says at once when mail arrives and each of those automations is checked then
 * (`Scheduler.check()`), within seconds instead of minutes. The checks every few minutes stay, slower
 * while it listens, and do all the work: IDLE only says when to check.
 *
 * A server that does not take IDLE (it does not list it, or refuses it) is left to the checks. A
 * connection that drops is opened again, more slowly after each failure in a row (a refused sign-in as
 * slowly as the checks back off, so that a wrong password is not tried every few minutes); the count
 * starts again only after a whole healthy round. TCP keepalive, IDLE renewed every few minutes (whose
 * DONE must be answered) and a restart of every connection after the computer slept find a connection
 * that died without a word. The passwords stay in the server, read when it connects.
 */

type MailTrigger = Extract<ScheduleTrigger, { source: 'mail' }>;

export interface IdleDeps {
  connectors: ConnectorStore;
  /** The automations that are on and wait for new mail (`Store.mailWatches()`). */
  watching(): { conversationId: string; trigger: MailTrigger }[];
  /** Check this automation now: the server said mail arrived (once more after a check under way). */
  check(conversationId: string): Promise<void>;
  /** IDLE is ended and started again after this long: a dead connection is found then at the latest. */
  renewMs?: number;
  /** The waits before opening a dropped connection again, one more step for each failure in a row. */
  backoffMs?: number[];
  /** The same after the server refused the user name and password. */
  loginBackoffMs?: number[];
  /** How long after the server says mail arrived the checks come: more that arrives with it joins them. */
  settleMs?: number;
  /** How long to wait for the server's answers. */
  timeoutMs?: number;
  /** The clock: a jump much longer than the sync interval means the computer slept. */
  now?: () => number;
}

/** How often the connections are matched against the automations that are on (`sync()`). */
export const IDLE_SYNC_MS = 15_000;
/** A sync that comes this much later than it should means the computer slept: every connection is opened again. */
const WOKE_AFTER_MS = 4 * IDLE_SYNC_MS;

type Resolved = Required<Omit<IdleDeps, 'watching' | 'check'>> & Pick<IdleDeps, 'check'>;

/** One mail account's folder, waiting in IDLE, for the automations that wait for new mail there. */
class Listener {
  /** The automations it checks when mail arrives. */
  readonly subscribers = new Set<string>();
  /** The server accepted IDLE and waits in it now. */
  live = false;
  /** The server does not take IDLE: nothing more is tried until its account changes. */
  unsupported = false;
  private stopped = false;
  private abort = new AbortController();
  private client?: ImapClient;
  private timers = new Set<() => void>();
  private checking = false;
  private again = false;
  private settle?: NodeJS.Timeout;
  readonly done: Promise<void>;

  constructor(
    readonly key: string,
    private account: string,
    private folder: string,
    private deps: Resolved,
  ) {
    this.done = this.run();
  }

  stop(): void {
    this.stopped = true;
    this.live = false;
    if (this.settle) clearTimeout(this.settle);
    this.abort.abort();
    this.client?.close();
    for (const cancel of [...this.timers]) cancel();
  }

  /** Resolves after `ms`, or at once when stopped; `cancel` clears it. */
  private wait(ms: number): { done: Promise<void>; cancel: () => void } {
    let cancel!: () => void;
    const done = new Promise<void>((r) => {
      const timer = setTimeout(() => cancel(), ms);
      timer.unref?.();
      cancel = () => {
        clearTimeout(timer);
        this.timers.delete(cancel);
        r();
      };
    });
    this.timers.add(cancel);
    if (this.stopped) cancel();
    return { done, cancel };
  }

  /** The server said mail arrived: check soon, and once more after checks under way. */
  private arrived(): void {
    if (this.settle || this.stopped) return;
    this.settle = setTimeout(() => {
      this.settle = undefined;
      void this.checkAll();
    }, this.deps.settleMs);
    this.settle.unref?.();
  }

  /** Each automation on this folder, one after another (one connection to the server at a time). */
  private async checkAll(): Promise<void> {
    if (this.checking) {
      this.again = true;
      return;
    }
    this.checking = true;
    try {
      for (const id of [...this.subscribers]) {
        if (this.stopped) return;
        try {
          await this.deps.check(id);
        } catch (err) {
          // A conversation deleted meanwhile: the next sync lets it go.
          if (!(err instanceof HttpError && err.status === 404)) console.error('[idle] could not check an automation:', err);
        }
      }
    } finally {
      this.checking = false;
    }
    if (this.again && !this.stopped) {
      this.again = false;
      void this.checkAll();
    }
  }

  private async run(): Promise<void> {
    let failures = 0;
    let refused = 0;
    while (!this.stopped) {
      try {
        const found = this.deps.connectors.mailById(this.account);
        if (!found?.password) throw new Error('no such mail account, or no password');
        const { account, password } = found;
        const c = await ImapClient.open(account.imap, { username: account.username, password }, this.deps.timeoutMs, this.abort.signal);
        this.client = c;
        if (this.stopped) return c.close();
        if (!c.capabilities.has('IDLE')) {
          this.unsupported = true;
          await c.logout();
          return;
        }
        c.keepAlive(60_000);
        await c.command(`EXAMINE ${quote(this.folder)}`);
        const onResponse = (r: ImapResponse) => {
          if (/^\* \d+ EXISTS\b/i.test(r.text)) this.arrived();
        };
        while (!this.stopped) {
          const renew = this.wait(this.deps.renewMs);
          try {
            await c.idle(onResponse, renew.done, () => (this.live = true));
          } finally {
            renew.cancel();
          }
          // A whole round went well: the next failure starts the waits again.
          failures = 0;
          refused = 0;
        }
        await c.logout();
      } catch (err) {
        this.live = false;
        this.client?.close();
        if (this.stopped) return;
        if (err instanceof IdleRefusedError) {
          this.unsupported = true;
          return;
        }
        const login = err instanceof ImapLoginError;
        const steps = login ? this.deps.loginBackoffMs : this.deps.backoffMs;
        const n = login ? refused++ : failures++;
        if (n === 0) console.warn(`[idle] listening for new mail stopped (${(err as Error).message}); trying again later`);
        await this.wait(steps[Math.min(n, steps.length - 1)]!).done;
      }
    }
  }
}

/** The IDLE connections of the automations that wait for new mail: one for each mail account and folder. */
export class IdleWatcher {
  private listeners = new Map<string, Listener>();
  private timer?: NodeJS.Timeout;
  private lastSync?: number;
  private deps: Resolved & Pick<IdleDeps, 'watching'>;

  constructor(deps: IdleDeps) {
    this.deps = {
      renewMs: 9 * 60_000,
      backoffMs: [5_000, 30_000, 120_000, 300_000, 600_000],
      loginBackoffMs: WATCH_LIMITS.backoffMinutes.map((m) => m * 60_000),
      settleMs: 1_500,
      timeoutMs: 30_000,
      now: Date.now,
      ...deps,
    };
  }

  /** Match the connections against the automations now and every `IDLE_SYNC_MS`. */
  start(): void {
    this.sync();
    this.timer = setInterval(() => this.sync(), IDLE_SYNC_MS);
    this.timer.unref?.();
  }

  /**
   * One connection for each mail account and folder that automations which are on wait for, checking
   * each of them when mail arrives. One that nothing waits for any more is closed; one whose account
   * changed in Settings (its server, user name, or saved again: a new password) is opened again; after
   * the computer slept (this sync came much later than it should), every one is opened again.
   */
  sync(): void {
    const now = this.deps.now();
    const woke = this.lastSync !== undefined && now - this.lastSync > WOKE_AFTER_MS;
    this.lastSync = now;
    const wanted = new Map<string, { account: string; folder: string; ids: string[] }>();
    for (const w of this.deps.watching()) {
      // The account without its password: nothing is asked of the credential store at every sync.
      const account = this.deps.connectors.mailAccount(w.trigger.account);
      if (!account) continue;
      const key = JSON.stringify([
        w.trigger.account,
        w.trigger.folder,
        account.imap,
        account.username,
        this.deps.connectors.mailSaves(w.trigger.account),
      ]);
      const entry = wanted.get(key) ?? { account: w.trigger.account, folder: w.trigger.folder, ids: [] };
      entry.ids.push(w.conversationId);
      wanted.set(key, entry);
    }
    for (const [key, l] of this.listeners) {
      if (woke || !wanted.has(key)) {
        l.stop();
        this.listeners.delete(key);
      }
    }
    for (const [key, w] of wanted) {
      let l = this.listeners.get(key);
      if (!l) {
        l = new Listener(key, w.account, w.folder, this.deps);
        this.listeners.set(key, l);
      }
      l.subscribers.clear();
      for (const id of w.ids) l.subscribers.add(id);
    }
  }

  private listenerOf(conversationId: string): Listener | undefined {
    for (const l of this.listeners.values()) if (l.subscribers.has(conversationId)) return l;
    return undefined;
  }

  /** Whether the server waits in IDLE for this automation's folder now: its checks can come more slowly. */
  live(conversationId: string): boolean {
    return this.listenerOf(conversationId)?.live ?? false;
  }

  /** Whether the automation's server does not take IDLE. */
  unsupported(conversationId: string): boolean {
    return this.listenerOf(conversationId)?.unsupported ?? false;
  }

  /** How many connections are kept (one for each account and folder). */
  get connections(): number {
    return this.listeners.size;
  }

  /** Closes every connection. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    const all = [...this.listeners.values()];
    this.listeners.clear();
    for (const l of all) l.stop();
    await Promise.all(all.map((l) => l.done));
  }
}
