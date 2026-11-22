import { ENDPOINT_METADATA_UNAVAILABLE, type TokenLimits } from '../shared/types';
import { validContext } from '../shared/modelLimits';
import { answerText } from './connectors/caldav';
import { HttpError } from './errors';
import { t } from './i18n';
import { pinnedSend, resolveAddresses, SYSTEM_NET } from './oauth/net';
import { isLocalHost, localAddresses, relayPorts } from './relaySandbox';
import { validEndpointModelId } from './validate';

const MAX_MIB = 4;
const MAX_BYTES = MAX_MIB * 1024 * 1024;

/** Use one deadline and one destination check for a catalog lookup and any individual model checks. */
async function modelRequests(baseUrl: string, key?: string | null) {
  const url = new URL(`${baseUrl}/models`); // baseUrl has passed validEndpointUrl()
  const deadline = Date.now() + 10_000;
  let addresses: string[] | undefined;
  try {
    // A DNS alias on a Relay port must pass the same check as a literal address. Connect only
    // to the addresses checked so a second lookup cannot change the destination.
    if (relayPorts().includes(Number(url.port || (url.protocol === 'https:' ? 443 : 80)))) {
      addresses = await resolveAddresses(url, SYSTEM_NET);
      const own = localAddresses();
      if (addresses.some((address) => isLocalHost(address, own))) throw new HttpError(400, t().endpointUrlRelay);
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, t().endpointCatalogConnection);
  }
  const headers = { Accept: 'application/json', 'Accept-Encoding': 'identity', ...(key ? { Authorization: `Bearer ${key}` } : {}) };
  return async (id?: string) => {
    const timeoutMs = deadline - Date.now();
    if (timeoutMs <= 0) throw new HttpError(502, t().endpointVerifyTimeout);
    try {
      return await pinnedSend(
        id === undefined ? url : new URL(`${url.href}/${encodeURIComponent(id)}`),
        { method: 'GET', headers, timeoutMs },
        addresses,
      );
    } catch {
      throw new HttpError(502, t().endpointCatalogConnection);
    }
  };
}

function upstreamError(status: number): HttpError {
  return new HttpError(502, status === 401 || status === 403 ? t().endpointCatalogDenied(status) : t().endpointCatalogHttp(status));
}

/** Bound both a single answer and the total bytes read when many models need individual checks. */
async function modelJson(response: Response, budget: { remaining: number }, id?: string): Promise<Record<string, unknown> | undefined> {
  const tooLarge = t().endpointResponseTooLarge(MAX_MIB, MAX_MIB * 2);
  let raw: string;
  try {
    raw = await answerText(response, Math.min(MAX_BYTES, budget.remaining), tooLarge);
  } catch (err) {
    const reason = err instanceof Error && err.message === tooLarge ? tooLarge : t().endpointCatalogConnection;
    throw new HttpError(502, id === undefined ? reason : t().endpointVerifyModelError(id, reason));
  }
  budget.remaining -= Buffer.byteLength(raw);
  try {
    const value: unknown = JSON.parse(raw);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // Only the expected JSON shape reaches the caller. A server's parse error can quote its raw body.
  }
}

/**
 * The context window a server reports for one model in its `/models` answer (an entry of its catalog,
 * or its own record), in the shapes its documentation and source give:
 * - vLLM (and SGLang, which answers as it does): `max_model_len`, the longest a request may be, its
 *   answer's tokens included (`ModelCard`, vllm/entrypoints/serve/engine/protocol.py);
 * - llama.cpp's server: `meta.n_ctx`, the context of one of its slots, which is what one request gets
 *   (`n_ctx_slot()`, tools/server/server-context.cpp); Goose reads the same field.
 * Not `meta.n_ctx_train` (what the model was trained for, more than a server may serve), nor llama.cpp's
 * router's `context_length` (the same figure). Other servers (Ollama, LM Studio) report none here.
 */
export function reportedLimits(entry: unknown): TokenLimits {
  const e = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
  const meta = (e.meta && typeof e.meta === 'object' ? e.meta : {}) as Record<string, unknown>;
  const context = [e.max_model_len, meta.n_ctx].find(validContext);
  return context ? { context } : {};
}

/**
 * The catalog's model ids, each with what it reports of its limits (`reportedLimits()`). A LoRA adapter
 * vLLM serves has no `max_model_len` of its own: its base model's (`parent`) applies.
 */
async function catalogModels(response: Response, budget: { remaining: number }): Promise<Map<string, TokenLimits>> {
  const catalog = await modelJson(response, budget);
  if (!Array.isArray(catalog?.data)) throw new HttpError(502, t().endpointCatalogInvalid(MAX_MIB));
  const models = new Map<string, TokenLimits>();
  for (const entry of catalog.data) {
    if (validEndpointModelId(entry?.id) && !models.has(entry.id)) models.set(entry.id, reportedLimits(entry));
  }
  if (catalog.data.length && !models.size) throw new HttpError(502, t().endpointCatalogInvalid(MAX_MIB));
  for (const entry of catalog.data) {
    const own = validEndpointModelId(entry?.id) ? models.get(entry.id) : undefined;
    const parent = typeof entry?.parent === 'string' ? models.get(entry.parent) : undefined;
    if (own && !own.context && parent?.context) own.context = parent.context;
  }
  return models;
}

/** Read the endpoint's catalog without writing settings. */
export async function listEndpointModels(baseUrl: string, key?: string | null): Promise<string[]> {
  const get = await modelRequests(baseUrl, key);
  const res = await get();
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw upstreamError(res.status);
  }
  return [...(await catalogModels(res, { remaining: MAX_BYTES })).keys()];
}

const missingRoute = (status: number) => [404, 405, 501].includes(status);

/**
 * Verify before saving. Only omissions and an unsupported list justify asking about individual models.
 * Resolves to what the server reported of the models' limits, from the same answers (`reportedLimits()`):
 * only the models it reported any for.
 */
export async function verifyEndpointModels(
  baseUrl: string,
  key: string | null | undefined,
  models: string[],
  allowMissingMetadata = false,
): Promise<Record<string, TokenLimits>> {
  const get = await modelRequests(baseUrl, key);
  const catalog = await get();
  const budget = { remaining: MAX_BYTES * 2 };
  // As entries, so that a model named `__proto__` is a key like any other.
  const reported: [string, TokenLimits][] = [];
  const report = (id: string, limits: TokenLimits | undefined) => {
    if (limits?.context) reported.push([id, { ...limits }]);
  };
  let missing = models;
  if (catalog.ok) {
    const listed = await catalogModels(catalog, budget);
    missing = models.filter((id) => !listed.has(id));
    for (const id of models) report(id, listed.get(id));
  } else {
    await catalog.body?.cancel().catch(() => undefined);
    if (!missingRoute(catalog.status)) throw upstreamError(catalog.status);
    if (!models.length) throw new HttpError(400, t().endpointVerifyNeedsModel);
  }
  let firstUnavailable: { id: string; status: number } | undefined;
  let individualSupported = false;
  // At most one request per distinct selected ID (bounded by maxModels), serial so a denial stops further probes.
  for (const id of missing) {
    // A literal dot segment would leave the model resource in the URL parser.
    if (id === '.' || id === '..') throw new HttpError(400, t().endpointVerifyMismatch(id));
    let res: Response;
    try {
      res = await get(id);
    } catch (err) {
      if (err instanceof HttpError) throw new HttpError(err.status, t().endpointVerifyModelError(id, err.message));
      throw err;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      if (!catalog.ok && missingRoute(res.status) && !individualSupported) {
        firstUnavailable ??= { id, status: res.status };
        continue;
      }
      throw new HttpError(502, t().endpointVerifyModelHttp(id, res.status));
    }
    // A working individual route makes earlier missing records definitive for this save.
    if (firstUnavailable) {
      await res.body?.cancel().catch(() => undefined);
      throw new HttpError(502, t().endpointVerifyModelHttp(firstUnavailable.id, firstUnavailable.status));
    }
    individualSupported = true;
    // Only the model's own ID confirms it. A generic success page or an alias for a different model fails.
    const record = await modelJson(res, budget, id);
    if (record?.id !== id) throw new HttpError(400, t().endpointVerifyMismatch(id));
    report(id, reportedLimits(record));
  }
  if (firstUnavailable && !allowMissingMetadata) throw new HttpError(409, t().endpointNoMetadata, ENDPOINT_METADATA_UNAVAILABLE);
  return Object.fromEntries(reported);
}
