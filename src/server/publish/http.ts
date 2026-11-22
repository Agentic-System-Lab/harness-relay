import { answerText } from '../connectors/caldav';
import { HttpError } from '../errors';
import { t } from '../i18n';

/** An answer a host gave that was not a success: its status, and the message its body had. */
export class HostError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** How much of an answer is read: Render's and Neon's are small JSON documents. */
const MAX_ANSWER = 1024 * 1024;

/**
 * One request to a host's API with the user's key (`Authorization: Bearer`), JSON both ways: to the
 * address given only (no redirect followed), with a time limit, its answer read to a limit. A failed
 * status throws a HostError with the host's own message (its `message` or `error`), cut short; a
 * request that never got an answer, an HttpError (502) naming the host.
 */
export async function hostJson(
  fetcher: typeof fetch,
  host: string,
  url: URL,
  key: string,
  init: { method?: 'GET' | 'POST' | 'PUT' | 'DELETE'; body?: unknown; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetcher(url, {
      method: init.method ?? 'GET',
      redirect: 'error',
      signal: init.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(init.timeoutMs ?? 30_000)])
        : AbortSignal.timeout(init.timeoutMs ?? 30_000),
      headers: {
        Authorization: 'Bearer ' + key,
        Accept: 'application/json',
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  } catch (err) {
    init.signal?.throwIfAborted();
    void err;
    throw new HttpError(502, t().publish.unreachable(host));
  }
  let text: string;
  try {
    text = await answerText(res, MAX_ANSWER, t().publish.unreachable(host));
  } catch {
    throw new HttpError(502, t().publish.unreachable(host));
  }
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }
  if (!res.ok) {
    const said =
      data && typeof data === 'object' ? ((data as Record<string, unknown>).message ?? (data as Record<string, unknown>).error) : undefined;
    throw new HostError(res.status, typeof said === 'string' ? said.slice(0, 300) : '');
  }
  return data;
}

/** A path segment from a host's own id: its characters only, so that it cannot leave its place in the path. */
export function segment(id: string): string {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new HttpError(502, t().publish.badAnswer);
  return encodeURIComponent(id);
}

/** A string field of an answer, or undefined. */
export function str(o: unknown, key: string): string | undefined {
  const v = o && typeof o === 'object' ? (o as Record<string, unknown>)[key] : undefined;
  return typeof v === 'string' ? v : undefined;
}

/** An object field of an answer, or undefined. */
export function obj(o: unknown, key: string): Record<string, unknown> | undefined {
  const v = o && typeof o === 'object' ? (o as Record<string, unknown>)[key] : undefined;
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/** An array field of an answer (the answer itself when `key` is undefined), or an empty one. */
export function arr(o: unknown, key?: string): unknown[] {
  const v = key === undefined ? o : o && typeof o === 'object' ? (o as Record<string, unknown>)[key] : undefined;
  return Array.isArray(v) ? v : [];
}
