'use strict';
/*
 * The fake Pi (`pi`, an open agent): `pi --version`, and `pi --mode rpc`: JSONL commands on stdin and
 * records on stdout, split on LF only, as Pi's RPC mode speaks them: `get_state`, `set_model`,
 * `get_commands`, `get_available_thinking_levels`, `set_thinking_level`, `get_available_models` (the
 * model catalog Harness Relay asks for), `prompt` (a turn's events up to `agent_settled`), `abort` and
 * `extension_ui_response`. It ends when its stdin does.
 *
 * Like Pi, it loads each extension `-e` names before it answers anything: Harness Relay's gate
 * (src/server/agents/piGate.js, the real file, imported by its path) is called with a small Pi API,
 * its command shows in `get_commands`, and its `tool_call` handler runs before every tool call, its
 * dialogs going out as Pi's RPC sends them (`extension_ui_request`, method `input`). A gate that does
 * not load registers nothing, so Harness Relay's own check refuses the run. `-e builtin:mcp` (with the
 * servers of `<PI_CODING_AGENT_DIR>/mcp.json`, their `${VAR}`s from the environment) stands for Pi's
 * MCP extension; `--no-mcp` leaves it out.
 *
 * Whether a call runs is decided only by what Harness Relay gave it, as with the real one: its tools
 * (`--tools`, else Pi's defaults read, bash, edit and write: no `ls` there, so a listing is a `bash`
 * `ls`), the gate's answers, and below full access Harness Relay's own sandbox around the process, the
 * real one: a write step really writes, and a write the sandbox refuses (EPERM, EROFS, EACCES) ends
 * the tool call as failed and the reply says "I may not write <path> here.". Commands are never run
 * (`echo e2e-approval`, or `npm publish e2e-approval` for `e2e:approve=publish`, the one kind that
 * asks in edit mode); with no tool for it (a read-only chat has no `bash` or `write`) it says so.
 * Pi has no to-do lists: `e2e:todo` shows nothing. It knows of no other working directory but those
 * its briefing names.
 *
 * Its model is the one `--model` names among those it knows: its catalog's (OpenAI, Anthropic and xAI
 * models, offered only with that provider's key in the environment) and models.json's providers (an
 * endpoint's, `relay-<id>`); a provider it knows with a model it does not becomes a model of that
 * provider, as Pi makes one. A prompt whose provider has no key is refused ("No API key found"), as
 * Pi refuses it. `--thinking` and `set_thinking_level` clamp to what the model offers.
 *
 * Its sessions are Pi's files, `<PI_CODING_AGENT_SESSION_DIR>/<time>_<id>.jsonl`, whose header line
 * Harness Relay checks before it resumes one with `--session <file>`; its marks (`e2e:flaky`) go in
 * the same folder, the only one of a member's that its runs may write and that is kept.
 *
 * It logs (`record()`) each prompt with the briefing, images, MCP servers, model (Pi's own
 * `<provider>/<id>`), effort, its active tools, whether the gate is loaded, the instruction files it
 * loads by itself, the names of the key variables it got (never their values) and its folders.
 * Inside Harness Relay's sandbox those lines go to the test's fake endpoint (`lib/log.cjs`).
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { targetOf } = require('../lib/files.cjs');
const { keyVerdict } = require('../lib/home.cjs');
const { exitAfterLog, record, refused } = require('../lib/log.cjs');
const { declined, directivesIn, lastUserMessage, noOther, noteIn, pieceDelay, pieces, plan, recordMcpEnv, wrote } = require('../lib/plan.cjs');
const { fail, out } = require('../lib/rpc.cjs');
const { args, flag, has, sleep } = require('../lib/self.cjs');

/** Pi's thinking levels, lowest first. */
const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/** Pi's tools when `--tools` does not say. */
const DEFAULT_TOOLS = ['read', 'bash', 'edit', 'write'];

/** The variable each provider of its catalog takes its key from. */
const KEY_VAR = { openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', xai: 'XAI_API_KEY' };

/** The variables a key may reach it in (logged by name only). */
const KEY_VARS = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'XAI_API_KEY', 'HARNESS_RELAY_ENDPOINT_API_KEY'];

const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** Its own catalog, as `get_available_models` gives it (shapes of test/fixtures/pi/available-models.jsonl). */
const CATALOG = [
  {
    id: 'gpt-fake',
    name: 'GPT Fake',
    api: 'openai-responses',
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    reasoning: true,
    input: ['text', 'image'],
    cost: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 0 },
    contextWindow: 400000,
    maxTokens: 128000,
    thinkingLevelMap: { off: 'none', minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: null },
  },
  {
    id: 'gpt-fake-mini',
    name: 'GPT Fake mini',
    api: 'openai-responses',
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    reasoning: false,
    input: ['text', 'image'],
    cost: { input: 0.25, output: 1, cacheRead: 0.025, cacheWrite: 0 },
    contextWindow: 400000,
    maxTokens: 128000,
  },
  {
    id: 'claude-fake',
    name: 'Claude Fake',
    api: 'anthropic-messages',
    provider: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    reasoning: true,
    input: ['text', 'image'],
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    contextWindow: 1000000,
    maxTokens: 128000,
    thinkingLevelMap: { off: null, xhigh: 'xhigh', max: 'max' },
  },
  {
    id: 'grok-fake',
    name: 'Grok Fake',
    api: 'openai-responses',
    provider: 'xai',
    baseUrl: 'https://api.x.ai/v1',
    reasoning: true,
    input: ['text', 'image'],
    cost: { input: 2, output: 10, cacheRead: 0.5, cacheWrite: 0 },
    contextWindow: 256000,
    maxTokens: 64000,
  },
];

const env = process.env;
const agentDir = () => env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent');
const sessionsDir = () => env.PI_CODING_AGENT_SESSION_DIR || path.join(agentDir(), 'sessions');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/** The levels a model takes (Pi's rule, as `piModelLevels` reads it). */
function levelsOf(model) {
  if (!model || !model.reasoning) return ['off'];
  const map = model.thinkingLevelMap || {};
  return LEVELS.filter((l) => (map[l] === null ? false : l === 'xhigh' || l === 'max' ? typeof map[l] === 'string' : true));
}

/** A level the model takes: the one asked for, else the nearest one below it (`off` for a level Pi has not). */
function clampLevel(model, level) {
  const offered = levelsOf(model);
  if (!LEVELS.includes(level)) return offered.includes('off') ? 'off' : offered[0];
  if (offered.includes(level)) return level;
  for (let i = LEVELS.indexOf(level); i >= 0; i--) if (offered.includes(LEVELS[i])) return LEVELS[i];
  return offered[0];
}

/** models.json's providers (`{ name, baseUrl, api, apiKey, models }` each), none when it has none. */
const modelsJson = () => (readJson(path.join(agentDir(), 'models.json')) || {}).providers || {};

/**
 * Every model it knows: its catalog's, with the models models.json adds to a catalog provider, and
 * each models.json provider's own. `available`: only those of a provider with a key (what
 * `get_available_models` lists).
 */
function registry({ available = false } = {}) {
  const models = CATALOG.map((m) => ({ ...m }));
  for (const [provider, p] of Object.entries(modelsJson())) {
    const own = models.find((m) => m.provider === provider) || {};
    for (const m of p.models || []) {
      const at = models.findIndex((x) => x.provider === provider && x.id === m.id);
      const model = {
        id: m.id,
        name: m.name || m.id,
        api: m.api || p.api || own.api || 'openai-completions',
        provider,
        baseUrl: m.baseUrl || p.baseUrl || own.baseUrl,
        reasoning: Boolean(m.reasoning),
        input: m.input || ['text'],
        cost: { ...zeroCost },
        contextWindow: m.contextWindow || 128000,
        maxTokens: m.maxTokens || 16384,
      };
      if (at >= 0) models[at] = model;
      else models.push(model);
    }
  }
  return available ? models.filter((m) => keyFor(m.provider) !== undefined) : models;
}

/**
 * The key a provider has: its models.json `apiKey` (`$VAR` from the environment; a variable's name, or
 * the key itself), else its catalog variable. Undefined: none, as Pi says "No API key found".
 */
function keyFor(provider) {
  const p = modelsJson()[provider];
  const value = p && typeof p.apiKey === 'string' ? p.apiKey : undefined;
  if (value !== undefined) {
    if (value.startsWith('$')) return env[value.slice(1)] || undefined;
    return env[value] || value || undefined;
  }
  return KEY_VAR[provider] ? env[KEY_VAR[provider]] || undefined : undefined;
}

/**
 * The model `ref` (`<provider>/<id>`) names: one it knows; for a provider it knows, a model made from
 * the provider's first (as Pi copies one); else its first available model, or none.
 */
function resolveModel(ref) {
  const all = registry();
  const at = String(ref || '').indexOf('/');
  const provider = at > 0 ? ref.slice(0, at) : '';
  const id = at > 0 ? ref.slice(at + 1) : String(ref || '');
  const exact = all.find((m) => m.provider === provider && m.id === id);
  if (exact) return exact;
  const base = all.find((m) => m.provider === provider);
  if (base && id) {
    const made = { ...base, id, name: id, reasoning: true, cost: { ...zeroCost } };
    delete made.thinkingLevelMap;
    return made;
  }
  return registry({ available: true })[0];
}

// --- Extensions -----------------------------------------------------------------------------------

/** What the loaded extensions registered: their commands, and their handlers by event. */
const extensions = { commands: [], handlers: {} };

/** Loads the extension at `abs` as Pi does (`-e <file>`): its default export, called with Pi's API. */
async function loadExtension(abs) {
  const commands = [];
  const handlers = [];
  const api = {
    registerCommand: (name, o = {}) => commands.push({ name, description: o.description || '', source: 'extension', sourceInfo: { path: abs, source: 'cli', scope: 'temporary', origin: 'top-level' } }),
    on: (event, handler) => handlers.push([event, handler]),
    registerTool: () => undefined,
    registerShortcut: () => undefined,
    registerFlag: () => undefined,
    getFlag: () => undefined,
    sendMessage: () => undefined,
  };
  let mod;
  try {
    mod = await import(pathToFileURL(abs).href);
  } catch (first) {
    // A Node single executable may not `import()` from disk: Node's own require of an ES module then.
    try {
      mod = require('node:module').createRequire(abs)(abs);
    } catch {
      return void out({ type: 'extension_error', extensionPath: abs, event: 'load', error: first && first.message ? first.message : String(first) });
    }
  }
  const factory = mod && typeof mod.default === 'function' ? mod.default : typeof mod === 'function' ? mod : undefined;
  if (!factory) return void out({ type: 'extension_error', extensionPath: abs, event: 'load', error: 'Extension does not export a default function' });
  try {
    await factory(api);
  } catch (err) {
    return void out({ type: 'extension_error', extensionPath: abs, event: 'load', error: err && err.message ? err.message : String(err) });
  }
  extensions.commands.push(...commands);
  for (const [event, handler] of handlers) (extensions.handlers[event] ||= []).push(handler);
}

/** Every `-e` value, in order. */
function extensionArgs() {
  const out = [];
  for (let i = 0; i < args.length; i++) if (args[i] === '-e' || args[i] === '--extension') out.push(args[i + 1]);
  return out.filter(Boolean);
}

/** MCP (`-e builtin:mcp`): the servers of mcp.json, by name, with their values from the environment. */
function loadMcp() {
  extensions.commands.push({
    name: 'mcp',
    description: 'Manage MCP servers: sign in, reconnect, enable or disable, and change exposure',
    source: 'extension',
    sourceInfo: { path: 'builtin:mcp', source: 'builtin', scope: 'temporary', origin: 'top-level' },
  });
  const servers = (readJson(path.join(agentDir(), 'mcp.json')) || {}).mcpServers || {};
  const fill = (values) => Object.fromEntries(Object.entries(values || {}).map(([k, v]) => [k, String(v).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => env[name] || '')]));
  recordMcpEnv(
    Object.fromEntries(Object.entries(servers).map(([name, s]) => [name, fill(s.url ? s.headers : s.env)])),
    Object.fromEntries(Object.entries(servers).filter(([, s]) => s.url).map(([name, s]) => [name, s.url])),
  );
  return Object.keys(servers);
}

// --- Sessions -----------------------------------------------------------------------------------

const shortId = () => crypto.randomBytes(4).toString('hex');

/**
 * The session of this process: `--session <file>` resumed (its header's id and folder, its own model
 * and level), else a new one in the sessions folder, or none kept with `--no-session`.
 */
function openSession() {
  const file = flag('--session');
  if (file && fs.existsSync(file)) {
    const entries = fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .flatMap((l) => {
        try {
          return [JSON.parse(l)];
        } catch {
          return [];
        }
      });
    const header = entries[0] && entries[0].type === 'session' ? entries[0] : undefined;
    if (header) {
      const model = entries.filter((e) => e.type === 'model_change').pop();
      const level = entries.filter((e) => e.type === 'thinking_level_change').pop();
      const s = {
        id: header.id,
        file,
        cwd: header.cwd || process.cwd(),
        last: entries[entries.length - 1].id || null,
        messages: entries.filter((e) => e.type === 'message').length,
        model: model ? `${model.provider}/${model.modelId}` : undefined,
        level: level ? level.thinkingLevel : undefined,
        resumed: true,
      };
      record({ session: s.id, resumed: true });
      return s;
    }
  }
  // A new session (Pi starts one quietly for a `--session` file that is not there).
  const id = crypto.randomUUID();
  const s = { id, cwd: process.cwd(), last: null, messages: 0, resumed: false };
  if (!has('--no-session')) {
    const at = new Date().toISOString();
    s.file = path.join(sessionsDir(), `${at.replace(/[:.]/g, '-')}_${id}.jsonl`);
    fs.mkdirSync(sessionsDir(), { recursive: true });
    fs.writeFileSync(s.file, JSON.stringify({ type: 'session', version: 3, id, timestamp: at, cwd: s.cwd }) + '\n');
    record({ session: id, resumed: false });
  }
  return s;
}

/** Adds an entry to the session's file (none with `--no-session`). */
function append(s, entry) {
  const id = shortId();
  const line = { ...entry, id, parentId: s.last, timestamp: new Date().toISOString() };
  s.last = id;
  if (entry.type === 'message') s.messages++;
  if (s.file) fs.appendFileSync(s.file, JSON.stringify(line) + '\n');
}

// --- What it loads by itself --------------------------------------------------------------------

const CONTEXT_FILES = ['AGENTS.override.md', 'AGENTS.md', 'AGENTS.MD', 'CLAUDE.md', 'CLAUDE.MD'];

/** The instruction files Pi loads: its agent folder's, then one per folder from `/` down to `cwd` (none with `--no-context-files`). */
function contextFiles(cwd) {
  if (has('--no-context-files')) return [];
  const isFile = (p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  };
  const dirs = [];
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    dirs.unshift(dir);
    if (path.dirname(dir) === dir) break;
  }
  const pick = (dir) => CONTEXT_FILES.map((n) => path.join(dir, n)).find(isFile);
  return [...new Set([pick(agentDir()), ...dirs.map(pick)].filter(Boolean))];
}

/** `--append-system-prompt`: a file's text, or the text itself. */
function briefingOf() {
  const value = flag('--append-system-prompt');
  if (value === undefined) return '';
  try {
    return fs.readFileSync(value, 'utf8');
  } catch {
    return value;
  }
}

/** The working directories besides `cwd` that a briefing names: Pi has no flag for them. */
function briefedOthers(briefing, cwd) {
  const shared = /share these working directories, each with the same access: (.+?)\. You start in /.exec(briefing);
  const dirs = shared ? shared[1].split(', ') : [...briefing.matchAll(/^ {2}- (.+?) \(branch /gm)].map((m) => m[1]);
  return dirs.filter((d) => path.resolve(d) !== path.resolve(cwd));
}

/** Pi's `ls` output: the folder's entries, folders with a `/`, in name order. */
function lsOutput(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    .join('\n');
}

// --- The RPC ------------------------------------------------------------------------------------

function rpcMain() {
  let mcp = [];
  let tools = [];
  let session;
  let model;
  let level = 'off';
  /** The turn under way: its abort controller and its end. */
  let current;
  /** The gate's dialogs waiting for their answer, by id. */
  const dialogs = new Map();

  const respond = (cmd, data, error) =>
    out({
      ...(cmd.id === undefined ? {} : { id: cmd.id }),
      type: 'response',
      command: cmd.type,
      success: !error,
      ...(error ? { error } : data === undefined ? {} : { data }),
    });

  const isActive = (name) => tools.some((t) => t === name || (t.endsWith('*') && name.startsWith(t.slice(0, -1))));

  const state = () => ({
    model,
    thinkingLevel: level,
    isStreaming: Boolean(current),
    isCompacting: false,
    steeringMode: 'one-at-a-time',
    followUpMode: 'one-at-a-time',
    ...(session.file ? { sessionFile: session.file } : {}),
    sessionId: session.id,
    autoCompactionEnabled: true,
    messageCount: session.messages,
    pendingMessageCount: 0,
  });

  const ui = {
    /** An `input` dialog over the RPC: its value, or undefined when cancelled or when the turn is stopped. */
    input: (title, placeholder, o = {}) =>
      new Promise((resolve) => {
        if (o.signal && o.signal.aborted) return resolve(undefined);
        const id = crypto.randomUUID();
        dialogs.set(id, resolve);
        out({ type: 'extension_ui_request', id, method: 'input', title, placeholder });
        if (o.signal) o.signal.addEventListener('abort', () => dialogs.delete(id) && resolve(undefined), { once: true });
      }),
    confirm: () => Promise.resolve(false),
    select: () => Promise.resolve(undefined),
    notify: () => undefined,
    setStatus: () => undefined,
  };

  async function start() {
    for (const e of extensionArgs()) if (!e.startsWith('builtin:')) await loadExtension(path.resolve(e));
    if (extensionArgs().includes('builtin:mcp') && !has('--no-mcp')) mcp = loadMcp();
    tools = flag('--tools') ? flag('--tools').split(',').map((t) => t.trim()).filter(Boolean) : [...DEFAULT_TOOLS, ...mcp.map((s) => `mcp__${s}__*`)];
    session = openSession();
    // A resumed session keeps its own model and level (`--thinking` over its level).
    model = (session.model && registry().find((m) => `${m.provider}/${m.id}` === session.model)) || resolveModel(flag('--model'));
    level = clampLevel(model, flag('--thinking') || session.level || 'off');
    if (!session.resumed && session.file && model) {
      append(session, { type: 'model_change', provider: model.provider, modelId: model.id });
      append(session, { type: 'thinking_level_change', thinkingLevel: level });
    }
  }

  async function handle(cmd) {
    switch (cmd.type) {
      case 'get_state':
        return respond(cmd, state());
      case 'set_model': {
        const m = registry().find((x) => x.provider === cmd.provider && x.id === cmd.modelId);
        if (!m) return respond(cmd, undefined, `Model not found: ${cmd.provider}/${cmd.modelId}`);
        model = m;
        level = clampLevel(model, level);
        append(session, { type: 'model_change', provider: m.provider, modelId: m.id });
        return respond(cmd, m);
      }
      case 'get_commands':
        return respond(cmd, { commands: extensions.commands });
      case 'get_available_thinking_levels':
        return respond(cmd, { levels: levelsOf(model) });
      case 'set_thinking_level': {
        const now = clampLevel(model, cmd.level);
        if (now !== cmd.level) out({ type: 'thinking_level_changed', level: now });
        level = now;
        append(session, { type: 'thinking_level_change', thinkingLevel: now });
        return respond(cmd);
      }
      case 'get_available_models':
        return respond(cmd, { models: registry({ available: true }) });
      case 'prompt': {
        if (current) return respond(cmd, undefined, 'Agent is already processing. Specify streamingBehavior to queue the message.');
        if (!model) return respond(cmd, undefined, 'No model selected.\n\nUse /login or set an API key, then select a model with /model.');
        if (keyFor(model.provider) === undefined) {
          return respond(cmd, undefined, `No API key found for ${model.provider}.\n\nUse /login to log into a provider via OAuth or API key.`);
        }
        respond(cmd, { disposition: 'started' });
        const ac = new AbortController();
        // A turn that breaks ends the process, as a crashed Pi does: Harness Relay shows its stderr.
        const done = turn(cmd, ac.signal).catch((err) => fail(`fake pi: ${err && err.stack ? err.stack : err}`));
        current = { ac, done: done.finally(() => (current = undefined)) };
        return current.done;
      }
      case 'abort':
        // Answered once the turn has settled (at once when there is none).
        if (current) {
          current.ac.abort();
          await current.done;
        }
        return respond(cmd);
      case 'extension_ui_response': {
        const resolve = dialogs.get(cmd.id);
        dialogs.delete(cmd.id);
        if (resolve) resolve(cmd.cancelled ? undefined : cmd.value);
        return;
      }
      default:
        return respond(cmd, undefined, `Unknown command: ${cmd.type}`);
    }
  }

  /** One prompt: the plan's steps as Pi's events, up to `agent_settled`. */
  async function turn(cmd, signal) {
    const prompt = String(cmd.message || '');
    const images = (cmd.images || []).filter((i) => i && i.type === 'image' && i.data);
    const briefing = briefingOf();
    const cwd = session.cwd;
    const ref = `${model.provider}/${model.id}`;
    record({
      prompt,
      briefing,
      images: images.length,
      mcp,
      model: ref,
      effort: level,
      tools,
      gate: extensions.commands.some((c) => c.name === 'harness-relay-gate'),
      instructions: contextFiles(cwd),
      skills: [],
      keys: KEY_VARS.filter((k) => env[k]),
      agentDir: agentDir(),
      sessionsDir: sessionsDir(),
    });
    const steps = plan(prompt, { cwd, images: images.length, mcp, briefing });
    const d = directivesIn(lastUserMessage(prompt) || '');
    if (steps[0] && steps[0].type === 'fail') return fail(steps[0].text);

    const usage = () => {
      const priced = model.cost && model.cost.input > 0;
      const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: priced ? 0.0012 : 0 };
      return { input: 90, output: 25, cacheRead: 10, cacheWrite: 0, totalTokens: 125, cost };
    };
    const base = () => ({ role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id });
    const finished = [];

    out({ type: 'agent_start' });
    out({ type: 'turn_start' });
    if (!session.messages) {
      const system = { role: 'system', content: '', sections: { preamble: 'You are a coding assistant running inside pi (a fake for the end-to-end tests).' } };
      out({ type: 'message_start', message: system });
      out({ type: 'message_end', message: system });
      append(session, { type: 'message', message: system });
    }
    const user = { role: 'user', content: [{ type: 'text', text: prompt }, ...images.map((i) => ({ type: 'image', data: i.data, mimeType: i.mimeType }))], timestamp: Date.now() };
    out({ type: 'message_start', message: user });
    out({ type: 'message_end', message: user });
    append(session, { type: 'message', message: user });

    /** The assistant message being written. */
    let msg = { ...base(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { ...zeroCost, total: 0 } }, stopReason: 'pending', timestamp: Date.now() };
    out({ type: 'message_start', message: msg });
    const update = (e) => out({ type: 'message_update', assistantMessageEvent: e });
    const endMessage = (stopReason, extra = {}) => {
      msg = { ...msg, usage: stopReason === 'aborted' ? msg.usage : usage(), stopReason, ...extra, thinkingLevel: level };
      out({ type: 'message_end', message: msg });
      finished.push(msg);
      return msg;
    };
    const nextMessage = () => {
      msg = { ...base(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { ...zeroCost, total: 0 } }, stopReason: 'pending', timestamp: Date.now() };
      out({ type: 'turn_start' });
      out({ type: 'message_start', message: msg });
    };
    /** Streams a block of `kind` (`thinking` or `text`); false when the turn was stopped on its way. */
    const stream = async (kind, text, slow = false) => {
      const contentIndex = msg.content.length;
      const block = kind === 'text' ? { type: 'text', text: '' } : { type: 'thinking', thinking: '' };
      msg.content.push(block);
      update({ type: `${kind}_start`, contentIndex });
      for (const piece of pieces(text, slow)) {
        if (signal.aborted) return false;
        block[kind === 'text' ? 'text' : 'thinking'] += piece;
        update({ type: `${kind}_delta`, contentIndex, delta: piece });
        await sleep(pieceDelay(slow));
      }
      update({ type: `${kind}_end`, contentIndex, content: block[kind === 'text' ? 'text' : 'thinking'] });
      return true;
    };
    /** Ends the turn: Pi's last records, and the reply kept in the session. */
    const settle = (aborted) => {
      out({ type: 'turn_end', message: msg, toolResults: [] });
      out({ type: 'agent_end', messages: finished });
      for (const m of finished.slice(-1)) append(session, { type: 'message', message: m });
      out({ type: 'agent_settled', aborted });
    };
    // Stopped: the message on its way ends with what it had (Pi's aborted message), and the turn settles.
    const stopped = () => {
      endMessage('aborted', { errorMessage: 'This operation was aborted' });
      settle(true);
    };

    let n = 0;
    /**
     * One tool call: the assistant message that makes it, Harness Relay's gate (every handler of the
     * extensions' `tool_call`), then the tool, and its result for the next assistant message. Its
     * outcome: `ok` with the result's text, or not (`text`: why), or `aborted`.
     */
    const call = async (toolName, input, run) => {
      const toolCallId = `call_fake_${process.pid}_${++n}`;
      const contentIndex = msg.content.length;
      const toolCall = { type: 'toolCall', id: toolCallId, name: toolName, arguments: input };
      update({ type: 'toolcall_start', contentIndex, id: toolCallId, toolName });
      update({ type: 'toolcall_delta', contentIndex, delta: JSON.stringify(input) });
      msg.content.push(toolCall);
      update({ type: 'toolcall_end', contentIndex, toolCall });
      const asked = endMessage('toolUse');
      out({ type: 'tool_execution_start', toolCallId, toolName, args: input });
      let blocked;
      for (const handler of extensions.handlers.tool_call || []) {
        try {
          const r = await handler({ type: 'tool_call', toolCallId, toolName, input }, { hasUI: true, ui, signal, cwd });
          if (r && r.block) blocked = r.reason || 'Blocked by an extension';
        } catch (err) {
          blocked = `Extension failed, blocking execution: ${err && err.message ? err.message : String(err)}`;
        }
        if (blocked) break;
      }
      let result;
      if (signal.aborted) result = { ok: false, aborted: true, text: 'Operation aborted', details: {} };
      else if (blocked) result = { ok: false, text: blocked, details: {} };
      else result = run();
      out({ type: 'tool_execution_end', toolCallId, toolName, result: { content: [{ type: 'text', text: result.text }], details: result.details || {} }, isError: !result.ok });
      const toolResult = { role: 'toolResult', toolCallId, toolName, content: [{ type: 'text', text: result.text }], details: result.details || {}, isError: !result.ok, timestamp: Date.now() };
      out({ type: 'message_start', message: toolResult });
      out({ type: 'message_end', message: toolResult });
      out({ type: 'turn_end', message: asked, toolResults: [toolResult] });
      nextMessage();
      return result;
    };

    /** The `bash` tool: never runs anything; what the commands the fake asks about would print. */
    const bash = (command) => () => {
      if (command === 'ls') return { ok: true, text: fs.readdirSync(cwd).filter((e) => !e.startsWith('.')).sort().join('\n') };
      return { ok: true, text: /\be2e-approval\b/.test(command) ? 'e2e-approval' : '(no output)' };
    };
    /** The `write` tool: the file really written, as far as the sandbox lets it. */
    const write = (file, content) => () => {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content);
        return { ok: true, text: `Successfully wrote to ${file}` };
      } catch (err) {
        // The sandbox's refusal (EPERM, EROFS, EACCES) as Pi's write tool reports any failure: its message.
        return { ok: false, text: refused(err) ? err.message : `Could not write ${file}: ${err.message}` };
      }
    };

    let prefix = '';
    const think = steps.find((s) => s.type === 'think');
    if (think && !(await stream('thinking', think.text))) return stopped();
    for (const step of steps) {
      if (signal.aborted) return stopped();
      if (step.type === 'error') {
        const errorMessage =
          { key: '401 "Unauthorized"', model: '404: {"message":"The model `fake` does not exist."}', connection: 'Connection error.: connect ECONNREFUSED 127.0.0.1:9' }[d.error] ||
          step.text;
        endMessage('error', { errorMessage });
        return settle(false);
      }
      if (step.type === 'tool') {
        const r = isActive('ls') ? await call('ls', { path: cwd }, () => ({ ok: true, text: lsOutput(cwd) })) : isActive('bash') ? await call('bash', { command: 'ls' }, bash('ls')) : undefined;
        if (r && r.aborted) return stopped();
      }
      if (step.type === 'approve') {
        const command = d.approve === 'publish' ? 'npm publish e2e-approval' : step.command;
        if (!isActive('bash')) {
          prefix += 'I have no tool to run commands here. ';
          continue;
        }
        const r = await call('bash', { command }, bash(command));
        if (r.aborted) return stopped();
        prefix += r.ok ? 'The command ran: e2e-approval. ' : declined('command', noteIn(r.text));
      }
      if (step.type === 'write') {
        const file = targetOf(step, cwd, briefedOthers(briefing, cwd));
        if (!file) {
          prefix += noOther(step);
          continue;
        }
        if (!isActive('write')) {
          prefix += wrote(step, false);
          continue;
        }
        const r = await call('write', { path: file, content: step.content }, write(file, step.content));
        if (r.aborted) return stopped();
        prefix += wrote(step, r.ok, r.ok ? '' : noteIn(r.text));
      }
      if (step.type === 'text') {
        if (!(await stream('text', prefix + step.text, step.slow))) return stopped();
        endMessage('stop');
        return settle(false);
      }
    }
    endMessage('stop');
    return settle(false);
  }

  // Commands, one JSON object a line (LF only: a CR before it is dropped), handled in order; an
  // unreadable one is answered as Pi answers it.
  let queue = Promise.resolve();
  let buf = Buffer.alloc(0);
  const ready = start().catch((err) => {
    process.stderr.write(`fake pi: ${err && err.stack ? err.stack : err}\n`, () => exitAfterLog(1));
    return new Promise(() => {});
  });
  const take = (line) => {
    if (!line.trim()) return;
    let cmd;
    try {
      cmd = JSON.parse(line);
    } catch (err) {
      return void out({ type: 'response', command: 'parse', success: false, error: `Failed to parse command: ${err.message}` });
    }
    if (!cmd || typeof cmd !== 'object') return;
    // `abort` and dialog answers arrive while a prompt runs: never queued behind it.
    if (cmd.type === 'abort' || cmd.type === 'extension_ui_response') return void ready.then(() => handle(cmd));
    queue = queue.then(() => ready).then(() => handle(cmd).then(() => undefined, (err) => process.stderr.write(`fake pi: ${err && err.stack ? err.stack : err}\n`)));
  };
  process.stdin.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (let i = buf.indexOf(10); i >= 0; i = buf.indexOf(10)) {
      const line = buf.subarray(0, i).toString('utf8');
      buf = buf.subarray(i + 1);
      take(line.endsWith('\r') ? line.slice(0, -1) : line);
    }
  });
  // Pi ends when its stdin does, whatever is under way.
  process.stdin.on('end', () => process.stdout.write('', () => exitAfterLog(0)));
}

module.exports = {
  provider: 'pi',
  bin: 'pi',
  aliases: [],
  label: 'Pi',
  name: 'Pi',
  version: '1.5.998',
  versionRe: /^1\.5\.998$/m,
  /**
   * Its state, which a run may write (its adapter's `statePaths`): `PI_CODING_AGENT_SESSION_DIR`,
   * where its sessions and marks go.
   */
  home: (e) => e.PI_CODING_AGENT_SESSION_DIR || path.join(os.homedir(), '.pi', 'agent', 'sessions'),
  /**
   * The key its run got, by `keyVerdict`: its model backend's (OPENAI_API_KEY, ANTHROPIC_API_KEY,
   * XAI_API_KEY) or its endpoint's (HARNESS_RELAY_ENDPOINT_API_KEY); null for none. Its prompts log
   * which of those variables it got (`keys`).
   */
  apiKey: (e) => {
    const name = KEY_VARS.find((k) => e[k]);
    return name ? keyVerdict(e[name]) : null;
  },
  main() {
    if (flag('--mode') === 'rpc') return rpcMain();
    if (has('--version') || has('-v')) return void process.stdout.write(`${module.exports.version}\n`);
    process.stderr.write(`fake pi: unknown command ${args.join(' ')}\n`, () => exitAfterLog(1));
  },
};
