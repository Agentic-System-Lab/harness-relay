'use strict';
/*
 * The fake Codex (`codex`): `codex app-server` (JSON-RPC without the version field: threads, turns,
 * items, approval requests; `account/read` and `account/rateLimits/read`, the plan's limits),
 * `--version`, `login status`, `login --with-api-key`, `logout`, `debug models`.
 *
 * Whether a write happens is decided only by what Harness Relay gave it, as with the real one: the
 * thread's sandbox (`sandbox`, or the permission profile it names, with its `write` entries;
 * `writable_roots`), its `approvalPolicy`, and the answers to its approval requests. The skills it
 * loads by itself are its home's skills/ (`skills.include_instructions`, `skills.config` in `-c` or
 * the thread's config).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { inside, ownSkills, targetOf, writeFile } = require('../lib/files.cjs');
const { keyVerdict, planResets, planUsedPercent, sessions, signIn, signedOut } = require('../lib/home.cjs');
const { exitAfterLog, record } = require('../lib/log.cjs');
const { declined, noOther, pieceDelay, pieces, plan, recordMcpEnv, wrote } = require('../lib/plan.cjs');
const { fail, rpcError, rpcPeer, track } = require('../lib/rpc.cjs');
const { args, has, home, newId, sleep } = require('../lib/self.cjs');

/** The verdict on the key `login --with-api-key` kept in its home, or null (signed in otherwise, or out). */
function keptApiKey() {
  try {
    return fs.readFileSync(path.join(home(), 'e2e-api-key'), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

function codexStatic() {
  if (has('--version')) return void process.stdout.write(`${module.exports.version}\n`);
  if (args[0] === 'login' && args[1] === 'status') {
    return void process.stderr.write(signedOut() ? 'Not logged in\n' : keptApiKey() ? 'Logged in using an API key\n' : 'Logged in using ChatGPT\n');
  }
  if (args[0] === 'login' && args[1] === '--with-api-key') {
    // The key comes on stdin, as `printenv OPENAI_API_KEY | codex login --with-api-key`.
    let key = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (key += chunk));
    process.stdin.on('end', () => {
      if (!key.trim()) return void process.stderr.write('No API key provided via stdin\n', () => exitAfterLog(1));
      signIn.loginWithApiKey(key.trim());
      process.stderr.write('Successfully logged in\n', () => exitAfterLog(0));
    });
    return;
  }
  if (args[0] === 'logout') {
    signIn.logout();
    return void process.stderr.write('Successfully logged out\n');
  }
  if (args[0] === 'debug' && args[1] === 'models') {
    const levels = ['low', 'medium', 'high'].map((effort) => ({ effort, description: effort }));
    return void process.stdout.write(
      JSON.stringify({
        models: [
          { slug: 'gpt-fake-codex', display_name: 'GPT Fake Codex', supported_reasoning_levels: levels, default_reasoning_level: 'medium', visibility: 'list' },
          { slug: 'gpt-fake-mini', display_name: 'GPT Fake Mini', supported_reasoning_levels: levels, default_reasoning_level: 'low', visibility: 'list' },
        ],
      }) + '\n',
    );
  }
  process.stderr.write(`fake codex: unknown command ${args.join(' ')}\n`);
  process.exitCode = 1;
}

/**
 * The config overrides it was started with (`-c key=value`, the value in TOML), as JSON: Harness
 * Relay writes only JSON strings, numbers, booleans, arrays and inline tables (`{ "k" = v }`).
 */
function codexOverrides() {
  const found = {};
  for (let i = 0; i < args.length - 1; i++) {
    const m = args[i] === '-c' ? /^([^=]+)=([\s\S]*)$/.exec(args[i + 1]) : null;
    if (!m) continue;
    try {
      found[m[1]] = JSON.parse(m[2].replace(/"(?:[^"\\]|\\.)*"(\s*=)?/g, (s, eq) => (eq ? `${s.slice(0, -eq.length)}:` : s)));
    } catch {
      /* not a value it reads */
    }
  }
  return found;
}

/**
 * Codex's own skills (its home's skills/), each on unless a `skills.config` entry turns its path
 * off; `loaded`: those it lists to the model (none with `skills.include_instructions` false).
 */
function codexSkills(config) {
  const off = new Set((config['skills.config'] || []).filter((e) => e && e.enabled === false).map((e) => e.path));
  const skills = ownSkills(path.join(home(), 'skills')).map((s) => ({ ...s, enabled: !off.has(s.path) }));
  return { skills, loaded: config['skills.include_instructions'] === false ? [] : skills.filter((s) => s.enabled).map((s) => s.name) };
}

function codexAppServer() {
  const threads = new Map();
  // Its config: the overrides it started with, and those of the threads started since.
  const conf = codexOverrides();
  let peer;
  peer = rpcPeer(
    false,
    async (method, p) => {
      switch (method) {
        case 'initialize':
          return { userAgent: 'codex_cli_rs/0.999.0 (fake)', codexHome: home() };
        case 'thread/start':
        case 'thread/resume': {
          const id = method === 'thread/resume' ? p.threadId : newId('thread');
          if (method === 'thread/resume' && !sessions.resume(id)) throw rpcError(`no rollout found for thread id ${id}`);
          if (method === 'thread/start') sessions.start(id);
          const config = p.config || {};
          if (config['skills.config']) conf['skills.config'] = [...(conf['skills.config'] || []), ...config['skills.config']];
          if ('skills.include_instructions' in config) conf['skills.include_instructions'] = config['skills.include_instructions'];
          threads.set(id, {
            cwd: p.cwd || process.cwd(),
            briefing: p.developerInstructions || '',
            approval: p.approvalPolicy || 'never',
            model: p.model || 'gpt-fake-codex',
            effort: config.model_reasoning_effort || null,
            skills: codexSkills(conf).loaded,
            mcp: Object.keys(config.mcp_servers || {}).filter((name) => (config.mcp_servers[name] || {}).enabled !== false),
            ...codexWrites(p),
          });
          const given = Object.entries(config.mcp_servers || {}).filter(([, s]) => s && s.enabled !== false && (s.command || s.url));
          recordMcpEnv(
            Object.fromEntries(given.map(([name, s]) => [name, s.env || s.http_headers || {}])),
            // A server with a URL (and no command) is a Streamable HTTP one.
            Object.fromEntries(given.filter(([, s]) => s.url && !s.command).map(([name, s]) => [name, s.url])),
          );
          return {
            thread: { id, preview: '', modelProvider: 'openai', createdAt: Math.floor(Date.now() / 1000), cwd: p.cwd },
            model: p.model || 'gpt-fake-codex',
            ...(typeof p.permissions === 'string' ? { activePermissionProfile: { id: p.permissions } } : {}),
          };
        }
        case 'turn/start': {
          const t = threads.get(p.threadId);
          if (!t) throw rpcError(`no thread ${p.threadId}`);
          const input = p.input || [];
          const prompt = input.map((i) => i.text || '').join('\n');
          const images = input.filter((i) => i.type === 'localImage' && i.path && fs.existsSync(i.path)).length;
          record({ prompt, briefing: t.briefing, approval: t.approval, dirs: t.dirs, images, mcp: t.mcp, model: t.model, effort: t.effort, skills: t.skills });
          const turnId = newId('turn');
          const steps = signedOut() ? [{ type: 'error', text: 'Not logged in. Run codex login.' }] : plan(prompt, { cwd: t.cwd, images, mcp: t.mcp, briefing: t.briefing });
          track(sleep(5).then(() => codexTurn(peer, p.threadId, turnId, t, steps)));
          return { turn: { id: turnId, items: [], status: 'inProgress', error: null } };
        }
        case 'turn/interrupt':
          interrupted.add(p.turnId);
          return {};
        case 'skills/list': {
          const skills = codexSkills(conf).skills.map((s) => ({ name: s.name, description: s.description, path: s.path, scope: 'user', enabled: s.enabled }));
          return { data: (p.cwds || [process.cwd()]).map((cwd) => ({ cwd, skills, errors: [] })) };
        }
        case 'config/read':
          return {
            config: { mcp_servers: {}, ...(conf['skills.include_instructions'] === false ? { skills: { include_instructions: false } } : {}) },
            origins: {},
          };
        case 'hooks/list':
          return { data: [] };
        case 'plugin/installed':
          return { marketplaces: [] };
        case 'mcpServerStatus/list':
          return { data: [] };
        // Who it is signed in as, and its plan's limits (Settings shows them in the account's block).
        case 'account/read':
          if (signedOut()) return { account: null, requiresOpenaiAuth: true };
          if (fs.existsSync(signIn.apiKey())) return { account: { type: 'apiKey' }, requiresOpenaiAuth: true };
          return { account: { type: 'chatgpt', email: signIn.email(), planType: 'plus' }, requiresOpenaiAuth: true };
        case 'account/rateLimits/read': {
          const used = planUsedPercent();
          const at = (ms) => Math.round(ms / 1000);
          return {
            rateLimits: {
              limitId: 'codex',
              primary: { usedPercent: used, windowDurationMins: 300, resetsAt: at(planResets.fiveHour()) },
              secondary: { usedPercent: Math.round(used / 2), windowDurationMins: 10080, resetsAt: at(planResets.week()) },
              credits: { hasCredits: false, unlimited: false, balance: null },
              planType: 'plus',
            },
          };
        }
        default:
          throw rpcError(`unknown method ${method}`, -32601);
      }
    },
    () => {},
  );
}

const interrupted = new Set();

/**
 * Where a thread's sandbox lets Codex write: its permission profile (`:workspace` and its `write`
 * entries; `:read-only` nothing), else the legacy mode (`workspace-write` and its `writable_roots`),
 * anywhere with `danger-full-access` (`dirs` null).
 */
function codexWrites(p) {
  const cwd = p.cwd || process.cwd();
  const config = p.config || {};
  if (typeof p.permissions === 'string') {
    const profile = (config.permissions || {})[p.permissions] || {};
    const writes = Object.entries(profile.filesystem || {})
      .filter(([, access]) => access === 'write')
      .map(([dir]) => dir);
    return { dirs: profile.extends === ':workspace' ? [cwd, ...writes] : profile.extends === ':danger-full-access' ? null : [], others: writes };
  }
  if (p.sandbox === 'danger-full-access') return { dirs: null, others: [] };
  if (p.sandbox === 'workspace-write') {
    const roots = (config.sandbox_workspace_write || {}).writable_roots || [];
    return { dirs: [cwd, ...roots], others: roots };
  }
  return { dirs: [], others: [] };
}

async function codexTurn(peer, threadId, turnId, t, steps) {
  const note = (method, params) => peer.notify(method, { threadId, turnId, ...params });
  let n = 0;
  let prefix = '';
  const stopped = () => interrupted.has(turnId);
  /** Asks to go beyond the sandbox, when its approval policy lets it ask. */
  const approve = async (method, params) => {
    if (t.approval === 'never') return false;
    const answer = await peer.request(method, { threadId, turnId, ...params }).catch(() => ({}));
    return Boolean(answer && ['accept', 'acceptForSession', 'approved'].includes(answer.decision));
  };
  for (const step of steps) {
    if (stopped()) break;
    if (step.type === 'fail') return fail(step.text);
    if (step.type === 'error') {
      note('error', { error: { message: step.text }, willRetry: false });
      return note('turn/completed', { turn: { id: turnId, items: [], status: 'failed', error: { message: step.text } } });
    }
    if (step.type === 'think') {
      const id = `rs_${++n}`;
      note('item/started', { item: { type: 'reasoning', id, summary: [], content: [] } });
      for (const piece of pieces(step.text)) {
        note('item/reasoning/summaryTextDelta', { itemId: id, delta: piece, summaryIndex: 0 });
        await sleep(pieceDelay());
      }
      note('item/completed', { item: { type: 'reasoning', id, summary: [step.text], content: [] } });
    }
    if (step.type === 'todo') {
      const status = { completed: 'completed', in_progress: 'inProgress', pending: 'pending' };
      note('turn/plan/updated', { explanation: null, plan: step.entries.map((e) => ({ step: e.text, status: status[e.status] })) });
    }
    if (step.type === 'tool') {
      const id = `call_${++n}`;
      const base = { type: 'commandExecution', id, command: '/bin/zsh -lc ls', cwd: t.cwd, processId: null, commandActions: [] };
      note('item/started', { item: { ...base, status: 'inProgress', aggregatedOutput: null, exitCode: null } });
      await sleep(20);
      note('item/completed', { item: { ...base, status: 'completed', aggregatedOutput: step.output, exitCode: 0, durationMs: 5 } });
    }
    if (step.type === 'approve') {
      const id = `call_${++n}`;
      const base = { type: 'commandExecution', id, command: step.command, cwd: t.cwd, processId: null, commandActions: [] };
      note('item/started', { item: { ...base, status: 'inProgress', aggregatedOutput: null, exitCode: null } });
      const ran = t.dirs === null || (await approve('item/commandExecution/requestApproval', { itemId: id, command: step.command, cwd: t.cwd, reason: 'Print a line (an e2e check)' }));
      note('item/completed', {
        item: ran ? { ...base, status: 'completed', aggregatedOutput: 'e2e-approval\n', exitCode: 0 } : { ...base, status: 'declined', aggregatedOutput: null, exitCode: null },
      });
      prefix += ran ? 'The command ran: e2e-approval. ' : declined('command');
    }
    if (step.type === 'write') {
      const file = targetOf(step, t.cwd, t.others);
      if (!file) {
        prefix += noOther(step);
        continue;
      }
      const id = `patch_${++n}`;
      const changes = [{ path: file, kind: { type: 'add' }, diff: step.content }];
      note('item/started', { item: { type: 'fileChange', id, changes, status: 'inProgress' } });
      // Outside its sandbox's folders, it asks to apply the patch anyway.
      const ok = inside(file, t.dirs) || (await approve('item/fileChange/requestApproval', { itemId: id, reason: 'Write outside the sandbox (an e2e check)' }));
      if (ok) writeFile(file, step.content);
      note('item/completed', { item: { type: 'fileChange', id, changes, status: ok ? 'completed' : 'declined' } });
      prefix += wrote(step, ok);
    }
    if (step.type === 'text') {
      const id = `msg_${++n}`;
      const text = prefix + step.text;
      note('item/started', { item: { type: 'agentMessage', id, text: '' } });
      for (const piece of pieces(text, step.slow)) {
        if (stopped()) break;
        note('item/agentMessage/delta', { itemId: id, delta: piece });
        await sleep(pieceDelay(step.slow));
      }
      note('item/completed', { item: { type: 'agentMessage', id, text } });
    }
  }
  note('thread/tokenUsage/updated', { tokenUsage: { last: { inputTokens: 150, cachedInputTokens: 0, outputTokens: 30, reasoningOutputTokens: 5, totalTokens: 180 }, total: {} } });
  note('turn/completed', { turn: { id: turnId, items: [], status: stopped() ? 'interrupted' : 'completed', error: null } });
}

module.exports = {
  provider: 'codex',
  bin: 'codex',
  label: 'Codex',
  name: 'Codex',
  version: 'codex-cli 0.999.0',
  versionRe: /^codex-cli 0\.999\.0$/m,
  /** Its own folder: CODEX_HOME, else ~/.codex. */
  home: (env) => env.CODEX_HOME || path.join(os.homedir(), '.codex'),
  /** The key it was given (CODEX_API_KEY, OPENAI_API_KEY), else the one `codex login --with-api-key` kept in its home. */
  apiKey(env) {
    const key = env.CODEX_API_KEY || env.OPENAI_API_KEY;
    return key ? keyVerdict(key) : keptApiKey();
  },
  main() {
    if (args.includes('app-server')) codexAppServer();
    else codexStatic();
  },
};
