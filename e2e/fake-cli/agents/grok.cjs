'use strict';
/*
 * The fake Grok (`grok`): `grok agent --no-leader stdio` (ACP: sessions, `session/update`,
 * `session/request_permission`, `_x.ai/billing`), `--version`, `models`, `inspect --json`, `logout`.
 *
 * Whether a write happens is decided only by what Harness Relay gave it, as with the real one: yolo
 * mode, the answers to `session/request_permission`, and the folders of the sandbox profile
 * GROK_SANDBOX names in its sandbox.toml (`read_write`); without a sandbox (yolo mode, and on
 * Windows, where Grok has none) the other working directories its briefing names. The skills it
 * loads by itself are the project's .claude/skills/, only in a folder it trusts
 * (GROK_CLAUDE_SKILLS_ENABLED).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { acpAgent, followup, picked, requestPermission, sessionUpdates } = require('../lib/acp.cjs');
const { inside, ownSkills, realLocation, targetOf, writeFile } = require('../lib/files.cjs');
const { keyVerdict, planResets, planUsedPercent, sessions, signIn, signedOut } = require('../lib/home.cjs');
const { record } = require('../lib/log.cjs');
const { declined, noOther, noteIn, plan, recordMcpEnv, wrote } = require('../lib/plan.cjs');
const { fail, rpcError } = require('../lib/rpc.cjs');
const { args, has, home, newId, sleep } = require('../lib/self.cjs');

function grokTrusted(folder) {
  try {
    const store = fs.readFileSync(path.join(home(), 'trusted_folders.toml'), 'utf8');
    return store.includes(JSON.stringify(folder).slice(1, -1)) && /trusted = true/.test(store);
  } catch {
    return false;
  }
}

/** The project root Grok keys trust on: the repository's root, else the folder itself. */
function projectRoot(dir) {
  let at = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(at, '.git'))) return fs.realpathSync(at);
    const up = path.dirname(at);
    if (up === at) return fs.realpathSync(dir);
    at = up;
  }
}

/**
 * The skills Grok takes from Claude Code, the project's .claude/skills: only in a folder it trusts
 * (an untrusted project's own setup is left out), and none with GROK_CLAUDE_SKILLS_ENABLED=false.
 */
function grokSkills(cwd) {
  if (process.env.GROK_CLAUDE_SKILLS_ENABLED === 'false') return [];
  const root = projectRoot(cwd);
  return grokTrusted(root) ? ownSkills(path.join(root, '.claude', 'skills')) : [];
}

/**
 * Where Grok's sandbox lets it write: the working directory and the `read_write` folders of the
 * profile GROK_SANDBOX names in its sandbox.toml; anywhere in yolo mode or without a sandbox
 * (`workspace`, on Windows, where Grok has none).
 */
function grokWrites(cwd, yolo) {
  const profile = process.env.GROK_SANDBOX;
  if (yolo || !profile || profile === 'workspace') return { dirs: null, others: [] };
  let readWrite = [];
  try {
    const lines = fs.readFileSync(path.join(home(), 'sandbox.toml'), 'utf8').split('\n');
    const start = lines.findIndex((l) => l.trim() === `[profiles.${profile}]`);
    for (let i = start + 1; start >= 0 && i < lines.length && !lines[i].trim().startsWith('['); i++) {
      const m = /^\s*read_write\s*=\s*(\[.*\])\s*$/.exec(lines[i]);
      if (m) readWrite = JSON.parse(m[1]);
    }
  } catch {
    /* no profile: the working directory only */
  }
  // The profile names each folder also by its real path: one of each.
  const others = [...new Map(readWrite.map((d) => [realLocation(d), d])).values()];
  return { dirs: [cwd, ...readWrite], others };
}

/**
 * The working directories besides `cwd` that a briefing names (Harness Relay's `use full paths for
 * the others`; in parallel mode, a worktree of each): how Grok learns them without a sandbox.
 */
function briefedOthers(briefing, cwd) {
  const shared = /share these working directories, each with the same access: (.+?)\. You start in /.exec(briefing);
  const dirs = shared ? shared[1].split(', ') : [...briefing.matchAll(/^ {2}- (.+?) \(branch /gm)].map((m) => m[1]);
  return dirs.filter((d) => path.resolve(d) !== path.resolve(cwd));
}

function grokStatic() {
  if (has('--version')) return void process.stdout.write(`${module.exports.version}\n`);
  if (args[0] === 'models') {
    if (signedOut()) {
      process.stderr.write('Error: not authenticated. Run grok login.\n');
      process.exitCode = 1;
      return;
    }
    return void process.stdout.write('Default model: grok-fake\n\nModels:\n* grok-fake\n- grok-fake-mini\n');
  }
  if (args[0] === 'inspect') {
    const cwd = process.cwd();
    const root = projectRoot(cwd);
    const skills = grokSkills(cwd).map((s) => ({ name: s.name, description: s.description, source: { type: 'claude', path: s.path } }));
    return void process.stdout.write(
      JSON.stringify({ cwd: fs.realpathSync(cwd), projectRoot: root, projectTrusted: grokTrusted(root), skills, mcpServers: [], projectInstructions: [], hooks: [] }) + '\n',
    );
  }
  if (args[0] === 'logout') {
    signIn.logout();
    return void process.stdout.write('Logged out.\n');
  }
  process.stderr.write(`fake grok: unknown command ${args.join(' ')}\n`);
  process.exitCode = 1;
}

/** A session started or resumed: Grok's own sandbox and briefing for it, on Grok's defaults. */
function openSession(method, p, open) {
  if (signedOut()) throw rpcError('Authentication required: not authenticated. Run grok login.');
  const id = method === 'session/resume' ? p.sessionId : newId('grok-session');
  if (method === 'session/resume' && !sessions.resume(id)) throw rpcError(`Session not found: ${id}`);
  if (method === 'session/new') sessions.start(id);
  const meta = p._meta || {};
  const cwd = p.cwd || process.cwd();
  const writes = grokWrites(cwd, Boolean(meta.yoloMode));
  // No sandbox: nothing but the briefing names the other folders.
  if (!writes.dirs) writes.others = briefedOthers(meta.rules || '', cwd);
  open.set(id, { cwd, briefing: meta.rules || '', yolo: Boolean(meta.yoloMode), cancelled: false, mcp: (p.mcpServers || []).map((s) => s.name), ...writes });
  recordMcpEnv(
    Object.fromEntries((p.mcpServers || []).map((s) => [s.name, Object.fromEntries((s.env || s.headers || []).map((v) => [v.name, v.value]))])),
    Object.fromEntries((p.mcpServers || []).filter((s) => s.type === 'http').map((s) => [s.name, s.url])),
  );
  // A new session starts on Grok's defaults (a resumed one too: the options are per process).
  Object.assign(open.get(id), { model: 'grok-fake', effort: 'medium' });
  return {
    ...(method === 'session/new' ? { sessionId: id } : {}),
    configOptions: [
      { id: 'model', currentValue: 'grok-fake' },
      { id: 'reasoning_effort', currentValue: 'medium' },
    ],
  };
}

function grokAgent() {
  acpAgent({
    initialize: () => ({ protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true }, mcpCapabilities: { http: true } }, authMethods: [] }),
    'session/new': (p, { sessions: open }) => openSession('session/new', p, open),
    // Its plan's billing (what its /usage shows), read from the grok.com sign-in.
    '_x.ai/billing': () => {
      if (signedOut()) throw rpcError('Authentication required to fetch billing data');
      return {
        subscription_tier: 'SuperGrok',
        config: { creditUsagePercent: planUsedPercent(), currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', end: new Date(planResets.week()).toISOString() } },
      };
    },
    'session/resume': (p, { sessions: open }) => openSession('session/resume', p, open),
    'session/set_config_option': (p, { sessions: open }) => {
      const s = open.get(p.sessionId);
      const key = { model: 'model', reasoning_effort: 'effort' }[p.configId];
      if (!s || !key) throw rpcError(`unknown config option ${p.configId}`, -32602);
      s[key] = p.value;
      return {};
    },
    'session/prompt': (p, { peer, sessions: open }) => {
      const s = open.get(p.sessionId);
      if (!s) throw rpcError(`no session ${p.sessionId}`);
      const blocks = p.prompt || [];
      const prompt = blocks.map((b) => b.text || '').join('\n');
      const images = blocks.filter((b) => b.type === 'image' && b.data).length;
      record({
        prompt,
        briefing: s.briefing,
        yolo: s.yolo,
        sandbox: process.env.GROK_SANDBOX || null,
        images,
        mcp: s.mcp,
        model: s.model,
        effort: s.effort,
        // What it loads by itself: its folder's trust, and the skills it takes from Claude Code.
        trusted: grokTrusted(projectRoot(s.cwd)),
        skills: grokSkills(s.cwd).map((x) => x.name),
      });
      s.cancelled = false;
      const steps = plan(prompt, { cwd: s.cwd, images, mcp: s.mcp, briefing: s.briefing });
      if (steps[0] && steps[0].type === 'error') throw rpcError(steps[0].text);
      return grokTurn(peer, p.sessionId, s, steps);
    },
  });
}

/** The options Grok offers when it asks: allow once, or reject. */
const OPTIONS = [
  { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
];

async function grokTurn(peer, sessionId, s, steps) {
  const u = sessionUpdates(peer, sessionId, () => s.cancelled);
  let n = 0;
  let prefix = '';
  /** Asks before a tool call (unless yolo): { ok, note }. */
  const permit = async (toolCall) => {
    if (s.yolo) return { ok: true };
    const answer = await requestPermission(peer, sessionId, toolCall, OPTIONS);
    const ok = picked(answer, 'allow-once');
    return { ok, note: ok ? '' : noteIn(followup(answer)) };
  };
  for (const step of steps) {
    if (s.cancelled) return { stopReason: 'cancelled' };
    if (step.type === 'fail') return fail(step.text);
    if (step.type === 'think') await u.thought(step.text);
    if (step.type === 'todo') u.plan(step.entries);
    if (step.type === 'tool') {
      const id = `tc_${++n}`;
      u.toolCall({ toolCallId: id, title: 'list_dir', kind: 'read', status: 'in_progress', rawInput: { path: '.' }, _meta: { 'x.ai/tool': { name: 'list_dir' } } });
      await sleep(20);
      u.toolDone(id, true, step.output);
    }
    if (step.type === 'approve') {
      const id = `tc_${++n}`;
      const call = { toolCallId: id, title: 'run_terminal_cmd', kind: 'execute', status: 'pending', rawInput: { command: step.command }, _meta: { 'x.ai/tool': { name: 'run_terminal_cmd' } } };
      u.toolCall(call);
      const p = await permit(call);
      u.toolDone(id, p.ok, p.ok ? 'e2e-approval' : 'Not executed: the user declined it.');
      prefix += p.ok ? 'The command ran: e2e-approval. ' : declined('command', p.note);
    }
    if (step.type === 'write') {
      const file = targetOf(step, s.cwd, s.others);
      if (!file) {
        prefix += noOther(step);
        continue;
      }
      const id = `tc_${++n}`;
      const call = { toolCallId: id, title: 'write_file', kind: 'edit', status: 'pending', rawInput: { path: file, content: step.content }, _meta: { 'x.ai/tool': { name: 'write_file' } } };
      u.toolCall(call);
      // Asked first, as Grok asks; then its sandbox refuses a folder outside the profile.
      const p = await permit(call);
      const ok = p.ok && inside(file, s.dirs);
      if (ok) writeFile(file, step.content);
      u.toolDone(id, ok, ok ? `Wrote ${file}` : p.ok ? 'Not executed: Operation not permitted.' : 'Not executed.');
      prefix += wrote(step, ok, p.note);
    }
    if (step.type === 'text') {
      if (!(await u.message(prefix + step.text, step.slow))) return { stopReason: 'cancelled' };
      u.update({ sessionUpdate: 'response_completed' });
    }
  }
  return { stopReason: 'end_turn', _meta: { usage: { inputTokens: 90, outputTokens: 25 } } };
}

module.exports = {
  provider: 'grok',
  bin: 'grok',
  label: 'Grok',
  name: 'Grok',
  version: 'grok 1.0.999',
  versionRe: /^grok 1\.0\.999$/m,
  /** Its own folder: GROK_HOME, else ~/.grok. */
  home: (env) => env.GROK_HOME || path.join(os.homedir(), '.grok'),
  /** The key it was given (XAI_API_KEY), by `keyVerdict`; null for none. */
  apiKey: (env) => (env.XAI_API_KEY ? keyVerdict(env.XAI_API_KEY) : null),
  main() {
    if (args[0] === 'agent' && args.includes('stdio')) grokAgent();
    else grokStatic();
  },
};
