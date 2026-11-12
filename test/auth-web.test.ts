import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, SIGNED_OUT_EVENT, api } from '../src/web/api';
import { clearKey, readKey, signedOutAnswer, whileSigningIn, writeKey } from '../src/web/auth';

const KEY = 'x-relay-key';
const SIGNED_OUT = { error: 'Signed out', code: 'signed-out' };

/** Lets every promise made so far settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('what an answer "signed out" means', () => {
  beforeEach(() => clearKey());

  it('signs the browser out when the request was sent with the key kept', async () => {
    writeKey('old');
    expect(await signedOutAnswer('old')).toBe('signed-out');
    expect(readKey()).toBeNull();
    // Also for a page that had no key.
    expect(await signedOutAnswer(null)).toBe('signed-out');
  });

  it('sends the request again when a sign-in replaced the key on its way, and keeps that key', async () => {
    writeKey('new');
    expect(await signedOutAnswer('old')).toBe('resend');
    expect(readKey()).toBe('new');
  });

  it('does nothing more when the key went (signed out already), or changed again after a resend', async () => {
    expect(await signedOutAnswer('old')).toBe('stale');
    writeKey('newer');
    expect(await signedOutAnswer('new', true)).toBe('stale');
    expect(readKey()).toBe('newer');
  });

  it('waits for a sign-in on its way, which may put a new key in place', async () => {
    writeKey('old');
    let done!: () => void;
    void whileSigningIn(new Promise<void>((r) => (done = r)).then(() => writeKey('new')));
    let answer: string | undefined;
    void signedOutAnswer('old').then((a) => (answer = a));
    await settle();
    expect(answer).toBeUndefined();
    done();
    await settle();
    expect(answer).toBe('resend');
    expect(readKey()).toBe('new');
  });
});

/** An answer whose body is read with `meanwhile` run first: what the page does while it is read. */
function answer(status: number, body: unknown, meanwhile?: () => void): Response {
  const read = async () => {
    meanwhile?.();
    return body;
  };
  return {
    ok: status < 400,
    status,
    statusText: '',
    json: read,
    text: async () => JSON.stringify(await read()),
  } as unknown as Response;
}

describe('a request answered "signed out"', () => {
  /** The keys each path was sent with, in order. */
  let sent: Record<string, (string | null)[]>;
  let signedOutEvents: number;

  /** `fetch`, answering each request by its path and the key it was sent with. */
  function server(respond: (path: string, key: string | null) => Response | Promise<Response>) {
    vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
      const key = (init.headers as Record<string, string>)[KEY] ?? null;
      (sent[path] ??= []).push(key);
      return respond(path, key);
    });
  }

  beforeEach(() => {
    clearKey();
    sent = {};
    signedOutEvents = 0;
    const page = new EventTarget();
    page.addEventListener(SIGNED_OUT_EVENT, () => signedOutEvents++);
    vi.stubGlobal('window', page);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('for the key it was sent with signs the page out', async () => {
    writeKey('old');
    server(() => answer(401, SIGNED_OUT));
    const err = (await api.listConversations().catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(401);
    expect(signedOutEvents).toBe(1);
    expect(readKey()).toBeNull();
  });

  it('is sent again with the new key when a sign-in replaced the key while its answer was read', async () => {
    // A sign-in link opened in a tab signed in already: the answer to a request sent with the old
    // key arrives with the sign-in's, and the new key is kept before that answer has been read.
    writeKey('old');
    server((_path, key) => (key === 'new' ? answer(200, []) : answer(401, SIGNED_OUT, () => writeKey('new'))));
    expect(await api.listConversations()).toEqual([]);
    expect(sent['/api/conversations']).toEqual(['old', 'new']);
    expect(signedOutEvents).toBe(0);
    expect(readKey()).toBe('new');
  });

  it('waits for a sign-in on its way, then is sent again with its key', async () => {
    writeKey('old');
    let login!: (r: Response) => void;
    server((path, key) => {
      if (path === '/api/auth/login') return new Promise<Response>((r) => (login = r));
      return key === 'new' ? answer(200, []) : answer(401, SIGNED_OUT);
    });
    const signingIn = api.signIn('ABCD-EFGH');
    let listed: unknown;
    const listing = api.listConversations().then((l) => (listed = l));
    await settle();
    // Answered "signed out", but the sign-in is not done: nothing is decided yet.
    expect(listed).toBeUndefined();
    expect(signedOutEvents).toBe(0);
    expect(readKey()).toBe('old');
    login(answer(200, { key: 'new' }));
    await Promise.all([signingIn, listing]);
    expect(listed).toEqual([]);
    expect(sent['/api/conversations']).toEqual(['old', 'new']);
    expect(signedOutEvents).toBe(0);
    expect(readKey()).toBe('new');
  });

  it('signs the page out after a sign-in on its way failed', async () => {
    writeKey('old');
    let login!: (r: Response) => void;
    server((path) => (path === '/api/auth/login' ? new Promise<Response>((r) => (login = r)) : answer(401, SIGNED_OUT)));
    const signingIn = api.signIn('WXYZ-0000').catch((e: unknown) => e);
    const listing = api.listConversations().catch((e: unknown) => e);
    await settle();
    login(answer(400, { error: 'That code is wrong or has expired.' }));
    expect(await signingIn).toBeInstanceOf(ApiError);
    expect(await listing).toBeInstanceOf(ApiError);
    expect(signedOutEvents).toBe(1);
    expect(readKey()).toBeNull();
  });

  it('is not sent again once the key went, nor more than once', async () => {
    writeKey('old');
    server(() => answer(401, SIGNED_OUT, () => clearKey()));
    expect(await api.listConversations().catch((e: unknown) => e)).toBeInstanceOf(ApiError);
    expect(sent['/api/conversations']).toEqual(['old']);
    expect(signedOutEvents).toBe(0);

    let n = 0;
    writeKey('k0');
    server(() => answer(401, SIGNED_OUT, () => writeKey(`k${++n}`)));
    expect(await api.listConversations().catch((e: unknown) => e)).toBeInstanceOf(ApiError);
    expect(sent['/api/conversations']).toEqual(['old', 'k0', 'k1']);
    expect(signedOutEvents).toBe(0);
    expect(readKey()).toBe('k2');
  });

  it('is sent again for a text answer too (a diff)', async () => {
    writeKey('old');
    server((_path, key) =>
      key === 'new' ? ({ ok: true, status: 200, text: async () => 'diff --git' } as unknown as Response) : answer(401, SIGNED_OUT, () => writeKey('new')),
    );
    expect(await api.messageDiff('c1', 'm1')).toBe('diff --git');
    expect(sent['/api/conversations/c1/messages/m1/diff']).toEqual(['old', 'new']);
    expect(signedOutEvents).toBe(0);
  });
});
