/**
 * The tray menu while it is open. On macOS and Windows an open menu keeps showing what it showed when
 * it opened: changing one of its items, or setting a new menu, changes nothing on screen until it
 * opens again (tried with Electron 45 on macOS), and setting a new menu while one is open keeps the
 * app from closing it. So while it is open, main.ts changes its items in place (`patchMenu`) and never
 * sets a new one, and `LiveMenu` closes and opens it again to show them: only when what it shows
 * changed (an update's progress, say), and at most every `everyMs`. A moment after it closes
 * (`graceMs`), still in place: the click on one of its items arrives after it closed, and the menu it
 * belongs to must still be the tray's. Linux's menus (D-Bus) are set anew each time, as before.
 * Nothing here imports Electron: main.ts passes in what it needs.
 */

/** How often an open menu may be opened again to show what changed. */
export const REOPEN_EVERY_MS = 1000;

/**
 * How long a menu opened again may take to say it opened, before it counts as closed (the user
 * clicked elsewhere at that moment, say).
 */
export const REOPEN_TIMEOUT_MS = 1500;

/** How long after it closed a menu still counts as open (the click on its item arrives after it closed). */
export const CLOSE_GRACE_MS = 300;

/**
 * How long main.ts waits between closing the menu and opening it again. Opened again at once, from
 * inside the closing menu's own loop, each menu runs inside the one before it on macOS, and after a
 * few the app takes seconds to quit, or never does (tried with Electron 45: 5 at once hang; 100,
 * 50 ms apart, quit at once).
 */
export const REOPEN_DELAY_MS = 50;

/** What an item of the menu shows, as main.ts's template has it (Electron's MenuItem has the same). */
export interface ItemState {
  id?: string;
  type?: string;
  label?: string;
  enabled?: boolean;
  visible?: boolean;
  checked?: boolean;
}

/** What a menu shows, as text: the same text, the same menu on screen. */
export function menuText(items: readonly ItemState[]): string {
  return items
    .filter((i) => i.visible !== false)
    .map((i) => `${i.id ?? i.type ?? ''}\t${i.label ?? ''}\t${i.enabled === false ? 0 : 1}\t${i.checked ? 1 : 0}`)
    .join('\n');
}

/**
 * Gives the menu's items (`find`, by id) what the template says: label, enabled, shown, checked.
 * False, changing nothing, when an item of the template is not in the menu (it is not the same menu).
 */
export function patchMenu(find: (id: string) => ItemState | null | undefined, template: readonly ItemState[]): boolean {
  const pairs: [ItemState, ItemState][] = [];
  for (const wanted of template) {
    if (!wanted.id) continue;
    const item = find(wanted.id);
    if (!item) return false;
    pairs.push([item, wanted]);
  }
  for (const [item, wanted] of pairs) {
    if (item.label !== (wanted.label ?? '')) item.label = wanted.label ?? '';
    if (item.enabled !== (wanted.enabled ?? true)) item.enabled = wanted.enabled ?? true;
    if (item.visible !== (wanted.visible ?? true)) item.visible = wanted.visible ?? true;
    if (wanted.type === 'checkbox' && item.checked !== (wanted.checked ?? false)) item.checked = wanted.checked ?? false;
  }
  return true;
}

type Timer = ReturnType<typeof setTimeout>;

export interface LiveMenuOptions {
  /** Closes the open menu and opens it again (it then shows its items as they are). */
  reopen: () => void;
  everyMs?: number;
  timeoutMs?: number;
  graceMs?: number;
  now?: () => number;
}

/** Whether the tray menu is open, and when to open it again to show what changed. */
export class LiveMenu {
  private open = false;
  /** Opened again by this class, and not yet said to be open. */
  private reopening = false;
  /**
   * The close of the menu this class opened again is expected until then: before the new one says it
   * opened, or after (on some systems the old menu's close comes late).
   */
  private expectClose = 0;
  /** Just closed: still counts as open for a moment (`graceMs`). */
  private closing?: Timer;
  /** What the open menu shows, and what it would show now. */
  private shown = '';
  private latest = '';
  /** When it last opened. */
  private since = 0;
  private timer?: Timer;
  private fallback?: Timer;

  constructor(private o: LiveMenuOptions) {}

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  private get every(): number {
    return this.o.everyMs ?? REOPEN_EVERY_MS;
  }

  /**
   * The menu is open, being opened again or just closed: its items are changed in place, and no new
   * menu is set.
   */
  get isOpen(): boolean {
    return this.open || this.reopening || this.closing !== undefined;
  }

  /**
   * The menu opened, showing `text` (`menuText`). Returns whether the user opened it (not this class,
   * opening it again).
   */
  opened(text: string): boolean {
    const byUser = !this.reopening;
    clearTimeout(this.fallback);
    this.fallback = undefined;
    clearTimeout(this.closing);
    this.closing = undefined;
    this.open = true;
    this.reopening = false;
    this.shown = text;
    this.latest = text;
    this.since = this.now();
    return byUser;
  }

  /** The menu closed (also as it is opened again: then nothing changes). */
  closed(): void {
    if (this.expectClose && this.now() <= this.expectClose) {
      this.expectClose = 0;
      return;
    }
    this.expectClose = 0;
    if (this.reopening) return;
    this.close();
  }

  /** What the menu would show now changed (its items were changed in place, while it is open). */
  changed(text: string): void {
    this.latest = text;
    if (!this.open || this.timer || text === this.shown) return;
    const wait = this.since + this.every - this.now();
    if (wait <= 0 && !this.reopening) this.reopen();
    else this.timer = setTimeout(() => this.due(), Math.max(wait, 0));
  }

  private due(): void {
    this.timer = undefined;
    if (!this.open || this.latest === this.shown) return;
    if (this.reopening) {
      // Still opening: try once it has.
      this.timer = setTimeout(() => this.due(), this.every);
      return;
    }
    this.reopen();
  }

  private reopen(): void {
    this.reopening = true;
    this.expectClose = this.now() + (this.o.timeoutMs ?? REOPEN_TIMEOUT_MS);
    this.fallback = setTimeout(() => {
      this.fallback = undefined;
      if (!this.reopening) return;
      this.reopening = false;
      this.close();
    }, this.o.timeoutMs ?? REOPEN_TIMEOUT_MS);
    try {
      this.o.reopen();
    } catch {
      clearTimeout(this.fallback);
      this.fallback = undefined;
      this.reopening = false;
      this.expectClose = 0;
      this.close();
    }
  }

  private close(): void {
    this.open = false;
    clearTimeout(this.timer);
    this.timer = undefined;
    clearTimeout(this.closing);
    this.closing = setTimeout(() => (this.closing = undefined), this.o.graceMs ?? CLOSE_GRACE_MS);
  }
}
