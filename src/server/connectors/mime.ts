import { randomBytes } from 'node:crypto';

/*
 * Mail messages, as much as the mail tools need: writing a plain-text message (UTF-8, headers encoded
 * as RFC 2047 words when they are not ASCII) and reading one (its headers, decoded, and its text: the
 * text/plain part, else the text/html part without its tags), whatever its transfer encoding and
 * charset. Pure, so it is tested with messages as servers send them.
 */

/**
 * An address as `Name <a@b>` or `a@b`, checked to be one: no line breaks, one `@`, no spaces in it.
 * The name may hold no `<`, `>`, `"`, `@` or backslash, nor control or formatting characters (a
 * right-to-left override), so it can never look like, or be taken for, another address: the card
 * shows exactly who a mail goes to, and `bareAddress()` finds that one address.
 */
export function validAddress(raw: string): string | undefined {
  const s = raw.trim();
  if (!s || s.length > 320 || /[\p{Cc}\p{Cf}]/u.test(s)) return undefined;
  const m = /^(?:([^<>]*?)\s*<([^<>\s]+@[^<>\s@]+)>|([^<>\s]+@[^<>\s@]+))$/.exec(s);
  if (!m) return undefined;
  const addr = (m[2] ?? m[3])!;
  if (!/^[^@\s"(),:;<>[\]\\]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(addr) && !/^[^@\s"<>\\]+@localhost$/.test(addr)) return undefined;
  const quoted = /^"([^"]*)"$/.exec((m[1] ?? '').trim());
  const name = (quoted ? quoted[1]! : (m[1] ?? '')).trim();
  if (/["@\\<>]/.test(name)) return undefined;
  return name ? `${name} <${addr}>` : addr;
}

/** The bare address of an address `validAddress()` gave (`Name <a@b>` or `a@b`): the one it checked. */
export function bareAddress(addr: string): string {
  const s = addr.trim();
  return /<([^<>]+)>$/.exec(s)?.[1] ?? s;
}

/**
 * A header value, as RFC 2047 words when it is not printable ASCII. The words are folded, one to a
 * line (each well under 78 characters), so a long subject never makes a line longer than mail allows.
 */
export function encodeWords(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  // Base64 words of at most 39 bytes each (52 characters of base64), cut between characters: with
  // the header's name before the first, each line stays under 78 characters.
  const words: string[] = [];
  let chunk = '';
  for (const ch of value) {
    if (Buffer.byteLength(chunk + ch) > 39) {
      words.push(chunk);
      chunk = '';
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w).toString('base64')}?=`).join('\r\n ');
}

/** An address header's value with its display names encoded. */
function encodeAddress(addr: string): string {
  const m = /^(.*?)\s*<([^>]+)>$/.exec(addr);
  if (!m) return addr;
  const name = m[1]!.trim();
  return name ? `${/^[\x20-\x7e]*$/.test(name) ? `"${name.replace(/["\\]/g, '')}"` : encodeWords(name)} <${m[2]}>` : `<${m[2]}>`;
}

/** Addresses for a header, folded one to a line when they would make a long line. */
function addressList(list: string[]): string {
  const encoded = list.map(encodeAddress);
  return encoded.join(', ').length > 900 ? encoded.join(',\r\n ') : encoded.join(', ');
}

export interface OutgoingMail {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  /** The Message-ID of the message this answers. */
  inReplyTo?: string;
  date?: Date;
}

/** A plain-text message, ready for SMTP's DATA or IMAP's APPEND (CRLF lines, base64 body). Bcc is never written. */
export function composeMail(
  m: OutgoingMail,
  domain = bareAddress(m.from).split('@')[1] ?? 'localhost',
): { raw: string; messageId: string } {
  const messageId = `<${randomBytes(12).toString('hex')}@${domain}>`;
  const date = (m.date ?? new Date()).toUTCString().replace('GMT', '+0000');
  const headers = [
    `From: ${encodeAddress(m.from)}`,
    `To: ${addressList(m.to)}`,
    ...(m.cc?.length ? [`Cc: ${addressList(m.cc)}`] : []),
    `Subject: ${encodeWords(m.subject.replace(/[\r\n]+/g, ' '))}`,
    `Date: ${date}`,
    `Message-ID: ${messageId}`,
    ...(m.inReplyTo ? [`In-Reply-To: ${m.inReplyTo}`, `References: ${m.inReplyTo}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    'User-Agent: Harness Relay',
  ];
  const body = Buffer.from(m.body.replace(/\r?\n/g, '\r\n')).toString('base64').replace(/.{76}/g, '$&\r\n');
  return { raw: `${headers.join('\r\n')}\r\n\r\n${body}\r\n`, messageId };
}

// --- Reading ---------------------------------------------------------------------------------------

/** Bytes in a charset as text (Node's TextDecoder knows the common ones, Big5 and the Japanese and Chinese ones included). */
function decodeCharset(bytes: Buffer, charset = 'utf-8'): string {
  try {
    return new TextDecoder(charset.trim().toLowerCase() || 'utf-8').decode(bytes);
  } catch {
    return bytes.toString('latin1');
  }
}

/** Quoted-printable as bytes. */
export function decodeQuotedPrintable(text: string): Buffer {
  const out: number[] = [];
  const s = text.replace(/=\r?\n/g, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === '=' && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) {
      out.push(parseInt(s.slice(i + 1, i + 3), 16));
      i += 2;
    } else out.push(...Buffer.from(c, 'latin1'));
  }
  return Buffer.from(out);
}

/** A header value's RFC 2047 words decoded (B and Q), the space between two words dropped. */
export function decodeWords(value: string): string {
  return value
    .replace(/(=\?[^?]+\?[BbQq]\?[^?]*\?=)\s+(?==\?)/g, '$1')
    .replace(/=\?([^?*]+)(?:\*[^?]*)?\?([BbQq])\?([^?]*)\?=/g, (_all, charset: string, enc: string, data: string) => {
      const bytes = enc.toUpperCase() === 'B' ? Buffer.from(data, 'base64') : decodeQuotedPrintable(data.replace(/_/g, ' '));
      return decodeCharset(bytes, charset);
    });
}

/**
 * A header value read byte for byte (latin1) as UTF-8, when its bytes are UTF-8 (a server that sends
 * UTF-8 headers, RFC 6532); else as it is.
 */
function utf8Header(value: string): string {
  if (!/[\x80-\xff]/.test(value)) return value;
  const text = Buffer.from(value, 'latin1').toString('utf8');
  return text.includes('\ufffd') ? value : text;
}

/** Headers by lower-case name (the first of each), unfolded and decoded. */
export function parseHeaders(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of block.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const name = line.slice(0, i).trim().toLowerCase();
    if (!(name in out)) out[name] = decodeWords(utf8Header(line.slice(i + 1).trim()));
  }
  return out;
}

/** A header's parameter (`charset`, `boundary`), unquoted. */
function param(header: string | undefined, name: string): string | undefined {
  const m = new RegExp(`(?:^|;)\\s*${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, 'i').exec(header ?? '');
  return m ? (m[1] ?? m[2]) : undefined;
}

/** Splits a raw message (or part) into its headers and body. */
function splitEntity(raw: string): { headers: Record<string, string>; body: string } {
  const m = /\r?\n\r?\n/.exec(raw);
  if (!m) return { headers: parseHeaders(raw), body: '' };
  return { headers: parseHeaders(raw.slice(0, m.index)), body: raw.slice(m.index + m[0].length) };
}

/** A part's body as text, by its transfer encoding and charset. */
function bodyText(headers: Record<string, string>, body: string): string {
  const enc = (headers['content-transfer-encoding'] ?? '').toLowerCase();
  const charset = param(headers['content-type'], 'charset');
  const bytes =
    enc === 'base64'
      ? Buffer.from(body.replace(/\s+/g, ''), 'base64')
      : enc === 'quoted-printable'
        ? decodeQuotedPrintable(body)
        : Buffer.from(body, 'latin1');
  return decodeCharset(bytes, charset);
}

/** A numeric character reference's character; one that is none (past U+10FFFF, a surrogate, NUL) is U+FFFD. */
function codePoint(n: number): string {
  return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '\ufffd';
}

/**
 * `html` without its script, style and head elements (what is in them is not text), in one pass: an
 * element never closed takes the rest with it.
 */
function withoutBlocks(html: string): string {
  const lower = html.toLowerCase();
  const out: string[] = [];
  const open = /<(script|style|head)\b/g;
  let at = 0;
  for (let m = open.exec(lower); m; m = open.exec(lower)) {
    out.push(html.slice(at, m.index));
    const close = lower.indexOf(`</${m[1]}`, open.lastIndex);
    if (close < 0) return out.join('');
    const end = lower.indexOf('>', close);
    at = end < 0 ? html.length : end + 1;
    open.lastIndex = at;
  }
  out.push(html.slice(at));
  return out.join('');
}

/** Whether the character after a `<` starts a tag, as a browser reads it: a letter, `/`, `!` or `?` (`x < 5` is text). */
const TAG_START = /[A-Za-z/!?]/;

/**
 * `html` without its tags, in one pass: from a `<` that starts one to the `>` that ends it, a tag
 * started inside it needing a `>` of its own, so pieces of a tag never join into one (removing tags
 * once would make `<script>` of `<scr<b>ipt>`). A `<` that starts no tag stays as text; a tag never
 * ended takes the rest with it, as in a browser.
 */
function withoutTags(html: string): string {
  const out: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < html.length; i++) {
    const c = html[i];
    if (c === '<' && TAG_START.test(html[i + 1] ?? '')) {
      if (depth === 0) out.push(html.slice(from, i));
      depth++;
    } else if (c === '>' && depth > 0 && --depth === 0) {
      from = i + 1;
    }
  }
  if (depth === 0) out.push(html.slice(from));
  return out.join('');
}

/**
 * HTML as plain text: no scripts or styles, block ends as line breaks, entities decoded. Every step
 * takes time in proportion to the text, whatever it holds (a mail of 400 KB of `<` included), so no
 * mail can hold the server up.
 */
export function htmlText(html: string): string {
  return withoutTags(
    withoutBlocks(html)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, '\n'),
  )
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d{1,8});/g, (_m, n: string) => codePoint(Number(n)))
    .replace(/&#[xX]([0-9a-fA-F]{1,7});/g, (_m, n: string) => codePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The text of an entity: plain text first, else HTML as text, looking into multipart parts (and attachments' names). */
function entityText(raw: string, depth = 0): { text: string; html?: string; attachments: string[] } {
  const { headers, body } = splitEntity(raw);
  const type = (headers['content-type'] ?? 'text/plain').toLowerCase();
  const disposition = headers['content-disposition'] ?? '';
  const filename = param(disposition, 'filename') ?? param(headers['content-type'], 'name');
  if (/^attachment/i.test(disposition) || (filename && !type.startsWith('text/')))
    return { text: '', attachments: [filename ? decodeWords(filename) : 'attachment'] };
  if (type.startsWith('multipart/') && depth < 8) {
    const boundary = param(headers['content-type'], 'boundary');
    if (!boundary) return { text: '', attachments: [] };
    const parts = body
      .split(new RegExp(`\\r?\\n?--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:--)?[ \\t]*\\r?\\n?`))
      .slice(1)
      .filter((p) => p.trim());
    let text = '';
    let html: string | undefined;
    const attachments: string[] = [];
    for (const part of parts) {
      const t = entityText(part, depth + 1);
      attachments.push(...t.attachments);
      if (t.text && !text) text = t.text;
      if (t.html && html === undefined) html = t.html;
    }
    return { text, ...(html !== undefined ? { html } : {}), attachments };
  }
  if (type.startsWith('text/html')) return { text: '', html: htmlText(bodyText(headers, body)), attachments: [] };
  if (type.startsWith('text/')) return { text: bodyText(headers, body), attachments: [] };
  return { text: '', attachments: [] };
}

export interface ReadMail {
  headers: Record<string, string>;
  text: string;
  /** The attachments' names. */
  attachments: string[];
}

/** A raw message's headers and text (its plain text, else its HTML as text). */
export function readMail(raw: string): ReadMail {
  const { headers } = splitEntity(raw);
  const t = entityText(raw);
  return { headers, text: (t.text || t.html || '').replace(/\r\n/g, '\n').trim(), attachments: t.attachments };
}
