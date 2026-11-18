/**
 * The model layer 3 of `scripts/cli-check.ts` runs the real CLIs on: a server on 127.0.0.1 that
 * answers from a script, in each API a CLI speaks to its model (Chat Completions, the Responses API,
 * the Anthropic Messages API, the Gemini API, and Muse Code's model catalog), streamed or not. Its
 * side of every exchange is fixed, so whatever changes between two versions' recordings is the CLI's.
 *
 * What it answers is set by the scenario named in the user's message (`[cli-check:<name>:<nonce>]`):
 * a reply that names the nonce, or first a call of the shell tool the CLI offers in its request (found
 * by its name and its parameters, its arguments filled from its schema) with the scenario's command,
 * then, once the request carries that call's result, a reply. A request without the marker (a title,
 * a summary the CLI asks for on the side) gets a short reply. Every request is kept, as the CLI sent
 * it, for the scenarios' checks (did a protected file's contents reach the model?).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export type Api = 'chat' | 'responses' | 'anthropic' | 'gemini';

/** The shell command a scenario's model asks the CLI to run; none: it only replies. */
export type Scenarios = Record<string, { command?: string; write?: { path: string; content: string }; thinking?: boolean }>;

export interface ToolDef {
  name: string;
  /** Its parameters' JSON schema (Gemini's types are upper case). */
  schema: Record<string, any>;
  /** The Responses API namespace it is in (Muse Code's tools are in `muse`), which its call names. */
  namespace?: string;
}

export interface ModelRequest {
  api: Api;
  path: string;
  model?: string;
  stream: boolean;
  /** The body as the CLI sent it. */
  raw: string;
  tools: string[];
  /** The scenario its user message names, with its nonce. */
  scenario?: { name: string; nonce: string };
  /** How many tool calls the conversation already holds. */
  calls: number;
  /** What it answered: a call of this tool, or a reply. */
  answered: { call?: { name: string; namespace?: string; args: Record<string, unknown> }; text?: string; thinking?: string };
}

export interface ScriptedModel {
  url: string;
  requests: ModelRequest[];
  /** Requests for an address it does not serve. */
  unknown: string[];
  close(): Promise<void>;
}

export const MODEL = 'cli-check-model';
export const MUSE_MODEL = 'muse-spark-1.3';

/** A scenario's marker, as the prompt carries it. */
export const marker = (name: string, nonce: string) => `[cli-check:${name}:${nonce}]`;
const MARKER = /\[cli-check:([a-z-]+):([0-9a-z]+)\]/g;

/** The shell tools of the CLIs, by name, most likely first. */
const SHELL_NAMES = [
  'bash',
  'shell',
  'exec_command',
  'shell_command',
  'run_shell_command',
  'run_terminal_cmd',
  'execute_command',
  'execute_bash',
  'terminal',
  'run_command',
  'developer__shell',
  'powershell',
  'command',
];

/** The shell tool among `tools`: by its name first, else one with a command parameter. */
export function shellTool(tools: readonly ToolDef[]): ToolDef | undefined {
  const named = (t: ToolDef) => t.name.toLowerCase().replace(/^.*__/, '');
  for (const n of SHELL_NAMES) {
    const t = tools.find((x) => x.name.toLowerCase() === n) ?? tools.find((x) => named(x) === n);
    if (t && commandKey(t)) return t;
  }
  return tools.find((t) => /shell|bash|exec|command|terminal/i.test(t.name) && commandKey(t));
}

/** Its parameter that takes the command: `command`, `cmd`, Antigravity's `CommandLine`… */
function commandKey(t: ToolDef): string | undefined {
  const keys = Object.keys(t.schema?.properties ?? {});
  for (const want of ['command', 'cmd', 'commandline', 'command_line', 'commands']) {
    const k = keys.find((x) => x.toLowerCase() === want);
    if (k) return k;
  }
  return undefined;
}

/** The CLIs' own tools that write a file, by name, most likely first. */
const WRITE_NAMES = [
  'write',
  'write_file',
  'create',
  'create_file',
  'write_to_file',
  'writefile',
  'file_editor',
  'str_replace_based_edit_tool',
  'text_editor',
  'developer__text_editor',
  'editor',
  'edit',
  'apply_patch',
];

const PATH_KEYS = ['file_path', 'filepath', 'path', 'absolutepath', 'targetfile', 'target_file', 'filename'];
const CONTENT_KEYS = ['content', 'contents', 'file_text', 'text', 'new_text', 'codecontent', 'code_content'];

/**
 * A call of the CLI's own tool that writes `path` with `content`, or undefined: a write tool by name
 * with a path and a content parameter (an editor tool's `command` set to make the file), or Codex's
 * `apply_patch` with a patch that adds it.
 */
export function writeCall(
  tools: readonly ToolDef[],
  path: string,
  content: string,
): { tool: ToolDef; args: Record<string, unknown> } | undefined {
  const named = (t: ToolDef) => t.name.toLowerCase().replace(/^.*__/, '');
  const keyOf = (t: ToolDef, want: string[]) => Object.keys(t.schema?.properties ?? {}).find((k) => want.includes(k.toLowerCase()));
  for (const n of WRITE_NAMES) {
    const t = tools.find((x) => x.name.toLowerCase() === n) ?? tools.find((x) => named(x) === n);
    if (!t) continue;
    const props: Record<string, any> = t.schema?.properties ?? {};
    if (n === 'apply_patch') {
      const key = Object.keys(props)[0] ?? 'input';
      return { tool: t, args: { [key]: `*** Begin Patch\n*** Add File: ${path}\n+${content}\n*** End Patch\n` } };
    }
    const pathKey = keyOf(t, PATH_KEYS);
    const contentKey = keyOf(t, CONTENT_KEYS);
    if (!pathKey || !contentKey) continue;
    const args: Record<string, unknown> = { [pathKey]: path, [contentKey]: content };
    // An editor tool (Goose's, OpenHands'): its command that makes a file.
    const command = Object.keys(props).find((k) => k.toLowerCase() === 'command');
    if (command) {
      const options: string[] = Array.isArray(props[command]?.enum) ? props[command].enum : [];
      args[command] = options.find((o) => o === 'create' || o === 'write') ?? 'create';
    }
    const required: string[] = Array.isArray(t.schema?.required) ? t.schema.required : [];
    for (const k of required) if (!(k in args)) args[k] = fill(k, props[k] ?? {});
    return { tool: t, args };
  }
  return undefined;
}

const typeOf = (s: any): string =>
  String(Array.isArray(s?.type) ? s.type.find((x: string) => x !== 'null') : (s?.type ?? '')).toLowerCase();

/** A shell tool's arguments for `command`: its command parameter, and every other required one filled from its schema. */
export function shellArgs(t: ToolDef, command: string): Record<string, unknown> {
  const props: Record<string, any> = t.schema?.properties ?? {};
  const required: string[] = Array.isArray(t.schema?.required) ? t.schema.required : [];
  const key = commandKey(t)!;
  const args: Record<string, unknown> = {};
  args[key] = typeOf(props[key]) === 'array' ? ['bash', '-lc', command] : command;
  for (const k of required) {
    if (k in args) continue;
    args[k] = fill(k, props[k] ?? {});
  }
  return args;
}

function fill(name: string, s: any): unknown {
  if (Array.isArray(s.enum) && s.enum.length) return s.enum[0];
  if (s.default !== undefined) return s.default;
  const type = typeOf(s);
  if (type === 'boolean') return false;
  if (type === 'integer' || type === 'number') {
    // Milliseconds or seconds to wait (Antigravity's `WaitMsBeforeAsync` takes 500 to 10000), within the schema's range.
    const want = /ms|milli/i.test(name) ? 10_000 : /timeout|wait/i.test(name) ? 120 : 0;
    const min = typeof s.minimum === 'number' ? s.minimum : -Infinity;
    const max = typeof s.maximum === 'number' ? s.maximum : Infinity;
    return Math.min(max, Math.max(min, want));
  }
  if (type === 'array') return [];
  if (type === 'object') return {};
  if (/dir|cwd|path|workdir/i.test(name)) return '.';
  return 'cli-check';
}

/** The tools a request offers, as one list whatever its API. */
export function toolsOf(api: Api, body: any): ToolDef[] {
  const tools: any[] = Array.isArray(body?.tools) ? body.tools : [];
  if (api === 'chat')
    return tools.filter((t) => t?.function?.name).map((t) => ({ name: t.function.name, schema: t.function.parameters ?? {} }));
  if (api === 'responses') {
    // A namespace holds functions of its own (Muse Code's `muse`), called with its name.
    return tools.flatMap((t) =>
      t?.type === 'namespace' && Array.isArray(t.tools)
        ? t.tools
            .filter((f: any) => f?.type === 'function' && f.name)
            .map((f: any) => ({ name: f.name, schema: f.parameters ?? {}, namespace: t.name }))
        : t?.type === 'function' && t.name
          ? [{ name: t.name, schema: t.parameters ?? {} }]
          : [],
    );
  }
  if (api === 'anthropic') return tools.filter((t) => t?.name).map((t) => ({ name: t.name, schema: t.input_schema ?? {} }));
  return tools.flatMap((t) =>
    (t?.functionDeclarations ?? []).map((f: any) => ({ name: f.name, schema: f.parametersJsonSchema ?? f.parameters ?? {} })),
  );
}

/** How many tool calls the conversation of a request already holds. */
export function callsOf(api: Api, body: any): number {
  if (api === 'chat')
    return (body?.messages ?? []).reduce((n: number, m: any) => n + (m?.role === 'assistant' ? (m.tool_calls?.length ?? 0) : 0), 0);
  if (api === 'responses') {
    const input = Array.isArray(body?.input) ? body.input : [];
    return input.filter((i: any) => /^(function_call|local_shell_call|custom_tool_call)$/.test(i?.type)).length;
  }
  if (api === 'anthropic') {
    return (body?.messages ?? []).reduce(
      (n: number, m: any) => n + (Array.isArray(m?.content) ? m.content.filter((c: any) => c?.type === 'tool_use').length : 0),
      0,
    );
  }
  return (body?.contents ?? []).reduce((n: number, c: any) => n + (c?.parts ?? []).filter((p: any) => p?.functionCall).length, 0);
}

/**
 * The scenario of a request: the last marker in what the user said (a resumed session's request holds
 * the earlier turn's marker too).
 */
export function scenarioOf(raw: string): { name: string; nonce: string } | undefined {
  let last: { name: string; nonce: string } | undefined;
  for (const m of raw.matchAll(MARKER)) last = { name: m[1]!, nonce: m[2]! };
  return last;
}

/** What the script answers a request. */
export function decide(
  scenarios: Scenarios,
  req: Pick<ModelRequest, 'scenario' | 'calls'>,
  tools: readonly ToolDef[],
): ModelRequest['answered'] {
  const sc = req.scenario && scenarios[req.scenario.name];
  if (!req.scenario || !sc) return { text: 'cli-check' };
  const thinking = sc.thinking ? `Thinking about ${req.scenario.nonce}.` : undefined;
  if (sc.write && req.calls === 0) {
    const w = writeCall(tools, sc.write.path, sc.write.content);
    if (w) {
      return {
        call: { name: w.tool.name, ...(w.tool.namespace ? { namespace: w.tool.namespace } : {}), args: w.args },
        ...(thinking ? { thinking } : {}),
      };
    }
    return {
      text: `cli-check ${req.scenario.name} ${req.scenario.nonce}: no write tool among ${tools.map((t) => t.name).join(', ') || 'none'}`,
    };
  }
  if (sc.command && req.calls === 0) {
    const tool = shellTool(tools);
    if (tool) {
      return {
        call: { name: tool.name, ...(tool.namespace ? { namespace: tool.namespace } : {}), args: shellArgs(tool, sc.command) },
        ...(thinking ? { thinking } : {}),
      };
    }
    return {
      text: `cli-check ${req.scenario.name} ${req.scenario.nonce}: no shell tool among ${tools.map((t) => t.name).join(', ') || 'none'}`,
    };
  }
  return { text: `cli-check ${req.scenario.name} ${req.scenario.nonce} done.`, ...(thinking ? { thinking } : {}) };
}

// ---------------------------------------------------------------------------
// Answers, in each API

type Send = (event: string | undefined, data: unknown) => void;
const usageChat = { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 };

function chatAnswer(a: ModelRequest['answered'], model: string, stream: boolean, send: Send, end: (body?: unknown) => void): void {
  const id = 'chatcmpl-cli-check';
  const call = a.call && {
    index: 0,
    id: 'call_cli_check',
    type: 'function',
    function: { name: a.call.name, arguments: JSON.stringify(a.call.args) },
  };
  const finish = a.call ? 'tool_calls' : 'stop';
  if (!stream) {
    return end({
      id,
      object: 'chat.completion',
      created: 0,
      model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: a.text ?? null,
            ...(a.thinking ? { reasoning_content: a.thinking } : {}),
            ...(call ? { tool_calls: [call] } : {}),
          },
          finish_reason: finish,
        },
      ],
      usage: usageChat,
    });
  }
  const chunk = (delta: unknown, finish_reason: string | null = null) =>
    send(undefined, { id, object: 'chat.completion.chunk', created: 0, model, choices: [{ index: 0, delta, finish_reason }] });
  chunk({ role: 'assistant', content: '' });
  if (a.thinking) chunk({ reasoning_content: a.thinking });
  if (a.text) for (const part of split(a.text)) chunk({ content: part });
  if (call) chunk({ tool_calls: [call] });
  chunk({}, finish);
  send(undefined, { id, object: 'chat.completion.chunk', created: 0, model, choices: [], usage: usageChat });
  send(undefined, '[DONE]');
  end();
}

function responsesAnswer(a: ModelRequest['answered'], model: string, stream: boolean, send: Send, end: (body?: unknown) => void): void {
  const base = { id: 'resp_cli_check', object: 'response', created_at: 0, model };
  const usage = {
    input_tokens: 12,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: 6,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 18,
  };
  const items: any[] = [];
  if (a.text) {
    items.push({
      id: 'msg_cli_check',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: a.text, annotations: [] }],
    });
  }
  if (a.call) {
    items.push({
      id: 'fc_cli_check',
      type: 'function_call',
      call_id: 'call_cli_check',
      name: a.call.name,
      ...(a.call.namespace ? { namespace: a.call.namespace } : {}),
      arguments: JSON.stringify(a.call.args),
      status: 'completed',
    });
  }
  if (!stream) return end({ ...base, status: 'completed', output: items, usage });
  let seq = 0;
  const ev = (type: string, data: Record<string, unknown>) => send(type, { type, sequence_number: seq++, ...data });
  ev('response.created', { response: { ...base, status: 'in_progress', output: [] } });
  ev('response.in_progress', { response: { ...base, status: 'in_progress', output: [] } });
  items.forEach((item, output_index) => {
    if (item.type === 'message') {
      ev('response.output_item.added', { output_index, item: { ...item, status: 'in_progress', content: [] } });
      ev('response.content_part.added', {
        item_id: item.id,
        output_index,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      });
      for (const delta of split(a.text!)) ev('response.output_text.delta', { item_id: item.id, output_index, content_index: 0, delta });
      ev('response.output_text.done', { item_id: item.id, output_index, content_index: 0, text: a.text });
      ev('response.content_part.done', { item_id: item.id, output_index, content_index: 0, part: item.content[0] });
    } else {
      ev('response.output_item.added', { output_index, item: { ...item, arguments: '', status: 'in_progress' } });
      ev('response.function_call_arguments.delta', { item_id: item.id, output_index, delta: item.arguments });
      ev('response.function_call_arguments.done', { item_id: item.id, output_index, arguments: item.arguments });
    }
    ev('response.output_item.done', { output_index, item });
  });
  ev('response.completed', { response: { ...base, status: 'completed', output: items, usage } });
  end();
}

function anthropicAnswer(
  a: ModelRequest['answered'],
  model: string,
  stream: boolean,
  thinkingOn: boolean,
  send: Send,
  end: (body?: unknown) => void,
): void {
  const blocks: any[] = [];
  if (a.thinking && thinkingOn) blocks.push({ type: 'thinking', thinking: a.thinking, signature: 'cli-check-signature' });
  if (a.text) blocks.push({ type: 'text', text: a.text });
  if (a.call) blocks.push({ type: 'tool_use', id: 'toolu_cli_check', name: a.call.name, input: a.call.args });
  const stop = a.call ? 'tool_use' : 'end_turn';
  const usage = { input_tokens: 12, output_tokens: 6, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const message = {
    id: 'msg_cli_check',
    type: 'message',
    role: 'assistant',
    model,
    content: blocks,
    stop_reason: stop,
    stop_sequence: null,
    usage,
  };
  if (!stream) return end(message);
  const ev = (type: string, data: Record<string, unknown>) => send(type, { type, ...data });
  ev('message_start', { message: { ...message, content: [], stop_reason: null, usage: { ...usage, output_tokens: 1 } } });
  blocks.forEach((b, index) => {
    if (b.type === 'thinking') {
      ev('content_block_start', { index, content_block: { type: 'thinking', thinking: '', signature: '' } });
      ev('content_block_delta', { index, delta: { type: 'thinking_delta', thinking: b.thinking } });
      ev('content_block_delta', { index, delta: { type: 'signature_delta', signature: b.signature } });
    } else if (b.type === 'text') {
      ev('content_block_start', { index, content_block: { type: 'text', text: '' } });
      for (const text of split(b.text)) ev('content_block_delta', { index, delta: { type: 'text_delta', text } });
    } else {
      ev('content_block_start', { index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
      ev('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
    }
    ev('content_block_stop', { index });
  });
  ev('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 6 } });
  ev('message_stop', {});
  end();
}

function geminiAnswer(a: ModelRequest['answered'], model: string, stream: boolean, send: Send, end: (body?: unknown) => void): void {
  const parts: any[] = [];
  if (a.thinking) parts.push({ text: a.thinking, thought: true });
  if (a.text) parts.push({ text: a.text });
  if (a.call) parts.push({ functionCall: { name: a.call.name, args: a.call.args } });
  const usageMetadata = { promptTokenCount: 12, candidatesTokenCount: 6, totalTokenCount: 18 };
  const whole = { candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP', index: 0 }], usageMetadata, modelVersion: model };
  if (!stream) return end(whole);
  send(undefined, { candidates: [{ content: { role: 'model', parts }, index: 0 }], modelVersion: model });
  send(undefined, {
    candidates: [{ content: { role: 'model', parts: [{ text: '' }] }, finishReason: 'STOP', index: 0 }],
    usageMetadata,
    modelVersion: model,
  });
  end();
}

/** A reply in a few pieces, as a model streams it. */
function split(text: string): string[] {
  const words = text.split(/(?<= )/);
  const out: string[] = [];
  for (let i = 0; i < words.length; i += 3) out.push(words.slice(i, i + 3).join(''));
  return out;
}

// ---------------------------------------------------------------------------

/** Starts the scripted model on 127.0.0.1 (a free port). */
export async function startModel(scenarios: Scenarios): Promise<ScriptedModel> {
  const requests: ModelRequest[] = [];
  const unknown: string[] = [];
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => (raw += c));
    req.on('end', () => {
      try {
        handle(req, res, raw);
      } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: (err as Error).message } }));
      }
    });
  });

  function handle(req: IncomingMessage, res: ServerResponse, raw: string): void {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    const json = (status: number, body: unknown): void =>
      void res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    // A check that the address answers (Claude Code's `HEAD /api/hello`).
    if (req.method === 'HEAD') return void res.writeHead(200).end();
    if (req.method === 'GET') {
      if (path.endsWith('/muse-code/models')) return json(200, { object: 'list', data: [{ id: MUSE_MODEL, object: 'model' }] });
      if (/\/v1beta\/models\/?$/.test(path)) {
        return json(200, {
          models: [{ name: `models/${MODEL}`, displayName: MODEL, supportedGenerationMethods: ['generateContent', 'countTokens'] }],
        });
      }
      if (/\/models\/?$/.test(path))
        return json(200, { object: 'list', data: [{ id: MODEL, object: 'model', created: 0, owned_by: 'cli-check' }] });
      unknown.push(`GET ${path}`);
      return json(404, { error: { message: `cli-check: no ${path}` } });
    }
    let body: any = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      /* not JSON: answered as an empty request */
    }
    if (path.endsWith('/messages/count_tokens')) return json(200, { input_tokens: 12 });
    if (path.endsWith(':countTokens')) return json(200, { totalTokens: 12 });
    const api: Api | undefined = path.endsWith('/chat/completions')
      ? 'chat'
      : path.endsWith('/responses')
        ? 'responses'
        : path.endsWith('/messages')
          ? 'anthropic'
          : /:(stream)?generateContent$/i.test(path)
            ? 'gemini'
            : undefined;
    if (!api) {
      unknown.push(`${req.method} ${path}`);
      return json(404, { error: { message: `cli-check: no ${path}` } });
    }
    const stream = api === 'gemini' ? /:streamGenerateContent$/i.test(path) : body.stream === true;
    const model = api === 'gemini' ? decodeURIComponent(/models\/([^:/]+)/.exec(path)?.[1] ?? MODEL) : String(body.model ?? MODEL);
    const tools = toolsOf(api, body);
    const scenario = scenarioOf(raw);
    const calls = callsOf(api, body);
    const answered = decide(scenarios, { ...(scenario ? { scenario } : {}), calls }, tools);
    requests.push({ api, path, model, stream, raw, tools: tools.map((t) => t.name), ...(scenario ? { scenario } : {}), calls, answered });

    const sse = api !== 'gemini' || url.searchParams.get('alt') === 'sse';
    if (stream) res.writeHead(200, { 'content-type': sse ? 'text/event-stream' : 'application/json', 'cache-control': 'no-cache' });
    // Gemini without alt=sse streams one JSON array.
    const pieces: unknown[] = [];
    const send: Send = (event, data) => {
      if (!sse) return void pieces.push(data);
      res.write(`${event ? `event: ${event}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
    };
    const end = (whole?: unknown): void => {
      if (whole !== undefined) return json(200, whole);
      res.end(sse ? undefined : JSON.stringify(pieces));
    };
    if (api === 'chat') chatAnswer(answered, model, stream, send, end);
    else if (api === 'responses') responsesAnswer(answered, model, stream, send, end);
    else if (api === 'anthropic')
      anthropicAnswer(answered, model, stream, body.thinking !== undefined && body.thinking?.type !== 'disabled', send, end);
    else geminiAnswer(answered, model, stream, send, end);
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    unknown,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
