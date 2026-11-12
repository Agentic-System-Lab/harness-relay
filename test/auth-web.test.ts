import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, SIGN_IN_TIMEOUT_MS, SIGNED_OUT_EVENT, api } from '../src/web/api';
import { clearKey, keyArrived, readKey, signedOutAnswer, whileSigningIn, writeKey } from '../src/web/auth';
import { en } from '../src/web/locales/en';

const KEY = 'x-relay-key';
const SIGNED_OUT = { error: 'Signed out', code: 'signed-out' };

/** Lets every promise made so far settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('what an answer "signed out" means', () => {
  beforeEach(() => clearKey());

  it('signs the tab out when the request was sent with the key kept, leaving the key for the other tabs', async () => {
    // Another tab may keep a newer one a moment later, which this tab's copy of the storage does not
    // show yet: taking the key out here could take that one out too.
    writeKey('old');
    expect(await signedOutAnswer('old')).toBe('signed-out');
    expect(readKey()).toBe('old');
    // Also for a page that has no key.
    clearKey();
    expect(await signedOutAnswer(null)).toBe('signed-out');
  });

  it('sends the request again when a sign-in replaced the key on its way, and keeps that key', async () => {
    writeKey('new');
    expect(await signedOutAnswer('old')).toBe('resend');
    expect(readKey()).toBe('new');
  });

  it('does nothing more when the key went (signed out on purpose), or changed again after a resend', async () => {
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

  it('waits for every sign-in on its way: one that finished first does not end the wait', async () => {
    writeKey('old');
    let slow!: () => void;
    let quick!: () => void;
    void whileSigningIn(new Promise<void>((r) => (slow = r)).then(() => writeKey('slow')));
    void whileSigningIn(new Promise<void>((r) => (quick = r)).then(() => {}));
    quick();
    await settle();
    let answer: string | undefined;
    void signedOutAnswer('old').then((a) => (answer = a));
    await settle();
    expect(answer).toBeUndefined();
    slow();
    await settle();
    expect(answer).toBe('resend');
  });

  it('also waits for a sign-in that starts while it waits', async () => {
    writeKey('old');
    let first!: () => void;
    let second!: () => void;
    void whileSigningIn(new Promise<void>((r) => (first = r)));
    let answer: string | undefined;
    void signedOutAnswer('old').then((a) => (answer = a));
    void whileSigningIn(new Promise<void>((r) => (second = r)).then(() => writeKey('new')));
    first();
    await settle();
    expect(answer).toBeUndefined();
    second();
    await settle();
    expect(answer).toBe('resend');
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
  /** The keys each path was sent with, in order, and the bodies. */
  let sent: Record<string, (string | null)[]>;
  let bodies: unknown[];
  let signedOutEvents: number;

  /** `fetch`, answering each request by its path and the key it was sent with. */
  function server(respond: (path: string, key: string | null, init: RequestInit) => Response | Promise<Response>) {
    vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
      if (init.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
      const key = (init.headers as Record<string, string>)[KEY] ?? null;
      (sent[path] ??= []).push(key);
      if (init.body !== undefined) bodies.push(JSON.parse(init.body as string));
      return respond(path, key, init);
    });
  }

  beforeEach(() => {
    clearKey();
    sent = {};
    bodies = [];
    signedOutEvents = 0;
    const page = new EventTarget();
    page.addEventListener(SIGNED_OUT_EVENT, () => signedOutEvents++);
    vi.stubGlobal('window', page);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('for the key it was sent with signs the page out', async () => {
    writeKey('old');
    server(() => answer(401, SIGNED_OUT));
    const err = (await api.listConversations().catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(401);
    expect(signedOutEvents).toBe(1);
    expect(readKey()).toBe('old');
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
    expect(readKey()).toBe('old');
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

  it("waits for the sign-in also when the page had no key, and a write is sent again with its body", async () => {
    let login!: (r: Response) => void;
    server((path, key) => {
      if (path === '/api/auth/login') return new Promise<Response>((r) => (login = r));
      return key === 'new' ? answer(200, { id: 'c1' }) : answer(401, SIGNED_OUT);
    });
    const signingIn = api.signIn('ABCD-EFGH');
    const renaming = api.updateConversation('c1', { title: 'Renamed' });
    await settle();
    login(answer(200, { key: 'new' }));
    await signingIn;
    expect(await renaming).toEqual({ id: 'c1' });
    expect(sent['/api/conversations/c1']).toEqual([null, 'new']);
    expect(bodies.filter((b) => (b as { title?: string }).title)).toEqual([{ title: 'Renamed' }, { title: 'Renamed' }]);
    expect(signedOutEvents).toBe(0);
  });

  it('is not sent again once it was aborted while it waited', async () => {
    writeKey('old');
    let login!: (r: Response) => void;
    server((path) => (path === '/api/auth/login' ? new Promise<Response>((r) => (login = r)) : answer(401, SIGNED_OUT)));
    const signingIn = api.signIn('ABCD-EFGH');
    const stop = new AbortController();
    const picking = api.pickCwd('/', stop.signal).catch((e: unknown) => e);
    await settle();
    stop.abort();
    login(answer(200, { key: 'new' }));
    await signingIn;
    expect(((await picking) as Error).name).toBe('AbortError');
    expect(sent['/api/cwds/pick']).toEqual(['old']);
    expect(signedOutEvents).toBe(0);
  });

  it("does not let the sign-in's own request wait for itself", async () => {
    // Never answered so (the sign-in route takes no session), but if it were, it must not hang.
    server(() => answer(401, SIGNED_OUT));
    expect(await api.signIn('ABCD-EFGH').catch((e: unknown) => e)).toBeInstanceOf(ApiError);
    expect(signedOutEvents).toBe(0);
  });

  it('is decided when a sign-in that never answers is given up', async () => {
    vi.useFakeTimers();
    writeKey('old');
    server((path, _key, init) =>
      path === '/api/auth/login'
        ? new Promise<Response>((_, reject) => init.signal?.addEventListener('abort', () => reject(init.signal?.reason)))
        : answer(401, SIGNED_OUT),
    );
    const signingIn = api.signIn('ABCD-EFGH').catch((e: unknown) => e);
    const listing = api.listConversations().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(SIGN_IN_TIMEOUT_MS - 1);
    expect(signedOutEvents).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    // The sign-in says the server did not answer; the request waiting for it is decided then.
    expect(((await signingIn) as Error).message).toBe(en.signIn.noAnswer);
    expect(await listing).toBeInstanceOf(ApiError);
    expect(signedOutEvents).toBe(1);
    expect(readKey()).toBe('old');
  });

  it('keeps no key from a sign-in answer cut short, and says the server did not answer', async () => {
    // Given up while the answer was read: its body reads as nothing.
    writeKey('old');
    server(
      () =>
        ({
          ok: true,
          status: 200,
          json: () => Promise.reject(new DOMException('The request timed out.', 'TimeoutError')),
        }) as unknown as Response,
    );
    expect(((await api.signIn('ABCD-EFGH').catch((e: unknown) => e)) as Error).message).toBe(en.signIn.noAnswer);
    expect(readKey()).toBe('old');
  });

  it('says the server did not answer when the time ran out while an error answer was read', async () => {
    vi.useFakeTimers();
    server(
      (_path, _key, init) =>
        new Promise<Response>((resolve) =>
          init.signal?.addEventListener('abort', () =>
            resolve({
              ok: false,
              status: 400,
              statusText: 'Bad Request',
              json: () => Promise.reject(init.signal?.reason),
            } as unknown as Response),
          ),
        ),
    );
    const signingIn = api.signIn('WXYZ-0000').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(SIGN_IN_TIMEOUT_MS);
    expect(((await signingIn) as Error).message).toBe(en.signIn.noAnswer);
  });

  it('fails as given up when a request is given up while its answer is read', async () => {
    writeKey('old');
    const stop = new AbortController();
    server(
      () =>
        ({
          ok: true,
          status: 200,
          json: () => {
            stop.abort();
            return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
          },
        }) as unknown as Response,
    );
    const err = (await api.pickCwd('/', stop.signal).catch((e: unknown) => e)) as Error;
    expect(err.name).toBe('AbortError');
  });

  it("gives the server's own answer when it came just as the time ran out", async () => {
    vi.useFakeTimers();
    server((_path, _key, init) => {
      // The answer "wrong code" arrives as the time limit aborts the request.
      return new Promise<Response>((resolve) =>
        init.signal?.addEventListener('abort', () => resolve(answer(400, { error: 'That code is wrong or has expired.' }))),
      );
    });
    const signingIn = api.signIn('WXYZ-0000').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(SIGN_IN_TIMEOUT_MS);
    const err = (await signingIn) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toBe('That code is wrong or has expired.');
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

describe("another tab's change to the key", () => {
  const KEY_NAME = 'relay:key';

  it('is a sign-in when it keeps a new key, and nothing else is', () => {
    expect(keyArrived({ key: KEY_NAME, newValue: 'new' })).toBe(true);
    expect(keyArrived({ key: KEY_NAME, newValue: null })).toBe(false); // signed out on purpose
    expect(keyArrived({ key: null, newValue: null })).toBe(false); // the storage cleared
    expect(keyArrived({ key: 'relay:lang', newValue: 'en' })).toBe(false);
  });
});
