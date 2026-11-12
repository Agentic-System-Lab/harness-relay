'use strict';
/*
 * The fake Cline (`cline`, an open agent): `cline --acp` (ACP: sessions, `session/update`,
 * `session/request_permission`), `--version`, and `[--cwd <dir>] config <kind> --json` (what it
 * loads by itself, for Settings and the lead agent). Anything else exits with an error at once.
 *
 * As Harness Relay drives the real one (3.0.74, src/server/agents/cline.ts), everything a run gets
 * comes from its environment and the files written before it starts:
 * - the provider (CLINE_PROVIDER), the model (CLINE_MODEL, taken only when its catalog for that
 *   provider has it, else the provider's default: the run's model then comes with
 *   `session/set_config_option`), the key (CLINE_API_KEY: without one no session starts), an
 *   endpoint's base URL (its provider settings file), the effort (`--thinking`);
 * - the briefing: the rules in CLINE_DIR/rules, read at every start (so a resumed session gets the
 *   current one); the MCP servers: its MCP settings file (ACP's `mcpServers` are ignored); skills off:
 *   `disabledTools` in its global settings;
 * - it asks about every tool call, reads too, unless `--auto-approve true` (full access). A refusal
 *   reaches its model only as its own fixed words (the user's note never does), and a stop while it
 *   asks ends the turn only once that request is answered. Its updates of a call it asks about come as
 *   `tool_call_update` first, its output always in `rawOutput`; OpenAI's models write with
 *   `apply_patch`, the others with `editor`. It has no to-do list over ACP (`e2e:todo` does nothing);
 * - it keeps its sessions in CLINE_DATA_DIR (`sessions/<id>/<id>.json`), with the session's usage so
 *   far, written before a prompt is answered (Harness Relay reads the turn's usage there, not in ACP);
 * - the images of a prompt are ignored: its model gets only their paths, in the prompt's text.
 * Whether a write happens is up to Harness Relay's own sandbox below full access (there is none in
 * Cline): the fake writes, and a write the sandbox refuses fails as its editor fails.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { acpAgent, picked, requestPermission, sessionUpdates } = require('../lib/acp.cjs');
const { ownSkills, safeList, targetOf } = require('../lib/files.cjs');
const { keyVerdict } = require('../lib/home.cjs');
const { exitAfterLog, flushLog, record, refused } = require('../lib/log.cjs');
const { declined, noOther, plan, recordMcpEnv, wrote } = require('../lib/plan.cjs');
const { fail, rpcError } = require('../lib/rpc.cjs');
const { args, flag, has, home, sleep } = require('../lib/self.cjs');

/** Its catalog per provider: the models a session lists, and the one it takes when CLINE_MODEL is none of them. */
const CATALOG = {
  'openai-native': { models: [['gpt-5.4', 'GPT-5.4'], ['gpt-5.4-mini', 'GPT-5.4 mini'], ['gpt-5.4-nano', 'GPT-5.4 nano']], default: 'gpt-5.4' },
  anthropic: { models: [['claude-haiku-5-5', 'Claude Haiku 5.5'], ['claude-sonnet-5-5', 'Claude Sonnet 5.5']], default: 'claude-haiku-5-5' },
  xai: { models: [['grok-4.3', 'Grok 4.3'], ['grok-4.20-0309-non-reasoning', 'Grok 4.20 (non-reasoning)']], default: 'grok-4.20-0309-non-reasoning' },
  // An OpenAI-compatible endpoint: one model, whatever CLINE_MODEL says.
  'openai-compatible': { models: [['gpt-4o', 'gpt-4o']], default: 'gpt-4o' },
};
const catalogOf = (provider) => CATALOG[provider] || CATALOG['openai-native'];

const MODES = [
  { id: 'plan', name: 'Plan', description: 'Explore the codebase and plan changes without modifying files' },
  { id: 'act', name: 'Act', description: 'Make changes to the codebase' },
];

/** The options it offers when it asks (it takes "always" as once). */
const OPTIONS = [
  { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'allow_always', name: 'Allow always', kind: 'allow_always' },
  { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
];

/** What its model reads of a call that was refused, or whose request was cancelled (a stop). */
const REJECTED = 'User rejected the tool call -- NOT a tool or system failure. Clarify with user before proceeding.';
const CANCELLED = 'Permission request was cancelled -- NOT a tool or system failure. Clarify with user before proceeding.';

const env = process.env;
const dataDir = () => env.CLINE_DATA_DIR || home();
const recordFile = (id) => path.join(dataDir(), 'sessions', id, `${id}.json`);
const messagesFile = (id) => path.join(dataDir(), 'sessions', id, `${id}.messages.json`);

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

/** The briefing: the rules files of its CLINE_DIR (Harness Relay's, `# Harness Relay` and the briefing), read at every start. */
function readBriefing() {
  const dir = path.join(env.CLINE_DIR || path.join(os.homedir(), '.cline'), 'rules');
  return listDir(dir)
    .filter((n) => n.endsWith('.md'))
    .map((n) => fs.readFileSync(path.join(dir, n), 'utf8').replace(/^# Harness Relay\n\n/, '').trim())
    .filter(Boolean)
    .join('\n\n');
}

/** Its MCP servers, from its MCP settings file only: their names, recorded with their values (env, or headers and URL). */
function readMcp() {
  const servers = (readJson(env.CLINE_MCP_SETTINGS_PATH || '', {}) || {}).mcpServers || {};
  const values = {};
  const http = {};
  for (const [name, s] of Object.entries(servers)) {
    const remote = s && (s.type === 'streamableHttp' || s.type === 'sse' || typeof s.url === 'string');
    values[name] = { ...((remote ? s.headers : s.env) || {}) };
    if (remote) http[name] = s.url;
  }
  recordMcpEnv(values, http);
  return Object.keys(servers);
}

/** Its global settings (`disabledTools`, `disabledPlugins`). */
const globalSettings = () => readJson(env.CLINE_GLOBAL_SETTINGS_PATH || '', {}) || {};

/** An endpoint's base URL, from its provider settings file (never a key there). */
function providerSettings(provider) {
  const all = readJson(env.CLINE_PROVIDER_SETTINGS_PATH || '', {}) || {};
  return ((all.providers || {})[provider] || {}).settings || {};
}

/** The skills folders it reads by itself: the project's, and the user's own. */
function skillDirs(cwd) {
  const user = os.homedir();
  return [
    path.join(cwd, '.clinerules', 'skills'),
    path.join(cwd, '.cline', 'skills'),
    path.join(cwd, '.claude', 'skills'),
    path.join(cwd, '.agents', 'skills'),
    path.join(user, '.agents', 'skills'),
  ];
}

/** The skills it loads by itself for a session: none with skills off (`disabledTools: ["skills"]`). */
function loadedSkills(cwd) {
  if ((globalSettings().disabledTools || []).includes('skills')) return [];
  return skillDirs(cwd).flatMap((d) => ownSkills(d).map((s) => s.name));
}

// --- What it loads by itself (`cline --cwd <dir> config <kind> --json`) -----------------------------

function rulesIn(cwd) {
  const user = os.homedir();
  const out = [];
  const rule = (name, file) => out.push({ name, instructions: fs.readFileSync(file, 'utf8').trim(), path: file });
  const folder = (dir) => listDir(dir).filter((n) => /\.(md|txt)$/i.test(n) && isFile(path.join(dir, n))).forEach((n) => rule(n.replace(/\.(md|txt)$/i, ''), path.join(dir, n)));
  const clinerules = path.join(cwd, '.clinerules');
  if (isFile(clinerules)) rule('.clinerules', clinerules);
  else folder(clinerules);
  folder(path.join(cwd, '.cline', 'rules'));
  if (isFile(path.join(cwd, 'AGENTS.md'))) rule('Workspace AGENTS.md', path.join(cwd, 'AGENTS.md'));
  if (isFile(path.join(user, '.agents', 'AGENTS.md'))) rule('Global AGENTS.md', path.join(user, '.agents', 'AGENTS.md'));
  folder(path.join(user, 'Documents', 'Cline', 'Rules'));
  folder(path.join(user, 'Cline', 'Rules'));
  return out;
}

const HOOK_EVENTS = { PreToolUse: 'tool_call', PostToolUse: 'tool_result', TaskStart: 'agent_start', TaskComplete: 'agent_end', UserPromptSubmit: 'prompt_submit' };

function configOf(kind, cwd) {
  const user = os.homedir();
  const files = (dirs, re) => dirs.flatMap((d) => listDir(d).filter((n) => re.test(n) && isFile(path.join(d, n))).map((n) => ({ n, file: path.join(d, n) })));
  switch (kind) {
    case 'rules':
      return rulesIn(cwd);
    case 'skills':
      return skillDirs(cwd).flatMap((d) =>
        ownSkills(d).map((s) => {
          const body = fs.readFileSync(s.path, 'utf8').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim();
          return { name: s.name, description: s.description, instructions: body, frontmatter: { name: s.name, description: s.description }, path: s.path };
        }),
      );
    case 'hooks':
      return files([path.join(cwd, '.clinerules', 'hooks'), path.join(cwd, '.cline', 'hooks'), path.join(user, 'Documents', 'Cline', 'Hooks')], /^[^.]/).map(({ n, file }) => {
        const fileName = n.replace(/\.[^.]+$/, '');
        return { fileName, hookEventName: HOOK_EVENTS[fileName] || fileName.toLowerCase(), path: file };
      });
    case 'agents':
      return [];
    case 'plugins':
      return files([path.join(cwd, '.cline', 'plugins'), path.join(user, 'Documents', 'Cline', 'Plugins'), path.join(user, '.agents', 'plugins')], /\.(js|mjs|cjs|ts)$/).map(({ n, file }) => ({
        name: n.replace(/\.[^.]+$/, ''),
        path: file,
      }));
    default:
      return undefined;
  }
}

function clineStatic() {
  if (has('--version')) return void process.stdout.write(`${module.exports.version}\n`);
  const at = args.indexOf('config');
  if (at >= 0 && has('--json')) {
    const kind = args[at + 1];
    const list = configOf(kind, path.resolve(flag('--cwd') || process.cwd()));
    if (list) return void process.stdout.write(JSON.stringify(list) + '\n');
    process.stderr.write(`error: unknown config kind '${kind}'\n`, () => exitAfterLog(1));
    return;
  }
  process.stderr.write(`fake cline: unknown command ${args.join(' ')}\n`, () => exitAfterLog(1));
}

// --- Its ACP agent --------------------------------------------------------------------------------

const sessionId = () => `${Date.now()}_${crypto.randomBytes(4).toString('base64url').slice(0, 5)}_cli`;

/** A session's state as `session/new` and `session/load` answer it: its modes, models and options. */
function stateOf(s) {
  const models = catalogOf(s.provider).models.map(([modelId, name]) => ({ modelId, name }));
  return {
    modes: { availableModes: MODES, currentModeId: s.mode },
    models: { availableModels: models, currentModelId: s.model },
    configOptions: [
      {
        type: 'select',
        id: 'provider',
        name: 'Provider',
        description: 'The authentication provider to use',
        category: '_provider',
        currentValue: s.provider,
        options: [
          { value: 'cline', name: 'Cline Usage-Billing' },
          { value: 'cline-pass', name: 'ClinePass' },
          { value: 'openai-codex', name: 'OpenAI ChatGPT Subscription' },
        ],
      },
      { type: 'select', id: 'model', name: 'Model', category: 'model', currentValue: s.model, options: models.map((m) => ({ value: m.modelId, name: m.name })) },
      {
        type: 'select',
        id: 'mode',
        name: 'Session Mode',
        description: 'Controls whether the agent can modify files',
        category: 'mode',
        currentValue: s.mode,
        options: MODES.map((m) => ({ value: m.id, name: m.name, description: m.description })),
      },
      {
        type: 'boolean',
        id: 'auto_approve',
        name: 'Auto-approve tools',
        description: 'Automatically approve all tool calls without asking for permission',
        currentValue: s.autoApprove,
      },
    ],
  };
}

/** A session started or loaded, as this start of Cline sets it up: provider, model, approvals, MCP servers. */
function openSession(method, p, open) {
  if (!env.CLINE_API_KEY) throw rpcError('Authentication required: Call authenticate before starting a session', -32000);
  const catalog = env.CLINE_API_KEY === 'catalog';
  let id;
  if (method === 'session/load') {
    id = String(p.sessionId || '');
    if (!id || !isFile(recordFile(id))) throw rpcError(`Resource not found: ${id}`, -32002, { uri: id });
  } else {
    id = sessionId();
  }
  const provider = env.CLINE_PROVIDER || 'openai-native';
  const cat = catalogOf(provider);
  const s = {
    cwd: p.cwd || process.cwd(),
    provider,
    // CLINE_MODEL only when its catalog has it: otherwise the provider's default, silently.
    model: cat.models.some(([m]) => m === env.CLINE_MODEL) ? env.CLINE_MODEL : cat.default,
    mode: 'act',
    autoApprove: flag('--auto-approve') === 'true',
    cancelled: false,
    mcp: catalog ? [] : readMcp(),
  };
  open.set(id, s);
  // The catalog's question (a placeholder key, nothing else asked) leaves no session behind.
  if (!catalog) {
    if (method === 'session/new') {
      fs.mkdirSync(path.dirname(recordFile(id)), { recursive: true });
      fs.writeFileSync(recordFile(id), JSON.stringify({ session_id: id, metadata: { aggregateUsage: { inputTokens: 0, outputTokens: 0, totalCost: 0 } } }));
      fs.writeFileSync(messagesFile(id), '[]');
    }
    record({ session: id, resumed: method === 'session/load' });
  }
  return { ...(method === 'session/new' ? { sessionId: id } : {}), ...stateOf(s) };
}

/** The history of a loaded session, as it replays it before answering `session/load`. */
function replay(peer, id) {
  for (const m of readJson(messagesFile(id), [])) {
    peer.notify('session/update', { sessionId: id, update: { sessionUpdate: m.role === 'user' ? 'user_message_chunk' : 'agent_message_chunk', content: { type: 'text', text: m.text } } });
  }
}

/** The session's usage so far, with this turn's added, and its messages: written before the prompt is answered. */
function saveTurn(id, s, prompt, reply) {
  const rec = readJson(recordFile(id), { session_id: id, metadata: {} });
  const u = (rec.metadata && rec.metadata.aggregateUsage) || { inputTokens: 0, outputTokens: 0, totalCost: 0 };
  // An endpoint's model has no price: Cline counts it as 0.
  const cost = s.provider === 'openai-compatible' ? 0 : 0.0012;
  rec.metadata = { ...rec.metadata, aggregateUsage: { inputTokens: u.inputTokens + 120, outputTokens: u.outputTokens + 30, totalCost: Math.round((u.totalCost + cost) * 1e6) / 1e6 } };
  fs.writeFileSync(recordFile(id), JSON.stringify(rec));
  const messages = readJson(messagesFile(id), []);
  messages.push({ role: 'user', text: prompt }, ...(reply ? [{ role: 'assistant', text: reply }] : []));
  fs.writeFileSync(messagesFile(id), JSON.stringify(messages));
}

/** The names of the model backends' keys its environment holds (Harness Relay gives it its key as CLINE_API_KEY only). */
const backendKeys = () => ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'XAI_API_KEY'].filter((k) => env[k]);

function sameFolder(a, b) {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return false;
  }
}

function clineAgent() {
  acpAgent({
    initialize: () => {
      process.stderr.write('[acp] starting ACP mode over stdio…\n');
      return {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, promptCapabilities: { image: true, audio: false, embeddedContext: false } },
        agentInfo: { name: 'cline', version: module.exports.version },
        authMethods: [
          { id: 'cline', name: 'Sign in with Cline' },
          { id: 'cline-pass', name: 'Sign in with ClinePass' },
          { id: 'openai-codex', name: 'Sign in with ChatGPT Subscription' },
        ],
      };
    },
    'session/new': (p, { sessions: open }) => openSession('session/new', p, open),
    'session/load': (p, { peer, sessions: open }) => {
      const state = openSession('session/load', p, open);
      replay(peer, p.sessionId);
      return state;
    },
    'session/set_config_option': (p, { peer, sessions: open }) => {
      const s = open.get(p.sessionId);
      if (!s) throw rpcError(`Session not found: ${p.sessionId}`, -32002);
      // Any model is taken (a prompt to one its provider lacks fails then).
      if (p.configId === 'model') s.model = String(p.value);
      else if (p.configId === 'mode') s.mode = String(p.value);
      else if (p.configId === 'auto_approve') s.autoApprove = p.value === true || p.value === 'true';
      else throw rpcError(`Unknown config option: ${p.configId}`, -32602);
      const { configOptions } = stateOf(s);
      peer.notify('session/update', { sessionId: p.sessionId, update: { sessionUpdate: 'config_option_update', configOptions } });
      return { configOptions };
    },
    'session/set_mode': (p, { sessions: open }) => {
      const s = open.get(p.sessionId);
      if (!s) throw rpcError(`Session not found: ${p.sessionId}`, -32002);
      s.mode = String(p.modeId);
      return {};
    },
    'session/prompt': async (p, { peer, sessions: open }) => {
      const id = p.sessionId;
      const s = open.get(id);
      if (!s) throw rpcError(`Session not found: ${id}`, -32002);
      const blocks = p.prompt || [];
      const prompt = blocks.filter((b) => b.type === 'text').map((b) => b.text || '').join('\n');
      const images = blocks.filter((b) => b.type === 'image' && b.data).length;
      const briefing = readBriefing();
      record({
        prompt,
        briefing,
        // The image blocks it got (its model never sees them).
        images,
        mcp: s.mcp,
        model: s.model,
        effort: flag('--thinking') || null,
        skills: loadedSkills(s.cwd),
        provider: s.provider,
        baseUrl: providerSettings(s.provider).baseUrl || null,
        autoApprove: s.autoApprove,
        backendKeys: backendKeys(),
        // It starts in the run's temp folder, never the project (Bun reads the `.env` of where it starts).
        startedInTmp: sameFolder(process.cwd(), env.TMPDIR || os.tmpdir()),
      });
      s.cancelled = false;
      const steps = plan(prompt, { cwd: s.cwd, images: 0, mcp: s.mcp, briefing });
      if (steps[0] && steps[0].type === 'error') {
        const text = steps[0].text;
        process.stderr.write(`Error handling request ${JSON.stringify({ method: 'session/prompt', sessionId: id })}: ${text}\n`);
        await flushLog();
        throw rpcError(`Internal error: ${text}`, -32603, { message: text });
      }
      const { result, reply } = await clineTurn(peer, id, s, steps, briefing);
      peer.notify('session/update', { sessionId: id, update: { sessionUpdate: 'session_info_update', updatedAt: new Date().toISOString() } });
      saveTurn(id, s, prompt, reply);
      await flushLog();
      return result;
    },
  });
}

/** A path shortened as its titles show their input (its JSON, cut). */
const cut = (text, n = 60) => (text.length > n ? `${text.slice(0, n)}...` : text);

/** The working directories besides `cwd` that a briefing names: how it learns them (it has no folder list of its own). */
function briefedOthers(briefing, cwd) {
  const shared = /share these working directories, each with the same access: (.+?)\. You start in /.exec(briefing);
  const dirs = shared ? shared[1].split(', ') : [...briefing.matchAll(/^ {2}- (.+?) \(branch /gm)].map((m) => m[1]);
  return dirs.filter((d) => path.resolve(d) !== path.resolve(cwd));
}

/** Writes a file as its editor does: `{ ok }`, or why not where it may not write (the sandbox's refusal). */
function writeAt(file, content) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return { ok: true };
  } catch (err) {
    if (refused(err)) return { ok: false, error: err.message };
    throw err;
  }
}

/** One turn: the steps of the reply in Cline's updates; its result and what it said. */
async function clineTurn(peer, sessionId, s, steps, briefing) {
  const u = sessionUpdates(peer, sessionId, () => s.cancelled);
  let n = 0;
  let prefix = '';
  let said = '';
  const cancelled = () => ({ result: { stopReason: 'cancelled' }, reply: said });

  /**
   * A tool call, asked about first unless it approves everything: `run()` does it once allowed and
   * gives its `rawOutput`. `{ ran, raw, cancelled }`.
   */
  const call = async (kind, rawInput, title, run) => {
    const toolCallId = `call_${process.pid}_${++n}`;
    const shown = { toolCallId, title, kind, status: 'pending', rawInput };
    if (!s.autoApprove) {
      u.update({ sessionUpdate: 'tool_call_update', ...shown });
      const answer = await requestPermission(peer, sessionId, shown, OPTIONS);
      if (!picked(answer, 'allow_once') && !picked(answer, 'allow_always')) {
        const stopped = !answer || !answer.outcome || answer.outcome.outcome === 'cancelled';
        u.update({ sessionUpdate: 'tool_call_update', toolCallId, status: 'failed' });
        u.update({ sessionUpdate: 'tool_call', ...shown });
        u.update({ sessionUpdate: 'tool_call_update', toolCallId, status: 'failed', rawOutput: JSON.stringify({ error: stopped ? CANCELLED : REJECTED }) });
        return { ran: false, cancelled: stopped };
      }
      u.update({ sessionUpdate: 'tool_call_update', toolCallId, status: 'in_progress' });
    }
    u.update({ sessionUpdate: 'tool_call', ...shown });
    const out = await run();
    await sleep(10);
    // A failed command or edit is `completed` too, its result saying `success: false`.
    u.update({ sessionUpdate: 'tool_call_update', toolCallId, status: 'completed', rawOutput: out.raw });
    return { ran: true, ...out };
  };

  for (const step of steps) {
    if (s.cancelled) return cancelled();
    if (step.type === 'fail') return fail(step.text);
    if (step.type === 'think') await u.thought(step.text);
    // `todo`: no to-do list over ACP.
    if (step.type === 'tool') {
      const input = { files: [{ path: s.cwd }] };
      const r = await call('read', input, `read_files: ${cut(JSON.stringify(input), 37)}`, async () => ({
        raw: [{ query: s.cwd, result: safeList(s.cwd), success: true }],
      }));
      if (r.cancelled) return cancelled();
    }
    if (step.type === 'approve') {
      const r = await call('execute', { commands: [step.command] }, `run_commands: ${step.command}`, async () => ({
        raw: [{ query: step.command, result: 'e2e-approval\n', success: true }],
      }));
      if (r.cancelled) return cancelled();
      prefix += r.ran ? 'The command ran: e2e-approval. ' : declined('command', '');
    }
    if (step.type === 'write') {
      const file = targetOf(step, s.cwd, briefedOthers(briefing, s.cwd));
      if (!file) {
        prefix += noOther(step);
        continue;
      }
      const existed = fs.existsSync(file);
      const line = step.content.replace(/\n$/, '');
      // OpenAI's models write with apply_patch, the others with its editor.
      const patch = s.provider === 'openai-native';
      const input = patch ? { input: `*** Begin Patch\n*** Add File: ${file}\n+${line}\n*** End Patch` } : { path: file, new_text: step.content };
      const tool = patch ? 'apply_patch' : 'editor';
      const r = await call(patch ? 'other' : 'edit', input, `${tool}: ${cut(JSON.stringify(input), 37)}`, async () => {
        const w = writeAt(file, step.content);
        const query = patch ? 'apply_patch' : `edit:${file}`;
        if (!w.ok) return { written: false, raw: { query, result: '', error: `Editor operation failed: ${w.error}`, success: false } };
        const result = patch
          ? `Successfully applied patch to the following files:\n${file}`
          : existed
            ? `Edited ${file}\n\`\`\`diff\n+1: ${line}\n\`\`\``
            : `File created successfully at: ${file}`;
        return { written: true, raw: { query, result, success: true } };
      });
      if (r.cancelled) return cancelled();
      prefix += wrote(step, Boolean(r.ran && r.written), '');
    }
    if (step.type === 'text') {
      const text = prefix + step.text;
      if (!(await u.message(text, step.slow))) return cancelled();
      said = text;
    }
  }
  return { result: { stopReason: s.cancelled ? 'cancelled' : 'end_turn' }, reply: said };
}

module.exports = {
  provider: 'cline',
  bin: 'cline',
  aliases: [],
  label: 'Cline',
  name: 'Cline',
  version: '3.99.999',
  versionRe: /^3\.99\.999$/m,
  /**
   * Its state, which a run may write (its adapter's `statePaths`): `CLINE_DATA_DIR` (`<state>/data`),
   * where it keeps its sessions (`sessions/<id>/`) and the fake its marks.
   */
  home: (env) => env.CLINE_DATA_DIR || path.join(os.homedir(), '.cline', 'data'),
  /** The key it was given for its provider (CLINE_API_KEY), by `keyVerdict`; null for none or a placeholder (`none`, the catalog's). */
  apiKey: (env) => {
    const key = env.CLINE_API_KEY;
    return !key || key === 'none' || key === 'catalog' ? null : keyVerdict(key);
  },
  main() {
    if (has('--acp')) clineAgent();
    else clineStatic();
  },
};
