/*
 * The chat's computer in the page (src/web/computer.ts): what a key becomes, what a press and release are,
 * when two clicks are a double click, what the wheel scrolls, how waiting input is merged, what the stream
 * says, where Cua's viewer can open, and what it says while a computer starts.
 */
import { describe, expect, it } from 'vitest';
import { COMPUTER_LIMITS, type ComputerInput } from '../src/shared/types';
import {
  computerEvent,
  computerKey,
  isDouble,
  mergeComputerInputs,
  pressInput,
  startingNote,
  viewerReachable,
  wheelInput,
} from '../src/web/computer';

const key = (
  k: string,
  o: Partial<{ ctrlKey: boolean; altKey: boolean; metaKey: boolean; shiftKey: boolean; isComposing: boolean; keyCode: number }> = {},
) => ({
  key: k,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  shiftKey: false,
  isComposing: false,
  ...o,
});

describe('the computer panel in the page', () => {
  it('turns keys into Cua’s names, characters into text, and leaves composing and lone modifiers alone', () => {
    expect(computerKey(key('Enter'), false)).toEqual({ keys: 'enter' });
    expect(computerKey(key('PageDown'), false)).toEqual({ keys: 'page_down' });
    expect(computerKey(key('F5'), false)).toEqual({ keys: 'f5' });
    expect(computerKey(key('Tab', { shiftKey: true }), false)).toEqual({ keys: 'shift+tab' });
    expect(computerKey(key('a'), false)).toEqual({ text: 'a' });
    expect(computerKey(key('A', { shiftKey: true }), false)).toEqual({ text: 'A' });
    expect(computerKey(key('é'), false)).toEqual({ text: 'é' });
    expect(computerKey(key('c', { ctrlKey: true }), false)).toEqual({ keys: 'ctrl+c' });
    expect(computerKey(key('T', { ctrlKey: true, shiftKey: true }), false)).toEqual({ keys: 'ctrl+shift+t' });
    // On a Mac, ⌘C is the computer's Ctrl+C, and ⌘ with anything else is Super.
    expect(computerKey(key('c', { metaKey: true }), true)).toEqual({ keys: 'ctrl+c' });
    expect(computerKey(key('k', { metaKey: true }), true)).toEqual({ keys: 'super+k' });
    expect(computerKey(key('Tab', { altKey: true }), false)).toEqual({ keys: 'alt+tab' });
    for (const k of [
      key('Shift', { shiftKey: true }),
      key('Process'),
      key('a', { isComposing: true }),
      key('a', { keyCode: 229 }),
      key('MediaPlay'),
    ])
      expect(computerKey(k, false), k.key).toBeUndefined();
  });

  it('makes a click of a press that stays put, a drag of one that moves, and a double click of two quick ones', () => {
    const start = { x: 0.5, y: 0.5, at: 0, button: 'left' as const };
    expect(pressInput(start, { x: 0.502, y: 0.5 })).toEqual({ type: 'click', x: 0.5, y: 0.5 });
    expect(pressInput(start, { x: 0.7, y: 0.6 })).toEqual({ type: 'drag', x: 0.5, y: 0.5, toX: 0.7, toY: 0.6 });
    expect(pressInput({ ...start, button: 'right' }, { x: 0.9, y: 0.9 })).toEqual({ type: 'click', x: 0.5, y: 0.5, button: 'right' });
    const a = { type: 'click' as const, x: 0.5, y: 0.5, at: 100 };
    expect(isDouble(a, { ...a, at: 300 })).toBe(true);
    expect(isDouble(a, { ...a, at: 500 })).toBe(false);
    expect(isDouble(a, { ...a, x: 0.6, at: 200 })).toBe(false);
    expect(isDouble(a, { ...a, button: 'right', at: 200 })).toBe(false);
  });

  it('scrolls by lines once the wheel has turned that far, the rest kept for the next turn', () => {
    const carry = { x: 0, y: 0 };
    expect(wheelInput(0, 20, { x: 0.1, y: 0.2 }, carry)).toBeUndefined();
    expect(wheelInput(0, 70, { x: 0.1, y: 0.2 }, carry)).toEqual({ type: 'scroll', x: 0.1, y: 0.2, direction: 'down', amount: 2 });
    expect(wheelInput(0, -3, { x: 0, y: 0 }, carry, true)).toEqual({ type: 'scroll', x: 0, y: 0, direction: 'up', amount: 3 });
    expect(wheelInput(-5000, 0, { x: 0, y: 0 }, carry)).toMatchObject({ direction: 'left', amount: COMPUTER_LIMITS.scrollMax });
  });

  it('merges text typed one key after another and scrolls the same way, then sends at most a batch', () => {
    const list: ComputerInput[] = [
      { type: 'text', text: 'h' },
      { type: 'text', text: 'i' },
      { type: 'key', keys: 'enter' },
      { type: 'scroll', x: 0, y: 0, direction: 'down', amount: 2 },
      { type: 'scroll', x: 0, y: 0, direction: 'down', amount: 3 },
      { type: 'scroll', x: 0, y: 0, direction: 'up', amount: 1 },
    ];
    expect(mergeComputerInputs(list).batch).toEqual([
      { type: 'text', text: 'hi' },
      { type: 'key', keys: 'enter' },
      { type: 'scroll', x: 0, y: 0, direction: 'down', amount: 5 },
      { type: 'scroll', x: 0, y: 0, direction: 'up', amount: 1 },
    ]);
    const many = Array.from({ length: COMPUTER_LIMITS.eventsMax + 3 }, (): ComputerInput => ({ type: 'key', keys: 'tab' }));
    const { batch, rest } = mergeComputerInputs(many);
    expect(batch).toHaveLength(COMPUTER_LIMITS.eventsMax);
    expect(rest).toHaveLength(3);
  });

  it('reads the stream’s frames and states, nothing else', () => {
    expect(computerEvent(JSON.stringify({ type: 'frame', data: 'AAA', mimeType: 'image/png', width: 1, height: 2 }))).toMatchObject({
      type: 'frame',
    });
    expect(computerEvent(JSON.stringify({ type: 'state', view: { status: 'ready' } }))).toMatchObject({ type: 'state' });
    expect(computerEvent(JSON.stringify({ type: 'frame', data: 1 }))).toBeUndefined();
    expect(computerEvent('not json')).toBeUndefined();
  });

  it('offers Cua’s viewer only on the computer Harness Relay runs on', () => {
    expect(viewerReachable({ desktop: true, hostname: 'relay.tail.ts.net' })).toBe(true);
    expect(viewerReachable({ desktop: false, hostname: '127.0.0.1' })).toBe(true);
    expect(viewerReachable({ desktop: false, hostname: 'localhost' })).toBe(true);
    expect(viewerReachable({ desktop: false, hostname: 'relay.tail.ts.net' })).toBe(false);
  });

  it('says, while a computer starts, how far Settings’ download of the image is, or the first start’s own, or nothing once it is here', () => {
    expect(startingNote({})).toBe('first-time');
    expect(startingNote({ imageReady: true })).toBeUndefined();
    // Waiting for Settings' download: nothing counted yet, then its bytes.
    expect(startingNote({ image: { done: 0 } })).toBe('preparing');
    expect(startingNote({ image: { done: 0, total: 1000 } })).toEqual({ image: { done: 0, total: 1000 } });
    expect(startingNote({ image: { done: 250 } })).toEqual({ image: { done: 250 } });
  });
});
