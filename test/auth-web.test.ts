import { beforeEach, describe, expect, it } from 'vitest';
import { clearKey, readKey, sendWithKey, writeKey } from '../src/web/auth';

const KEY = 'x-relay-key';

/**
 * A server for `sendWithKey`: `answer` gives each request's status by the key it was sent with, and
 * `meanwhile` runs while a request is on its way (a sign-in elsewhere on the page). `sent` records the keys.
 */
function server(answer: (key: string | null) => number, meanwhile?: () => void) {
  const sent: (string | null)[] = [];
  const send = async (_url: string, init: RequestInit) => {
    const key = (init.headers as Record<string, string>)[KEY] ?? null;
    sent.push(key);
    meanwhile?.();
    return new Response('{}', { status: answer(key) });
  };
  return { sent, send };
}

const withKey = (key: string | null): RequestInit => ({ headers: key ? { [KEY]: key } : {} });

describe('sending a request with the key', () => {
  beforeEach(() => clearKey());

  it('sends it once with the key kept', async () => {
    writeKey('old');
    const s = server(() => 200);
    expect((await sendWithKey('/api/x', withKey, s.send)).status).toBe(200);
    expect(s.sent).toEqual(['old']);
  });

  it('gives back a signed-out answer for the key kept, for the caller to sign the page out', async () => {
    writeKey('old');
    const s = server(() => 401);
    expect((await sendWithKey('/api/x', withKey, s.send)).status).toBe(401);
    expect(s.sent).toEqual(['old']);
    expect(readKey()).toBe('old');
  });

  it('sends it again with the new key when a sign-in replaced the key on its way', async () => {
    // A sign-in link opened in a tab signed in already: its sign-in ends the old session.
    writeKey('old');
    const s = server(
      (key) => (key === 'new' ? 200 : 401),
      () => writeKey('new'),
    );
    expect((await sendWithKey('/api/x', withKey, s.send)).status).toBe(200);
    expect(s.sent).toEqual(['old', 'new']);
    expect(readKey()).toBe('new');
  });

  it('also when the page had no key yet', async () => {
    const s = server(
      (key) => (key ? 200 : 401),
      () => writeKey('new'),
    );
    expect((await sendWithKey('/api/x', withKey, s.send)).status).toBe(200);
    expect(s.sent).toEqual([null, 'new']);
  });

  it('sends it again once at most', async () => {
    let n = 0;
    writeKey('k0');
    const s = server(
      () => 401,
      () => writeKey(`k${++n}`),
    );
    expect((await sendWithKey('/api/x', withKey, s.send)).status).toBe(401);
    expect(s.sent).toEqual(['k0', 'k1']);
  });

  it('does not send again for any other answer', async () => {
    writeKey('old');
    const s = server(
      () => 403,
      () => writeKey('new'),
    );
    expect((await sendWithKey('/api/x', withKey, s.send)).status).toBe(403);
    expect(s.sent).toEqual(['old']);
  });
});
