import { describe, expect, it } from 'vitest';
import type { RunBackends } from '../src/server/agents/types';
import type { ProviderRequest } from '../src/server/oauth/broker';
import {
  CHARS_PER_TOKEN,
  llmAnswer,
  llmComplete,
  llmRequest,
  llmTarget,
  promptTokens,
  type LlmDeps,
  type LlmTarget,
} from '../src/server/llmQuery';

const backends: RunBackends = {
  apis: { anthropic: 'sk-ant-secret', openai: 'sk-openai-secret' },
  endpoints: [
    { id: 'homelab', name: 'Home lab', baseUrl: 'http://192.168.1.20:8000/v1', models: ['qwen'], apiKey: 'lab-key' },
    { id: 'ollama', name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', models: ['gemma'] },
  ],
};

describe("RLM's sub-model: where it is asked", () => {
  it("asks each API backend at its own host, and an endpoint at its base URL, with that connection's key only", () => {
    expect(llmTarget(backends, 'anthropic/claude-haiku-5-5')).toEqual({
      id: 'anthropic/claude-haiku-5-5',
      kind: 'anthropic',
      model: 'claude-haiku-5-5',
      url: new URL('https://api.anthropic.com/v1/messages'),
      key: 'sk-ant-secret',
    });
    expect(llmTarget(backends, 'openai/gpt-5.4-nano').url.href).toBe('https://api.openai.com/v1/chat/completions');
    expect(llmTarget({ apis: { xai: 'x' }, endpoints: [] }, 'xai/grok-4.3').url.href).toBe('https://api.x.ai/v1/chat/completions');
    expect(llmTarget(backends, 'homelab/Qwen/Qwen3-30B-A3B')).toEqual({
      id: 'homelab/Qwen/Qwen3-30B-A3B',
      kind: 'endpoint',
      model: 'Qwen/Qwen3-30B-A3B',
      url: new URL('http://192.168.1.20:8000/v1/chat/completions'),
      key: 'lab-key',
    });
    expect(llmTarget(backends, 'ollama/gemma').key).toBeUndefined();
  });

  it('says what to set up when the model is not one, or its connection is not set up', () => {
    expect(() => llmTarget(backends, 'gemma')).toThrow('gemma is not a model as <backend>/<model>');
    expect(() => llmTarget(backends, 'xai/grok-4.3')).toThrow('no xAI API key is set up in Settings → Model connections');
    expect(() => llmTarget(backends, 'gone/model')).toThrow('the model connection gone is not set up in Settings → Model connections');
  });
});

describe("RLM's sub-model: how long a question is", () => {
  it('counts Chinese, Japanese and Korean characters as a token each, and other text three characters to one', () => {
    expect(CHARS_PER_TOKEN).toBe(3);
    expect(promptTokens('')).toBe(0);
    expect(promptTokens('abcdef')).toBe(2);
    expect(promptTokens('abcdefg')).toBe(3);
    expect(promptTokens('上下文長度')).toBe(5);
    expect(promptTokens('コンテキスト')).toBe(6);
    expect(promptTokens('컨텍스트')).toBe(4);
    // Full-width punctuation counts as wide; the rest as other text.
    expect(promptTokens('長度：32768。')).toBe(4 + Math.ceil(5 / 3));
  });
});

describe("RLM's sub-model: its requests and answers", () => {
  const anthropic = llmTarget(backends, 'anthropic/claude-haiku-5-5');
  const openai = llmTarget(backends, 'openai/gpt-5.4-nano');
  const ollama = llmTarget(backends, 'ollama/gemma');

  it("writes Anthropic's Messages request, its key in x-api-key", () => {
    const r = llmRequest(anthropic, { prompt: 'Summarize this.', system: 'Be brief.', maxTokens: 300 });
    expect(r).toMatchObject({ method: 'POST', timeoutMs: 120_000 });
    expect(r.headers).toMatchObject({
      'Content-Type': 'application/json',
      'x-api-key': 'sk-ant-secret',
      'anthropic-version': '2023-06-01',
    });
    expect(r.headers.Authorization).toBeUndefined();
    expect(JSON.parse(r.body!)).toEqual({
      model: 'claude-haiku-5-5',
      max_tokens: 300,
      system: 'Be brief.',
      messages: [{ role: 'user', content: 'Summarize this.' }],
    });
  });

  it("writes Chat Completions for the others: OpenAI's newer max_completion_tokens, the older max_tokens elsewhere, a key only where there is one", () => {
    const o = llmRequest(openai, { prompt: 'Q', system: 'S', maxTokens: 50 });
    expect(o.headers.Authorization).toBe('Bearer sk-openai-secret');
    expect(JSON.parse(o.body!)).toEqual({
      model: 'gpt-5.4-nano',
      messages: [
        { role: 'system', content: 'S' },
        { role: 'user', content: 'Q' },
      ],
      max_completion_tokens: 50,
      stream: false,
    });
    const e = llmRequest(ollama, { prompt: 'Q', maxTokens: 50 });
    expect(e.headers.Authorization).toBeUndefined();
    expect(JSON.parse(e.body!)).toEqual({ model: 'gemma', messages: [{ role: 'user', content: 'Q' }], max_tokens: 50, stream: false });
  });

  it('reads the text, the tokens and whether the answer was cut, in either API', () => {
    expect(
      llmAnswer(anthropic, {
        content: [
          { type: 'thinking', thinking: 'hm' },
          { type: 'text', text: 'Short ' },
          { type: 'text', text: 'answer.' },
        ],
        usage: { input_tokens: 12, output_tokens: 3 },
        stop_reason: 'max_tokens',
      }),
    ).toEqual({ text: 'Short answer.', inputTokens: 12, outputTokens: 3, truncated: true });
    expect(
      llmAnswer(openai, {
        choices: [{ message: { content: 'Yes.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 7, completion_tokens: 1 },
      }),
    ).toEqual({ text: 'Yes.', inputTokens: 7, outputTokens: 1, truncated: false });
    // An endpoint that gives its content as parts, and no usage.
    expect(llmAnswer(ollama, { choices: [{ message: { content: [{ type: 'text', text: 'A' }] }, finish_reason: 'length' }] })).toEqual({
      text: 'A',
      inputTokens: 0,
      outputTokens: 0,
      truncated: true,
    });
    expect(() => llmAnswer(anthropic, { type: 'error' })).toThrow('anthropic/claude-haiku-5-5 answered with no content');
    expect(() => llmAnswer(openai, { choices: [] })).toThrow('openai/gpt-5.4-nano answered with no message');
  });
});

describe("RLM's sub-model: asking it", () => {
  /** A backend that answers with `status` and `body`, recording what was sent where. */
  function backend(status: number, body: string, o: Partial<LlmDeps> = {}) {
    const sent: { url: string; request: ProviderRequest; addresses?: readonly string[] }[] = [];
    const deps: LlmDeps = {
      send: async (url, request, addresses) => {
        sent.push({ url: url.href, request, ...(addresses ? { addresses } : {}) });
        return new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
      },
      net: { lookup: async () => ['93.184.216.34'] },
      relayPorts: () => [8787],
      own: () => [],
      ...o,
    };
    return { deps, sent };
  }
  const signal = new AbortController().signal;
  const openai = llmTarget(backends, 'openai/gpt-5.4-nano');

  it('sends the question to its backend and gives back the answer', async () => {
    const { deps, sent } = backend(
      200,
      JSON.stringify({ choices: [{ message: { content: 'Done.' } }], usage: { prompt_tokens: 4, completion_tokens: 2 } }),
    );
    expect(await llmComplete(openai, { prompt: 'Q', maxTokens: 10 }, signal, deps)).toEqual({
      text: 'Done.',
      inputTokens: 4,
      outputTokens: 2,
      truncated: false,
    });
    expect(sent.map((s) => s.url)).toEqual(['https://api.openai.com/v1/chat/completions']);
    expect(sent[0]!.addresses).toBeUndefined();
  });

  it('says why a backend refused, in its own words, never with the key', async () => {
    const { deps } = backend(
      401,
      JSON.stringify({ error: { message: 'Incorrect API key provided: sk-open***cret.', type: 'invalid_request_error' } }),
    );
    const err = await llmComplete(openai, { prompt: 'Q', maxTokens: 10 }, signal, deps).catch((e: Error) => e);
    expect((err as Error).message).toBe('openai/gpt-5.4-nano answered 401: Incorrect API key provided: sk-open***cret.');
    expect((err as Error).message).not.toContain('sk-openai-secret');
    const text = backend(502, 'Bad gateway');
    await expect(llmComplete(openai, { prompt: 'Q', maxTokens: 10 }, signal, text.deps)).rejects.toThrow(
      'openai/gpt-5.4-nano answered 502: Bad gateway',
    );
    const notJson = backend(200, '<html>');
    await expect(llmComplete(openai, { prompt: 'Q', maxTokens: 10 }, signal, notJson.deps)).rejects.toThrow(
      'openai/gpt-5.4-nano answered with something other than JSON',
    );
  });

  it('refuses an answer larger than it reads', async () => {
    const { deps } = backend(200, 'x'.repeat(4 * 1024 * 1024 + 1));
    await expect(llmComplete(openai, { prompt: 'Q', maxTokens: 10 }, signal, deps)).rejects.toThrow('the answer is larger than 4 MB');
  });

  it("refuses an endpoint whose name leads to this computer on one of Harness Relay's own ports, and pins the addresses it checked", async () => {
    const own: LlmTarget = {
      id: 'lab/m',
      kind: 'endpoint',
      model: 'm',
      url: new URL('http://relay.example.test:8787/v1/chat/completions'),
    };
    const local = backend(200, '{}', { net: { lookup: async () => ['127.0.0.1'] } });
    await expect(llmComplete(own, { prompt: 'Q', maxTokens: 10 }, signal, local.deps)).rejects.toThrow(
      "lab/m's endpoint is one of Harness Relay's own ports",
    );
    expect(local.sent).toEqual([]);
    const elsewhere = backend(200, JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
    await llmComplete(own, { prompt: 'Q', maxTokens: 10 }, signal, elsewhere.deps);
    expect(elsewhere.sent[0]!.addresses).toEqual(['93.184.216.34']);
  });

  it('ends the request itself when the run ends, not only the wait, and its reading of the answer', async () => {
    const stop = new AbortController();
    const signals: (AbortSignal | undefined)[] = [];
    const deps: LlmDeps = {
      ...backend(200, '{}').deps,
      send: (_url, request) => (signals.push(request.signal), new Promise<Response>(() => undefined)),
    };
    const asking = llmComplete(openai, { prompt: 'Q', maxTokens: 10 }, stop.signal, deps);
    stop.abort();
    await expect(asking).rejects.toThrow('the run ended');
    // The request was given the run's signal: its connection is closed with it.
    expect(signals).toHaveLength(1);
    expect(signals[0]!.aborted).toBe(true);
    await expect(llmComplete(openai, { prompt: 'Q', maxTokens: 10 }, stop.signal, deps)).rejects.toThrow('the run ended');

    // An answer still coming in: its reading is cancelled.
    const late = new AbortController();
    let cancelled = false;
    const slowBody = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => undefined), cancel: () => void (cancelled = true) });
    const reading = llmComplete(openai, { prompt: 'Q', maxTokens: 10 }, late.signal, {
      ...backend(200, '{}').deps,
      send: async () => new Response(slowBody, { status: 200 }),
    });
    await new Promise((r) => setTimeout(r, 20));
    late.abort();
    await expect(reading).rejects.toThrow('the run ended');
    expect(cancelled).toBe(true);
  });

  it('stops looking up an endpoint on one of its ports when the run ends', async () => {
    const stop = new AbortController();
    const own: LlmTarget = {
      id: 'lab/m',
      kind: 'endpoint',
      model: 'm',
      url: new URL('http://relay.example.test:8787/v1/chat/completions'),
    };
    const { deps, sent } = backend(200, '{}', { net: { lookup: () => new Promise(() => undefined) } });
    const asking = llmComplete(own, { prompt: 'Q', maxTokens: 10 }, stop.signal, deps);
    stop.abort();
    await expect(asking).rejects.toThrow('the run ended');
    expect(sent).toEqual([]);
  });
});
