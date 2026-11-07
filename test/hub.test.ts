import { describe, expect, it } from 'vitest';
import type { ServerEvent } from '../src/shared/types';
import { Hub } from '../src/server/hub';

const status: ServerEvent = { type: 'status', running: false, activeAgentIds: [] };

describe('Hub', () => {
  it('keeps a reconnected listener when the old connection unsubscribes twice', () => {
    // An SSE connection unsubscribes on abort and again when its keep-alive loop ends.
    const hub = new Hub();
    const a: ServerEvent[] = [];
    const b: ServerEvent[] = [];
    const offA = hub.subscribe('c', (e) => a.push(e));
    offA();
    hub.subscribe('c', (e) => b.push(e));
    offA();
    hub.emit('c', status);
    expect(a).toEqual([]);
    expect(b).toEqual([status]);
  });

  it('keeps other listeners of the same conversation', () => {
    const hub = new Hub();
    const b: ServerEvent[] = [];
    const offA = hub.subscribe('c', () => {});
    hub.subscribe('c', (e) => b.push(e));
    offA();
    offA();
    hub.emit('c', status);
    expect(b).toEqual([status]);
  });
});
