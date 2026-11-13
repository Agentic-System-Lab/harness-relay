import { createDecipheriv, createECDH, createHmac, createPublicKey, verify } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { AuthStore, CODE_TTL_MS, SESSION_MAX_AGE_S } from '../src/server/auth';
import { withLang } from '../src/server/i18n';
import { openDatabase, type Database } from '../src/server/db';
import {
  MAX_PER_BROWSER,
  MAX_PUSH_BYTES,
  PushService,
  VAPID_SUBJECT,
  encryptPush,
  endpointProblem,
  fitPayload,
  generateVapidKeys,
  parsePrefs,
  pushTopic,
  subscriptionKeys,
  vapidAuthorization,
  type PushRequest,
  type VapidKeys,
} from '../src/server/push';
import type { AlertPayload } from '../src/shared/types';

const b = (s: string) => Buffer.from(s.replace(/\s+/g, ''), 'base64url');
const hmac = (key: Buffer, data: Buffer) => createHmac('sha256', key).update(data).digest();

/** What a browser does with a push message (RFC 8291, the receiving side): its plaintext. */
function decrypt(body: Buffer, uaPrivate: Buffer, authSecret: Buffer): Buffer {
  const salt = body.subarray(0, 16);
  const idlen = body[20]!;
  const asPublic = body.subarray(21, 21 + idlen);
  const sealed = body.subarray(21 + idlen);
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(uaPrivate);
  const uaPublic = ecdh.getPublicKey();
  const prkKey = hmac(authSecret, ecdh.computeSecret(asPublic));
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(sealed.subarray(-16));
  const padded = Buffer.concat([decipher.update(sealed.subarray(0, -16)), decipher.final()]);
  return padded.subarray(0, padded.lastIndexOf(2));
}

/** A browser's side of a subscription: its keys, and the subscription it gives the server. */
function browser(endpoint = 'https://fcm.googleapis.com/fcm/send/abc123') {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = Buffer.from('0123456789abcdef');
  return {
    private: ecdh.getPrivateKey(),
    auth,
    sub: { endpoint, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } },
  };
}

const payload: AlertPayload = { title: 'Fix the login page', body: 'Claude finished replying', tag: 'relay-c1', url: '/#/c/c1', silent: false, kind: 'done' };
const prefs = { done: true, needs: true, sound: true };

describe('push message encryption (RFC 8291)', () => {
  // Section 5's message (the ciphertext in the RFC's appendix A does not go with its own inputs).
  it('gives the RFC\'s own example, byte for byte', () => {
    const body = encryptPush(
      b('V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24'),
      b('BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcx aOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4'),
      b('BTBZMqHH6r4Tts7J_aSIgg'),
      { asPrivate: b('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'), salt: b('DGv6ra1nlYgDCS1FRnbzlw') },
    );
    expect(body.toString('base64url')).toBe(
      'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT' +
        'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
    );
  });

  it('is read by the browser it was made for, with fresh keys and salt each time', () => {
    const ua = browser();
    const { uaPublic, auth } = subscriptionKeys(ua.sub.keys)!;
    const one = encryptPush(Buffer.from('hello'), uaPublic, auth);
    const two = encryptPush(Buffer.from('hello'), uaPublic, auth);
    expect(decrypt(one, ua.private, ua.auth).toString()).toBe('hello');
    expect(one.subarray(0, 16).equals(two.subarray(0, 16))).toBe(false);
    expect(one.readUInt32BE(16)).toBe(4096);
    expect(() => decrypt(one, ua.private, Buffer.from('fedcba9876543210'))).toThrow();
  });
});

describe('VAPID (RFC 8292)', () => {
  it('signs a token for the push service the browser subscribed with, which its public key verifies', () => {
    const keys = generateVapidKeys();
    const header = vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', keys, 1_700_000_000_000);
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header)!;
    expect(m).toBeTruthy();
    expect(m[4]).toBe(keys.publicKey);
    expect(JSON.parse(b(m[1]!).toString())).toEqual({ typ: 'JWT', alg: 'ES256' });
    expect(JSON.parse(b(m[2]!).toString())).toEqual({ aud: 'https://fcm.googleapis.com', exp: 1_700_000_000 + 12 * 3600, sub: VAPID_SUBJECT });
    const pub = b(keys.publicKey);
    const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, format: 'jwk' });
    expect(verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key, dsaEncoding: 'ieee-p1363' }, b(m[3]!))).toBe(true);
    expect(b(keys.privateKey)).toHaveLength(32);
    expect(pub).toHaveLength(65);
  });
});

describe('push subscriptions', () => {
  it('takes only the push services of browsers, over HTTPS', () => {
    for (const ok of [
      'https://fcm.googleapis.com/fcm/send/x',
      'https://updates.push.services.mozilla.com/wpush/v2/x',
      'https://web.push.apple.com/QH1y',
      'https://wns2-par02p.notify.windows.com/w/?token=x',
    ]) {
      expect(endpointProblem(ok), ok).toBeUndefined();
    }
    for (const bad of [
      'http://fcm.googleapis.com/fcm/send/x',
      'https://127.0.0.1/x',
      'https://evilfcm.googleapis.com.example/x',
      'https://notgoogleapis.com/x',
      'https://fcm.googleapis.com:8443/x',
      'https://user:pw@fcm.googleapis.com/x',
      'not a url',
      `https://fcm.googleapis.com/${'x'.repeat(2100)}`,
    ]) {
      expect(endpointProblem(bad), bad).toBeTruthy();
    }
  });

  it('reads keys only of the right length: a P-256 public key (uncompressed) and a 16-byte secret', () => {
    const ua = browser();
    expect(subscriptionKeys(ua.sub.keys)).toBeTruthy();
    expect(subscriptionKeys({ p256dh: ua.sub.keys.p256dh.slice(4), auth: ua.sub.keys.auth })).toBeUndefined();
    expect(subscriptionKeys({ p256dh: ua.sub.keys.p256dh, auth: 'AAAA' })).toBeUndefined();
    expect(subscriptionKeys({ p256dh: 'not base64!', auth: ua.sub.keys.auth })).toBeUndefined();
    // 65 bytes from 0x04, but no point of the curve.
    expect(subscriptionKeys({ p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString('base64url'), auth: ua.sub.keys.auth })).toBeUndefined();
  });

  it('reads saved preferences, each on unless saved off', () => {
    expect(parsePrefs('{"done":false,"needs":true,"sound":false}')).toEqual({ done: false, needs: true, sound: false });
    expect(parsePrefs('broken')).toEqual({ done: true, needs: true, sound: true });
  });

  it('shortens a payload until it fits in one message', () => {
    expect(JSON.parse(fitPayload(payload).toString())).toEqual(payload);
    const long = fitPayload({ ...payload, body: 'x'.repeat(10_000), title: 'y'.repeat(5000) });
    expect(long.length).toBeLessThanOrEqual(MAX_PUSH_BYTES - 86 - 17);
    expect(JSON.parse(long.toString()).url).toBe(payload.url);
  });

  it('labels the messages of one conversation alike, as a push service takes a Topic', () => {
    expect(pushTopic('c1')).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(pushTopic('c1')).toBe(pushTopic('c1'));
    expect(pushTopic('c2')).not.toBe(pushTopic('c1'));
  });
});

describe('PushService', () => {
  let db: Database;
  let sent: PushRequest[];
  let status: number;
  const sender = async (req: PushRequest) => {
    sent.push(req);
    return { status, text: '' };
  };

  beforeEach(() => {
    db = openDatabase(':memory:');
    sent = [];
    status = 201;
  });

  it('makes its keys when first asked and keeps them in the database, never in the keyring', () => {
    const push = new PushService(db, sender);
    const { publicKey } = push.status();
    expect(publicKey && b(publicKey)).toHaveLength(65);
    const row = () => JSON.parse((db.prepare("SELECT value FROM app_settings WHERE key = 'push_vapid'").get() as { value: string }).value) as VapidKeys;
    expect(row().publicKey).toBe(publicKey);
    expect(b(row().privateKey)).toHaveLength(32);
    // The same pair at the next start.
    expect(new PushService(db, sender).status()).toEqual({ publicKey });
    // The private key goes with the public one: what it signs, the public key verifies.
    const header = vapidAuthorization('https://web.push.apple.com/x', row(), Date.now());
    expect(header.endsWith(`k=${publicKey}`)).toBe(true);
  });

  it('makes new keys when the private one is missing or not the public one\'s, dropping the subscriptions made with the old', () => {
    const push = new PushService(db, sender);
    const { publicKey } = push.status();
    push.subscribe(undefined, browser().sub, prefs, 'en');
    // As an earlier build left it: the private key in the system keyring, only the public one here.
    db.prepare("UPDATE app_settings SET value = ? WHERE key = 'push_vapid'").run(JSON.stringify({ publicKey, keyring: true }));
    const again = new PushService(db, sender);
    const fresh = again.status().publicKey;
    expect(fresh).toBeTruthy();
    expect(fresh).not.toBe(publicKey);
    expect(again.subscriptions()).toEqual([]);
    // A private key of another pair.
    const other = generateVapidKeys();
    again.subscribe(undefined, browser().sub, prefs, 'en');
    db.prepare("UPDATE app_settings SET value = ? WHERE key = 'push_vapid'").run(JSON.stringify({ publicKey: fresh, privateKey: other.privateKey }));
    const third = new PushService(db, sender);
    expect(third.status().publicKey).not.toBe(fresh);
    expect(third.hasSubscriptions()).toBe(false);
  });

  it('says why it has no keys in the language of each request, not the first one', () => {
    // The database refuses the new key (full, say).
    db.exec("CREATE TRIGGER no_keys BEFORE INSERT ON app_settings BEGIN SELECT RAISE(ABORT, 'disk full'); END");
    const push = new PushService(db, sender);
    expect(withLang('en', () => push.status().error)).toMatch(/^This server cannot send push notifications now \(disk full\)/);
    expect(withLang('zh-TW', () => push.status().error)).toMatch(/^這台伺服器現在無法送出推播通知（disk full）/);
  });

  it('sends nothing to a browser whose session is past its time, though its session is still there', () => {
    const auth = new AuthStore(db);
    const old = auth.redeem(auth.createCode(CODE_TTL_MS.device).code, 'Safari · iOS')!.id;
    db.prepare('UPDATE auth_sessions SET created_at = ? WHERE id = ?').run(Date.now() - SESSION_MAX_AGE_S * 1000 - 1, old);
    const push = new PushService(db, sender);
    push.subscribe(old, browser().sub, prefs, 'en');
    expect(push.subscriptions()).toEqual([]);
    expect(push.hasSubscriptions()).toBe(false);
  });

  it("keeps a browser's latest subscriptions only", () => {
    let clock = 1_000;
    const push = new PushService(db, sender, () => clock);
    const endpoints = Array.from({ length: MAX_PER_BROWSER + 2 }, (_, i) => `https://fcm.googleapis.com/fcm/send/${i}`);
    for (const e of endpoints) {
      clock += 1;
      push.subscribe(undefined, browser(e).sub, prefs, 'en');
    }
    expect(push.subscriptions().map((s) => s.endpoint)).toEqual(endpoints.slice(2));
  });

  it('keeps one subscription per browser, removed with its signed-in browser', () => {
    const auth = new AuthStore(db);
    const signIn = () => auth.redeem(auth.createCode(CODE_TTL_MS.device).code, 'Safari · iOS')!.id;
    const phone = signIn();
    const laptop = signIn();
    const push = new PushService(db, sender);
    const a = browser('https://web.push.apple.com/a');
    const c = browser('https://fcm.googleapis.com/fcm/send/c');
    push.subscribe(phone, a.sub, prefs, 'zh-TW');
    push.subscribe(phone, a.sub, { ...prefs, sound: false }, 'en');
    push.subscribe(laptop, c.sub, prefs, 'en');
    expect(push.subscriptions().map((s) => [s.endpoint, s.sessionId, s.prefs.sound, s.lang])).toEqual([
      [a.sub.endpoint, phone, false, 'en'],
      [c.sub.endpoint, laptop, true, 'en'],
    ]);
    expect(push.subscription(laptop, a.sub.endpoint)).toBeUndefined();
    // Another signed-in browser cannot take it over.
    expect(push.subscribe(laptop, { ...a.sub, keys: c.sub.keys }, prefs, 'en')).toBe('taken');
    expect(push.subscription(phone, a.sub.endpoint)?.p256dh).toBe(a.sub.keys.p256dh);
    // Only its own browser removes it.
    expect(push.unsubscribe(laptop, a.sub.endpoint)).toBe(false);
    auth.revoke(phone);
    expect(push.subscriptions().map((s) => s.endpoint)).toEqual([c.sub.endpoint]);
    expect(push.unsubscribe(laptop, c.sub.endpoint)).toBe(true);
    expect(push.hasSubscriptions()).toBe(false);
  });

  it('posts an encrypted, signed message the browser can read', async () => {
    const push = new PushService(db, sender, () => 1_700_000_000_000);
    const ua = browser();
    push.subscribe(undefined, ua.sub, prefs, 'en');
    expect(await push.push(push.subscriptions()[0]!, payload, { urgency: 'high', ttl: 60, topic: pushTopic('c1') })).toBe('sent');
    const [req] = sent;
    expect(req!.endpoint).toBe(ua.sub.endpoint);
    expect(req!.headers).toMatchObject({ 'Content-Encoding': 'aes128gcm', TTL: '60', Urgency: 'high', Topic: pushTopic('c1') });
    expect(req!.headers.Authorization).toMatch(/^vapid t=.+, k=/);
    expect(JSON.parse(decrypt(req!.body, ua.private, ua.auth).toString())).toEqual(payload);
  });

  it('removes a subscription its push service says is gone, and keeps one that failed for now', async () => {
    const push = new PushService(db, sender);
    push.subscribe(undefined, browser().sub, prefs, 'en');
    const sub = push.subscriptions()[0]!;
    status = 500;
    expect(await push.push(sub, payload)).toBe('failed');
    expect(push.hasSubscriptions()).toBe(true);
    status = 410;
    expect(await push.push(sub, payload)).toBe('gone');
    expect(push.hasSubscriptions()).toBe(false);
    // Given again, it is refused: the browser subscribes anew.
    expect(push.subscribe(undefined, { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, prefs, 'en')).toBe('gone');
    for (const refused of [401, 403, 404]) {
      push.subscribe(undefined, browser(`https://fcm.googleapis.com/fcm/send/${refused}`).sub, prefs, 'en');
      status = refused;
      expect(await push.push(push.subscriptions()[0]!, payload), String(refused)).toBe('gone');
      expect(push.hasSubscriptions()).toBe(false);
    }
    // One kept from before that is not a push service's address now: never sent to.
    status = 201;
    const before = sent.length;
    expect(await push.push({ ...sub, endpoint: 'https://127.0.0.1/push' }, payload)).toBe('failed');
    expect(sent).toHaveLength(before);
    const thrown = new PushService(db, async () => {
      throw new Error('offline');
    });
    thrown.subscribe(undefined, browser().sub, prefs, 'en');
    expect(await thrown.push(thrown.subscriptions()[0]!, payload)).toBe('failed');
  });
});
