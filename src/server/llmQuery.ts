import { API_BACKEND_LABEL, isApiBackend, parseBackendModel, type ApiBackend } from '../shared/types';
import type { RunBackends } from './agents/types';
import { API_BACKEND_HOST } from './backends';
import type { ProviderRequest } from './oauth/broker';
import { pinnedSend, resolveAddresses, SYSTEM_NET, type McpNet } from './oauth/net';
import { isLocalHost, localAddresses, relayPorts } from './relaySandbox';

/*
 * The sub-model RLM mode's `llm_query()` asks (`RELAY_RLM=<backend>/<model>`, `runCode.ts`): one plain
 * completion with no tools, on a model connection of Settings → Model connections (OpenAI's, Anthropic's
 * or xAI's API key, or one of the user's own OpenAI-compatible endpoints). The only inference request
 * Harness Relay makes itself; every other one is a CLI's.
 *
 * The key stays in the server: it goes only to the backend's own host (the API's, or the endpoint's
 * address as Settings checked it), over a connection of its own to the addresses looked up, following no
 * redirect (`pinnedSend()`), and never to the runner, its sandbox or what the agent is told. An endpoint
 * on one of Harness Relay's own ports is refused, as when Settings lists its models (`endpointModels.ts`).
 */

/** Where a sub-model's requests go, with its key. */
export interface LlmTarget {
  /** Its id, as `RELAY_RLM` names it: `<backend>/<model>`. */
  id: string;
  kind: ApiBackend | 'endpoint';
  /** The model's own name, as its backend serves it. */
  model: string;
  url: URL;
  key?: string;
}

/** One question to the sub-model. */
export interface LlmRequest {
  prompt: string;
  system?: string;
  maxTokens: number;
}

/** Its answer: the text, what it cost in tokens as the backend reports them, and whether it was cut at `maxTokens`. */
export interface LlmAnswer {
  text: string;
  inputTokens: number;
  outputTokens: number;
  truncated: boolean;
}

/** How long one question may take. */
export const LLM_TIMEOUT_MS = 120_000;

/** The most an answer may be, in bytes. */
const MAX_ANSWER_BYTES = 4 * 1024 * 1024;

/**
 * Where `id` (`<backend>/<model>`) is asked, from the model connections set up now. Throws, saying what
 * to set up, when it is not one or its backend is not set up.
 */
export function llmTarget(backends: RunBackends, id: string): LlmTarget {
  const parsed = parseBackendModel(id);
  if (!parsed) throw new Error(`${id} is not a model as <backend>/<model>`);
  if (isApiBackend(parsed.backend)) {
    const key = backends.apis[parsed.backend];
    if (!key) throw new Error(`no ${API_BACKEND_LABEL[parsed.backend]} API key is set up in Settings → Model connections`);
    const path = parsed.backend === 'anthropic' ? '/v1/messages' : '/v1/chat/completions';
    return { id, kind: parsed.backend, model: parsed.model, url: new URL(`https://${API_BACKEND_HOST[parsed.backend]}${path}`), key };
  }
  const endpoint = backends.endpoints.find((e) => e.id === parsed.backend);
  if (!endpoint) throw new Error(`the model connection ${parsed.backend} is not set up in Settings → Model connections`);
  return {
    id,
    kind: 'endpoint',
    model: parsed.model,
    // Its base URL has passed `validEndpointUrl()`: http(s), no credentials, query or fragment, no trailing slash.
    url: new URL(`${endpoint.baseUrl}/chat/completions`),
    ...(endpoint.apiKey ? { key: endpoint.apiKey } : {}),
  };
}

/** The request for `req` in the backend's own API: Anthropic's Messages, else OpenAI's Chat Completions. */
export function llmRequest(target: LlmTarget, req: LlmRequest): ProviderRequest {
  const json = { 'Content-Type': 'application/json', Accept: 'application/json', 'Accept-Encoding': 'identity' };
  if (target.kind === 'anthropic') {
    return {
      method: 'POST',
      headers: { ...json, 'x-api-key': target.key ?? '', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: target.model,
        max_tokens: req.maxTokens,
        ...(req.system ? { system: req.system } : {}),
        messages: [{ role: 'user', content: req.prompt }],
      }),
      timeoutMs: LLM_TIMEOUT_MS,
    };
  }
  return {
    method: 'POST',
    headers: { ...json, ...(target.key ? { Authorization: `Bearer ${target.key}` } : {}) },
    body: JSON.stringify({
      model: target.model,
      messages: [...(req.system ? [{ role: 'system', content: req.system }] : []), { role: 'user', content: req.prompt }],
      // OpenAI's own API takes the newer name; xAI's and the endpoints (vLLM, Ollama…) the older one.
      ...(target.kind === 'openai' ? { max_completion_tokens: req.maxTokens } : { max_tokens: req.maxTokens }),
      stream: false,
    }),
    timeoutMs: LLM_TIMEOUT_MS,
  };
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

/** The text of a message's content: a string, or the text parts of a list of them. */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((p) =>
      p && typeof p === 'object' && (p as { type?: unknown }).type === 'text' ? String((p as { text?: unknown }).text ?? '') : '',
    )
    .join('');
}

/** An answer in the backend's own API, read; throws when it is not one. */
export function llmAnswer(target: LlmTarget, body: unknown): LlmAnswer {
  const o = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const usage = (o.usage && typeof o.usage === 'object' ? o.usage : {}) as Record<string, unknown>;
  if (target.kind === 'anthropic') {
    if (!Array.isArray(o.content)) throw new Error(`${target.id} answered with no content`);
    return {
      text: contentText(o.content),
      inputTokens: num(usage.input_tokens),
      outputTokens: num(usage.output_tokens),
      truncated: o.stop_reason === 'max_tokens',
    };
  }
  const choice = Array.isArray(o.choices) ? (o.choices[0] as Record<string, unknown> | undefined) : undefined;
  const message = choice?.message as Record<string, unknown> | undefined;
  if (!message) throw new Error(`${target.id} answered with no message`);
  return {
    text: contentText(message.content),
    inputTokens: num(usage.prompt_tokens),
    outputTokens: num(usage.completion_tokens),
    truncated: choice?.finish_reason === 'length',
  };
}

/** A response's body as text, at most `max` bytes (more is refused). */
async function bodyText(res: Response, max: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`the answer is larger than ${max / (1024 * 1024)} MB`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Why a backend refused a question: its status and its own message (never the request, which holds the key). */
function refusal(target: LlmTarget, status: number, text: string): Error {
  let message = '';
  try {
    const err = (JSON.parse(text) as { error?: unknown }).error;
    message =
      typeof err === 'string'
        ? err
        : typeof (err as { message?: unknown })?.message === 'string'
          ? (err as { message: string }).message
          : '';
  } catch {
    /* not JSON */
  }
  const said = (message || text).replace(/\s+/g, ' ').trim().slice(0, 300);
  return new Error(`${target.id} answered ${status}${said ? `: ${said}` : ''}`);
}

/** What `llmComplete` needs (swapped in tests). */
export interface LlmDeps {
  send: typeof pinnedSend;
  net: McpNet;
  relayPorts: () => number[];
  own: () => string[];
}

const defaultDeps: LlmDeps = { send: pinnedSend, net: SYSTEM_NET, relayPorts, own: localAddresses };

/** Ask the sub-model one question. Throws with a reason the agent can be told (never the key). */
export async function llmComplete(
  target: LlmTarget,
  req: LlmRequest,
  signal: AbortSignal,
  deps: LlmDeps = defaultDeps,
): Promise<LlmAnswer> {
  if (signal.aborted) throw new Error('the run ended');
  const port = Number(target.url.port || (target.url.protocol === 'https:' ? 443 : 80));
  let addresses: string[] | undefined;
  if (target.kind === 'endpoint' && deps.relayPorts().includes(port)) {
    // A name that leads to this computer on one of Harness Relay's own ports, as Settings refuses it.
    addresses = await resolveAddresses(target.url, deps.net);
    const own = deps.own();
    if (addresses.some((a) => isLocalHost(a, own))) throw new Error(`${target.id}'s endpoint is one of Harness Relay's own ports`);
  }
  let stop!: (err: Error) => void;
  const stopped = new Promise<never>((_resolve, reject) => (stop = reject));
  const onAbort = () => stop(new Error('the run ended'));
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await Promise.race([deps.send(target.url, llmRequest(target, req), addresses), stopped]);
    const text = await Promise.race([bodyText(res, MAX_ANSWER_BYTES), stopped]);
    if (res.status < 200 || res.status > 299) throw refusal(target, res.status, text);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`${target.id} answered with something other than JSON`);
    }
    return llmAnswer(target, body);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
