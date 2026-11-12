'use strict';
/*
 * The fake OpenCode (`opencode`, an open agent): `opencode acp --port <port>` (ACP on stdio, and its
 * own HTTP server on 127.0.0.1:<port>), `--version`, `models --verbose`, `debug skill`, `agent list`.
 * Anything else exits with code 1 at once.
 *
 * What it does depends only on what Harness Relay gave it, as with the real one: its config (its
 * config folder's `opencode.json`, then OPENCODE_CONFIG and OPENCODE_CONFIG_CONTENT; the project's own
 * only without OPENCODE_DISABLE_PROJECT_CONFIG, its rules then after the run's; OPENCODE_PERMISSION last),
 * whose permission rules decide what it asks about (`session/request_permission`, the last rule that
 * matches wins), whose `shell` runs its commands (`relay-shell -c <command>`), whose model and provider it
 * runs on, and whose `instructions` hold its briefing (`harness-relay-briefing.md`). It really writes the
 * files it is asked to: below full access Harness Relay's own sandbox refuses a write outside the folders
 * a run may write, and it says so as OpenCode does ("Unknown: FileSystem.writeFile (<path>)").
 *
 * Its HTTP server, which Harness Relay watches below full access, wants the run's password (Basic auth,
 * OPENCODE_SERVER_USERNAME / OPENCODE_SERVER_PASSWORD): its event stream (`GET /global/event`: the
 * permission requests it asks and their answers, its session's status), its pending permission requests
 * (`GET /permission`) and their answers (`POST /permission/<id>/reply`, Harness Relay's reason for a
 * refusal, which the model then reads as the user's feedback).
 *
 * Its sessions and marks are kept in its data folder (XDG_DATA_HOME, the conversation member's own,
 * which a run may write), never in `opencode/opencode.db` there (Harness Relay opens that as SQLite).
 */
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { acpAgent, requestPermission, sessionUpdates } = require('../lib/acp.cjs');
const { ownSkills, safeList, targetOf } = require('../lib/files.cjs');
const { keyVerdict, sessions } = require('../lib/home.cjs');
const { exitAfterLog, record, tryWrite } = require('../lib/log.cjs');
const { declined, lastUserMessage, noOther, noteIn, plan, recordMcpEnv, wrote } = require('../lib/plan.cjs');
const { fail, rpcError } = require('../lib/rpc.cjs');
const { args, sleep } = require('../lib/self.cjs');

const VERSION = '1.19.999';

/** The API providers' key variables, as OpenCode reads them. */
const KEY_ENV = { openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', xai: 'XAI_API_KEY' };
/** An endpoint's key, as Harness Relay names it in its provider config (`env`). */
const ENDPOINT_KEY_ENV = 'HARNESS_RELAY_ENDPOINT_KEY';

/** Its model catalog (models.dev, as OpenCode keeps it): one model each that calls tools, and one that does not. */
const CATALOG = [
  { provider: 'openai', id: 'gpt-e2e-fake', name: 'GPT E2E Fake', toolcall: true },
  { provider: 'openai', id: 'image-e2e-fake', name: 'Image E2E Fake', toolcall: false },
  { provider: 'anthropic', id: 'claude-e2e-fake', name: 'Claude E2E Fake', toolcall: true },
  { provider: 'xai', id: 'grok-e2e-fake', name: 'Grok E2E Fake', toolcall: true },
];
const VARIANTS = ['low', 'medium', 'high'];
const PROVIDER_NAME = { openai: 'OpenAI', anthropic: 'Anthropic', xai: 'xAI' };

const env = process.env;

// --- Its config --------------------------------------------------------------------------------

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** Deep merge, `b` over `a` (its keys keep `a`'s order, new ones after). */
function merge(a, b) {
  if (!isObject(a) || !isObject(b)) return b === undefined ? a : b;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = merge(a[k], v);
  return out;
}

/** What OpenCode fills in in a config's text before it reads it: `{env:NAME}` and `{file:path}`. */
function substitute(text, dir) {
  return text
    .replace(/\{env:([^}]+)\}/g, (_, name) => JSON.stringify(env[name] || '').slice(1, -1))
    .replace(/\{file:([^}]+)\}/g, (_, file) => {
      const p = file.startsWith('~/') ? path.join(os.homedir(), file.slice(2)) : path.resolve(dir, file);
      try {
        return JSON.stringify(fs.readFileSync(p, 'utf8').trim()).slice(1, -1);
      } catch {
        return '';
      }
    });
}

/** A config file's content (undefined when there is none, or it is not JSON). */
function configFile(file) {
  try {
    return JSON.parse(substitute(fs.readFileSync(file, 'utf8'), path.dirname(file)));
  } catch {
    return undefined;
  }
}

/**
 * Its config for a folder, as OpenCode reads it: its config folder's `opencode.json`, OPENCODE_CONFIG,
 * OPENCODE_CONFIG_CONTENT, the project's own (unless OPENCODE_DISABLE_PROJECT_CONFIG=1; its permission
 * rules come after the run's, the worst case of what that flag guards against), OPENCODE_PERMISSION.
 */
function readConfig(cwd) {
  const dir = env.OPENCODE_CONFIG_DIR || path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'opencode');
  let config = configFile(path.join(dir, 'opencode.json')) || {};
  if (env.OPENCODE_CONFIG) config = merge(config, configFile(env.OPENCODE_CONFIG) || {});
  if (env.OPENCODE_CONFIG_CONTENT) {
    try {
      config = merge(config, JSON.parse(substitute(env.OPENCODE_CONFIG_CONTENT, cwd)));
    } catch (err) {
      throw new Error(`OPENCODE_CONFIG_CONTENT is not valid JSON: ${err.message}`);
    }
  }
  const project = [];
  if (env.OPENCODE_DISABLE_PROJECT_CONFIG !== '1') {
    for (const file of [path.join(cwd, 'opencode.json'), path.join(cwd, '.opencode', 'opencode.json')]) {
      const own = configFile(file);
      if (!own) continue;
      const { permission, ...rest } = own;
      config = merge(rest, config);
      if (isObject(permission)) project.push(permission);
    }
  }
  if (env.OPENCODE_PERMISSION) {
    try {
      config.permission = merge(config.permission || {}, JSON.parse(env.OPENCODE_PERMISSION));
    } catch {
      /* not JSON: OpenCode leaves it out */
    }
  }
  return { ...config, projectPermission: project };
}

// --- Its permission rules ----------------------------------------------------------------------

/** OpenCode's wildcard: `*` any text, `?` one character. */
function wildcard(pattern, value) {
  const esc = (s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${pattern.split('*').map((p) => p.split('?').map(esc).join('.')).join('.*')}$`, 's').test(value);
}

/** A permission config as rules, in order: `{key: action}` or `{key: {pattern: action}}`. */
function rulesOf(permission) {
  const out = [];
  for (const [key, v] of Object.entries(isObject(permission) ? permission : {})) {
    if (typeof v === 'string') out.push({ key, pattern: '*', action: v });
    else if (isObject(v)) for (const [pattern, action] of Object.entries(v)) out.push({ key, pattern, action });
  }
  return out;
}

/** OpenCode's own defaults, before the config's rules: nearly everything allowed. */
const DEFAULT_RULES = rulesOf({ '*': 'allow', doom_loop: 'ask', external_directory: 'ask' });

/** What a call asks for (`allow`, `ask`, `deny`): the last rule that matches its permission and pattern. */
function decide(config, permission, pattern = '*') {
  let action = 'ask';
  for (const r of [...DEFAULT_RULES, ...rulesOf(config.permission), ...config.projectPermission.flatMap(rulesOf)]) {
    if (wildcard(r.key, permission) && wildcard(r.pattern, pattern)) action = r.action;
  }
  return action;
}

// --- What it runs on ---------------------------------------------------------------------------

/** The models of a provider: the catalog's (API providers), or those an inline provider names. */
function providerModels(config, provider) {
  const inline = isObject(config.provider) ? config.provider[provider] : undefined;
  if (isObject(inline)) {
    return Object.entries(isObject(inline.models) ? inline.models : {}).map(([id, m]) => ({ provider, id, name: (isObject(m) && m.name) || id, toolcall: true, inline: true }));
  }
  return CATALOG.filter((m) => m.provider === provider);
}

/** The providers a run may use: `enabled_providers`, else every catalog provider and inline one. */
function enabledProviders(config) {
  if (Array.isArray(config.enabled_providers)) return config.enabled_providers.map(String);
  return [...new Set([...CATALOG.map((m) => m.provider), ...Object.keys(isObject(config.provider) ? config.provider : {})])];
}

const modelsOf = (config) => enabledProviders(config).flatMap((p) => providerModels(config, p));

/** A model by its id (`<provider>/<model>`), among those the run may use. */
function findModel(config, id) {
  return modelsOf(config).find((m) => `${m.provider}/${m.id}` === id);
}

/** A model's effort levels (its variants): none for an inline provider's. */
const variantsOf = (model) => (model && !model.inline && model.toolcall ? VARIANTS : []);

/** The session's config options, as `session/new` and `set_config_option` answer them. */
function configOptions(config, s) {
  const model = findModel(config, s.model);
  const efforts = variantsOf(model);
  return [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: s.model,
      options: modelsOf(config).map((m) => ({ value: `${m.provider}/${m.id}`, name: `${(isObject(config.provider) && config.provider[m.provider]?.name) || PROVIDER_NAME[m.provider] || m.provider}/${m.name}` })),
    },
    ...(efforts.length
      ? [{ id: 'effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: s.effort, options: [...efforts, 'default'].map((value) => ({ value })) }]
      : []),
    { id: 'mode', name: 'Session Mode', category: 'mode', type: 'select', currentValue: s.mode, options: ['build', 'plan'].map((value) => ({ value, name: value })) },
  ];
}

/** The key variable a provider is run with: an API provider's own, or the endpoint key an inline one names. */
function keyEnvOf(config, provider) {
  if (KEY_ENV[provider]) return KEY_ENV[provider];
  const inline = isObject(config.provider) ? config.provider[provider] : undefined;
  return isObject(inline) && Array.isArray(inline.env) && inline.env[0] ? String(inline.env[0]) : undefined;
}

/** The provider this start is for: its config's only enabled one, else the first API key it was given. */
function runProvider(e) {
  try {
    const p = JSON.parse(e.OPENCODE_CONFIG_CONTENT || '{}').enabled_providers;
    if (Array.isArray(p) && p.length === 1) return String(p[0]);
  } catch {
    /* none */
  }
  return Object.keys(KEY_ENV).find((p) => e[KEY_ENV[p]]);
}

// --- What it loads by itself -------------------------------------------------------------------

/** The folders from `cwd` up to its repository's root (the filesystem's root outside one). */
function upToRoot(cwd) {
  const dirs = [];
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    dirs.push(dir);
    if (fs.existsSync(path.join(dir, '.git')) || path.dirname(dir) === dir) return dirs;
  }
}

/** The repository root `cwd` is in, if any. */
function gitRoot(cwd) {
  const dirs = upToRoot(cwd);
  const top = dirs[dirs.length - 1];
  return fs.existsSync(path.join(top, '.git')) ? top : undefined;
}

const BUILT_IN_SKILL = { name: 'customize-opencode', description: "Change OpenCode's own settings", location: '<built-in>', content: 'Edit opencode.json.' };

/**
 * Its skills for a folder: the project's `.claude/skills` and `.agents/skills` (from the folder up to its
 * repository's root) and those of the home it stands in for the user's (OPENCODE_TEST_HOME), but those
 * its `skill` rules deny (all, with `"skill": "deny"`), and its built-in one.
 */
function opencodeSkills(cwd, config) {
  if (isObject(config.permission) && config.permission.skill === 'deny') return [];
  const home = env.OPENCODE_TEST_HOME || os.homedir();
  const dirs = [...upToRoot(cwd).flatMap((d) => [path.join(d, '.claude', 'skills'), path.join(d, '.agents', 'skills')]), path.join(home, '.claude', 'skills'), path.join(home, '.agents', 'skills')];
  const found = new Map();
  for (const dir of dirs) {
    for (const s of ownSkills(dir)) {
      if (found.has(s.name)) continue;
      let content = '';
      try {
        content = fs.readFileSync(s.path, 'utf8');
      } catch {
        /* listed anyway */
      }
      found.set(s.name, { name: s.name, description: s.description, location: s.path, content });
    }
  }
  return [...found.values(), BUILT_IN_SKILL].filter((s) => decide(config, 'skill', s.name) !== 'deny');
}

/** Its subagents (`general`, `explore`), but those its config turns off; none when `task` is denied. */
function opencodeAgents(config) {
  return ['general', 'explore'].filter((name) => !(isObject(config.agent) && config.agent[name]?.disable) && decide(config, 'task', name) !== 'deny');
}

// --- The commands outside a turn ---------------------------------------------------------------

function staticCommand() {
  if (args[0] === '--version' || args[0] === '-v') return void process.stdout.write(`${VERSION}\n`);
  if (args[0] === 'models') {
    // Only the providers it may use and has a key for, as OpenCode lists them.
    const config = readConfig(process.cwd());
    const out = [];
    for (const m of CATALOG) {
      if (!enabledProviders(config).includes(m.provider) || !env[KEY_ENV[m.provider]]) continue;
      out.push(`${m.provider}/${m.id}`);
      if (args.includes('--verbose')) {
        const info = {
          id: m.id,
          providerID: m.provider,
          name: m.name,
          status: 'active',
          capabilities: { toolcall: m.toolcall, output: { text: true } },
          ...(m.toolcall ? { variants: Object.fromEntries(VARIANTS.map((v) => [v, {}])) } : {}),
        };
        out.push(JSON.stringify(info, null, 2));
      }
    }
    return void process.stdout.write(out.join('\n') + '\n');
  }
  if (args[0] === 'debug' && args[1] === 'skill') {
    return void process.stdout.write(JSON.stringify(opencodeSkills(process.cwd(), readConfig(process.cwd())), null, 2) + '\n');
  }
  if (args[0] === 'agent' && args[1] === 'list') {
    const config = readConfig(process.cwd());
    const lines = ['build (primary)', '[]', 'plan (primary)', '[]', ...opencodeAgents(config).flatMap((a) => [`${a} (subagent)`, '[]'])];
    return void process.stdout.write(lines.join('\n') + '\n');
  }
  process.stderr.write(`fake opencode: unknown command ${args.join(' ')}\n`, () => exitAfterLog(1));
}

// --- Its own server ----------------------------------------------------------------------------

/**
 * Its HTTP server on 127.0.0.1:`port`, wanting the run's password: the event stream, the pending
 * permission requests and their replies. `server.emit(type, properties)` sends an event on every open
 * stream; `server.pending` holds the requests it waits on (by id), which a reply settles.
 */
function startServer(port, ready) {
  const user = env.OPENCODE_SERVER_USERNAME || 'opencode';
  const password = env.OPENCODE_SERVER_PASSWORD || '';
  const auth = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
  const streams = new Set();
  const state = {
    pending: new Map(),
    emit(type, properties) {
      const line = `data: ${JSON.stringify({ payload: { type, properties } })}\n\n`;
      for (const s of streams) s.write(line);
    },
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (password && req.headers.authorization !== auth) return void res.writeHead(401).end('Unauthorized');
    if (req.method === 'GET' && url.pathname === '/global/event') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify({ payload: { type: 'server.connected', properties: {} } })}\n\n`);
      streams.add(res);
      res.on('close', () => streams.delete(res));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/permission') {
      const list = [...state.pending.values()].map((p) => p.request);
      return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(list));
    }
    const reply = /^\/permission\/([^/]+)\/reply$/.exec(url.pathname);
    if (req.method === 'POST' && reply) {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const p = state.pending.get(decodeURIComponent(reply[1]));
        if (!p) return void res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ name: 'NotFoundError' }));
        let answer = {};
        try {
          answer = JSON.parse(body || '{}');
        } catch {
          return void res.writeHead(400).end();
        }
        p.settle({ reply: String(answer.reply || 'reject'), message: typeof answer.message === 'string' ? answer.message : '' });
        res.writeHead(200, { 'content-type': 'application/json' }).end('true');
      });
      return;
    }
    res.writeHead(404).end();
  });
  // As `opencode acp` does: it does not answer `initialize` when it cannot serve.
  server.once('error', (err) => process.stderr.write(`ServeError: could not listen on 127.0.0.1:${port}: ${err.message}\n`, () => exitAfterLog(1)));
  server.listen(port, '127.0.0.1', () => ready(state));
}

// --- The turn ----------------------------------------------------------------------------------

/** The working directories besides `cwd` its briefing names (Harness Relay's "use full paths for the others"; in parallel mode its worktrees). */
function briefedOthers(briefing, cwd) {
  const shared = /share these working directories, each with the same access: (.+?)\. You start in /.exec(briefing);
  const dirs = shared ? shared[1].split(', ') : [...briefing.matchAll(/^ {2}- (.+?) \(branch /gm)].map((m) => m[1]);
  return dirs.filter((d) => path.resolve(d) !== path.resolve(cwd));
}

/** Its briefing (the instruction file Harness Relay names `harness-relay-briefing.md`) and its other instruction files. */
function instructionsOf(config) {
  const list = Array.isArray(config.instructions) ? config.instructions.map(String) : [];
  const file = list.find((f) => path.basename(f) === 'harness-relay-briefing.md');
  let briefing = '';
  if (file) {
    try {
      briefing = fs.readFileSync(file, 'utf8').replace(/\n$/, '');
    } catch {
      /* not readable: no briefing */
    }
  }
  return { briefing, instructions: list.filter((f) => f !== file) };
}

/** Whether `file` is outside the session's project (its folder, or the repository it is in): OpenCode's `external_directory`. */
function external(file, cwd) {
  const within = (dir) => {
    const rel = path.relative(dir, file);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  };
  const root = gitRoot(cwd);
  return !within(path.resolve(cwd)) && !(root && within(root));
}

/** A command's output as OpenCode runs it: `<shell> -c <command>` in the session's folder; without a shell (Windows), what it would print. */
function runCommand(shell, command, cwd) {
  if (!shell) {
    const m = /^(?:env )?echo (.*)$/.exec(command);
    return { stdout: m ? `${m[1]}\n` : '', stderr: '', code: 0 };
  }
  const r = spawnSync(shell, ['-c', command], { cwd, encoding: 'utf8', timeout: 30_000 });
  return { stdout: r.stdout || '', stderr: r.stderr || (r.error ? String(r.error.message) : ''), code: typeof r.status === 'number' ? r.status : 1 };
}

const PERMISSION_OPTIONS = [
  { optionId: 'once', kind: 'allow_once', name: 'Allow once' },
  { optionId: 'always', kind: 'allow_always', name: 'Always allow' },
  { optionId: 'reject', kind: 'reject_once', name: 'Reject' },
];

const REJECTED = 'The user rejected permission to use this specific tool call.';
const DENIED = 'The user has specified a rule which prevents you from using this specific tool call.';

/** A session id as OpenCode makes them: `ses_` and 26 letters and digits. */
function newSessionId() {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return `ses_${[...crypto.randomBytes(26)].map((b) => abc[b % abc.length]).join('')}`;
}

/** What it keeps of a session in its data folder (next to the mark `sessions` keeps). */
function saveSession(id, s) {
  fs.writeFileSync(sessions.file(id), JSON.stringify({ cwd: s.cwd, model: s.model, effort: s.effort, mode: s.mode, costTotal: s.costTotal, turns: s.turns }));
}

function loadSession(id) {
  try {
    return JSON.parse(fs.readFileSync(sessions.file(id), 'utf8') || '{}');
  } catch {
    return {};
  }
}

function opencodeAgent(server) {
  let config;
  const configFor = (cwd) => (config ??= readConfig(cwd));
  let seq = 0;
  const next = (prefix) => `${prefix}_${Date.now().toString(36)}${(++seq).toString(36)}`;

  /** A session opened (`session/new`, or a resumed one), with its MCP servers and its model. */
  function open(agent, id, p, kept) {
    const cwd = p.cwd || process.cwd();
    const c = configFor(cwd);
    const model = kept.model || String(c.model || '');
    const effort = kept.effort !== undefined ? kept.effort : variantsOf(findModel(c, model))[0] || null;
    const s = { cwd, model, effort, mode: kept.mode || 'build', costTotal: kept.costTotal || 0, turns: kept.turns || [], cancelled: false, mcp: (p.mcpServers || []).map((m) => m.name) };
    agent.sessions.set(id, s);
    recordMcpEnv(
      Object.fromEntries((p.mcpServers || []).map((m) => [m.name, Object.fromEntries((m.env || m.headers || []).map((v) => [v.name, v.value]))])),
      Object.fromEntries((p.mcpServers || []).filter((m) => m.type === 'http').map((m) => [m.name, m.url])),
    );
    saveSession(id, s);
    return s;
  }

  const resume = (p, agent) => {
    if (!sessions.resume(p.sessionId)) throw rpcError('Internal error: OpenCode service failure', -32603, { service: 'session' });
    const s = open(agent, p.sessionId, p, loadSession(p.sessionId));
    return { configOptions: configOptions(configFor(s.cwd), s) };
  };

  acpAgent({
    initialize: () => ({
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        mcpCapabilities: { http: true, sse: true },
        promptCapabilities: { embeddedContext: true, image: true },
        sessionCapabilities: { close: {}, fork: {}, list: {}, resume: {} },
      },
      authMethods: [{ description: 'Run `opencode auth login` in the terminal', name: 'Login with opencode', id: 'opencode-login' }],
      agentInfo: { name: 'OpenCode', version: VERSION },
    }),
    'session/new': (p, agent) => {
      const id = newSessionId();
      sessions.start(id);
      const s = open(agent, id, p, {});
      return { sessionId: id, configOptions: configOptions(configFor(s.cwd), s) };
    },
    'session/resume': resume,
    'session/load': resume,
    'session/set_config_option': (p, { peer, sessions: opened }) => {
      const s = opened.get(p.sessionId);
      if (!s) throw rpcError(`Internal error: Session not found: ${p.sessionId}`, -32603, { service: 'session' });
      const c = configFor(s.cwd);
      const value = String(p.value);
      if (p.configId === 'model') {
        const model = findModel(c, value);
        if (!model) throw rpcError(`Invalid params: model not found: ${value}`, -32602, { model: value });
        s.model = value;
        // A new model starts on its own first effort level.
        s.effort = variantsOf(model)[0] || null;
      } else if (p.configId === 'effort') {
        if (!variantsOf(findModel(c, s.model)).concat('default').includes(value)) throw rpcError(`Invalid params: effort not found: ${value}`, -32602, { effort: value });
        s.effort = value;
      } else if (p.configId === 'mode') {
        if (!['build', 'plan'].includes(value)) throw rpcError(`Invalid params: mode not found: ${value}`, -32602, { mode: value });
        s.mode = value;
      } else {
        throw rpcError(`Invalid params: unknown config option ${p.configId}`, -32602);
      }
      saveSession(p.sessionId, s);
      const options = configOptions(c, s);
      peer.notify('session/update', { sessionId: p.sessionId, update: { sessionUpdate: 'config_option_update', configOptions: options } });
      return { configOptions: options };
    },
    'session/prompt': (p, { peer, sessions: opened }) => {
      const s = opened.get(p.sessionId);
      if (!s) throw rpcError(`Internal error: Session not found: ${p.sessionId}`, -32603, { service: 'session' });
      return opencodeTurn(peer, server, p, s, configFor(s.cwd), next);
    },
  });
}

async function opencodeTurn(peer, server, p, s, c, next) {
  const sessionId = p.sessionId;
  const blocks = p.prompt || [];
  const prompt = blocks.map((b) => b.text || '').join('\n');
  const images = blocks.filter((b) => b.type === 'image' && b.data).length;
  const { briefing, instructions } = instructionsOf(c);
  const [provider] = s.model.split('/');
  const keyEnv = keyEnvOf(c, provider);
  const inline = isObject(c.provider) ? c.provider[provider] : undefined;
  record({
    prompt,
    briefing,
    images,
    mcp: s.mcp,
    model: s.model,
    effort: s.effort,
    mode: s.mode,
    provider,
    permission: c.permission || null,
    continueOnDeny: Boolean(c.experimental && c.experimental.continue_loop_on_deny),
    instructions,
    skills: opencodeSkills(s.cwd, c).map((x) => x.name),
    agents: opencodeAgents(c),
    shell: c.shell || null,
    ...(isObject(inline) ? { endpoint: { baseUrl: inline.options?.baseURL, key: Boolean(keyEnv && env[keyEnv]) } } : {}),
    // The key variables of other backends it was given (none, when Harness Relay gives it its run's only).
    otherKeys: [...Object.values(KEY_ENV), ENDPOINT_KEY_ENV].filter((k) => k !== keyEnv && env[k]),
  });

  // What it runs on: a model of a provider it may use, with that provider's key.
  if (!enabledProviders(c).includes(provider) || !findModel(c, s.model)) {
    throw rpcError(`Internal error: Model not found: ${s.model}`, -32603, { service: 'session', errorName: 'ProviderModelNotFoundError' });
  }
  if (KEY_ENV[provider] && !env[KEY_ENV[provider]]) {
    throw rpcError('Authentication required: provider authentication required', -32000, { providerId: provider });
  }

  s.cancelled = false;
  const steps = plan(prompt, { cwd: s.cwd, images, mcp: s.mcp, briefing });
  if (steps[0] && steps[0].type === 'fail') return fail(steps[0].text);
  if (steps[0] && steps[0].type === 'error') throw rpcError(`Internal error: ${steps[0].text}`, -32603, { service: 'session', errorName: 'APIError' });

  server.emit('session.status', { sessionID: sessionId, status: { type: 'busy' } });
  const u = sessionUpdates(peer, sessionId, () => s.cancelled);
  const cancelled = { stopReason: 'cancelled', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, _meta: {} };
  const others = briefedOthers(briefing, s.cwd);
  const messageID = next('msg');
  const continueOnDeny = Boolean(c.experimental && c.experimental.continue_loop_on_deny);
  let prefix = '';
  let stoppedOnDeny = false;

  /**
   * Asks the client about a call whose rule says `ask` (`permission`: OpenCode's name for it, the request's
   * `toolCall`): `{ ok, feedback }`. A reply through its server (Harness Relay's reason for a refusal)
   * settles the request before the ACP answer comes, which then finds nothing left to answer.
   */
  const ask = async (permission, patterns, toolCall) => {
    const id = next('per');
    const request = { id, sessionID: sessionId, permission, patterns, metadata: {}, always: [], tool: { messageID, callID: toolCall.toolCallId } };
    let settle;
    const replied = new Promise((resolve) => (settle = resolve));
    server.pending.set(id, { request, settle });
    server.emit('permission.asked', request);
    const answered = requestPermission(peer, sessionId, toolCall, PERMISSION_OPTIONS).then((answer) => {
      const o = answer && answer.outcome;
      if (o && o.outcome === 'selected' && (o.optionId === 'once' || o.optionId === 'always')) return { reply: o.optionId, message: '' };
      return { reply: 'reject', message: '' };
    });
    const r = await Promise.race([replied, answered]);
    server.pending.delete(id);
    server.emit('permission.replied', { sessionID: sessionId, requestID: id, reply: r.reply });
    return { ok: r.reply !== 'reject', feedback: r.message };
  };

  /** Asks when the rule says so: `{ ok, feedback, asked }` (a denied rule refuses without asking). */
  const permit = async (permission, pattern, toolCall) => {
    const action = decide(c, permission, pattern);
    if (action === 'allow') return { ok: true, asked: false };
    if (action === 'deny') return { ok: false, denied: true, asked: false };
    return { ...(await ask(permission, [pattern], toolCall)), asked: true };
  };

  /** A refused call's end, as OpenCode says it; without `continue_loop_on_deny` the turn ends there. */
  const refuse = (id, p) => {
    const text = p.denied ? DENIED : p.feedback ? `${REJECTED.slice(0, -1)} with the following feedback: ${p.feedback}` : REJECTED;
    u.update({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'failed', content: [{ type: 'content', content: { type: 'text', text } }], rawOutput: { error: text } });
    if (!p.denied && !continueOnDeny) stoppedOnDeny = true;
  };

  for (const step of steps) {
    if (s.cancelled) return cancelled;
    if (step.type === 'think') await u.thought(step.text);
    if (step.type === 'todo') {
      const id = next('call');
      const todos = step.entries.map((e) => ({ content: e.text, status: e.status, priority: 'medium' }));
      u.toolCall({ toolCallId: id, title: 'todowrite', kind: 'other', status: 'pending', locations: [], rawInput: {} });
      u.update({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'in_progress', kind: 'other', title: 'todowrite', locations: [], rawInput: { todos } });
      const ok = await permit('todowrite', '*', { toolCallId: id, title: 'todowrite', kind: 'other', status: 'pending', locations: [], rawInput: {} });
      if (s.cancelled) return cancelled;
      if (!ok.ok) refuse(id, ok);
      else u.update({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed', title: `${todos.length} todos`, content: [{ type: 'content', content: { type: 'text', text: JSON.stringify(todos, null, 2) } }] });
    }
    if (step.type === 'tool') {
      const id = next('call');
      u.toolCall({ toolCallId: id, title: 'glob', kind: 'search', status: 'pending', locations: [], rawInput: {} });
      u.update({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'in_progress', kind: 'search', title: '*', locations: [], rawInput: { pattern: '*', path: s.cwd } });
      const ok = await permit('glob', '*', { toolCallId: id, title: '*', kind: 'search', status: 'pending', locations: [{ path: s.cwd }], rawInput: { pattern: '*', path: s.cwd } });
      if (s.cancelled) return cancelled;
      if (!ok.ok) refuse(id, ok);
      else u.update({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed', title: s.cwd, content: [{ type: 'content', content: { type: 'text', text: safeList(s.cwd) } }] });
    }
    if (step.type === 'approve') {
      const id = next('call');
      const command = step.command;
      u.toolCall({ toolCallId: id, title: 'bash', kind: 'execute', status: 'pending', locations: [{ path: s.cwd }], rawInput: { cwd: s.cwd } });
      u.update({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'in_progress', kind: 'execute', title: command, locations: [{ path: s.cwd }], rawInput: { command, cwd: s.cwd } });
      const ok = await permit('bash', command, { toolCallId: id, title: command, kind: 'execute', status: 'pending', locations: [], rawInput: { command } });
      if (s.cancelled) return cancelled;
      if (!ok.ok) {
        refuse(id, ok);
        prefix += declined('command', noteIn(ok.feedback));
      } else {
        const r = runCommand(c.shell, command, s.cwd);
        const output = r.stdout + r.stderr;
        u.update({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'in_progress', kind: 'execute', title: command, locations: [{ path: s.cwd }], rawInput: { command, cwd: s.cwd }, content: [{ type: 'content', content: { type: 'text', text: output } }] });
        // Done whatever its exit code, as OpenCode says it.
        u.update({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed', title: command, content: [{ type: 'content', content: { type: 'text', text: output } }], rawOutput: { output, metadata: { output, exit: r.code, truncated: false } } });
        prefix += r.code === 0 ? `The command ran: ${r.stdout.trim()}. ` : `The command failed (exit ${r.code}): ${(r.stderr || r.stdout).trim()}. `;
      }
    }
    if (step.type === 'write') {
      const file = targetOf(step, s.cwd, others);
      if (!file) {
        prefix += noOther(step);
        continue;
      }
      const id = next('call');
      u.toolCall({ toolCallId: id, title: 'write', kind: 'edit', status: 'pending', locations: [], rawInput: {} });
      u.update({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'in_progress', kind: 'edit', title: 'write', locations: [{ path: file }], rawInput: { filePath: file, content: step.content } });
      // A folder outside the project asks first, for that folder.
      let ok = { ok: true, asked: false };
      if (external(file, s.cwd)) {
        const parentDir = path.dirname(file);
        ok = await permit('external_directory', path.join(parentDir, '*'), { toolCallId: id, kind: 'other', title: parentDir, status: 'pending', rawInput: { filepath: file, parentDir } });
        if (s.cancelled) return cancelled;
      }
      if (ok.ok) {
        const exists = fs.existsSync(file);
        const diff = `Index: ${file}\n===================================================================\n--- ${file}\n+++ ${file}\n@@ -0,0 +1,1 @@\n+${step.content.replace(/\n$/, '')}\n`;
        ok = await permit('edit', path.relative(gitRoot(s.cwd) || s.cwd, file), {
          toolCallId: id,
          title: file,
          kind: 'edit',
          status: 'pending',
          locations: [{ path: file }],
          rawInput: { filepath: file, diff },
          content: [{ type: 'diff', path: file, oldText: exists ? fs.readFileSync(file, 'utf8') : '', newText: step.content }],
        });
        if (s.cancelled) return cancelled;
        if (ok.ok) {
          // After an edit it asked about and was allowed, OpenCode tells the client too (answered, never done there).
          if (ok.asked) await peer.request('fs/write_text_file', { sessionId, path: file, content: step.content }).catch(() => undefined);
          const written = tryWrite(file, step.content);
          if (written) {
            const out = 'Wrote file successfully.';
            u.update({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed', title: path.basename(file), content: [{ type: 'content', content: { type: 'text', text: out } }], rawOutput: { output: out, metadata: { diagnostics: {}, filepath: file, exists, truncated: false } } });
          } else {
            // How OpenCode (Bun's file system) says a write the sandbox refused.
            const text = `Unknown: FileSystem.writeFile (${file})`;
            u.update({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'failed', content: [{ type: 'content', content: { type: 'text', text } }], rawOutput: { error: text } });
          }
          prefix += wrote(step, written, '');
          continue;
        }
      }
      refuse(id, ok);
      prefix += wrote(step, false, noteIn(ok.feedback));
    }
    // Without `continue_loop_on_deny`, a refusal ends its turn at once, with nothing more said.
    if (stoppedOnDeny) break;
    if (step.type === 'text') {
      if (!(await u.message(prefix + step.text, step.slow))) return cancelled;
      s.turns.push({ user: lastUserMessage(prompt) || '', reply: prefix + step.text });
    }
  }
  if (s.cancelled) return cancelled;
  // Its cost is the session's total so far.
  s.costTotal = Math.round((s.costTotal + 0.0012) * 1e6) / 1e6;
  saveSession(sessionId, s);
  u.update({ sessionUpdate: 'usage_update', used: 9100, size: 262144, cost: { amount: s.costTotal, currency: 'USD' } });
  server.emit('session.status', { sessionID: sessionId, status: { type: 'idle' } });
  await sleep(5);
  return { stopReason: 'end_turn', usage: { inputTokens: 120, outputTokens: 30, totalTokens: 9100 }, _meta: {} };
}

module.exports = {
  provider: 'opencode',
  bin: 'opencode',
  aliases: [],
  label: 'OpenCode',
  name: 'OpenCode',
  version: VERSION,
  versionRe: /^1\.19\.999$/m,
  /**
   * Its state, which a run may write (one of its adapter's `statePaths`): `XDG_DATA_HOME` (`<state>/data`).
   */
  home: (e) => e.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'),
  /** Its run's key (its provider's variable, or the endpoint's), by `keyVerdict`; null for none. */
  apiKey(e) {
    const provider = runProvider(e);
    const name = provider ? KEY_ENV[provider] || (provider.startsWith('relay-') ? ENDPOINT_KEY_ENV : undefined) : undefined;
    return name && e[name] ? keyVerdict(e[name]) : null;
  },
  main() {
    if (args[0] !== 'acp') return staticCommand();
    const port = Number(args[args.indexOf('--port') + 1] || 0);
    // Its server first, as `opencode acp` serves before it answers `initialize`.
    startServer(port, (server) => opencodeAgent(server));
  },
};
