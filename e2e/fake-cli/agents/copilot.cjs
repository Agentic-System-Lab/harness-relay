'use strict';
/*
 * The fake GitHub Copilot CLI (`copilot`, 1.0.109 as Harness Relay drives it): `copilot --acp` (ACP:
 * sessions with `session/new` and `session/load`, config options `mode` and `allow_all`,
 * `session/request_permission` with allow-once, allow-always and deny, `logout`), `login
 * --device-code`, `--version`, `mcp|skill|instruction|plugin list --json`, and its headless server
 * (`--headless --stdio`: JSON-RPC framed by `Content-Length:` headers; `connect`, `account.getQuota`,
 * `account.getCurrentAuth`, the plan's premium requests).
 *
 * Its home is COPILOT_HOME, else ~/.copilot. A run's home is a folder of its own whose
 * `session-state` links to the account's: the account's home is then where that link leads (its
 * sign-in, sessions and marks go there). A question about its models or sign-in runs in a home with
 * no `session-state` at all: the session it opens there is not kept. It is signed in until signed out there (`logout`,
 * E2E_FAKE_SIGNED_OUT): signing out also marks the account's `config.json`, which a run's home and
 * the home a question about its models runs in take a copy of.
 *
 * Whether something happens is decided only by what Harness Relay gave it, as with the real one: its
 * flags (`--sandbox`, `--allow-all`, `--add-dir`, `--model`, `--reasoning-effort`,
 * `--excluded-tools skill`), its home's `settings.json` (`sandbox`: on only with `--sandbox` too, its
 * read-write and denied paths), the session's `allow_all` option, and the answers to its permission
 * requests. Without allow-all it asks before every command but `echo` (which it takes for read-only),
 * every file it writes and every URL it fetches; in its sandbox a write outside the working directory,
 * a temporary folder of its own and the policy's read-write paths (or in a denied one) fails without asking.
 * A refused, cancelled or unanswered call fails, and the turn ends there at once (`end_turn`, nothing
 * more said). `/sandbox policy` is answered without the model: the policy its settings give, as
 * Copilot prints it.
 *
 * Its briefing is its home's `copilot-instructions.md` (the real one reads it at every start). It logs
 * each prompt's briefing, model, effort, mode, allow-all, sandbox, images, MCP servers and the skills it
 * loads by itself (its home's `skills`, a project's `.github/skills`), and the project hooks it would
 * run by itself (`.github/hooks/*.json`, from the working directory up to its repository's root).
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { acpAgent, picked, requestPermission, sessionUpdates } = require('../lib/acp.cjs');
const { inside, notAWorkingDirectory, ownSkills, targetOf } = require('../lib/files.cjs');
const { keyVerdict, planResets, planUsedPercent, sessions, signIn, signedOut } = require('../lib/home.cjs');
const { exitAfterLog, record, tryWrite } = require('../lib/log.cjs');
const { directivesIn, lastUserMessage, noOther, plan, recordMcpEnv, skillsIn, wrote } = require('../lib/plan.cjs');
const { fail, rpcError } = require('../lib/rpc.cjs');
const self = require('../lib/self.cjs');

const VERSION = '1.0.999';

/** Its models, as a session lists them, each with the reasoning efforts it takes. */
const MODELS = [
  { id: 'claude-fake-sonnet', name: 'Claude Fake Sonnet', efforts: ['low', 'medium', 'high'] },
  { id: 'gpt-fake-mini', name: 'GPT Fake Mini', efforts: [] },
];
const DEFAULT_MODEL = 'claude-fake-sonnet';
const AGENT = 'https://agentclientprotocol.com/protocol/session-modes#agent';
const MODES = [AGENT, 'https://agentclientprotocol.com/protocol/session-modes#plan', 'https://agentclientprotocol.com/protocol/session-modes#autopilot'];

/** A JSON file of its home, which may begin with `//` comment lines; undefined when missing or not JSON. */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\s*\/\/[^\n]*$/gm, ''));
  } catch {
    return undefined;
  }
}

/** The folder COPILOT_HOME names for this start (a run's own, a probe's, an account's), else ~/.copilot. */
const ownHome = () => process.env.COPILOT_HOME || path.join(os.homedir(), '.copilot');

/** Whether its sign-in is gone: signed out in the account's home, or its `config.json` (a copy of the account's too) says so. */
const isSignedOut = () => signedOut() || Boolean((readJson(path.join(ownHome(), 'config.json')) || {}).e2eSignedOut);

/** The folders from `dir` up to its repository's root (a folder with `.git`), or `dir` alone outside one. */
function upToRepo(dir) {
  const dirs = [];
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    dirs.push(d);
    if (fs.existsSync(path.join(d, '.git'))) return dirs;
    if (path.dirname(d) === d) return [path.resolve(dir)];
  }
}

/** The project's hooks it runs by itself when a session opens (the fake runs none, it logs them). */
function projectHooks(dirs) {
  const found = new Set();
  for (const dir of dirs) {
    for (const up of upToRepo(dir)) {
      let names = [];
      try {
        names = fs.readdirSync(path.join(up, '.github', 'hooks'));
      } catch {
        continue;
      }
      for (const n of names) if (/\.json$/i.test(n)) found.add(path.join(up, '.github', 'hooks', n));
    }
  }
  return [...found].sort();
}

/** The skills it loads by itself for `cwd`: a project's `.github/skills` (up to its repository's root), then its home's; none without its skill tool. */
function copilotSkills(cwd) {
  if (self.values('--excluded-tools').includes('skill')) return [];
  const seen = new Set();
  const out = [];
  const add = (dir, source) => {
    for (const s of ownSkills(dir)) {
      if (seen.has(s.name)) continue;
      seen.add(s.name);
      out.push({ ...s, source });
    }
  };
  for (const up of upToRepo(cwd)) add(path.join(up, '.github', 'skills'), 'project');
  add(path.join(ownHome(), 'skills'), 'personal-copilot');
  return out;
}

// --- The commands that only ask it something ---------------------------------------------------------

/** `login --device-code`: GitHub's device link and a code, then signed in (the fake needs no one to authorize it). */
function login() {
  process.stdout.write('To authenticate, visit https://github.com/login/device and enter code E2EF-AKE1\nWaiting for authorization...\n');
  setTimeout(() => {
    signIn.login('');
    fs.mkdirSync(ownHome(), { recursive: true });
    fs.writeFileSync(
      path.join(ownHome(), 'config.json'),
      `// This file is managed automatically.\n${JSON.stringify({ loggedInUsers: [{ host: 'https://github.com', login: 'e2e' }], lastLoggedInUser: { host: 'https://github.com', login: 'e2e' } }, null, 2)}\n`,
    );
    process.stdout.write('Signed in successfully as e2e.\n', () => exitAfterLog(0));
  }, 100);
}

function copilotStatic(args) {
  if (args.includes('--version') || args[0] === 'version') return void process.stdout.write(`GitHub Copilot CLI ${VERSION}.\nRun 'copilot update' to check for updates.\n`);
  if (args[0] === 'login') return login();
  if (args[1] === 'list' && args.includes('--json')) {
    if (args[0] === 'mcp') return void process.stdout.write(`${JSON.stringify({ mcpServers: {} }, null, 2)}\n`);
    if (args[0] === 'skill') {
      const skills = copilotSkills(process.cwd()).map((s) => ({ name: s.name, description: s.description, source: s.source, path: path.dirname(s.path), enabled: true }));
      return void process.stdout.write(`${JSON.stringify(skills, null, 2)}\n`);
    }
    if (args[0] === 'instruction' || args[0] === 'plugin') return void process.stdout.write('[]\n');
  }
  if (args[0] === '--acp') return copilotAcp();
  if (args[0] === '--headless' && args.includes('--stdio')) return copilotHeadless();
  process.stderr.write(`fake copilot: unknown command ${args.join(' ') || '(none: no interactive mode here)'}\n`);
  process.exitCode = 1;
}

// --- `copilot --headless --stdio` -------------------------------------------------------------------

/**
 * Its headless server, as its SDK speaks to it: JSON-RPC with `Content-Length:` headers. It answers
 * `connect` and the account's quota (300 premium requests a month, `planUsedPercent()` of them used;
 * signed out, or signed out with no GitHub token, it is not authenticated) and auth.
 */
function copilotHeadless() {
  let buf = Buffer.alloc(0);
  const send = (msg) => {
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...msg }), 'utf8');
    process.stdout.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]));
  };
  const authed = () => !isSignedOut() || Boolean(process.env.COPILOT_GITHUB_TOKEN);
  const answer = (m) => {
    if (m.method === 'connect') return send({ id: m.id, result: { ok: true, protocolVersion: 3, version: VERSION } });
    if (m.method === 'account.getQuota') {
      if (!authed()) return send({ id: m.id, error: { code: -32603, message: 'Request account.getQuota failed with message: Not authenticated. Please authenticate first.' } });
      const used = Math.round((300 * planUsedPercent()) / 100);
      const unlimited = { isUnlimitedEntitlement: true, entitlementRequests: 0, usedRequests: 0, remainingPercentage: 100, hasQuota: true };
      return send({
        id: m.id,
        result: { quotaSnapshots: { chat: unlimited, completions: unlimited, premium_interactions: { isUnlimitedEntitlement: false, entitlementRequests: 300, usedRequests: used, remainingPercentage: ((300 - used) / 300) * 100, hasQuota: true } } },
      });
    }
    if (m.method === 'account.getCurrentAuth') {
      if (!authed()) return send({ id: m.id, result: {} });
      return send({ id: m.id, result: { authInfo: { type: process.env.COPILOT_GITHUB_TOKEN ? 'env' : 'user', login: 'e2e', copilotUser: { login: 'e2e', copilot_plan: 'individual', quota_reset_date_utc: new Date(planResets.week()).toISOString() } } } });
    }
    send({ id: m.id, error: { code: -32601, message: `Unhandled method ${m.method}` } });
  };
  process.stdin.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      const length = Number(/content-length:\s*(\d+)/i.exec(buf.subarray(0, end).toString('latin1'))?.[1]);
      if (buf.length < end + 4 + length) return;
      const m = JSON.parse(buf.subarray(end + 4, end + 4 + length).toString('utf8'));
      buf = buf.subarray(end + 4 + length);
      if (m.id !== undefined) answer(m);
    }
  });
  process.stdin.on('end', () => exitAfterLog(0));
}

// --- `copilot --acp` ------------------------------------------------------------------------------

const CAPABILITIES = {
  auth: { logout: {} },
  loadSession: true,
  mcpCapabilities: { http: true, sse: true },
  promptCapabilities: { image: true, audio: false, embeddedContext: true },
  sessionCapabilities: { close: {}, list: {} },
};
const OPTIONS = [
  { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' },
  { optionId: 'allow_always', kind: 'allow_always', name: 'Always allow' },
  { optionId: 'reject_once', kind: 'reject_once', name: 'Deny' },
];

/** Its sandbox for this start: on only with `--sandbox` and its settings' `sandbox.enabled`; where it may write, what it may not touch. */
function sandboxOf(cwd) {
  const sb = (readJson(path.join(ownHome(), 'settings.json')) || {}).sandbox || {};
  if (!self.has('--sandbox') || sb.enabled !== true) return { on: false };
  const fsp = (sb.userPolicy && sb.userPolicy.filesystem) || {};
  return {
    on: true,
    bypass: sb.allowBypass === true,
    // Its own temporary folder only (`<temp>/copilot-<uuid>`), not the system's whole temporary folder.
    writable: [...(sb.addCurrentWorkingDirectory === false ? [] : [cwd]), ...(fsp.readwritePaths || []), path.join(os.tmpdir(), `copilot-${process.pid}`)],
    readonly: fsp.readonlyPaths || [],
    denied: fsp.deniedPaths || [],
  };
}

/** `/sandbox policy`, as Copilot prints it (its headings in bold). */
function policyText(cwd, sb) {
  if (!sb.on) return 'Command sandboxing is disabled, so no policy is in force and commands run unrestricted.\n\nUse /sandbox enable to turn it on.';
  const list = (title, paths) => (paths.length ? `  ${title} (${paths.length}):\n${paths.map((p) => `    ${p}\n`).join('')}` : '');
  return [
    `Effective sandbox policy for ${cwd}`,
    '',
    `\u001b[1mUser-configured paths:\u001b[22m`,
    list('Read-write paths', sb.writable.slice(1, -1)) + list('Read-only paths', sb.readonly) + list('Denied paths', sb.denied),
    `\u001b[1mWorking directory:\u001b[22m`,
    `  Read-write paths (1):\n    ${cwd}\n`,
    `\u001b[1mCapabilities:\u001b[22m`,
    `  Allow sandbox bypass: ${sb.bypass ? 'yes' : 'no'}`,
    '',
  ].join('\n');
}

/** The model this start runs: on an endpoint (BYOK) COPILOT_MODEL, else `--model`, else its settings', else its default. */
function startModel() {
  if (process.env.COPILOT_PROVIDER_BASE_URL) return process.env.COPILOT_MODEL || 'byok-model';
  return self.flag('--model') || (readJson(path.join(ownHome(), 'settings.json')) || {}).model || DEFAULT_MODEL;
}

function configOptions(s) {
  return [
    { type: 'select', id: 'mode', category: 'mode', currentValue: s.mode, options: MODES.map((value) => ({ value })) },
    { type: 'select', id: 'model', category: 'model', currentValue: s.model, options: MODELS.map((m) => ({ value: m.id, name: m.name })) },
    { type: 'select', id: 'allow_all', category: 'permissions', currentValue: s.allowAll ? 'on' : 'off', options: [{ value: 'on' }, { value: 'off' }] },
  ];
}

function copilotAcp() {
  const open = (method, p, agent) => {
    if (isSignedOut() && !process.env.COPILOT_PROVIDER_BASE_URL) throw rpcError('Authentication required', -32000);
    const model = startModel();
    const effort = self.flag('--reasoning-effort');
    const known = MODELS.find((m) => m.id === model);
    if (effort && !process.env.COPILOT_PROVIDER_BASE_URL && known && !known.efforts.includes(effort)) {
      throw rpcError(`Request sessions.open failed with message: session construction failed: Model '${model}' does not support reasoning effort configuration.`, -32603);
    }
    const loading = method === 'session/load';
    const id = loading ? p.sessionId : crypto.randomUUID();
    // Its sessions are kept in its home's `session-state`: a home of a question's own has none (the
    // session is gone with it), so nothing is kept or resumed there.
    const keeps = fs.existsSync(path.join(ownHome(), 'session-state'));
    if (loading && !(keeps && sessions.resume(id))) throw rpcError(`Resource not found: Session ${id} not found`, -32002);
    if (!loading && keeps) sessions.start(id);
    const cwd = p.cwd || process.cwd();
    const addDirs = self.values('--add-dir');
    let briefing = '';
    try {
      briefing = fs.readFileSync(path.join(ownHome(), 'copilot-instructions.md'), 'utf8');
    } catch {
      briefing = '';
    }
    const s = {
      cwd,
      others: addDirs.filter((d) => !notAWorkingDirectory(d)),
      // Where its file tools write without its path check asking: the working directories it was given.
      workspace: [cwd, ...addDirs],
      model,
      effort: effort || null,
      mode: AGENT,
      allowAll: self.has('--allow-all'),
      sandbox: sandboxOf(cwd),
      mcp: (p.mcpServers || []).map((x) => x.name),
      briefing,
      cancelled: false,
    };
    agent.sessions.set(id, s);
    recordMcpEnv(
      Object.fromEntries((p.mcpServers || []).map((x) => [x.name, Object.fromEntries((x.env || x.headers || []).map((v) => [v.name, v.value]))])),
      Object.fromEntries((p.mcpServers || []).filter((x) => x.type === 'http').map((x) => [x.name, x.url])),
    );
    const hooks = projectHooks([cwd, ...addDirs]);
    if (hooks.length) record({ projectHooks: hooks });
    // A load replays the session's messages before it answers.
    if (loading) {
      agent.peer.notify('session/update', { sessionId: id, update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '(an earlier question)' } } });
      agent.peer.notify('session/update', { sessionId: id, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '(an earlier answer)' } } });
    }
    return {
      ...(loading ? {} : { sessionId: id }),
      models: { availableModels: [{ modelId: 'auto', name: 'Auto' }, ...MODELS.map((m) => ({ modelId: m.id, name: m.name }))], currentModelId: model },
      modes: { currentModeId: s.mode, availableModes: MODES.map((m) => ({ id: m, name: m.split('#')[1] })) },
      configOptions: configOptions(s),
    };
  };

  acpAgent({
    initialize: () => ({
      protocolVersion: 1,
      agentCapabilities: CAPABILITIES,
      agentInfo: { name: 'Copilot', title: 'Copilot', version: VERSION },
      authMethods: [{ id: 'copilot-login', name: 'Log in with Copilot CLI', description: 'Run `copilot login` in the terminal' }],
    }),
    logout: () => {
      signIn.logout();
      const file = path.join(ownHome(), 'config.json');
      fs.mkdirSync(ownHome(), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ ...(readJson(file) || {}), loggedInUsers: [], e2eSignedOut: true }, null, 2));
      // Every start of it is `--acp`: its sign-out is logged as its own line.
      record({ args: ['acp', 'logout'], home: self.home() });
      return {};
    },
    'session/new': (p, agent) => open('session/new', p, agent),
    'session/load': (p, agent) => open('session/load', p, agent),
    'session/set_config_option': (p, { sessions: live }) => {
      const s = live.get(p.sessionId);
      if (!s) throw rpcError(`Resource not found: Session ${p.sessionId} not found`, -32002);
      if (p.configId === 'mode') {
        if (!MODES.includes(p.value)) throw rpcError(`unknown mode ${p.value}`, -32602);
        s.mode = p.value;
        if (p.value === MODES[2]) s.allowAll = true; // autopilot allows everything
      } else if (p.configId === 'allow_all') s.allowAll = p.value === 'on';
      else throw rpcError(`unknown config option ${p.configId}`, -32602);
      return { configOptions: configOptions(s) };
    },
    'session/prompt': (p, { peer, sessions: live }) => {
      const s = live.get(p.sessionId);
      if (!s) throw rpcError(`Resource not found: Session ${p.sessionId} not found`, -32002);
      const blocks = p.prompt || [];
      const prompt = blocks.filter((b) => b.type === 'text').map((b) => b.text || '').join('\n');
      if (prompt.trim() === '/sandbox policy') {
        peer.notify('session/update', { sessionId: p.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: policyText(s.cwd, s.sandbox) } } });
        return { stopReason: 'end_turn' };
      }
      const images = blocks.filter((b) => b.type === 'image' && b.data).length;
      record({
        prompt,
        briefing: s.briefing,
        images,
        mcp: s.mcp,
        model: s.model,
        effort: s.effort,
        mode: s.mode,
        allowAll: s.allowAll,
        sandbox: s.sandbox.on ? { writable: s.sandbox.writable, denied: s.sandbox.denied } : null,
        skills: copilotSkills(s.cwd).map((x) => x.name),
      });
      s.cancelled = false;
      const steps = plan(prompt, { cwd: s.cwd, images, mcp: s.mcp, briefing: s.briefing });
      if (steps[0] && steps[0].type === 'error') throw rpcError(steps[0].text);
      const user = lastUserMessage(prompt);
      const skillFiles = user !== undefined && directivesIn(user).skills ? skillsIn(s.briefing).map((x) => x.file) : [];
      return copilotTurn(peer, p.sessionId, s, steps, skillFiles);
    },
  });
}

/** One prompt's reply: its steps, each tool call as Copilot reports it, asking where it asks. */
async function copilotTurn(peer, sessionId, s, steps, skillFiles) {
  const u = sessionUpdates(peer, sessionId, () => s.cancelled);
  const usage = { inputTokens: 120, outputTokens: 30, totalTokens: 150, cachedReadTokens: 0, cachedWriteTokens: 0 };
  const ended = (stopReason) => ({ stopReason, usage });
  let prefix = '';
  let n = 0;
  const callId = () => `call_${++n}_${crypto.randomBytes(3).toString('hex')}`;
  const report = (call, status, extra = {}) => u.update({ sessionUpdate: 'tool_call_update', toolCallId: call.toolCallId, status, ...extra });

  /** Asks about `call` (unless allow-all): whether it may run. Refused, cancelled or unanswered, the turn is over. */
  const permit = async (call, asked) => {
    if (s.allowAll) return true;
    const answer = await Promise.race([
      requestPermission(peer, sessionId, { ...call, ...asked, status: 'pending' }, OPTIONS),
      new Promise((resolve) => {
        const watch = setInterval(() => s.cancelled && (clearInterval(watch), resolve({ outcome: { outcome: 'cancelled' } })), 50);
      }),
    ]);
    const ok = picked(answer, 'allow_once') || picked(answer, 'allow_always');
    if (!ok) record({ refused: call.title });
    return ok;
  };
  /** The end of a refused call: Copilot's own words, a notice, and nothing more. */
  const refused = (call) => {
    report(call, 'failed', { rawOutput: { message: 'The user rejected this tool call.', code: 'rejected' } });
    u.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Info: Operation cancelled by user' } });
    return ended(s.cancelled ? 'cancelled' : 'end_turn');
  };
  /** Whether its sandbox lets it write `file` (anywhere without one). */
  const mayWrite = (file) => !s.sandbox.on || (inside(file, s.sandbox.writable) && !inside(file, s.sandbox.denied));

  for (const step of steps) {
    if (s.cancelled) return ended('cancelled');
    if (step.type === 'fail') return fail(step.text);
    if (step.type === 'think') await u.thought(step.text);
    if (step.type === 'todo') u.plan(step.entries);
    if (step.type === 'tool') {
      // A view of the working directory: a read there asks nothing.
      const call = { toolCallId: callId(), title: `Viewing ${s.cwd}`, kind: 'read', rawInput: { path: s.cwd }, locations: [{ path: s.cwd }] };
      u.toolCall({ ...call, status: 'pending' });
      await self.sleep(20);
      report(call, 'completed', { rawOutput: { content: step.output } });
    }
    if (step.type === 'approve') {
      const call = { toolCallId: callId(), title: 'Print a line', kind: 'execute', rawInput: { command: step.command, description: 'Print a line' } };
      u.toolCall({ ...call, status: 'pending' });
      // `echo` it takes for read-only, and runs without asking.
      const readOnly = /^echo\b/.test(step.command);
      if (!readOnly && !(await permit(call, { title: step.command, rawInput: { command: step.command, commands: [step.command.split(' ')[0]] } }))) return refused(call);
      const out = 'e2e-approval\n';
      report(call, 'completed', {
        content: [{ type: 'content', content: { type: 'text', text: `${out}<shellId: ${n} completed with exit code 0>` } }],
        rawOutput: { content: `${out}<shellId: ${n} completed with exit code 0>`, contents: [{ type: 'shell_exit', shellId: String(n), exitCode: 0, cwd: s.cwd }] },
      });
      prefix += 'The command ran: e2e-approval. ';
    }
    if (step.type === 'fetch') {
      const call = { toolCallId: callId(), title: `Fetching ${step.url}`, kind: 'fetch', rawInput: { url: step.url } };
      u.toolCall({ ...call, status: 'pending' });
      if (!(await permit(call, { rawInput: { url: step.url } }))) return refused(call);
      report(call, 'completed', { rawOutput: { content: `Content of ${step.url}` } });
      prefix += `I read ${step.url}. `;
    }
    if (step.type === 'write') {
      const file = targetOf(step, s.cwd, s.others);
      if (!file) {
        prefix += noOther(step);
        continue;
      }
      const call = { toolCallId: callId(), title: `Creating ${file}`, kind: 'edit', rawInput: { path: file, file_text: step.content }, locations: [{ path: file }] };
      u.toolCall({ ...call, status: 'pending' });
      // Its file tools keep to its sandbox's policy, refusing without asking.
      if (!mayWrite(file)) {
        report(call, 'failed', { rawOutput: { message: inside(file, s.sandbox.denied) ? 'Is a sandbox denied path.' : "Outside the sandbox's writable paths.", code: 'failure' } });
        prefix += wrote(step, false);
        continue;
      }
      if (!(await permit(call, { title: 'Create file', rawInput: { fileName: file, diff: `+++ ${file}\n+${step.content}` } }))) return refused(call);
      const ok = tryWrite(file, step.content);
      report(call, ok ? 'completed' : 'failed', ok ? { rawOutput: { content: `Created file ${file} with ${step.content.length} characters` } } : { rawOutput: { message: `permission denied: ${file}` } });
      prefix += wrote(step, ok);
    }
    if (step.type === 'text') {
      // The tool library's skills it was asked to read: a read outside the working directories asks first.
      for (const skill of skillFiles) {
        const call = { toolCallId: callId(), title: `Viewing ${skill}`, kind: 'read', rawInput: { path: skill }, locations: [{ path: skill }] };
        u.toolCall({ ...call, status: 'pending' });
        if (!inside(skill, s.workspace) && !inside(skill, [os.tmpdir()]) && !(await permit(call, {}))) return refused(call);
        report(call, 'completed', { rawOutput: { content: '' } });
      }
      if (!(await u.message(prefix + step.text, step.slow))) return ended('cancelled');
    }
  }
  return ended(s.cancelled ? 'cancelled' : 'end_turn');
}

module.exports = {
  provider: 'copilot',
  bin: 'copilot',
  aliases: [],
  label: 'Copilot',
  name: 'Copilot',
  version: `GitHub Copilot CLI ${VERSION}.`,
  versionRe: /^GitHub Copilot CLI 1\.0\.999\.$/m,
  /** Its home: COPILOT_HOME, else ~/.copilot; for a run's own home, the account's, where its `session-state` leads. */
  home: (env) => {
    const own = env.COPILOT_HOME || path.join(os.homedir(), '.copilot');
    try {
      const link = path.join(own, 'session-state');
      if (fs.lstatSync(link).isSymbolicLink()) return path.dirname(fs.realpathSync(link));
    } catch {
      // no link: this home itself
    }
    return own;
  },
  /** The key it was given (COPILOT_GITHUB_TOKEN), by `keyVerdict`; null for none. */
  apiKey: (env) => (env.COPILOT_GITHUB_TOKEN ? keyVerdict(env.COPILOT_GITHUB_TOKEN) : null),
  main(args) {
    copilotStatic(args);
  },
};
