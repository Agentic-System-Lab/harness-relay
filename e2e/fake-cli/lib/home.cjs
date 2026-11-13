'use strict';
/*
 * What a fake keeps in its CLI's home (`self.home()`, the test's own): its sign-in, its sessions and
 * the messages it has answered before. Each account of a CLI has a home of its own.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { record } = require('./log.cjs');
const self = require('./self.cjs');

/** Whether `key` is the one the test expects (E2E_EXPECTED_API_KEY): what the fakes say of a key, never the key. */
function keyVerdict(key) {
  return key === process.env.E2E_EXPECTED_API_KEY ? 'expected' : 'other';
}

/**
 * Its sign-in, kept in its home as the real ones keep theirs: signed in (as e2e@example.com) until
 * signed out there (`auth logout`, `logout`), which leaves `e2e-signed-out`; signing in again
 * (`auth login`) takes it away, as the account the code pasted names when it is an email address.
 * Codex's `login --with-api-key` signs in with the key on stdin, keeping only `keyVerdict` of it.
 */
const signIn = {
  out: () => path.join(self.home(), 'e2e-signed-out'),
  account: () => path.join(self.home(), 'e2e-account'),
  apiKey: () => path.join(self.home(), 'e2e-api-key'),
  email() {
    try {
      return fs.readFileSync(this.account(), 'utf8').trim() || 'e2e@example.com';
    } catch {
      return 'e2e@example.com';
    }
  },
  logout() {
    fs.mkdirSync(self.home(), { recursive: true });
    fs.writeFileSync(this.out(), '');
    fs.rmSync(this.account(), { force: true });
    fs.rmSync(this.apiKey(), { force: true });
  },
  login(code) {
    fs.mkdirSync(self.home(), { recursive: true });
    fs.rmSync(this.out(), { force: true });
    if (/^[^\s@]+@[^\s@]+$/.test(code)) fs.writeFileSync(this.account(), code);
    else fs.rmSync(this.account(), { force: true });
  },
  /** Codex: signed in with an API key, which replaces the sign-in it had. */
  loginWithApiKey(key) {
    fs.mkdirSync(self.home(), { recursive: true });
    fs.rmSync(this.out(), { force: true });
    fs.rmSync(this.account(), { force: true });
    fs.writeFileSync(this.apiKey(), keyVerdict(key));
  },
};

let signedOutNow;
/**
 * Whether it is signed out: E2E_FAKE_SIGNED_OUT (a list of provider ids: `codex,cursor`) names it,
 * or its home was signed out. Found once, when first asked: a process is signed in or out throughout.
 */
function signedOut() {
  if (signedOutNow === undefined) {
    signedOutNow =
      (process.env.E2E_FAKE_SIGNED_OUT || '')
        .split(',')
        .map((c) => c.trim().toLowerCase())
        .includes(self.cli()) || fs.existsSync(signIn.out());
  }
  return signedOutNow;
}

/** Sessions, kept in the CLI's home: started ones can be resumed, others cannot. */
const sessions = {
  file: (id) => path.join(self.home(), 'e2e-sessions', encodeURIComponent(id)),
  start(id) {
    fs.mkdirSync(path.dirname(this.file(id)), { recursive: true });
    fs.writeFileSync(this.file(id), '');
    record({ session: id, resumed: false });
  },
  resume(id) {
    if (!fs.existsSync(this.file(id))) return false;
    record({ session: id, resumed: true });
    return true;
  },
};

/** Whether this CLI sees `text` for the first time (remembered in its home, which is the test's own). */
function firstTime(text) {
  const mark = path.join(self.home(), `e2e-seen-${crypto.createHash('sha1').update(text).digest('hex')}`);
  if (fs.existsSync(mark)) return false;
  fs.mkdirSync(path.dirname(mark), { recursive: true });
  fs.writeFileSync(mark, '');
  return true;
}

/**
 * How much of its plan the account signed in here has used, as each fake reports it (Claude Code's
 * `get_usage`, Codex's `account/rateLimits/read`, Grok's `_x.ai/billing`, `muse usage --json`): 42%
 * for the default sign-in (e2e@example.com), 7% for any other, so that each account shows its own.
 */
function planUsedPercent() {
  const used = signIn.email() === 'e2e@example.com' ? 42 : 7;
  record({ usage: used, home: self.home() });
  return used;
}

/** When the fakes' plan windows start over: five hours, and a week, from now (ms since the epoch). */
const planResets = { fiveHour: () => Date.now() + 5 * 3600_000, week: () => Date.now() + 7 * 86_400_000 };

module.exports = { keyVerdict, signIn, signedOut, sessions, firstTime, planUsedPercent, planResets };
