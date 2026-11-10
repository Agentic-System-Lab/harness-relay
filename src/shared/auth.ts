/*
 * Signing a browser in to Harness Relay, shared by server and client. Without it any program on
 * this computer that can reach localhost could drive the agents, also code an agent runs in its
 * sandbox (see docs/architecture.md, "Signing in").
 */

/** The header that carries a signed-in browser's key (kept in that origin's localStorage). */
export const AUTH_KEY_HEADER = 'x-relay-key';

/** The error code of a request from a browser that is not signed in. */
export const SIGNED_OUT = 'signed-out';

/** The fragment a sign-in link ends with: `#code=ABCD-EFGH`. */
export const CODE_FRAGMENT = 'code=';

/** Crockford's base 32: no I, L, O or U, so a code read aloud or typed is hard to get wrong. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** How many characters a sign-in code has (40 bits). */
export const CODE_LENGTH = 8;

/** A code as shown: `ABCD-EFGH`. */
export function formatCode(raw: string): string {
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

/** A sign-in code from random bytes (one per character). */
export function codeFromBytes(bytes: Uint8Array): string {
  return formatCode(Array.from(bytes.slice(0, CODE_LENGTH), (b) => ALPHABET[b % 32]).join(''));
}

/**
 * A code as typed, in the form it is stored in: upper case, without spaces or dashes, with the
 * letters Crockford's base 32 reads as digits (O as 0, I and L as 1). Undefined when it cannot be one.
 */
export function normalizeCode(input: string): string | undefined {
  const raw = input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  return raw.length === CODE_LENGTH && [...raw].every((ch) => ALPHABET.includes(ch)) ? raw : undefined;
}

/** The sign-in code a link's fragment carries (`#code=…`), if any. */
export function codeFromHash(hash: string): string | undefined {
  const fragment = hash.replace(/^#/, '');
  if (!fragment.startsWith(CODE_FRAGMENT)) return undefined;
  const code = fragment.slice(CODE_FRAGMENT.length);
  try {
    return decodeURIComponent(code) || undefined;
  } catch {
    return code; // a stray %: tried as it is, and refused as a wrong code
  }
}

/** A short name for a signed-in browser, from its User-Agent ("Chrome on macOS"). */
export function browserLabel(userAgent: string | undefined): string {
  const ua = userAgent ?? '';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\/|FxiOS\//.test(ua)
      ? 'Firefox'
      : /Chrome\/|CriOS\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : '';
  const os = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Mac OS X|Macintosh/.test(ua)
          ? 'macOS'
          : /Windows/.test(ua)
            ? 'Windows'
            : /Linux/.test(ua)
              ? 'Linux'
              : '';
  return browser && os ? `${browser} · ${os}` : browser || os || ua.slice(0, 60) || '?';
}
