'use strict';
/*
 * The fake Goose (`goose`, an open agent): `goose acp` (ACP on stdio: its turns, and the questions
 * Harness Relay asks it outside one, `_goose/unstable/providers/list` and `_goose/unstable/sources/list`),
 * and `--version`. Anything else exits with code 1 at once.
 *
 * What it does depends only on what Harness Relay gave it, as with the real one: its provider, model
 * and mode from GOOSE_PROVIDER, GOOSE_MODEL and GOOSE_MODE (else its `config.yaml`) and then the session's
 * options (`session/set_config_option`, `session/set_mode`), an endpoint's provider file in its config
 * (`custom_providers/relay-<id>.json`), its extensions (EXTENSIONS, or the session's
 * `_meta.enabledExtensions`), plugins (PLUGINS) and instruction files (CONTEXT_FILE_NAMES), and its
 * briefing (`_goose/unstable/session/system-prompt/set`). In `approve` mode it asks about every tool call
 * (`session/request_permission`); in `auto` about none; in `chat` it calls no tool. A refusal's reason
 * reaches it as a steer of the running turn (`_goose/unstable/session/steer`), which it waits for a moment.
 *
 * It really runs its commands (`$GOOSE_SHELL -c <command>`) and writes its files: below full access
 * Harness Relay's own sandbox refuses a write outside the folders a run may write, and it says so as
 * Goose does ("Failed to write <path>: Operation not permitted (os error 1)"). In read-only Harness
 * Relay lets plain reading commands run without asking, `echo` among them, so the command it asks to
 * run is `env echo e2e-approval` (`env` is no reading program).
 *
 * Its sessions and marks are kept in its data folder (`$GOOSE_PATH_ROOT/data`, the conversation member's
 * own, which a run may write), never in `sessions/sessions.db` there (Harness Relay opens that as SQLite).
 */
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { acpAgent, requestPermission, sessionUpdates } = require('../lib/acp.cjs');
const { ownSkills, safeList, targetOf } = require('../lib/files.cjs');
const { keyVerdict, sessions } = require('../lib/home.cjs');
const { exitAfterLog, record, refused } = require('../lib/log.cjs');
const { declined, lastUserMessage, noOther, noteIn, plan, recordMcpEnv, wrote } = require('../lib/plan.cjs');
const { fail, rpcError } = require('../lib/rpc.cjs');
const { args, sleep } = require('../lib/self.cjs');

const VERSION = '1.58.999';
const env = process.env;

/** The API providers' key variables, as Goose reads them. */
const KEY_ENV = { openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', xai: 'XAI_API_KEY' };
/** Its catalog of the API providers' models (no model API asked). */
const CATALOG = {
  openai: { name: 'OpenAI', models: [{ id: 'gpt-e2e-fake', name: 'GPT E2E Fake' }, { id: 'gpt-e2e-fake-mini', name: 'GPT E2E Fake Mini' }] },
  anthropic: { name: 'Anthropic', models: [{ id: 'claude-e2e-fake', name: 'Claude E2E Fake' }] },
  xai: { name: 'xAI', models: [{ id: 'grok-e2e-fake', name: 'Grok E2E Fake' }] },
};
const EFFORTS = ['off', 'low', 'medium', 'high', 'max'];
const MODES = [
  { id: 'auto', name: 'auto', description: 'Automatically approve tool calls' },
  { id: 'approve', name: 'approve', description: 'Ask before every tool call' },
  { id: 'smart_approve', name: 'smart_approve', description: 'Ask only for sensitive tool calls' },
  { id: 'chat', name: 'chat', description: 'Chat only, no tool calls' },
];
/** Its bundled skills. */
const BUILT_IN_SKILLS = [
  { name: 'goose-doc-guide', description: "Find answers in Goose's own documentation" },
  { name: 'web-search', description: 'Search the web' },
];

// --- Its home and config -----------------------------------------------------------------------

/** GOOSE_PATH_ROOT: its config, data and state (the conversation member's own in a run). */
const root = () => env.GOOSE_PATH_ROOT || path.join(os.homedir(), '.config', 'goose');
const homeDir = () => env.HOME || os.homedir();

/** A key of its `config.yaml` (only `KEY: value` lines). */
function configValue(key) {
  try {
    const m = new RegExp(`^${key}:\\s*(.+?)\\s*$`, 'm').exec(fs.readFileSync(path.join(root(), 'config', 'config.yaml'), 'utf8'));
    return m ? m[1].replace(/^["']|["']$/g, '') : undefined;
  } catch {
    return undefined;
  }
}

/** A setting as Goose reads it: its upper-case variable first, then `config.yaml`. */
const setting = (key) => env[key] || configValue(key);

/** A JSON setting (EXTENSIONS, PLUGINS, CONTEXT_FILE_NAMES), or `fallback`. */
function jsonSetting(key, fallback) {
  try {
    const v = setting(key);
    return v === undefined ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}

/** The custom providers in its config (`custom_providers/<name>.json`), by name. */
function customProviders() {
  const dir = path.join(root(), 'config', 'custom_providers');
  const out = {};
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    return out;
  }
  for (const n of names) {
    try {
      const p = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
      if (p && typeof p.name === 'string') out[p.name] = p;
    } catch {
      /* not one */
    }
  }
  return out;
}

/** A provider's models, its default first, and the efforts it offers (a custom provider: `off` only). */
function providerInfo(provider) {
  if (CATALOG[provider]) return { name: CATALOG[provider].name, models: CATALOG[provider].models.map((m) => m.id), efforts: EFFORTS, keyEnv: KEY_ENV[provider] };
  const custom = customProviders()[provider];
  if (!custom) return undefined;
  return {
    name: custom.display_name || provider,
    models: (Array.isArray(custom.models) ? custom.models : []).map((m) => String(m && m.name)).filter(Boolean),
    efforts: ['off'],
    keyEnv: custom.api_key_env || undefined,
    requiresAuth: Boolean(custom.requires_auth),
    baseUrl: custom.base_url,
  };
}

/** The session's config options, as `session/new`, `session/load` and `set_config_option` answer them. */
function configOptions(s) {
  const info = providerInfo(s.provider) || { models: [], efforts: ['off'] };
  const custom = customProviders();
  return [
    {
      id: 'provider',
      name: 'Provider',
      type: 'select',
      currentValue: s.provider,
      options: [...Object.entries(CATALOG).map(([value, p]) => ({ value, name: p.name })), ...Object.values(custom).map((p) => ({ value: p.name, name: p.display_name || p.name }))],
    },
    { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: s.mode, options: MODES.map((m) => ({ value: m.id, name: m.name })) },
    { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: s.model, options: info.models.map((value) => ({ value, name: value })) },
    { id: 'thinking_effort', name: 'Thinking effort', category: 'thought_level', type: 'select', currentValue: s.effort, options: info.efforts.map((value) => ({ value, name: value })) },
  ];
}

const modesOf = (s) => ({ currentModeId: s.mode, availableModes: MODES });

// --- What it loads by itself -------------------------------------------------------------------

/** The repository root above `cwd` (a folder holding `.git`), if any. */
function gitRoot(cwd) {
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    if (path.dirname(dir) === dir) return undefined;
  }
}

/** Its skills for a folder: the project's, its home's, and its bundled ones (`_goose/unstable/sources/list`). */
function gooseSkills(cwd) {
  const home = homeDir();
  const dirs = [
    ...[path.join(cwd, '.goose', 'skills'), path.join(cwd, '.claude', 'skills'), path.join(cwd, '.agents', 'skills')].map((d) => [d, false]),
    ...[path.join(home, '.agents', 'skills'), path.join(home, '.claude', 'skills'), path.join(home, '.config', 'agents', 'skills')].map((d) => [d, true]),
  ];
  const found = new Map();
  for (const [dir, global] of dirs) {
    for (const s of ownSkills(dir)) {
      if (found.has(s.name)) continue;
      let content = '';
      try {
        content = fs.readFileSync(s.path, 'utf8');
      } catch {
        /* listed anyway */
      }
      found.set(s.name, { type: 'skill', name: s.name, description: s.description, content, path: s.path, global, writable: true });
    }
  }
  for (const b of BUILT_IN_SKILLS) if (!found.has(b.name)) found.set(b.name, { type: 'skill', ...b, content: '', path: `builtin://${b.name}`, global: true, writable: false });
  return [...found.values()];
}

/** Its plugin folders for `cwd` that it loads: listed in PLUGINS as enabled, or not listed at all. */
function goosePlugins(cwd) {
  const listed = jsonSetting('PLUGINS', {});
  const dirs = [path.join(cwd, '.agents', 'plugins'), path.join(homeDir(), '.agents', 'plugins')];
  const out = [];
  for (const dir of [...new Set(dirs)]) {
    let names = [];
    try {
      names = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      const at = path.join(dir, name);
      const entry = listed && typeof listed === 'object' ? listed[at] : undefined;
      if (!entry || entry.enabled !== false) out.push({ name, root: at });
    }
  }
  return out;
}

/** The MCP servers a plugin brings (its `.mcp.json`), named `<plugin>:<server>`. */
function pluginServers(plugin) {
  try {
    const mcp = JSON.parse(fs.readFileSync(path.join(plugin.root, '.mcp.json'), 'utf8'));
    return Object.keys(mcp && typeof mcp.mcpServers === 'object' ? mcp.mcpServers : {}).map((n) => `${plugin.name}:${n}`);
  } catch {
    return [];
  }
}

/** Its instruction files for `cwd`: its config's and `.agents`', then from the repository root down to `cwd`. */
function gooseInstructions(cwd) {
  const names = jsonSetting('CONTEXT_FILE_NAMES', ['.goosehints']);
  if (!Array.isArray(names)) return [];
  const files = [];
  for (const name of names) files.push(path.join(root(), 'config', String(name)));
  files.push(path.join(root(), '.agents', 'AGENTS.md'));
  const top = gitRoot(cwd);
  const dirs = [];
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    dirs.unshift(dir);
    if (!top || dir === top || path.dirname(dir) === dir) break;
  }
  for (const dir of dirs) for (const name of names) files.push(path.join(dir, String(name)));
  return [...new Set(files)].filter((f) => fs.existsSync(f));
}

/**
 * The session's extensions: the list `session/new` gave (`_meta.enabledExtensions`), else `developer`,
 * EXTENSIONS' enabled ones, the tool library's servers and the plugins' servers.
 */
function gooseExtensions(p, cwd) {
  const given = p._meta && Array.isArray(p._meta.enabledExtensions) ? p._meta.enabledExtensions : undefined;
  if (given) return given.map((e) => (e && e.type === 'mcp' ? String(e.server && e.server.name) : String(e && e.name)));
  const extensions = jsonSetting('EXTENSIONS', {});
  const platform = Object.values(extensions && typeof extensions === 'object' ? extensions : {})
    .filter((e) => e && e.enabled)
    .map((e) => String(e.name));
  return [...new Set(['developer', ...platform, ...(p.mcpServers || []).map((m) => m.name), ...goosePlugins(cwd).flatMap(pluginServers)])];
}

// --- The commands outside a turn ---------------------------------------------------------------

function staticCommand() {
  if (args[0] === '--version' || args[0] === '-V') return void process.stdout.write(`${VERSION}\n`);
  process.stderr.write(`fake goose: unknown command ${args.join(' ')}\n`, () => exitAfterLog(1));
}

// --- The turn ----------------------------------------------------------------------------------

/** The working directories besides `cwd` its briefing names (Harness Relay's "use full paths for the others"; in parallel mode its worktrees). */
function briefedOthers(briefing, cwd) {
  const shared = /share these working directories, each with the same access: (.+?)\. You start in /.exec(briefing);
  const dirs = shared ? shared[1].split(', ') : [...briefing.matchAll(/^ {2}- (.+?) \(branch /gm)].map((m) => m[1]);
  return dirs.filter((d) => path.resolve(d) !== path.resolve(cwd));
}

/** A command's output as Goose runs it: `$GOOSE_SHELL -c <command>` in the session's folder; without one (Windows), what it would print. */
function runCommand(command, cwd) {
  const shell = env.GOOSE_SHELL;
  if (!shell) {
    const m = /^(?:env )?echo (.*)$/.exec(command);
    return { stdout: m ? `${m[1]}\n` : '', stderr: '', code: 0 };
  }
  const r = spawnSync(shell, ['-c', command], { cwd, encoding: 'utf8', timeout: 30_000 });
  return { stdout: r.stdout || '', stderr: r.stderr || (r.error ? String(r.error.message) : ''), code: typeof r.status === 'number' ? r.status : 1 };
}

const PERMISSION_OPTIONS = ['allow_always', 'allow_once', 'reject_once', 'reject_always'].map((k) => ({ optionId: k, name: k, kind: k }));
const DECLINED = 'The user has declined to run this tool. DO NOT attempt to call this tool again. If there are no alternative methods to proceed, clearly explain the situation and STOP.';

/** Rust's words for a write the file system refused (as Goose says it), by its error code. */
const RUST_ERROR = { EPERM: 'Operation not permitted (os error 1)', EROFS: 'Read-only file system (os error 30)', EACCES: 'Permission denied (os error 13)' };

/** Writes `content` to `file`, making its folder first: undefined when written, else Rust's words for why not (a sandbox's refusal). */
function writeFile(file, content) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return undefined;
  } catch (err) {
    if (refused(err)) return RUST_ERROR[err.code];
    throw err;
  }
}

/** A new session's id, as Goose makes them: the day, and its number that day. */
function newSessionId() {
  const d = new Date();
  const day = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  let n = 1;
  while (fs.existsSync(sessions.file(`${day}_${n}`))) n++;
  return `${day}_${n}`;
}

/** What it keeps of a session in its data folder (next to the mark `sessions` keeps). */
function saveSession(id, s) {
  const { cwd, provider, model, effort, mode, briefing, costTotal, history, extensions } = s;
  fs.writeFileSync(sessions.file(id), JSON.stringify({ cwd, provider, model, effort, mode, briefing, costTotal, history, extensions }));
}

function loadSession(id) {
  try {
    return JSON.parse(fs.readFileSync(sessions.file(id), 'utf8') || '{}');
  } catch {
    return {};
  }
}

function gooseAgent() {
  let seq = 0;
  const next = (prefix) => `${prefix}_${Date.now().toString(36)}${(++seq).toString(36)}`;

  /** A session opened (new or loaded), with its MCP servers and extensions; `kept`: what it had. */
  function open(agent, id, p, kept) {
    const cwd = p.cwd || process.cwd();
    const s = {
      cwd,
      provider: kept.provider || setting('GOOSE_PROVIDER') || 'openai',
      model: kept.model,
      effort: kept.effort || 'off',
      mode: kept.mode || setting('GOOSE_MODE') || 'auto',
      briefing: kept.briefing || '',
      costTotal: kept.costTotal || 0,
      history: kept.history || [],
      cancelled: false,
      mcp: (p.mcpServers || []).map((m) => m.name),
      // A loaded session keeps the extensions it started with (the tool library's servers come again with the load).
      extensions: kept.extensions ? [...new Set([...kept.extensions, ...(p.mcpServers || []).map((m) => m.name)])] : gooseExtensions(p, cwd),
      steers: [],
    };
    const info = providerInfo(s.provider);
    if (!info) throw rpcError(`Internal error: Unknown provider: ${s.provider}`, -32603);
    s.model ??= setting('GOOSE_MODEL') || info.models[0];
    agent.sessions.set(id, s);
    recordMcpEnv(
      Object.fromEntries((p.mcpServers || []).map((m) => [m.name, Object.fromEntries((m.env || m.headers || []).map((v) => [v.name, v.value]))])),
      Object.fromEntries((p.mcpServers || []).filter((m) => m.type === 'http').map((m) => [m.name, m.url])),
    );
    saveSession(id, s);
    return s;
  }

  const answer = (s, id) => ({
    ...(id ? { sessionId: id } : {}),
    modes: modesOf(s),
    configOptions: configOptions(s),
    _meta: { extensionResults: s.extensions.map((name) => ({ name, success: true })), workingDir: s.cwd },
  });

  const session = (open, id) => {
    const s = open.get(id);
    if (!s) throw rpcError('Resource not found', -32002, `Session not found: ${id}`);
    return s;
  };

  acpAgent({
    initialize: () => ({
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, audio: false, embeddedContext: true },
        mcpCapabilities: { http: true, sse: false },
        sessionCapabilities: { list: {}, delete: {}, close: {} },
        auth: {},
        _meta: { goose: { recipeParameterScopes: {}, localInference: {} } },
      },
      authMethods: [{ id: 'goose-provider', name: 'Configure Provider', description: 'Run `goose configure` to set up your AI provider and API key' }],
      agentInfo: { name: 'goose', version: VERSION },
    }),
    // Outside a turn: its catalog, and its skills for a folder.
    '_goose/unstable/providers/list': (p) => ({
      entries: (Array.isArray(p.providerIds) ? p.providerIds : Object.keys(CATALOG))
        .filter((id) => CATALOG[id])
        .map((id) => ({ providerId: id, providerName: CATALOG[id].name, defaultModel: CATALOG[id].models[0].id, models: CATALOG[id].models })),
    }),
    '_goose/unstable/sources/list': (p) => ({ sources: p.sourceType === 'skill' || p.sourceType === undefined ? gooseSkills(p.projectDir || process.cwd()) : [] }),
    'session/new': (p, agent) => {
      const id = newSessionId();
      sessions.start(id);
      return answer(open(agent, id, p, {}), id);
    },
    'session/load': (p, agent) => {
      if (!sessions.resume(p.sessionId)) throw rpcError('Resource not found', -32002, `Session not found: ${p.sessionId}`);
      const s = open(agent, p.sessionId, p, loadSession(p.sessionId));
      // Its history first (the last turn: `replayTail`), then the answer, with the session's own options.
      for (const turn of s.history.slice(-1)) {
        agent.peer.notify('session/update', { sessionId: p.sessionId, update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: turn.user } } });
        agent.peer.notify('session/update', { sessionId: p.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: turn.reply } } });
      }
      return answer(s);
    },
    '_goose/unstable/session/system-prompt/set': (p, { sessions: opened }) => {
      const s = session(opened, p.sessionId);
      s.briefing = String(p.text || '');
      saveSession(p.sessionId, s);
      return {};
    },
    'session/set_config_option': (p, { peer, sessions: opened }) => {
      const s = session(opened, p.sessionId);
      const value = String(p.value);
      if (p.configId === 'provider') {
        const info = providerInfo(value);
        if (!info) throw rpcError(`Invalid params: unknown provider ${value}`, -32602);
        // A new provider starts on its own default model.
        s.provider = value;
        s.model = info.models[0];
        if (!info.efforts.includes(s.effort)) s.effort = 'off';
      } else if (p.configId === 'model') {
        s.model = value;
      } else if (p.configId === 'thinking_effort') {
        if (!(providerInfo(s.provider) || { efforts: [] }).efforts.includes(value)) throw rpcError(`Invalid params: unknown thinking effort ${value}`, -32602);
        s.effort = value;
      } else if (p.configId === 'mode') {
        if (!MODES.some((m) => m.id === value)) throw rpcError(`Invalid params: unknown mode ${value}`, -32602);
        s.mode = value;
      } else {
        throw rpcError(`Invalid params: unknown config option ${p.configId}`, -32602);
      }
      saveSession(p.sessionId, s);
      const options = configOptions(s);
      peer.notify('session/update', { sessionId: p.sessionId, update: { sessionUpdate: 'config_option_update', configOptions: options } });
      return { configOptions: options };
    },
    'session/set_mode': (p, { peer, sessions: opened }) => {
      const s = session(opened, p.sessionId);
      if (!MODES.some((m) => m.id === p.modeId)) throw rpcError(`Invalid params: unknown mode ${p.modeId}`, -32602);
      s.mode = p.modeId;
      saveSession(p.sessionId, s);
      peer.notify('session/update', { sessionId: p.sessionId, update: { sessionUpdate: 'current_mode_update', currentModeId: s.mode } });
      return {};
    },
    // A message into the running turn (Harness Relay's reason for a refusal): kept for the call it refused.
    '_goose/unstable/session/steer': (p, { peer, sessions: opened }) => {
      const s = session(opened, p.sessionId);
      if (!s.activeRunId || p.expectedRunId !== s.activeRunId) throw rpcError(`Invalid params: no running turn ${p.expectedRunId}`, -32602);
      const text = (p.prompt || []).map((b) => b.text || '').join('\n');
      const messageId = `steer_${crypto.randomUUID()}`;
      s.steers.push(text);
      if (s.onSteer) s.onSteer();
      peer.notify('session/update', { sessionId: p.sessionId, update: { sessionUpdate: 'session_info_update', _meta: { goose: { queuedSteer: { messageId, runId: s.activeRunId } } } } });
      return { runId: s.activeRunId, messageId };
    },
    'session/prompt': (p, { peer, sessions: opened }) => gooseTurn(peer, p, session(opened, p.sessionId), next),
  });
}

async function gooseTurn(peer, p, s, next) {
  const sessionId = p.sessionId;
  const blocks = p.prompt || [];
  const prompt = blocks.map((b) => b.text || '').join('\n');
  const images = blocks.filter((b) => b.type === 'image' && b.data).length;
  const info = providerInfo(s.provider) || { models: [], efforts: [] };
  const keyEnv = info.keyEnv;
  record({
    prompt,
    briefing: s.briefing,
    images,
    mcp: s.mcp,
    model: s.model,
    effort: s.effort,
    mode: s.mode,
    provider: s.provider,
    instructions: gooseInstructions(s.cwd),
    skills: gooseSkills(s.cwd).map((x) => x.name),
    plugins: goosePlugins(s.cwd).map((x) => x.name),
    extensions: s.extensions,
    ...(info.baseUrl ? { endpoint: { baseUrl: info.baseUrl, key: Boolean(keyEnv && env[keyEnv]), models: info.models } } : {}),
    // The key variables of other backends it was given (none, when Harness Relay gives it its run's only).
    otherKeys: [...Object.values(KEY_ENV), ...Object.keys(env).filter((k) => /^HARNESS_RELAY_ENDPOINT_.+_API_KEY$/.test(k))].filter((k) => k !== keyEnv && env[k]),
  });

  const update = (u) => peer.notify('session/update', { sessionId, update: u });
  s.activeRunId = `run_${crypto.randomUUID()}`;
  s.cancelled = false;
  s.steers = [];
  update({ sessionUpdate: 'session_info_update', _meta: { goose: { activeRunId: s.activeRunId } } });
  update({ sessionUpdate: 'usage_update', used: 0, size: 400000 });
  const endRun = () => {
    s.activeRunId = undefined;
    update({ sessionUpdate: 'session_info_update', _meta: { goose: { activeRunId: null } } });
  };
  const cancelled = () => {
    endRun();
    return { stopReason: 'cancelled', usage: { totalTokens: 0, inputTokens: 0, outputTokens: 0 } };
  };
  const failed = (message, code = -32603, data = { reason: 'turn_failed' }) => {
    endRun();
    return rpcError(message, code, data);
  };

  // Its provider's key, as Goose signs in with it; the model, as the provider knows it.
  if ((KEY_ENV[s.provider] || info.requiresAuth) && !(keyEnv && env[keyEnv])) throw failed('Authentication required', -32000);
  if (!info.models.includes(s.model)) {
    throw failed(`Ran into this error: Request failed: Resource not found (404) at ${info.baseUrl || `https://${s.provider}`}: The model \`${s.model}\` does not exist or you do not have access to it.`);
  }

  const steps = plan(prompt, { cwd: s.cwd, images, mcp: s.mcp, briefing: s.briefing });
  if (steps[0] && steps[0].type === 'fail') return fail(steps[0].text);
  if (steps[0] && steps[0].type === 'error') throw failed(`Ran into this error: ${steps[0].text}`);

  const u = sessionUpdates(peer, sessionId, () => s.cancelled);
  const others = briefedOthers(s.briefing, s.cwd);
  const inference = { provider: s.provider, requestedModel: s.model };
  let prefix = '';

  /** A tool call, as Goose announces it: no kind, no status; the tool in `_meta`. */
  const announce = (tool, extension, title, rawInput) => {
    const id = next('call');
    update({ sessionUpdate: 'tool_call', toolCallId: id, title, rawInput, _meta: { goose: { toolCall: { toolName: tool, extensionName: extension }, created: Math.floor(Date.now() / 1000), messageId: next('resp'), inference } } });
    return id;
  };

  /**
   * Asks about a call in `approve` mode (every one; none in `auto`): `{ ok, note }`. A refused one waits a
   * moment for Harness Relay's steer, its reason, as Goose takes it into the running turn.
   */
  const permit = async (id, title, rawInput) => {
    if (s.mode !== 'approve' && s.mode !== 'smart_approve') return { ok: true };
    const steered = s.steers.length;
    const a = await requestPermission(peer, sessionId, { toolCallId: id, kind: 'other', status: 'pending', title, rawInput }, PERMISSION_OPTIONS);
    const o = a && a.outcome;
    if (o && o.outcome === 'selected' && (o.optionId === 'allow_once' || o.optionId === 'allow_always')) return { ok: true };
    if (s.cancelled || !o || o.outcome === 'cancelled') return { ok: false, note: '' };
    if (s.steers.length === steered) await new Promise((resolve) => ((s.onSteer = resolve), setTimeout(resolve, 1500)));
    s.onSteer = undefined;
    const steer = s.steers.slice(steered).join('\n');
    return { ok: false, note: noteIn(steer), steer };
  };

  /** A refused call's end, and the steer it took in. */
  const refuse = (id, r, extra = {}) => {
    update({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'failed', content: [{ type: 'content', content: { type: 'text', text: DECLINED } }], ...extra });
    if (r.steer) update({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: r.steer }, _meta: { goose: { steer: true } } });
  };

  const done = (id, ok, text, extra = {}) =>
    update({ sessionUpdate: 'tool_call_update', toolCallId: id, status: ok ? 'completed' : 'failed', content: [{ type: 'content', content: { type: 'text', text } }], ...extra });

  for (const step of steps) {
    if (s.cancelled) return cancelled();
    const tools = s.mode !== 'chat';
    if (step.type === 'think') await u.thought(step.text);
    if (step.type === 'todo' && tools) {
      const mark = { completed: 'x', in_progress: '~', pending: ' ' };
      const rawInput = { content: step.entries.map((e) => `- [${mark[e.status] || ' '}] ${e.text}`).join('\n') };
      const id = announce('todo__todo_write', 'todo', 'todo: todo write', rawInput);
      const r = await permit(id, 'todo: todo write', rawInput);
      if (s.cancelled) return cancelled();
      if (!r.ok) refuse(id, r);
      else done(id, true, `Updated (${rawInput.content.length} chars)`);
    }
    if (step.type === 'tool' && tools) {
      const rawInput = { path: '.', depth: 2 };
      const id = announce('tree', 'developer', 'tree · .', rawInput);
      const r = await permit(id, 'tree · .', rawInput);
      if (s.cancelled) return cancelled();
      if (!r.ok) refuse(id, r);
      else done(id, true, safeList(s.cwd));
    }
    if (step.type === 'approve') {
      // `echo` alone would be a reading command, which Harness Relay lets run without asking in read-only.
      const command = step.command === 'echo e2e-approval' ? 'env echo e2e-approval' : step.command;
      if (!tools) {
        prefix += 'I may not run commands in chat mode. ';
        continue;
      }
      const rawInput = { command, timeout_secs: 30 };
      const title = `shell · ${command}`;
      const id = announce('shell', 'developer', title, rawInput);
      const r = await permit(id, title, rawInput);
      if (s.cancelled) return cancelled();
      if (!r.ok) {
        refuse(id, r);
        prefix += declined('command', r.note);
      } else {
        const out = runCommand(command, s.cwd);
        update({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'in_progress', _meta: { toolNotification: { type: 'live_output', params: { sequence: 1, chunks: [{ stream: 'stdout', output: out.stdout }], truncated: false } } } });
        // A command that fails is a failed call.
        done(id, out.code === 0, out.code === 0 ? out.stdout : `${out.stdout}${out.stderr}\nCommand exited with code ${out.code}`, { rawOutput: { stdout: out.stdout, stderr: out.stderr, exit_code: out.code } });
        prefix += out.code === 0 ? `The command ran: ${out.stdout.trim()}. ` : `The command failed (exit ${out.code}): ${(out.stderr || out.stdout).trim()}. `;
      }
    }
    if (step.type === 'write') {
      const file = targetOf(step, s.cwd, others);
      if (!file) {
        prefix += noOther(step);
        continue;
      }
      if (!tools) {
        prefix += wrote(step, false, '');
        continue;
      }
      // The path as the model gives it: relative to its folder, or whole for another one.
      const given = step.other ? file : step.path;
      const rawInput = { path: given, content: step.content };
      const title = `write · ${given}`;
      const id = announce('write', 'developer', title, rawInput);
      const r = await permit(id, title, rawInput);
      if (s.cancelled) return cancelled();
      const locations = [{ path: given, line: 1 }];
      if (!r.ok) {
        refuse(id, r, { locations });
        prefix += wrote(step, false, r.note);
        continue;
      }
      const refusal = writeFile(file, step.content);
      if (!refusal) done(id, true, `Created ${given} (${step.content.split('\n').filter(Boolean).length} lines)`, { locations });
      else done(id, false, `Failed to write ${given}: ${refusal}`);
      prefix += wrote(step, !refusal, '');
    }
    if (step.type === 'text') {
      if (!(await u.message(prefix + step.text, step.slow))) return cancelled();
      s.history.push({ user: lastUserMessage(prompt) || '', reply: prefix + step.text });
    }
  }
  if (s.cancelled) return cancelled();
  // Its cost is the session's total so far.
  s.costTotal = Math.round((s.costTotal + 0.0011) * 1e6) / 1e6;
  saveSession(sessionId, s);
  endRun();
  update({ sessionUpdate: 'usage_update', used: 3300, size: 400000, cost: { amount: s.costTotal, currency: 'USD' } });
  await sleep(5);
  return { stopReason: 'end_turn', usage: { totalTokens: 3300, inputTokens: 3270, outputTokens: 30 } };
}

module.exports = {
  provider: 'goose',
  bin: 'goose',
  aliases: [],
  label: 'Goose',
  name: 'Goose',
  version: VERSION,
  versionRe: /^1\.58\.999$/m,
  /**
   * Its state, which a run may write (one of its adapter's `statePaths`): `<GOOSE_PATH_ROOT>/data`.
   */
  home: (e) => path.join(e.GOOSE_PATH_ROOT || path.join(os.homedir(), '.config', 'goose'), 'data'),
  /** Its run's key (its provider's variable, or the endpoint's), by `keyVerdict`; null for none. */
  apiKey(e) {
    const provider = e.GOOSE_PROVIDER;
    let name = provider ? KEY_ENV[provider] : Object.values(KEY_ENV).find((k) => e[k]);
    if (provider && !name && provider.startsWith('relay-')) name = `HARNESS_RELAY_ENDPOINT_${provider.slice('relay-'.length).toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`;
    return name && e[name] ? keyVerdict(e[name]) : null;
  },
  main() {
    if (args[0] === 'acp') gooseAgent();
    else staticCommand();
  },
};
