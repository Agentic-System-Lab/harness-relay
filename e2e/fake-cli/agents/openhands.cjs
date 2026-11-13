'use strict';
/*
 * The fake OpenHands (`openhands`, an open agent): `openhands acp` (ACP: sessions, `session/update`,
 * `session/request_permission`) and `--version`. Anything else exits with an error at once. Settings'
 * list of what it loads by itself is read from the project's files by the server; its models from
 * LiteLLM's list in its install, which e2e/support/fake-cli.ts lays out as `uv tool install` does
 * (`litellmModels` below).
 *
 * As Harness Relay drives the real one (1.16.0, src/server/agents/openhands.ts), everything a run gets
 * comes from its environment and the run's own home, written before it starts:
 * - `agent_settings.json` (OPENHANDS_PERSISTENCE_DIR): the model (`llm.model`, `<openai|anthropic|xai>/…`,
 *   an endpoint's with `llm.base_url`), the effort (`llm.reasoning_effort`), its tools
 *   (`filter_tools_regex`); without it no session starts. The key is the environment's variable for
 *   the model's provider (none: the prompt fails as LiteLLM does). `mcp.json` there: the MCP servers
 *   (ACP's `mcpServers` are ignored). Its skills in `$HOME/.openhands/skills`: the briefing, which goes
 *   into the session's system prompt, kept from the session's start;
 * - its sessions in OPENHANDS_CONVERSATIONS_DIR, as it keeps them: `<id without dashes>/base_state.json`
 *   (its state, the conversation's usage so far) and `events/event-NNNNN-<id>.json`. Each action is in
 *   the log before it is announced and asked about, and its observation or rejection after the answer,
 *   so Harness Relay can tell what each request is about; and a resumed session's actions that were
 *   never answered are asked about again with nothing announced, as the real one does;
 * - it asks about every action (one request naming none, `confirmation-<session>`) unless its mode is
 *   `always-approve` (full access, `session/set_mode`); a refusal reaches its model only as its own
 *   fixed words. Updates carry the conversation's usage so far in `_meta`, are never streamed, and
 *   a failed tool comes as `completed` with its observation saying so;
 * - it never exits by itself: its process is stopped after the turn, so all of it is written before
 *   the prompt is answered (for a fake, it still ends half a minute after its input closes).
 * Whether a write happens is up to Harness Relay's own sandbox below full access (there is none in
 * OpenHands): the fake writes, and a write the sandbox refuses fails as its file editor fails.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { picked } = require('../lib/acp.cjs');
const { ownSkills, safeList, targetOf } = require('../lib/files.cjs');
const { keyVerdict } = require('../lib/home.cjs');
const { exitAfterLog, flushLog, record, refused } = require('../lib/log.cjs');
const { declined, directivesIn, lastUserMessage, noOther, plan, recordMcpEnv, wrote } = require('../lib/plan.cjs');
const { fail, out, rpcError, track } = require('../lib/rpc.cjs');
const { args, has, home, sleep } = require('../lib/self.cjs');

const env = process.env;

const MODES = [
  { description: 'Request permission before making any changes', id: 'always-ask', name: 'Always Ask Mode' },
  { description: 'Automatically approve all actions without asking', id: 'always-approve', name: 'Always Approve Mode' },
  { description: 'Use LLM security analyzer to auto-approve safe actions. Only ask for permission on high risk actions.', id: 'llm-approve', name: 'LLM Approve Mode' },
];

const OPTIONS = [
  { kind: 'allow_once', name: 'Yes, proceed', optionId: 'accept' },
  { kind: 'reject_once', name: 'Reject', optionId: 'reject' },
  { kind: 'allow_always', name: "Always proceed (don't ask again)", optionId: 'always_proceed' },
  { kind: 'allow_once', name: 'Auto-confirm LOW/MEDIUM risk, ask for HIGH risk action', optionId: 'risk_based' },
];

/** What its model reads of an action the user rejected. */
const REJECTED = 'User rejected the action. Please ask the user how they want to proceed.';
/** What Harness Relay writes for an action an earlier turn left unanswered (`LEFTOVER_REASON` in openhands.ts), as far as the fake looks. */
const LEFTOVER = /^Not run: this action was left unfinished when an earlier turn was stopped or cut off/;

/** The provider's key variable LiteLLM reads, by the model's prefix. */
const KEY_VARS = { openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', xai: 'XAI_API_KEY' };
const PROVIDER_NAME = { openai: 'OpenAI', anthropic: 'Anthropic', xai: 'xAI' };
const EVENT_FILE = /^event-(\d{5})-([0-9a-fA-F-]{8,})\.json$/;

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
}

const isFile = (p) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

const persistence = () => env.OPENHANDS_PERSISTENCE_DIR || path.join(os.homedir(), '.openhands');
const conversations = () => env.OPENHANDS_CONVERSATIONS_DIR || home();
const sessionDir = (id) => path.join(conversations(), id.replace(/-/g, '').toLowerCase());
const settingsOf = () => readJson(path.join(persistence(), 'agent_settings.json'), undefined);
const now = () => new Date().toISOString().replace(/Z$/, '');
const UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

/** The key LiteLLM would send for a model (`openai/…`): its provider's variable. */
const keyVar = (model) => KEY_VARS[String(model || '').split('/')[0]] || 'OPENAI_API_KEY';

/** Its MCP servers, from `mcp.json` only: their names, recorded with their values (env, or headers and URL). */
function readMcp() {
  const servers = (readJson(path.join(persistence(), 'mcp.json'), {}) || {}).mcpServers || {};
  const values = {};
  const http = {};
  for (const [name, s] of Object.entries(servers)) {
    const remote = s && (s.transport === 'http' || s.transport === 'sse' || typeof s.url === 'string');
    values[name] = { ...((remote ? s.headers : s.env) || {}) };
    if (remote) http[name] = s.url;
  }
  recordMcpEnv(values, http);
  return Object.keys(servers);
}

/** Its own skills folder (in the run's home): the briefing (Harness Relay's skill), and any other skill there. */
function homeSkills() {
  const dir = path.join(os.homedir(), '.openhands', 'skills');
  const files = listDir(dir).filter((n) => n.endsWith('.md'));
  const briefing = files.includes('harness-relay-briefing.md') ? fs.readFileSync(path.join(dir, 'harness-relay-briefing.md'), 'utf8').trim() : '';
  return { briefing, others: files.filter((n) => n !== 'harness-relay-briefing.md').map((n) => n.replace(/\.md$/, '')) };
}

/** The folders it reads a project from: the working directory, then its repository root (a `.git` above, no ceiling). */
function projectRoots(cwd) {
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir === cwd ? [cwd] : [cwd, dir];
    if (path.dirname(dir) === dir) return [cwd];
  }
}

/** The project's skills it loads by itself (`.agents/skills`, `.openhands/skills`, `.openhands/microagents`), and its home's. */
function loadedSkills(cwd) {
  const names = [];
  for (const root of projectRoots(cwd)) {
    for (const d of [path.join(root, '.agents', 'skills'), path.join(root, '.openhands', 'skills'), path.join(root, '.openhands', 'microagents')]) {
      for (const s of ownSkills(d)) names.push(s.name);
      for (const n of listDir(d)) if (/\.md$/i.test(n) && n.toLowerCase() !== 'readme.md' && isFile(path.join(d, n))) names.push(n.replace(/\.md$/i, ''));
    }
  }
  return [...new Set([...names, ...homeSkills().others])];
}

// --- Its session files ------------------------------------------------------------------------------

/** A session's event log: its events in order, and the next one written. */
function eventLog(dir) {
  const events = path.join(dir, 'events');
  const read = () =>
    listDir(events)
      .map((name) => [EVENT_FILE.exec(name), name])
      .filter(([m]) => m)
      .sort(([a], [b]) => Number(a[1]) - Number(b[1]))
      .map(([, name]) => readJson(path.join(events, name), {}));
  return {
    read,
    append(event) {
      fs.mkdirSync(events, { recursive: true });
      const next = listDir(events).filter((n) => EVENT_FILE.test(n)).length;
      const e = { id: crypto.randomUUID(), timestamp: now(), ...event };
      fs.writeFileSync(path.join(events, `event-${String(next).padStart(5, '0')}-${e.id}.json`), JSON.stringify(e));
      return e;
    },
  };
}

/** The actions its log holds that nothing answered (an observation, a rejection, an error after them), oldest first. */
function unanswered(events) {
  const answered = new Set(events.filter((e) => e.kind === 'ObservationEvent' || e.kind === 'UserRejectObservation').map((e) => e.action_id));
  const failed = new Set(events.filter((e) => e.kind === 'AgentErrorEvent').map((e) => e.tool_call_id));
  return events.filter((e) => e.kind === 'ActionEvent' && e.action && !answered.has(e.id) && !failed.has(e.tool_call_id));
}

/** The briefing a session's system prompt holds (its first event), from its start. */
function storedBriefing(events) {
  const ctx = events[0] && events[0].kind === 'SystemPromptEvent' && events[0].dynamic_context && events[0].dynamic_context.text;
  const m = /^\[BEGIN context from \[harness-relay-briefing\]\]\n([\s\S]*?)\n\[END Context\]$/.exec(ctx || '');
  return m ? m[1] : '';
}

function saveState(s, status) {
  s.status = status;
  const usage = { prompt_tokens: s.metrics.input, completion_tokens: s.metrics.output, cache_read_tokens: 0, reasoning_tokens: 0 };
  const state = {
    id: s.id,
    workspace: { working_dir: s.cwd, kind: 'LocalWorkspace' },
    execution_status: status,
    confirmation_policy: { kind: s.mode === 'always-approve' ? 'NeverConfirm' : 'AlwaysConfirm' },
    stats: { usage_to_metrics: { agent: { model_name: s.llm.model, accumulated_cost: s.metrics.cost, accumulated_token_usage: { model: s.llm.model, ...usage } } } },
    // The fake's own: how many events its model has read (the rest are new to it at the next prompt).
    e2e_read_events: s.read,
  };
  fs.writeFileSync(path.join(s.dir, 'base_state.json'), JSON.stringify(state, null, 2));
}

// --- Its ACP agent ---------------------------------------------------------------------------------

/**
 * Its end of the JSON-RPC connection on stdio. Unlike the other fakes it keeps running when its input
 * closes, as OpenHands does (Harness Relay stops it after the turn), for half a minute.
 */
function peer(onRequest, onNotification) {
  const pending = new Map();
  let next = 0;
  const send = (msg) => out({ jsonrpc: '2.0', ...msg });
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof msg.method !== 'string') {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || 'error'));
      else p.resolve(msg.result);
      return;
    }
    if (msg.id === undefined || msg.id === null) return onNotification(msg.method, msg.params || {});
    track(
      (async () => {
        try {
          const result = await onRequest(msg.method, msg.params || {});
          send({ id: msg.id, result: result === undefined ? null : result });
        } catch (err) {
          const error = { code: err.code || -32603, message: err.message || String(err) };
          send({ id: msg.id, error: err.data === undefined ? error : { ...error, data: err.data } });
        }
      })(),
    );
  });
  rl.on('close', () => setTimeout(() => exitAfterLog(0), 30_000));
  return {
    notify: (method, params) => send({ method, params }),
    request: (method, params) =>
      new Promise((resolve, reject) => {
        const id = next++;
        pending.set(id, { resolve, reject });
        send({ id, method, params });
      }),
  };
}

function openhandsAgent() {
  const sessions = new Map();
  // Its mode is the process's: every start asks.
  let mode = 'always-ask';
  const conn = peer(
    async (method, p) => {
      switch (method) {
        case 'initialize':
          return {
            agentCapabilities: { loadSession: true, mcpCapabilities: { http: true, sse: true }, promptCapabilities: { audio: false, embeddedContext: true, image: true } },
            agentInfo: { name: 'OpenHands CLI ACP Agent', version: module.exports.version.replace(/^OpenHands CLI /, '') },
            authMethods: [{ _meta: { type: 'agent' }, description: 'Authenticate through agent', id: 'oauth', name: 'OAuth with OpenHands Cloud' }],
            protocolVersion: 1,
          };
        case 'session/new':
        case 'session/load': {
          const s = openSession(method, p);
          s.mode = mode;
          sessions.set(s.id, s);
          if (method === 'session/load') replay(s);
          const modes = { availableModes: MODES, currentModeId: mode };
          if (method === 'session/new') {
            setImmediate(() =>
              conn.notify('session/update', {
                sessionId: s.id,
                update: {
                  availableCommands: [
                    { description: 'Show available slash commands', input: { hint: 'No arguments' }, name: 'help' },
                    { description: 'Control confirmation mode (always-ask|always-approve|llm-approve)', input: { hint: 'always-ask | always-approve | llm-approve' }, name: 'confirm' },
                  ],
                  sessionUpdate: 'available_commands_update',
                },
              }),
            );
            return { modes, sessionId: s.id };
          }
          return { modes };
        }
        case 'session/set_mode': {
          if (!MODES.some((m) => m.id === p.modeId)) throw rpcError('Invalid params', -32602, { reason: `Unknown mode: ${p.modeId}` });
          mode = p.modeId;
          for (const s of sessions.values()) s.mode = mode;
          conn.notify('session/update', { sessionId: p.sessionId, update: { sessionUpdate: 'current_mode_update', currentModeId: mode } });
          return {};
        }
        case 'session/set_config_option':
          return {}; // taken, and nothing changes: the model is its settings file's
        case 'session/prompt':
          return prompt(conn, sessions.get(p.sessionId), p);
        default:
          throw rpcError('Method not found', -32601, { method });
      }
    },
    (method, p) => {
      if (method === 'session/cancel' && sessions.has(p.sessionId)) sessions.get(p.sessionId).cancelled = true;
    },
  );

  /** The session's history, replayed before `session/load` answers (Harness Relay drops it). */
  function replay(s) {
    for (const e of eventLog(s.dir).read()) {
      if (e.kind !== 'MessageEvent') continue;
      const text = ((e.llm_message && e.llm_message.content) || []).map((c) => c.text || '').join('');
      conn.notify('session/update', { sessionId: s.id, update: { content: { text, type: 'text' }, sessionUpdate: e.source === 'user' ? 'user_message_chunk' : 'agent_message_chunk' } });
    }
  }
}

/** A session started or loaded: its settings read again (another model, another backend), its files made or read. */
function openSession(method, p) {
  const settings = settingsOf();
  if (!settings || !settings.llm) throw rpcError('Authentication required', -32000, { reason: 'Authentication required to create a session' });
  let id = method === 'session/load' ? String(p.sessionId || '') : crypto.randomUUID();
  if (!UUID.test(id)) throw rpcError('Invalid params', -32602, { reason: 'Invalid session ID format', sessionId: id });
  if (id.length === 32) id = `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
  id = id.toLowerCase();
  const dir = sessionDir(id);
  const saved = readJson(path.join(dir, 'base_state.json'), undefined);
  // An unknown session is "loaded" as a new, empty one.
  const fresh = !saved;
  const stats = saved && saved.stats && saved.stats.usage_to_metrics && saved.stats.usage_to_metrics.agent;
  const s = {
    id,
    dir,
    cwd: p.cwd || env.OPENHANDS_WORK_DIR || process.cwd(),
    llm: settings.llm,
    toolFilter: settings.filter_tools_regex || null,
    mcp: readMcp(),
    cancelled: false,
    fresh,
    metrics: {
      input: (stats && stats.accumulated_token_usage && stats.accumulated_token_usage.prompt_tokens) || 0,
      output: (stats && stats.accumulated_token_usage && stats.accumulated_token_usage.completion_tokens) || 0,
      cost: (stats && stats.accumulated_cost) || 0,
    },
    read: (saved && saved.e2e_read_events) || 0,
  };
  const log = eventLog(dir);
  if (fresh) {
    // Its system prompt, with its skills (the briefing among them), is kept from the session's start.
    fs.mkdirSync(path.join(dir, 'events'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'events', '.eventlog.lock'), '');
    const { briefing } = homeSkills();
    log.append({
      source: 'agent',
      system_prompt: { type: 'text', text: 'You are OpenHands agent, a helpful AI assistant that can interact with a computer to solve tasks.' },
      tools: (settings.tools || []).map((t) => t.name),
      ...(briefing ? { dynamic_context: { type: 'text', text: `[BEGIN context from [harness-relay-briefing]]\n${briefing}\n[END Context]` } } : {}),
      kind: 'SystemPromptEvent',
    });
    s.read = 1;
    saveState(s, 'idle');
  }
  s.briefing = storedBriefing(log.read());
  record({ session: id, resumed: !fresh });
  return s;
}

/** The text of an update's `_meta`: the conversation's usage so far. */
function meta(s) {
  const m = s.metrics;
  const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(2).replace(/\.?0+$/, '')}K` : String(n));
  return {
    field_meta: {
      'openhands.dev/metrics': {
        input_tokens: m.input,
        output_tokens: m.output,
        cache_read_tokens: 0,
        reasoning_tokens: 0,
        cost: m.cost,
        status_line: `↑ input ${k(m.input)} • cache hit N/A • ↓ output ${k(m.output)} • $ ${m.cost.toFixed(2)}`,
      },
    },
  };
}

/** One call of its model: what it counts (an endpoint's model has no price). */
function llmCall(s, input = 1200, output = 40) {
  s.metrics.input += input;
  s.metrics.output += output;
  if (!s.llm.base_url) s.metrics.cost = Math.round((s.metrics.cost + 0.0021) * 1e7) / 1e7;
}

/** The working directories besides `cwd` that a briefing names (it has no folder list of its own). */
function briefedOthers(briefing, cwd) {
  const shared = /share these working directories, each with the same access: (.+?)\. You start in /.exec(briefing);
  const dirs = shared ? shared[1].split(', ') : [...briefing.matchAll(/^ {2}- (.+?) \(branch /gm)].map((m) => m[1]);
  return dirs.filter((d) => path.resolve(d) !== path.resolve(cwd));
}

/**
 * Reaches `url` for real, as its own tools do: through the proxy the environment names (below full
 * access Harness Relay's sandbox's, which asks the user about a host the run may not reach, and
 * refuses it when declined), else directly. `{ ok, status, why, body }`.
 */
function reach(url) {
  return new Promise((resolve) => {
    let target;
    try {
      target = new URL(url);
    } catch {
      return resolve({ ok: false, why: 'not a URL' });
    }
    const secure = target.protocol === 'https:';
    const via = secure ? env.HTTPS_PROXY || env.https_proxy : env.HTTP_PROXY || env.http_proxy;
    let settled = false;
    const done = (r) => {
      if (!settled) resolve(r);
      settled = true;
    };
    const answer = (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => (body = (body + d).slice(0, 2000)));
      res.on('end', () => done({ ok: res.statusCode < 400, status: res.statusCode, why: `${res.statusCode} ${res.statusMessage || ''}`.trim(), body: body.trim() }));
      res.on('error', (err) => done({ ok: false, why: err.code || err.message }));
    };
    // Its own agent: the proxy is asked as named here (an agent of Node's own might send this request to a proxy too).
    const o = { agent: new http.Agent(), timeout: 600_000 };
    let req;
    if (via) {
      const proxy = new URL(via);
      const auth = proxy.username
        ? { 'proxy-authorization': `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}` }
        : {};
      const at = { ...o, host: proxy.hostname.replace(/^\[|\]$/g, ''), port: Number(proxy.port) || 80 };
      if (secure) {
        req = http.request({ ...at, method: 'CONNECT', path: `${target.hostname}:${target.port || 443}`, headers: { host: `${target.hostname}:${target.port || 443}`, ...auth } });
        req.on('connect', (res, socket) => {
          socket.destroy();
          done({ ok: res.statusCode === 200, status: res.statusCode, why: `${res.statusCode} ${res.statusMessage || ''}`.trim(), body: '' });
        });
      } else {
        req = http.request({ ...at, method: 'GET', path: target.href, headers: { host: target.host, ...auth } }, answer);
      }
    } else {
      req = (secure ? https : http).request(target, { ...o, agent: secure ? new https.Agent() : o.agent, method: 'GET' }, answer);
    }
    req.on('error', (err) => done({ ok: false, why: err.code || err.message }));
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.end();
  });
}

/** What it says of a URL it tried to reach. */
const reached = (url, r) => (r.ok ? `I fetched ${url}. ` : `I could not reach ${url} (${r.why}). `);

/** Python's words for a refused write (`[Errno 1] Operation not permitted`), from Node's error. */
function pythonError(err) {
  const words = { EPERM: '[Errno 1] Operation not permitted', EACCES: '[Errno 13] Permission denied', EROFS: '[Errno 30] Read-only file system' };
  return words[err.code] || err.message;
}

/** A directory as its file editor views it. */
function viewDir(dir) {
  const lines = [`${dir}/`];
  for (const name of fs.readdirSync(dir).filter((n) => !n.startsWith('.')).sort()) {
    const p = path.join(dir, name);
    const sub = fs.statSync(p).isDirectory();
    lines.push(`${p}${sub ? '/' : ''}`);
    if (sub) for (const inner of listDir(p).filter((n) => !n.startsWith('.'))) lines.push(path.join(p, inner));
  }
  return `Here's the files and directories up to 2 levels deep in ${dir}, excluding hidden items:\n${lines.join('\n')}`;
}

const sameFolder = (a, b) => {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return false;
  }
};

/** One prompt: the turn, everything about it written before it is answered (the process is stopped right after). */
async function prompt(conn, s, p) {
  if (!s) throw rpcError('Invalid params', -32602, { reason: `Unknown session: ${p.sessionId}` });
  const blocks = p.prompt || [];
  let text = blocks.filter((b) => b.type === 'text').map((b) => b.text || '').join('\n');
  const images = blocks.filter((b) => b.type === 'image' && b.data).length;
  // A resumed session's system prompt is its start's: a briefing changed since comes before the prompt.
  const block = /^<harness-relay-briefing>\n([\s\S]*?)\n<\/harness-relay-briefing>\n\n/.exec(text);
  const briefing = block ? block[1] : s.briefing;
  if (block) text = text.slice(block[0].length);
  const log = eventLog(s.dir);
  let publicSkills;
  try {
    publicSkills = fs.statSync(path.join(os.homedir(), '.openhands', 'cache', 'skills', 'public-skills'));
  } catch {
    publicSkills = undefined;
  }
  record({
    prompt: text,
    briefing,
    images,
    mcp: s.mcp,
    model: s.llm.model,
    effort: s.llm.reasoning_effort || null,
    thinkingBudget: s.llm.extended_thinking_budget || null,
    baseUrl: s.llm.base_url || null,
    toolFilter: s.toolFilter,
    mode: s.mode,
    skills: loadedSkills(s.cwd),
    // Its terminal: tmux with its socket folder (full access), else a pseudo-terminal; its public skills off (a file where it clones them).
    terminal: env.TMUX_TMPDIR ? 'tmux' : 'pty',
    publicSkills: publicSkills ? (publicSkills.isFile() ? 'off' : 'on') : 'none',
    keyVar: keyVar(s.llm.model),
    backendKeys: Object.values(KEY_VARS).filter((k) => env[k]),
    startedInTmp: sameFolder(process.cwd(), env.TMPDIR || os.tmpdir()),
  });
  s.cancelled = false;
  log.append({ source: 'user', llm_message: { role: 'user', content: [{ type: 'text', text }] }, kind: 'MessageEvent' });
  saveState(s, 'running');

  const update = (u) => conn.notify('session/update', { _meta: meta(s), sessionId: s.id, update: u });
  const thought = (t) => update({ content: { text: `**Reasoning**:\n${t}\n`, type: 'text' }, sessionUpdate: 'agent_thought_chunk' });
  const fresh = s.fresh;
  s.fresh = false;
  if (fresh) update({ content: { text: `System Prompt:\nYou are OpenHands agent, a helpful AI assistant that can interact with a computer to solve tasks.\n\n${briefing}`, type: 'text' }, sessionUpdate: 'agent_thought_chunk' });

  // What is new to its model since it last read the log: Harness Relay's rejections of actions left from before.
  const events = log.read();
  const left = events.slice(s.read).filter((e) => e.kind === 'UserRejectObservation' && LEFTOVER.test(e.rejection_reason || ''));

  /** Ends the turn as paused (a stop): a running action has finished, an unanswered one stays so. */
  const paused = async () => {
    update({ content: { text: 'Conversation Paused', type: 'text' }, sessionUpdate: 'agent_thought_chunk' });
    s.read = log.read().length;
    saveState(s, 'paused');
    await flushLog();
    return { stopReason: 'end_turn' };
  };

  /**
   * Asks about the actions just announced (none named: `confirmation-<session>`), unless it approves
   * everything: 'accept', 'reject', or 'cancelled' (a stop).
   */
  const confirm = async () => {
    if (s.mode === 'always-approve') return 'accept';
    saveState(s, 'waiting_for_confirmation');
    const answer = await conn
      .request('session/request_permission', { options: OPTIONS, sessionId: s.id, toolCall: { kind: 'other', status: 'pending', title: 'Confirm Agent Actions', toolCallId: `confirmation-${s.id}` } })
      .catch(() => ({ outcome: { outcome: 'cancelled' } }));
    // A stop (the request cancelled) leaves the action unanswered: the turn is paused.
    const allowed = OPTIONS.some((o) => o.kind.startsWith('allow') && picked(answer, o.optionId));
    if (!allowed && !picked(answer, 'reject')) return 'cancelled';
    saveState(s, 'running');
    return allowed ? 'accept' : 'reject';
  };

  /** The rejection of an action, as it records and shows it. */
  const reject = (action, toolCallId, tool) => {
    const obs = log.append({ source: 'environment', tool_name: tool, tool_call_id: toolCallId, rejection_reason: REJECTED, rejection_source: 'user', action_id: action.id, kind: 'UserRejectObservation' });
    update({ content: [{ content: { text: `Tool: ${tool}\n\nRejection Reason:\n${REJECTED}`, type: 'text' }, type: 'content' }], rawOutput: obs, status: 'failed', toolCallId, sessionUpdate: 'tool_call_update' });
  };

  let n = 0;
  /**
   * One action: in the log first, then announced (`announce`: its kind, title, input, what it shows),
   * asked about, and once allowed run (`run()`: its observation). `{ ran, obs }` or `{ stopped }`.
   */
  const act = async (tool, rawInput, announce, run, hidden) => {
    llmCall(s);
    const toolCallId = `toolu_e2e_${process.pid}_${++n}`;
    const action = log.append({ source: 'agent', thought: [], tool_name: tool, tool_call_id: toolCallId, action: rawInput, summary: announce.summary, security_risk: 'LOW', kind: 'ActionEvent' });
    update({
      content: [{ content: { text: `Predicted Security Risk: LOW\n\nSummary: ${announce.summary}\n\n${announce.shows}`, type: 'text' }, type: 'content' }],
      kind: announce.kind,
      ...(announce.locations ? { locations: announce.locations } : {}),
      rawInput,
      status: 'in_progress',
      title: announce.title,
      toolCallId,
      sessionUpdate: 'tool_call',
    });
    const answer = await confirm();
    if (answer === 'cancelled') return { stopped: true };
    if (answer === 'reject') {
      reject(action, toolCallId, tool);
      return { ran: false };
    }
    const observation = await run();
    const obs = log.append({ source: 'environment', tool_name: tool, tool_call_id: toolCallId, observation, action_id: action.id, kind: 'ObservationEvent' });
    // Its task tracker's list comes as a plan, not as the call's result.
    if (!hidden) {
      const said = (observation.content || []).map((c) => c.text).join('\n');
      update({ content: [{ content: { text: `Tool: ${tool}\nResult:\n${said}`, type: 'text' }, type: 'content' }], rawOutput: obs, status: 'completed', toolCallId, sessionUpdate: 'tool_call_update' });
    }
    return { ran: true, obs: observation };
  };
  const textOf = (t) => [{ cache_prompt: false, type: 'text', text: t }];

  // Actions a resumed session holds that nothing answered: asked about again before anything else,
  // with nothing announced (or run unasked, when it approves everything), as the real one does.
  for (const action of unanswered(events)) {
    const answer = await confirm();
    if (answer === 'cancelled') return paused();
    if (answer === 'reject') reject(action, action.tool_call_id, action.tool_name);
    else log.append({ source: 'environment', tool_name: action.tool_name, tool_call_id: action.tool_call_id, observation: { content: textOf('(run when the session was resumed)'), is_error: false, kind: 'Observation' }, action_id: action.id, kind: 'ObservationEvent' });
  }

  // A missing key fails the prompt, as LiteLLM does when it calls the model.
  const missingKey = !env[keyVar(s.llm.model)];
  const user = lastUserMessage(text);
  const stuck = user !== undefined && directivesIn(user).stuck;
  const steps = missingKey
    ? [{ type: 'error', text: `litellm.AuthenticationError: Missing ${PROVIDER_NAME[s.llm.model.split('/')[0]] || 'OpenAI'} API Key - ${keyVar(s.llm.model)} is not set` }]
    : plan(text, { cwd: s.cwd, images, mcp: s.mcp, briefing });

  if (stuck) {
    // Its stuck detector ends the turn as if done, with nothing said: only its state says so.
    llmCall(s);
    s.read = log.read().length;
    saveState(s, 'stuck');
    await flushLog();
    return { stopReason: 'end_turn' };
  }

  let prefix = left.length ? `Harness Relay rejected ${left.length === 1 ? 'an action' : `${left.length} actions`} left from an earlier turn: “${left[0].rejection_reason}” ` : '';
  for (const step of steps) {
    if (s.cancelled) return paused();
    if (step.type === 'fail') return fail(step.text);
    if (step.type === 'error') {
      const details = `Conversation run failed for id=${s.id}: ${missingKey ? step.text : `RuntimeError: ${step.text}`}\n\nConversation logs are stored at: ${s.dir}`;
      update({ content: { text: `Error: ${details}`, type: 'text' }, sessionUpdate: 'agent_message_chunk' });
      log.append({ source: 'environment', tool_name: '', tool_call_id: '', error: details, kind: 'ConversationErrorEvent' });
      s.read = log.read().length;
      saveState(s, 'error');
      await flushLog();
      throw rpcError('Internal error', -32603, {
        reason: 'Failed to process prompt',
        details: `${details}\n\nTo help debug this issue, please file a bug report at: https://github.com/OpenHands/OpenHands-CLI/issues`,
      });
    }
    if (step.type === 'think') {
      llmCall(s, 600, 30);
      thought(step.text);
    }
    if (step.type === 'todo') {
      const status = { completed: 'done', in_progress: 'in_progress', pending: 'todo' };
      const task_list = step.entries.map((e) => ({ title: e.text, notes: '', status: status[e.status] || 'todo' }));
      const r = await act(
        'task_tracker',
        { command: 'plan', task_list, kind: 'TaskTrackerAction' },
        { kind: 'other', title: `task_tracker: ${JSON.stringify({ command: 'plan', task_list: task_list.map(({ title, status: st }) => ({ title, status: st })) })}`, summary: 'Plan the work', shows: `📋 Update Task List (${task_list.length} tasks)` },
        async () => ({ content: textOf(`Task list has been updated with ${task_list.length} items.`), command: 'plan', task_list, kind: 'TaskTrackerObservation' }),
        true,
      );
      if (r.stopped) return paused();
      if (r.ran) update({ entries: step.entries.map((e) => ({ content: e.text, priority: 'medium', status: e.status })), sessionUpdate: 'plan' });
    }
    if (step.type === 'tool') {
      const rawInput = { command: 'view', path: s.cwd, file_text: null, old_str: null, new_str: null, insert_line: null, view_range: null, kind: 'FileEditorAction' };
      const summary = 'List the working directory';
      const r = await act('file_editor', rawInput, { kind: 'read', locations: [{ path: s.cwd }], title: `${summary}: Reading ${s.cwd}`, summary, shows: `Reading ${s.cwd}` }, async () => {
        let listing;
        try {
          listing = viewDir(s.cwd);
        } catch (err) {
          return { content: textOf(`ERROR:\n${safeList(s.cwd)}`), is_error: true, command: 'view', path: s.cwd, kind: 'FileEditorObservation', error: String(err.message) };
        }
        return { content: textOf(listing), is_error: false, command: 'view', path: s.cwd, prev_exist: true, old_content: null, new_content: null, kind: 'FileEditorObservation' };
      });
      if (r.stopped) return paused();
    }
    if (step.type === 'approve') {
      const rawInput = { command: step.command, is_input: false, timeout: null, reset: false, kind: 'TerminalAction' };
      const summary = 'Print a line';
      const r = await act('terminal', rawInput, { kind: 'execute', title: `${summary}: $ ${step.command}`, summary, shows: `$ ${step.command}` }, async () => ({
        content: textOf(/^npm publish/.test(step.command) ? '+ e2e-approval@1.0.0' : 'e2e-approval'),
        is_error: false,
        command: step.command,
        exit_code: 0,
        timeout: false,
        metadata: { exit_code: 0, pid: -1, working_dir: s.cwd, py_interpreter_path: null, prefix: '', suffix: '\n[The command completed with exit code 0.]' },
        kind: 'TerminalObservation',
      }));
      if (r.stopped) return paused();
      prefix += r.ran ? 'The command ran: e2e-approval. ' : declined('command', '');
    }
    if (step.type === 'fetch') {
      // It has no web tool of its own: `curl` in its terminal, which reaches the page for real (below
      // full access through the sandbox's proxy, which asks about a host the run may not reach).
      const command = `curl -sS --fail ${step.url}`;
      const rawInput = { command, is_input: false, timeout: null, reset: false, kind: 'TerminalAction' };
      const summary = 'Fetch the page';
      let got = { ok: false, why: 'not run' };
      const r = await act('terminal', rawInput, { kind: 'execute', title: `${summary}: $ ${command}`, summary, shows: `$ ${command}` }, async () => {
        got = await reach(step.url);
        const host = (/^\w+:\/\/([^/:]+)/.exec(step.url) || [])[1] || step.url;
        const code = got.ok ? 0 : got.status ? 22 : 6;
        const said = got.ok ? got.body : got.status ? `curl: (22) The requested URL returned error: ${got.status}` : `curl: (6) Could not resolve host: ${host} (${got.why})`;
        return { content: textOf(said), is_error: false, command, exit_code: code, timeout: false, metadata: { exit_code: code, pid: -1, working_dir: s.cwd }, kind: 'TerminalObservation' };
      });
      if (r.stopped) return paused();
      prefix += r.ran ? reached(step.url, got) : declined('fetch', '');
    }
    if (step.type === 'write') {
      const file = targetOf(step, s.cwd, briefedOthers(briefing, s.cwd));
      if (!file) {
        prefix += noOther(step);
        continue;
      }
      const rawInput = { command: 'create', path: file, file_text: step.content, old_str: null, new_str: null, insert_line: null, view_range: null, kind: 'FileEditorAction' };
      const summary = `Create ${path.basename(file)}`;
      let written = false;
      const r = await act('file_editor', rawInput, { kind: 'edit', locations: [{ path: file }], title: `${summary}: Editing ${file}`, summary, shows: `Editing ${file}` }, async () => {
        const existed = fs.existsSync(file);
        try {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, step.content);
          written = true;
          return { content: textOf(`File created successfully at: ${file}`), is_error: false, command: 'create', path: file, prev_exist: existed, old_content: null, new_content: step.content, kind: 'FileEditorObservation' };
        } catch (err) {
          if (!refused(err)) throw err;
          return { content: textOf(`Ran into ${pythonError(err)}: '${file}' while trying to write to ${file}`), is_error: true, command: 'create', path: file, kind: 'FileEditorObservation' };
        }
      });
      if (r.stopped) return paused();
      prefix += wrote(step, written, '');
    }
    if (step.type === 'text') {
      llmCall(s);
      const reply = prefix + step.text;
      // It does not stream: the whole reply at once. A slow one takes its time afterwards (a stop pauses it).
      update({ content: { text: reply, type: 'text' }, sessionUpdate: 'agent_message_chunk' });
      log.append({ source: 'agent', llm_message: { role: 'assistant', content: [{ type: 'text', text: reply }] }, kind: 'MessageEvent' });
      for (let waited = 0; waited < step.slow; waited += 100) {
        if (s.cancelled) return paused();
        await sleep(100);
      }
    }
  }
  s.read = log.read().length;
  saveState(s, 'finished');
  await flushLog();
  return { stopReason: 'end_turn' };
}

function openhandsStatic() {
  if (has('--version')) return void process.stdout.write(`${module.exports.version}\n`);
  process.stderr.write(`fake openhands: unknown command ${args.join(' ')}\n`, () => exitAfterLog(1));
}

module.exports = {
  provider: 'openhands',
  bin: 'openhands',
  aliases: [],
  label: 'OpenHands',
  name: 'OpenHands',
  version: 'OpenHands CLI 1.16.999',
  versionRe: /^OpenHands CLI 1\.16\.999$/m,
  /**
   * Its state, which a run may write (its adapter's only `statePaths`): `OPENHANDS_CONVERSATIONS_DIR`,
   * where it keeps its sessions (`<id without dashes>/`) and the fake its marks.
   */
  home: (env) => env.OPENHANDS_CONVERSATIONS_DIR || path.join(os.homedir(), '.openhands', 'conversations'),
  /**
   * The key LiteLLM would send for the run's model (its provider's variable, from `agent_settings.json`),
   * by `keyVerdict`; null for none, or an endpoint's placeholder (`no-key`).
   */
  apiKey: (env) => {
    const settings = env.OPENHANDS_PERSISTENCE_DIR ? readJson(path.join(env.OPENHANDS_PERSISTENCE_DIR, 'agent_settings.json'), undefined) : undefined;
    const key = settings && settings.llm ? env[keyVar(settings.llm.model)] : undefined;
    return !key || key === 'no-key' ? null : keyVerdict(key);
  },
  /**
   * LiteLLM's model list as its install has it (`litellm/model_prices_and_context_window_backup.json`
   * in its virtual environment), a few of each provider: e2e/support/fake-cli.ts writes it there.
   */
  litellmModels: {
    'gpt-5.4': { litellm_provider: 'openai', mode: 'responses', supports_function_calling: true, supports_reasoning: true, supports_xhigh_reasoning_effort: true },
    'gpt-5.4-mini': { litellm_provider: 'openai', mode: 'chat', supports_function_calling: true, supports_reasoning: true },
    'gpt-4o': { litellm_provider: 'openai', mode: 'chat', supports_function_calling: true },
    'gpt-4o-audio-preview': { litellm_provider: 'openai', mode: 'chat', supports_function_calling: true },
    'claude-sonnet-5-5': { litellm_provider: 'anthropic', mode: 'chat', supports_function_calling: true, supports_reasoning: true },
    'anthropic/claude-haiku-5-5': { litellm_provider: 'anthropic', mode: 'chat', supports_function_calling: true, supports_reasoning: true },
    'xai/grok-4.3': { litellm_provider: 'xai', mode: 'chat', supports_function_calling: true, supports_reasoning: true },
    'xai/grok-code-fast-1': { litellm_provider: 'xai', mode: 'chat', supports_function_calling: true, supports_reasoning: true },
    'text-embedding-3-small': { litellm_provider: 'openai', mode: 'embedding' },
  },
  main() {
    if (args[0] === 'acp') openhandsAgent();
    else openhandsStatic();
  },
};
