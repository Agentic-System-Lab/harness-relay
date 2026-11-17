import type { ScheduleTrigger } from '../shared/types';
import type { ConnectorStore } from './connectors/accounts';
import { ImapClient, quote, type ImapResponse } from './connectors/imap';
import { triggerKey } from './watch';

/*
 * IMAP IDLE (RFC 2177) for the automations that start when a new mail arrives: one connection for
 * each that is on, waiting in its folder, so that the mail server says at once when mail arrives and
 * the automation is checked then (`Scheduler.check()`), within seconds instead of minutes. The checks
 * every few minutes stay, slower while it listens, and do all the work: IDLE only says when to check.
 * A server that does not take IDLE is left to them. A connection that drops (a lost network, a
 * computer that slept) is opened again, more slowly after each failure in a row; it is renewed before
 * the server's own time limit (about 29 minutes). The passwords stay in the server, as for the checks.
 */

type MailTrigger = Extract<ScheduleTrigger, { source: 'mail' }>;

export interface IdleDeps {
  connectors: ConnectorStore;
  /** The automations that are on and wait for new mail (`Store.mailWatches()`). */
  watching(): { conversationId: string; trigger: MailTrigger }[];
  /** Check this automation now: the server said mail arrived. */
  check(conversationId: string): Promise<void>;
  /** IDLE is ended and started again after this long, before the server would end it. */
  renewMs?: number;
  /** The waits before opening a dropped connection again, one more step for each failure in a row. */
  backoffMs?: number[];
  /** How long after the server says mail arrived the check comes: more that arrives with it joins it. */
  settleMs?: number;
  /** How long to wait for the server's answers. */
  timeoutMs?: number;
}

/** How often the connections are matched against the automations that are on (`sync()`). */
export const IDLE_SYNC_MS = 15_000;

/** One automation's connection, waiting in IDLE. */
class Listener {
  /** Connected and waiting in IDLE now. */
  live = false;
  /** The server says it does not take IDLE: nothing more is tried, until its account changes. */
  unsupported = false;
  private stopped = false;
  private wake?: () => void;
  private client?: ImapClient;
  private checking = false;
  private again = false;
  private settle?: NodeJS.Timeout;
  readonly done: Promise<void>;

  constructor(
    readonly conversationId: string,
    readonly key: string,
    private trigger: MailTrigger,
    private deps: Required<Omit<IdleDeps, 'watching'>>,
  ) {
    this.done = this.run();
  }

  stop(): void {
    this.stopped = true;
    this.live = false;
    if (this.settle) clearTimeout(this.settle);
    this.wake?.();
    this.client?.close();
  }

  /** Waits this long, or until stopped. */
  private sleep(ms: number): Promise<void> {
    return new Promise((r) => {
      const timer = setTimeout(r, ms);
      timer.unref?.();
      this.wake = () => (clearTimeout(timer), r());
    });
  }

  /** The server said mail arrived: check soon, and once more after a check under way. */
  private arrived(): void {
    if (this.settle || this.stopped) return;
    this.settle = setTimeout(() => {
      this.settle = undefined;
      void this.checkNow();
    }, this.deps.settleMs);
    this.settle.unref?.();
  }

  private async checkNow(): Promise<void> {
    if (this.checking) {
      this.again = true;
      return;
    }
    this.checking = true;
    try {
      await this.deps.check(this.conversationId);
    } catch (err) {
      console.error('[idle] could not check an automation:', err);
    } finally {
      this.checking = false;
    }
    if (this.again && !this.stopped) {
      this.again = false;
      void this.checkNow();
    }
  }

  private async run(): Promise<void> {
    let failures = 0;
    while (!this.stopped) {
      try {
        const found = this.deps.connectors.mailById(this.trigger.account);
        if (!found?.password) throw new Error('no such mail account, or no password');
        const { account, password } = found;
        const c = await ImapClient.open(account.imap, { username: account.username, password }, this.deps.timeoutMs);
        this.client = c;
        if (this.stopped) return c.close();
        if (!c.capabilities.has('IDLE')) {
          this.unsupported = true;
          await c.logout();
          return;
        }
        await c.command(`EXAMINE ${quote(this.trigger.folder)}`);
        failures = 0;
        this.live = true;
        const onResponse = (r: ImapResponse) => {
          if (/^\* \d+ EXISTS\b/i.test(r.text)) this.arrived();
        };
        while (!this.stopped) {
          const renew = this.sleep(this.deps.renewMs);
          await c.idle(onResponse, renew);
        }
        await c.logout();
      } catch (err) {
        this.live = false;
        this.client?.close();
        if (this.stopped) return;
        const steps = this.deps.backoffMs;
        const wait = steps[Math.min(failures, steps.length - 1)]!;
        failures++;
        if (failures === 1) console.warn(`[idle] listening for new mail stopped (${(err as Error).message}); trying again`);
        await this.sleep(wait);
      }
    }
  }
}

/** The IDLE connections of the automations that wait for new mail. */
export class IdleWatcher {
  private listeners = new Map<string, Listener>();
  private timer?: NodeJS.Timeout;
  private deps: Required<Omit<IdleDeps, 'watching'>> & Pick<IdleDeps, 'watching'>;

  constructor(deps: IdleDeps) {
    this.deps = {
      renewMs: 25 * 60_000,
      backoffMs: [5_000, 30_000, 120_000, 300_000, 600_000],
      settleMs: 1_500,
      timeoutMs: 30_000,
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
   * One connection for each automation that is on and waits for new mail: one for an automation it did
   * not have is opened, and one whose automation went, changed its folder or account, or whose account
   * changed in Settings, is closed (and opened again for what it waits for now).
   */
  sync(): void {
    const wanted = new Map<string, { trigger: MailTrigger; key: string }>();
    for (const w of this.deps.watching()) {
      const account = this.deps.connectors.mailById(w.trigger.account)?.account;
      // The account's server and user name too: changed in Settings, the connection is opened again.
      const key = JSON.stringify([triggerKey(w.trigger), account?.imap, account?.username]);
      wanted.set(w.conversationId, { trigger: w.trigger, key });
    }
    for (const [id, l] of this.listeners) {
      if (wanted.get(id)?.key !== l.key) {
        l.stop();
        this.listeners.delete(id);
      }
    }
    for (const [id, w] of wanted) {
      if (!this.listeners.has(id)) this.listeners.set(id, new Listener(id, w.key, w.trigger, this.deps));
    }
  }

  /** Whether the automation's connection is waiting in IDLE now: its checks can come more slowly. */
  live(conversationId: string): boolean {
    return this.listeners.get(conversationId)?.live ?? false;
  }

  /** Whether the automation's server said it does not take IDLE. */
  unsupported(conversationId: string): boolean {
    return this.listeners.get(conversationId)?.unsupported ?? false;
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
