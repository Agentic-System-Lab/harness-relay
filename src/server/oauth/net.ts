import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { Readable } from 'node:stream';
import { t } from '../i18n';
import { isLocalHost, isPrivateAddress, localAddresses } from '../relaySandbox';
import type { ProviderRequest } from './broker';

/*
 * The requests a tool library MCP server's sign-in makes (discovery, registration, tokens, revocation),
 * with Node's own http and https: no redirect is ever followed, and for a server that is not on this
 * computer, every address they go to is looked up first and refused when one of its addresses is on this
 * computer or the local network (loopback, private, link-local, the unspecified address, the clouds'
 * metadata services: the checks the browser tools use, `relaySandbox.ts`), and the connection then goes
 * to the addresses checked, and no others (a name whose address changes after the check, DNS rebinding,
 * reaches nothing it was not checked for). A server on this computer (a stand-in, a local proxy) may name
 * addresses here, as before. What a request reads is bounded by its caller (`jsonObject()`).
 */

/** How the sign-in's requests find a host's addresses (the system's lookup; tests give their own). */
export interface McpNet {
  lookup(host: string): Promise<string[]>;
  /**
   * Sends a request to the addresses checked for it (tests: to a stand-in on this computer, as if it
   * were elsewhere); `pinnedSend()` otherwise.
   */
  send?: (url: URL, r: ProviderRequest, addresses: readonly string[] | undefined) => Promise<Response>;
}

/** How long a host's lookup may take. */
const LOOKUP_MS = 10_000;

/** The system's lookup, all of a name's addresses as they come. */
export const SYSTEM_NET: McpNet = {
  lookup: async (host) => (await dnsLookup(host, { all: true, verbatim: true })).map((a) => a.address),
};

/** Whether an address is on this computer or the local network, which a server elsewhere may not send Harness Relay to. */
export function nearbyAddress(address: string, own: readonly string[] = localAddresses()): boolean {
  return isLocalHost(address, own) || isPrivateAddress(address);
}

/** Resolve once, with a deadline, so the caller can check and pin the exact addresses used for its request. */
export async function resolveAddresses(url: URL, net: McpNet): Promise<string[]> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addresses: string[];
  if (isIP(host)) addresses = [host];
  else {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(t().mcpLookupSlow(LOOKUP_MS / 1000))), LOOKUP_MS);
    });
    try {
      addresses = await Promise.race([net.lookup(host), late]);
    } catch (err) {
      throw new Error(t().mcpUnresolved(url.host, (err as Error).message));
    } finally {
      clearTimeout(timer);
    }
  }
  if (!addresses.length) throw new Error(t().mcpUnresolved(url.host, ''));
  return addresses;
}

/** The addresses a remote MCP server may contact: refuse the whole lookup if any address is nearby. */
export async function checkedAddresses(url: URL, net: McpNet, own: readonly string[] = localAddresses()): Promise<string[]> {
  const addresses = await resolveAddresses(url, net);
  if (addresses.some((a) => nearbyAddress(a, own))) throw new Error(t().mcpNearbyAddress(url.host));
  return addresses;
}

/** A lookup that answers only these addresses, whatever name it is asked (the connection goes where the check said). */
export function pinnedLookup(addresses: readonly string[]): LookupFunction {
  const list = addresses.map((address) => ({ address, family: isIP(address) }));
  return ((_host: string, options: { family?: number | string; all?: boolean } | number, cb: (...a: unknown[]) => void) => {
    const asked = typeof options === 'number' ? options : options?.family;
    const family = asked === 'IPv4' ? 4 : asked === 'IPv6' ? 6 : asked;
    const fit = family === 4 || family === 6 ? list.filter((a) => a.family === family) : list;
    if (!fit.length) return cb(Object.assign(new Error(t().mcpUnresolved(_host, '')), { code: 'ENOTFOUND' }));
    if (typeof options === 'object' && options?.all) return cb(null, fit);
    return cb(null, fit[0]!.address, fit[0]!.family);
  }) as unknown as LookupFunction;
}

/** Statuses whose answer has no body (the `Response` constructor refuses one). */
const NO_BODY = [101, 204, 205, 304];

/**
 * A request with Node's http or https (never following a redirect), to `addresses` only when given; its
 * answer as a web `Response`, whose body the caller reads (bounded) or cancels.
 */
export function pinnedSend(url: URL, r: ProviderRequest, addresses: readonly string[] | undefined): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method: r.method,
      headers: { ...r.headers, ...(r.body !== undefined ? { 'content-length': String(Buffer.byteLength(r.body)) } : {}) },
      signal: r.signal ? AbortSignal.any([AbortSignal.timeout(r.timeoutMs), r.signal]) : AbortSignal.timeout(r.timeoutMs),
      // A connection of its own: none kept for another request, which may have been checked for other addresses.
      agent: false,
      ...(addresses ? { lookup: pinnedLookup(addresses) } : {}),
    });
    req.on('response', (res: IncomingMessage) => {
      try {
        const headers = new Headers();
        for (const [name, value] of Object.entries(res.headers))
          for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value]) headers.append(name, v);
        const status = res.statusCode ?? 0;
        if (NO_BODY.includes(status)) res.resume();
        const body = NO_BODY.includes(status) ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>);
        resolve(new Response(body, { status, headers }));
      } catch (err) {
        res.destroy();
        reject(err as Error);
      }
    });
    req.on('error', reject);
    req.end(r.body);
  });
}

/**
 * A request of a server's sign-in to `url`: for a server that is not on this computer (`local` false),
 * only to addresses on the internet, checked and pinned; for one on this computer, as it is.
 */
export async function mcpSend(url: string, r: ProviderRequest, o: { local: boolean; net: McpNet }): Promise<Response> {
  const u = new URL(url);
  const addresses = o.local ? undefined : await checkedAddresses(u, o.net);
  return (o.net.send ?? pinnedSend)(u, r, addresses);
}
