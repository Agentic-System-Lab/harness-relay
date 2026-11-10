import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLOSE_GRACE_MS, LiveMenu, menuText, patchMenu, REOPEN_EVERY_MS, REOPEN_TIMEOUT_MS, type ItemState } from '../desktop/src/traymenu';

describe('what the tray menu shows', () => {
  it('is the text of its shown items: labels, enabled, checked; hidden items leave it out', () => {
    const items: ItemState[] = [
      { id: 'status', label: 'Running', enabled: false },
      { type: 'separator' },
      { id: 'login', type: 'checkbox', label: 'Open at login', checked: true },
      { id: 'switch', label: 'Switch now', visible: false },
    ];
    const text = menuText(items);
    expect(text.split('\n')).toEqual(['status\tRunning\t0\t0', 'separator\t\t1\t0', 'login\tOpen at login\t1\t1']);
    expect(menuText([...items.slice(0, 3), { id: 'switch', label: 'Switch now', visible: true }])).not.toBe(text);
    expect(menuText([{ id: 'status', label: 'Running', enabled: false, visible: true }])).toBe(menuText([{ id: 'status', label: 'Running', enabled: false }]));
  });

  it('is changed in place in the open menu, item by item, and not at all when an item is missing', () => {
    const menu = new Map<string, ItemState>([
      ['update', { id: 'update', label: 'Downloading… (1%)', enabled: false, visible: true }],
      ['switch', { id: 'switch', label: 'Switch now', enabled: true, visible: false }],
      ['login', { id: 'login', label: 'Open at login', enabled: true, visible: true, checked: false }],
    ]);
    const find = (id: string) => menu.get(id);
    const template: ItemState[] = [
      { id: 'update', label: 'Update ready', enabled: false },
      { type: 'separator' },
      { id: 'switch', label: 'Switch now', visible: true },
      { id: 'login', type: 'checkbox', label: 'Open at login', checked: true },
    ];
    expect(patchMenu(find, template)).toBe(true);
    expect(menu.get('update')).toMatchObject({ label: 'Update ready', enabled: false, visible: true });
    expect(menu.get('switch')).toMatchObject({ visible: true, enabled: true });
    expect(menu.get('login')).toMatchObject({ checked: true });

    expect(patchMenu(find, [{ id: 'update', label: 'Downloading… (50%)' }, { id: 'quit', label: 'Quit' }])).toBe(false);
    expect(menu.get('update')!.label).toBe('Update ready');
  });

  it('sets only what differs: Electron redraws nothing for an item left alone', () => {
    const sets: string[] = [];
    const item = {
      id: 'update',
      _label: 'Downloading… (1%)',
      get label() {
        return this._label;
      },
      set label(v: string) {
        sets.push(v);
        this._label = v;
      },
      enabled: false,
      visible: true,
    };
    patchMenu(() => item, [{ id: 'update', label: 'Downloading… (1%)', enabled: false }]);
    patchMenu(() => item, [{ id: 'update', label: 'Downloading… (2%)', enabled: false }]);
    expect(sets).toEqual(['Downloading… (2%)']);
  });
});

describe('an open tray menu that shows what changed', () => {
  let clock = 0;
  beforeEach(() => {
    vi.useFakeTimers();
    clock = 0;
  });
  afterEach(() => vi.useRealTimers());

  /**
   * A LiveMenu with a fake tray: reopening closes the menu and opens it again a moment later. The old
   * menu says it closed at once, or (`lateClose`) only after the new one said it opened.
   */
  function setup(o: { opensAgain?: boolean; lateClose?: boolean } = {}) {
    const events: string[] = [];
    let current = 'A';
    const live: LiveMenu = new LiveMenu({
      reopen: () => {
        events.push('reopen');
        if (!o.lateClose) live.closed();
        if (o.opensAgain !== false) setTimeout(() => live.opened(current), 5);
        if (o.lateClose) setTimeout(() => live.closed(), 10);
      },
      now: () => clock,
    });
    const advance = async (ms: number) => {
      clock += ms;
      await vi.advanceTimersByTimeAsync(ms);
    };
    const change = (text: string) => {
      current = text;
      live.changed(text);
    };
    return { live, events, advance, change };
  }

  it('is not opened again when nothing it shows changed, nor while it is closed', async () => {
    const { live, events, advance, change } = setup();
    change('B'); // closed: main.ts sets a new menu instead
    expect(live.isOpen).toBe(false);
    expect(live.opened('B')).toBe(true);
    await advance(REOPEN_EVERY_MS * 3);
    change('B');
    await advance(REOPEN_EVERY_MS * 3);
    expect(events).toEqual([]);
  });

  it('is opened again to show a change, at most once a second, and with the latest change', async () => {
    const { live, events, advance, change } = setup();
    live.opened('A');
    change('1%');
    expect(events).toEqual([]); // opened a moment ago: not at once
    await advance(REOPEN_EVERY_MS - 10);
    change('2%');
    change('3%');
    expect(events).toEqual([]);
    await advance(10);
    expect(events).toEqual(['reopen']);
    expect(live.isOpen).toBe(true); // between closing and opening again, it still counts as open
    await advance(5);
    expect(live.isOpen).toBe(true);
    change('4%'); // just opened again: waits its turn
    await advance(REOPEN_EVERY_MS - 1);
    expect(events).toEqual(['reopen']);
    await advance(1);
    expect(events).toEqual(['reopen', 'reopen']);
  });

  it('is opened again at once for a change a second or more after it opened', async () => {
    const { live, events, advance, change } = setup();
    live.opened('A');
    await advance(REOPEN_EVERY_MS * 5);
    change('Update ready');
    expect(events).toEqual(['reopen']);
  });

  it('says whether the user opened it, or it was opened again', async () => {
    const { live, advance, change } = setup();
    let byUser: boolean | undefined;
    expect(live.opened('A')).toBe(true);
    await advance(REOPEN_EVERY_MS);
    // The fake tray calls opened() itself: watch what it returns.
    const opened = live.opened.bind(live);
    live.opened = (text: string) => (byUser = opened(text));
    change('B');
    await advance(5);
    expect(byUser).toBe(false);
  });

  it("stays open when the old menu says it closed only after the new one opened, and closes when the user closes it", async () => {
    const { live, events, advance, change } = setup({ lateClose: true });
    live.opened('A');
    await advance(REOPEN_EVERY_MS);
    change('B');
    await advance(20); // opened again at 5 ms, the old one closed at 10 ms
    expect(events).toEqual(['reopen']);
    expect(live.isOpen).toBe(true);
    await advance(REOPEN_EVERY_MS);
    change('C');
    expect(events).toEqual(['reopen', 'reopen']);
    await advance(20);
    live.closed(); // the user, this time (the old one's close was taken already)
    await advance(CLOSE_GRACE_MS);
    expect(live.isOpen).toBe(false);
  });

  it('still counts as open for a moment after the user closed it (the click comes after), then not, and is not opened again', async () => {
    const { live, events, advance, change } = setup();
    live.opened('A');
    live.closed();
    expect(live.isOpen).toBe(true);
    change('B'); // changed in place, not opened again
    await advance(CLOSE_GRACE_MS - 1);
    expect(live.isOpen).toBe(true);
    await advance(1);
    expect(live.isOpen).toBe(false);
    await advance(REOPEN_EVERY_MS * 3);
    expect(events).toEqual([]);
    // A change waiting for its turn when the user closes it is dropped.
    live.opened('B');
    change('C');
    live.closed();
    await advance(REOPEN_EVERY_MS * 3);
    expect(events).toEqual([]);
    // Opened again by the user during the moment after it closed: open as usual.
    live.opened('C');
    live.closed();
    live.opened('C');
    await advance(CLOSE_GRACE_MS * 2);
    expect(live.isOpen).toBe(true);
  });

  it('counts as closed when it does not open again in time', async () => {
    const { live, events, advance, change } = setup({ opensAgain: false });
    live.opened('A');
    await advance(REOPEN_EVERY_MS);
    change('B');
    expect(events).toEqual(['reopen']);
    expect(live.isOpen).toBe(true);
    await advance(REOPEN_TIMEOUT_MS + CLOSE_GRACE_MS);
    expect(live.isOpen).toBe(false);
    change('C');
    await advance(REOPEN_EVERY_MS * 3);
    expect(events).toEqual(['reopen']);
  });

  it('counts as closed when opening it again fails', async () => {
    const live = new LiveMenu({
      reopen: () => {
        throw new Error('no tray');
      },
      now: () => clock,
    });
    live.opened('A');
    clock += REOPEN_EVERY_MS;
    live.changed('B');
    await vi.advanceTimersByTimeAsync(CLOSE_GRACE_MS);
    expect(live.isOpen).toBe(false);
  });
});
