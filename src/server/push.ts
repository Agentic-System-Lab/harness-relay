import { createCipheriv, createECDH, createHash, createHmac, createPrivateKey, randomBytes, sign, type KeyObject } from 'node:crypto';
import type { AlertPayload, AlertPrefs, Lang, PushStatus, PushSubscriptionJson } from '../shared/types';
import { LANGS } from '../shared/types';
import { nul, transaction, type Database } from './db';
import { t } from './i18n';

/*
 * Push notifications (Web Push), so that a phone, or a browser with no Harness Relay page open, hears
 * when agents finish or need the user. A browser that turns notifications on subscribes with its push
 * service (Google's for Chrome and Android, Apple's for Safari and iPhone, Mozilla's for Firefox,
 * Microsoft's for Edge) and gives this server its subscription: the push service's address for it and
 * the keys to encrypt for it. The server then sends each notification there, encrypted end to end
 * (RFC 8291: the push service cannot read it) and signed with this server's own key (VAPID, RFC 8292),
 * and the push service wakes the browser's service worker (`src/web/public/sw.js`), which shows it.
 *
 * Nothing here needs a library: node:crypto has the P-256 keys, ECDH, HMAC (HKDF) and AES-GCM.
 */

/** Whom push services may contact about this sender (VAPID's `sub`): the project, never the user. */
export const VAPID_SUBJECT = 'https://agentic-system-lab.github.io/harness-relay/';

/**
 * The push services a subscription may point at (a host or one under it). The server only ever sends
 * to these, so a subscription cannot make it send requests elsewhere (into the local network, say).
 */
export const PUSH_HOSTS = ['fcm.googleapis.com', 'android.googleapis.com', 'push.services.mozilla.com', 'push.apple.com', 'notify.windows.com'];

/** The longest push service address taken. */
const MAX_ENDPOINT = 2048;

/** Why a push service address is refused, or undefined when it is one of `PUSH_HOSTS` over HTTPS. */
export function endpointProblem(endpoint: string): string | undefined {
  if (endpoint.length > MAX_ENDPOINT) return t().pushEndpointRefused(endpoint.slice(0, 60));
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return t().pushEndpointRefused(endpoint.slice(0, 60));
  }
  const host = url.hostname.toLowerCase();
  const known = PUSH_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  if (url.protocol !== 'https:' || !known || url.username || url.password || url.port) return t().pushEndpointRefused(host);
  return undefined;
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const hmac = (key: Buffer, data: Buffer) => createHmac('sha256', key).update(data).digest();

/** The record size each message says it has (RFC 8188); a message is one record, far smaller. */
const RECORD_SIZE = 4096;
/** The most a push service takes in one message, and so the largest payload (header and tag aside). */
export const MAX_PUSH_BYTES = 4096;
const HEADER_BYTES = 16 + 4 + 1 + 65;

/**
 * Encrypts a push message for a browser (RFC 8291, `aes128gcm`): `uaPublic` and `authSecret` are the
 * subscription's keys. `asPrivate` and `salt` are fresh for each message (given in tests only, to
 * check against the RFC's example).
 */
export function encryptPush(plaintext: Buffer, uaPublic: Buffer, authSecret: Buffer, o: { asPrivate?: Buffer; salt?: Buffer } = {}): Buffer {
  const ecdh = createECDH('prime256v1');
  if (o.asPrivate) ecdh.setPrivateKey(o.asPrivate);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const salt = o.salt ?? randomBytes(16);
  const secret = ecdh.computeSecret(uaPublic);
  // HKDF with SHA-256, each output shorter than one hash: HMAC(PRK, info || 0x01).
  const prkKey = hmac(authSecret, secret);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  // 0x02: the last (and only) record, with no padding.
  const body = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(HEADER_BYTES - 65);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, body]);
}

/** This server's key pair for VAPID (P-256): the public key uncompressed (65 bytes), the private key (32), base64url. */
export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

export function generateVapidKeys(): VapidKeys {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: b64(ecdh.getPublicKey()), privateKey: b64(pad32(ecdh.getPrivateKey())) };
}

const pad32 = (b: Buffer) => (b.length >= 32 ? b : Buffer.concat([Buffer.alloc(32 - b.length), b]));

function vapidKeyObject(keys: VapidKeys): KeyObject {
  const pub = Buffer.from(keys.publicKey, 'base64url');
  return createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', d: keys.privateKey, x: b64(pub.subarray(1, 33)), y: b64(pub.subarray(33, 65)) },
    format: 'jwk',
  });
}

/** How long a VAPID token is good for (push services take at most 24 hours). */
const VAPID_TTL_S = 12 * 60 * 60;

/**
 * The `Authorization` header for a message to `endpoint` (RFC 8292): a token signed with this server's
 * key (ES256) for that push service, and the public key it checks it with.
 */
export function vapidAuthorization(endpoint: string, keys: VapidKeys, now = Date.now()): string {
  const header = b64(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + VAPID_TTL_S, sub: VAPID_SUBJECT }));
  const signature = sign('sha256', Buffer.from(`${header}.${claims}`), { key: vapidKeyObject(keys), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${b64(signature)}, k=${keys.publicKey}`;
}

/** A message to send to a push service: what `PushSender` posts. */
export interface PushRequest {
  endpoint: string;
  headers: Record<string, string>;
  body: Buffer;
}

/** Posts a message to a push service and gives its status (fetch; a fake in tests). */
export type PushSender = (req: PushRequest) => Promise<{ status: number; text: string }>;

/** How long a push service may take to answer. */
const SEND_TIMEOUT_MS = 15_000;

export const fetchPush: PushSender = async ({ endpoint, headers, body }) => {
  const res = await fetch(endpoint, { method: 'POST', headers, body: new Uint8Array(body), redirect: 'error', signal: AbortSignal.timeout(SEND_TIMEOUT_MS) });
  return { status: res.status, text: (await res.text().catch(() => '')).slice(0, 500) };
};

/** How a push went: delivered to the push service, the subscription is gone (and was removed), or it failed. */
export type PushResult = 'sent' | 'gone' | 'failed';

/**
 * A short label for a conversation's messages (`Topic`, at most 32 base64url characters): while a
 * phone is offline, a push service keeps only the latest message of each.
 */
export const pushTopic = (key: string) => createHash('sha256').update(key).digest('base64url').slice(0, 32);

/** A browser's subscription, as kept. */
export interface PushSubscriptionRecord {
  endpoint: string;
  p256dh: string;
  auth: string;
  /** The signed-in browser it belongs to (none when the server takes no sign-in: tests). */
  sessionId?: string;
  prefs: AlertPrefs;
  /** The language its notifications are written in (the UI's when it last subscribed). */
  lang: Lang;
}

interface SubscriptionRow {
  endpoint: string;
  session_id: string | null;
  p256dh: string;
  auth: string;
  prefs: string;
  lang: string;
}

/** The most subscriptions remembered as gone (`PushService.gone`); then it starts over. */
const MAX_GONE = 1000;

/** The app setting with this server's VAPID key pair. */
const VAPID_SETTING = 'push_vapid';

/** The public key of a private VAPID key (base64url), or undefined when it is not one. */
function publicKeyOf(privateKey: string): string | undefined {
  const d = decodeKey(privateKey, 32);
  if (!d) return undefined;
  try {
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(d);
    return b64(ecdh.getPublicKey());
  } catch {
    return undefined;
  }
}

const decodeKey = (value: string, bytes: number, first?: number): Buffer | undefined => {
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(value)) return undefined;
  const b = Buffer.from(value, 'base64url');
  return b.length === bytes && (first === undefined || b[0] === first) ? b : undefined;
};

/** Whether a public key is a point of P-256 (one could share a secret with it). */
function onCurve(key: Buffer): boolean {
  try {
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    ecdh.computeSecret(key);
    return true;
  } catch {
    return false;
  }
}

/** A subscription's keys, decoded: the browser's public key (P-256, uncompressed) and its auth secret. */
export function subscriptionKeys(s: Pick<PushSubscriptionRecord, 'p256dh' | 'auth'>): { uaPublic: Buffer; auth: Buffer } | undefined {
  const uaPublic = decodeKey(s.p256dh, 65, 4);
  const auth = decodeKey(s.auth, 16);
  return uaPublic && auth && onCurve(uaPublic) ? { uaPublic, auth } : undefined;
}

/**
 * The push subscriptions of signed-in browsers (`push_subscriptions`, removed with their browser's
 * session when it signs out), this server's VAPID keys, and sending.
 */
export class PushService {
  private keys?: VapidKeys;
  private keyError?: string;
  /** Subscriptions their push service said are gone, since the server started: not taken again. */
  private gone = new Set<string>();

  constructor(
    private readonly db: Database,
    private readonly send: PushSender = fetchPush,
    private readonly now: () => number = Date.now,
  ) {}

  /** The public key browsers subscribe with (made the first time it is asked for), or why there is none. */
  status(): PushStatus {
    const keys = this.vapid();
    return keys ? { publicKey: keys.publicKey } : { error: this.keyError ?? t().pushUnavailable('') };
  }

  /**
   * This server's VAPID key pair, made the first time it is asked for and kept in the database
   * (`app_settings`: owner-only, and kept from agents below full access like the rest of it). Never in
   * the system keyring: a locked one asks to be unlocked, which a server running as a service cannot
   * show and a dismissed prompt leaves unanswered, and push would stop. The key only signs this
   * server's own notifications. A pair whose private key is missing or does not go with its public key
   * (one an earlier build kept in the keyring) is made anew, and the subscriptions made with the old
   * one are removed: their browsers subscribe again when opened.
   */
  private vapid(): VapidKeys | undefined {
    if (this.keys) return this.keys;
    const row = this.db.prepare('SELECT value FROM app_settings WHERE key = ?').get(VAPID_SETTING) as { value: string } | undefined;
    let saved: Partial<VapidKeys> = {};
    try {
      saved = row ? (JSON.parse(row.value) as Partial<VapidKeys>) : {};
    } catch {
      /* broken: made again */
    }
    if (saved.publicKey && saved.privateKey && publicKeyOf(saved.privateKey) === saved.publicKey) {
      this.keys = { publicKey: saved.publicKey, privateKey: saved.privateKey };
      return this.keys;
    }
    const fresh = generateVapidKeys();
    try {
      transaction(this.db, () => {
        this.db
          .prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
          .run(VAPID_SETTING, JSON.stringify(fresh));
        this.db.prepare('DELETE FROM push_subscriptions').run();
      });
    } catch (err) {
      this.keyError = t().pushUnavailable((err as Error).message);
      return undefined;
    }
    this.keys = fresh;
    return fresh;
  }

  /**
   * Keeps (or updates) a browser's subscription, for the signed-in browser `sessionId`: `taken` when
   * another signed-in browser has it, `gone` when its push service said it is gone (the browser then
   * subscribes anew; known while the server runs).
   */
  subscribe(sessionId: string | undefined, sub: PushSubscriptionJson, prefs: AlertPrefs, lang: Lang): 'ok' | 'taken' | 'gone' {
    if (!this.vapid()) throw new Error(this.keyError ?? t().pushUnavailable(''));
    if (this.gone.has(sub.endpoint)) return 'gone';
    const changed = this.db
      .prepare(
        `INSERT INTO push_subscriptions (endpoint, session_id, p256dh, auth, prefs, lang, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, prefs = excluded.prefs, lang = excluded.lang
         WHERE push_subscriptions.session_id IS excluded.session_id`,
      )
      .run(sub.endpoint, nul(sessionId), sub.keys.p256dh, sub.keys.auth, JSON.stringify(prefs), lang, this.now()).changes;
    return changed > 0 ? 'ok' : 'taken';
  }

  /** Removes a browser's subscription; only its own browser's session (or anyone without sign-in) may. */
  unsubscribe(sessionId: string | undefined, endpoint: string): boolean {
    return this.db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND session_id IS ?').run(endpoint, nul(sessionId)).changes > 0;
  }

  /** Every browser's subscription. */
  subscriptions(): PushSubscriptionRecord[] {
    const rows = this.db.prepare('SELECT * FROM push_subscriptions ORDER BY created_at').all() as unknown as SubscriptionRow[];
    return rows.map((r) => ({
      endpoint: r.endpoint,
      p256dh: r.p256dh,
      auth: r.auth,
      ...(r.session_id ? { sessionId: r.session_id } : {}),
      prefs: parsePrefs(r.prefs),
      lang: (LANGS as string[]).includes(r.lang) ? (r.lang as Lang) : 'zh-TW',
    }));
  }

  /** The subscription of `endpoint`, when it belongs to `sessionId`'s browser. */
  subscription(sessionId: string | undefined, endpoint: string): PushSubscriptionRecord | undefined {
    return this.subscriptions().find((s) => s.endpoint === endpoint && s.sessionId === sessionId);
  }

  hasSubscriptions(): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM push_subscriptions LIMIT 1').get());
  }

  /**
   * Sends a notification to one browser. A subscription its push service says is gone (404, 410), or
   * no longer takes this server's key (401, 403), is removed; its browser subscribes again when opened.
   */
  async push(sub: PushSubscriptionRecord, payload: AlertPayload, o: { urgency?: 'normal' | 'high'; ttl?: number; topic?: string } = {}): Promise<PushResult> {
    const keys = this.vapid();
    const decoded = subscriptionKeys(sub);
    if (!keys || !decoded || endpointProblem(sub.endpoint)) return 'failed';
    let body: Buffer;
    try {
      body = encryptPush(fitPayload(payload), decoded.uaPublic, decoded.auth);
    } catch (err) {
      console.warn(`[push] could not encrypt for ${new URL(sub.endpoint).host}: ${(err as Error).message}`);
      return 'failed';
    }
    const headers: Record<string, string> = {
      Authorization: vapidAuthorization(sub.endpoint, keys, this.now()),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(o.ttl ?? 6 * 60 * 60),
      Urgency: o.urgency ?? 'normal',
      ...(o.topic ? { Topic: o.topic } : {}),
    };
    try {
      const res = await this.send({ endpoint: sub.endpoint, headers, body });
      if (res.status >= 200 && res.status < 300) return 'sent';
      if ([401, 403, 404, 410].includes(res.status)) {
        transaction(this.db, () => this.db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(sub.endpoint));
        if (this.gone.size >= MAX_GONE) this.gone.clear();
        this.gone.add(sub.endpoint);
        return 'gone';
      }
      console.warn(`[push] ${new URL(sub.endpoint).host} answered ${res.status}: ${res.text}`);
    } catch (err) {
      console.warn(`[push] could not reach ${new URL(sub.endpoint).host}: ${(err as Error).message}`);
    }
    return 'failed';
  }
}

/** Saved preferences; what is missing or not a boolean is on (as a browser turns them on). */
export function parsePrefs(value: string): AlertPrefs {
  let raw: Partial<Record<keyof AlertPrefs, unknown>> = {};
  try {
    raw = (JSON.parse(value) as typeof raw) ?? {};
  } catch {
    /* defaults */
  }
  return { done: raw.done !== false, needs: raw.needs !== false, sound: raw.sound !== false };
}

/** The payload as JSON, its text shortened until it fits in one push message. */
export function fitPayload(payload: AlertPayload): Buffer {
  const room = MAX_PUSH_BYTES - HEADER_BYTES - 17;
  let p = payload;
  let json = Buffer.from(JSON.stringify(p));
  while (json.length > room && (p.body.length > 0 || p.title.length > 1)) {
    p = p.body.length > 0 ? { ...p, body: p.body.slice(0, Math.floor(p.body.length / 2)) } : { ...p, title: p.title.slice(0, Math.floor(p.title.length / 2)) };
    json = Buffer.from(JSON.stringify(p));
  }
  return json;
}
