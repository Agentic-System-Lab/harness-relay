/*
 * A hand-over of the chat's browser in the page (src/web/handover.ts): which way the card offers first,
 * where a click on the screencast lands, what a key becomes, how the waiting input is merged, what the
 * stream says, and the page's size in the panel.
 */
import { describe, expect, it } from 'vitest';
import { HANDOVER_LIMITS, type HandoverInput } from '../src/shared/types';
import {
  addressEntry,
  addressOf,
  framePoint,
  isTap,
  keyInput,
  mergeInputs,
  minutesLeft,
  nextBatch,
  modifiersOf,
  preferredMode,
  screenEvent,
  viewportOf,
  type KeyLike,
} from '../src/web/handover';

describe('which way the card offers first', () => {
  it('the window when the chat is on the computer Harness Relay runs on (the desktop app, 127.0.0.1, localhost)', () => {
    const both = ['window', 'screencast'] as const;
    expect(preferredMode(both, { desktop: true, hostname: 'relay.example.ts.net' })).toBe('window');
    for (const hostname of ['127.0.0.1', 'localhost', '[::1]', '127.0.0.2'])
      expect(preferredMode(both, { desktop: false, hostname })).toBe('window');
  });

  it('the screencast from elsewhere (a phone through remote access, a codespace), and always where no window can open', () => {
    expect(preferredMode(['window', 'screencast'], { desktop: false, hostname: 'relay.tail1234.ts.net' })).toBe('screencast');
    expect(preferredMode(['window', 'screencast'], { desktop: false, hostname: 'fuzzy-x-8787.app.github.dev' })).toBe('screencast');
    expect(preferredMode(['screencast'], { desktop: true, hostname: '127.0.0.1' })).toBe('screencast');
  });
});

describe('where a point of the screencast lands on the page', () => {
  it('is a fraction of the frame, which is fitted in the image keeping its shape: the bars beside it are no part of it', () => {
    // A 1280 × 800 frame in a 1000 × 1000 box: 1000 × 625, with bars of 187.5 above and below.
    const box = { left: 10, top: 20, width: 1000, height: 1000 };
    const frame = { width: 1280, height: 800 };
    expect(framePoint(510, 520, box, frame)).toEqual({ x: 0.5, y: 0.5 });
    expect(framePoint(10, 207.5, box, frame)).toEqual({ x: 0, y: 0 });
    expect(framePoint(1010, 832.5, box, frame)).toEqual({ x: 1, y: 1 });
    expect(framePoint(510, 100, box, frame)).toBeUndefined();
    // A tall frame (a phone's page) in a wide box: bars at the sides.
    expect(framePoint(500, 500, { left: 0, top: 0, width: 1000, height: 500 }, { width: 390, height: 700 })).toEqual({ x: 0.5, y: 1 });
    expect(framePoint(100, 250, { left: 0, top: 0, width: 1000, height: 500 }, { width: 390, height: 700 })).toBeUndefined();
    expect(framePoint(1, 1, box, { width: 0, height: 0 })).toBeUndefined();
    // Let go of past the frame's edge: at the edge.
    expect(framePoint(510, 100, box, frame, true)).toEqual({ x: 0.5, y: 0 });
    expect(framePoint(-50, 2000, box, frame, true)).toEqual({ x: 0, y: 1 });
  });
});

describe("what the panel's address bar opens", () => {
  it('opens http and https addresses only', () => {
    expect(addressEntry('localhost:3000')).toEqual({ url: 'http://localhost:3000/' });
    expect(addressEntry('http://192.168.1.20/admin?x=1')).toEqual({ url: 'http://192.168.1.20/admin?x=1' });
    expect(addressEntry('file:///etc/hosts')).toEqual({ refused: true });
    expect(addressEntry('javascript:alert(1)')).toEqual({ refused: true });
    expect(addressEntry('  ')).toBeUndefined();
  });

  it('an address with its scheme as it is; this computer and the local network over http, the rest over https', () => {
    expect(addressOf('localhost:3000')).toBe('http://localhost:3000');
    expect(addressOf('127.0.0.1:8080/token')).toBe('http://127.0.0.1:8080/token');
    expect(addressOf('192.168.1.5')).toBe('http://192.168.1.5');
    expect(addressOf('printer.local/admin')).toBe('http://printer.local/admin');
    expect(addressOf('[::1]:3000')).toBe('http://[::1]:3000');
    expect(addressOf('example.com/login')).toBe('https://example.com/login');
    expect(addressOf('  https://example.com  ')).toBe('https://example.com');
    // A scheme the server refuses goes as it is, and the server says why.
    expect(addressOf('file:///etc/hosts')).toBe('file:///etc/hosts');
    expect(addressOf('   ')).toBeUndefined();
  });
});

describe('what a key in the typing box becomes', () => {
  const key = (o: Partial<KeyLike>): KeyLike => ({
    key: 'a',
    code: 'KeyA',
    keyCode: 65,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    isComposing: false,
    ...o,
  });

  it("types a hardware keyboard's characters, with Option on a Mac and AltGr elsewhere too", () => {
    expect(keyInput(key({}), true)).toEqual({ type: 'key', key: 'a', code: 'KeyA', keyCode: 65, text: 'a' });
    expect(keyInput(key({ key: 'A', shiftKey: true }), false)).toEqual({
      type: 'key',
      key: 'A',
      code: 'KeyA',
      keyCode: 65,
      modifiers: 8,
      text: 'A',
    });
    expect(keyInput(key({ key: 'å', altKey: true }), true)).toMatchObject({ text: 'å', modifiers: 1 });
    expect(keyInput(key({ key: '€', code: 'KeyE', altKey: true, ctrlKey: true }), false)).toMatchObject({ text: '€', modifiers: 3 });
  });

  it('sends the keys that type nothing as keys: Enter, Backspace, Tab, Escape, the arrows', () => {
    for (const k of ['Enter', 'Backspace', 'Tab', 'Escape', 'ArrowLeft', 'PageDown'])
      expect(keyInput(key({ key: k, code: k, keyCode: 0 }), false)).toEqual({ type: 'key', key: k, code: k });
  });

  it("turns the editing shortcuts into their commands (⌘ on a Mac, Ctrl elsewhere), leaves paste to the box's paste event, and drops the rest", () => {
    expect(keyInput(key({ metaKey: true }), true)).toMatchObject({ command: 'selectAll', modifiers: 4 });
    expect(keyInput(key({ ctrlKey: true }), false)).toMatchObject({ command: 'selectAll', modifiers: 2 });
    expect(keyInput(key({ key: 'z', metaKey: true }), true)).toMatchObject({ command: 'undo' });
    expect(keyInput(key({ key: 'z', metaKey: true, shiftKey: true }), true)).toMatchObject({ command: 'redo' });
    expect(keyInput(key({ key: 'y', ctrlKey: true }), false)).toMatchObject({ command: 'redo' });
    expect(keyInput(key({ key: 'v', metaKey: true }), true)).toBe('paste');
    expect(keyInput(key({ key: 'v', ctrlKey: true }), false)).toBe('paste');
    // Copying, a new tab, closing: never taken from this browser for the page.
    for (const k of ['c', 't', 'w', 'r']) expect(keyInput(key({ key: k, metaKey: true }), true)).toBeUndefined();
  });

  it('leaves to the box what an input method composes and what an on-screen keyboard does not name', () => {
    expect(keyInput(key({ isComposing: true }), true)).toBeUndefined();
    expect(keyInput(key({ key: 'Process', keyCode: 229 }), false)).toBeUndefined();
    expect(keyInput(key({ key: 'Unidentified', keyCode: 229 }), false)).toBeUndefined();
    expect(keyInput(key({ key: 'Dead', code: 'KeyE', altKey: true }), true)).toBeUndefined();
    expect(keyInput(key({ key: 'Shift', shiftKey: true }), true)).toBeUndefined();
  });

  it('gives the modifier keys as Chromium takes them', () => {
    expect(modifiersOf({ altKey: true, ctrlKey: true, metaKey: true, shiftKey: true })).toBe(15);
    expect(modifiersOf({ altKey: false, ctrlKey: false, metaKey: true, shiftKey: false })).toBe(4);
  });
});

describe('the input waiting to go', () => {
  it('merges moves one after another and wheel turns, and keeps everything else in order', () => {
    const list: HandoverInput[] = [
      { type: 'mouse', action: 'move', x: 0.1, y: 0.1, button: 'none' },
      { type: 'mouse', action: 'move', x: 0.2, y: 0.2, button: 'none' },
      { type: 'mouse', action: 'down', x: 0.2, y: 0.2, button: 'left' },
      { type: 'mouse', action: 'move', x: 0.3, y: 0.3, button: 'left' },
      { type: 'mouse', action: 'move', x: 0.4, y: 0.4, button: 'left' },
      { type: 'mouse', action: 'up', x: 0.4, y: 0.4, button: 'left' },
      { type: 'wheel', x: 0.5, y: 0.5, dx: 0, dy: 10 },
      { type: 'wheel', x: 0.6, y: 0.5, dx: 5, dy: 20 },
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
    ];
    expect(mergeInputs(list)).toEqual([
      { type: 'mouse', action: 'move', x: 0.2, y: 0.2, button: 'none' },
      { type: 'mouse', action: 'down', x: 0.2, y: 0.2, button: 'left' },
      { type: 'mouse', action: 'move', x: 0.4, y: 0.4, button: 'left' },
      { type: 'mouse', action: 'up', x: 0.4, y: 0.4, button: 'left' },
      { type: 'wheel', x: 0.6, y: 0.5, dx: 5, dy: 30 },
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
    ]);
  });

  it('starts a new wheel turn before the sum passes what the server takes of one', () => {
    const wheels: HandoverInput[] = Array.from({ length: 120 }, () => ({ type: 'wheel', x: 0.5, y: 0.5, dx: 0, dy: 100 }));
    const merged = mergeInputs([...wheels, { type: 'mouse', action: 'down', x: 0.5, y: 0.5 }]);
    expect(merged.map((e) => (e.type === 'wheel' ? e.dy : e.type))).toEqual([10_000, 2000, 'mouse']);
    for (const e of merged) if (e.type === 'wheel') expect(Math.abs(e.dy)).toBeLessThanOrEqual(HANDOVER_LIMITS.wheelMax);
  });

  it('sends at most a batch at a time, the rest waiting its turn in order', () => {
    const typed: HandoverInput[] = Array.from({ length: 250 }, (_, i) => ({ type: 'text', text: String(i) }));
    const first = nextBatch(typed);
    expect(first.batch).toHaveLength(HANDOVER_LIMITS.eventsMax);
    expect(first.batch[0]).toEqual({ type: 'text', text: '0' });
    const second = nextBatch(first.rest);
    const third = nextBatch(second.rest);
    expect([...first.batch, ...second.batch, ...third.batch]).toEqual(typed);
    expect(third.rest).toEqual([]);
  });

  it("tells a touch's tap (a click) from its drag (a scroll)", () => {
    expect(isTap({ x: 10, y: 10, at: 0 }, { x: 14, y: 16, at: 200 })).toBe(true);
    expect(isTap({ x: 10, y: 10, at: 0 }, { x: 10, y: 40, at: 200 })).toBe(false);
    expect(isTap({ x: 10, y: 10, at: 0 }, { x: 10, y: 10, at: 2000 })).toBe(false);
  });
});

describe("the screencast's stream and the panel", () => {
  it('reads frames, addresses, notices and the end, and nothing else', () => {
    expect(screenEvent('{"type":"frame","data":"AAA","width":10,"height":20}')).toEqual({
      type: 'frame',
      data: 'AAA',
      width: 10,
      height: 20,
    });
    expect(screenEvent('{"type":"location","url":"https://a/","back":true,"forward":false}')).toMatchObject({ type: 'location' });
    expect(screenEvent('{"type":"notice","kind":"popup"}')).toMatchObject({ kind: 'popup' });
    expect(screenEvent('{"type":"ended"}')).toEqual({ type: 'ended' });
    for (const bad of ['', 'nope', '{"type":"frame","data":"A","width":0,"height":1}', '{"type":"notice","kind":"other"}', '{"type":"x"}'])
      expect(screenEvent(bad)).toBeUndefined();
  });

  it("counts a card's minutes left, and lays the page out to the panel's size", () => {
    expect(minutesLeft(10 * 60_000, 0)).toBe(10);
    expect(minutesLeft(10_000, 0)).toBe(1);
    expect(minutesLeft(0, 5)).toBe(0);
    expect(viewportOf(390.4, 700.6, 3)).toEqual({ type: 'viewport', width: 390, height: 701, scale: 2 });
    expect(viewportOf(1200, 50, 1)).toEqual({ type: 'viewport', width: 1200, height: 200, scale: 1 });
    expect(viewportOf(9000, 900, 1.3)).toMatchObject({ width: 4000, scale: 1.25 });
  });
});
