'use strict';
/*
 * The fake Antigravity (`agy`, 1.5.6 as Harness Relay drives it): `agy acp` (ACP: sessions with the
 * briefing in `_meta.antigravity.systemPrompt.append`, config options `model`, `thought_level` and
 * `mode`, `session/request_permission` with allow-once and deny-once only, and `logout`),
 * `acp --login`, `--version`, `models`, `-p /skills|/hooks|/agents --output-format json`,
 * `plugin list --json`; `--settings <json>` (one command's settings) anywhere before them.
 *
 * Its home is its `.gemini` folder: `--gemini-dir` (an account's own, `agy acp` only), else
 * `$HOME/.gemini` (the commands that only ask it something get an account's folder as HOME). Its
 * settings are `antigravity-cli/settings.json` there, or with `--cli_dir_name <name>` the run's own
 * `antigravity-cli/<name>/settings.json` alone. It is signed in with Google until signed out in that
 * home (`logout`, E2E_FAKE_SIGNED_OUT), or with GEMINI_API_KEY, which it uses only with
 * `modelProvider: "gemini"` in its settings (and then never the Google sign-in).
 *
 * It has no sandbox: what it does is decided by its settings, its flags and the answers to its
 * permission requests, as with the real one. In its `default` mode, with `toolPermission:
 * "request-review"` (or none), it asks before every command and every write (in the workspace too:
 * `accept-edits` mode writes there without asking) and before a read outside the workspace (the
 * working directory and the session's `additionalDirectories`, unless `allowNonWorkspaceAccess` is
 * true); `proceed-in-sandbox` runs commands without asking, and `always-proceed` or
 * `--dangerously-skip-permissions` asks nothing. A call allowed (or not asked about) runs wherever
 * it points; a web page it reads without asking (the fake reaches no network). A refused, cancelled
 * or unanswered call fails, and the turn ends there at once
 * (`end_turn`, nothing more said): the note a refusal carries is ignored (logged as `refused`).
 *
 * Each session keeps, in the home, the briefing it was last given (the real one adds each to its
 * system prompt) and its mode; a resumed session starts again on the default model and thinking
 * level (its settings' `model`, else gemini-fake-pro). It logs its settings at each start of a
 * turn, the project setup it would start by itself (`projectSetup`: `.agents/mcp_config.json`,
 * hooks, plugins, from each folder up to its repository's root), and the skills it loads by itself
 * (`<home>/config/skills`, a project's `.agents/skills`).
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { acpAgent, followup, picked, requestPermission, sessionUpdates } = require('../lib/acp.cjs');
const { inside, notAWorkingDirectory, ownSkills, targetOf } = require('../lib/files.cjs');
const { keyVerdict, sessions, signIn, signedOut } = require('../lib/home.cjs');
const { exitAfterLog, record, tryWrite } = require('../lib/log.cjs');
const { directivesIn, lastUserMessage, noOther, plan, recordMcpEnv, skillsIn, wrote } = require('../lib/plan.cjs');
const { fail, rpcError } = require('../lib/rpc.cjs');
const self = require('../lib/self.cjs');

const VERSION = '1.5.999';

/** Its models, as `agy models` lists them (one line per thinking level) and its sessions' options name them. */
const MODELS = [
  { id: 'gemini-fake-pro', name: 'Gemini Fake Pro', levels: ['low', 'high'] },
  { id: 'gemini-fake-flash', name: 'Gemini Fake Flash', levels: ['low', 'medium', 'high'] },
];
const DEFAULT_MODEL = 'gemini-fake-pro';
const MODES = [
  { id: 'default', name: 'Default', description: 'Ask before edits and commands, per your permission settings.' },
  { id: 'accept-edits', name: 'Accept edits', description: 'Approve file edits in the workspace without asking.' },
  { id: 'plan', name: 'Plan', description: 'Plan carefully before executing a task.' },
];

/** The customization folders it reads in a project, and what in them it starts or runs by itself. */
const AGY_ROOTS = ['.agents', '.agent', '_agents', '_agent'];
const AGY_RUNNABLE = ['mcp_config.json', 'hooks.json', 'plugins', 'plugins.json'];

const SIGNED_OUT_MODELS = 'Error: Please sign in to view available models. Launch the CLI without arguments to sign in.';
const capital = (s) => s[0].toUpperCase() + s.slice(1);

// --- Its settings and sign-in ---------------------------------------------------------------------

/** The arguments without the settings for one command (`--settings <json>`), and those settings. */
function withoutSettings(argv) {
  const rest = [];
  let given = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--settings') {
      rest.push(argv[i]);
      continue;
    }
    try {
      given = { ...given, ...JSON.parse(argv[i + 1]) };
    } catch {
      throw new Error(`invalid --settings: ${argv[i + 1]}`);
    }
    i++;
  }
  return { rest, given };
}

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
};

/** Its CLI folder in its home. */
const appDir = () => path.join(self.home(), 'antigravity-cli');

/**
 * The settings it runs with: a run's own folder's (`--cli_dir_name`) alone, else the account's
 * `settings.json`, with the settings given for this one command over them. `file`: where they were read.
 */
function settingsFor(given = {}) {
  const runDir = self.flag('--cli_dir_name');
  const file = runDir ? path.join(appDir(), runDir, 'settings.json') : path.join(appDir(), 'settings.json');
  const read = readJson(file);
  return { file, found: read !== undefined, settings: { ...(read && typeof read === 'object' ? read : {}), ...given } };
}

/** Whether it is signed in with these settings: by its key with `modelProvider: "gemini"`, else by the Google sign-in its home keeps. */
function signedInWith(settings) {
  if (settings.modelProvider === 'gemini') return Boolean(process.env.GEMINI_API_KEY);
  return !signedOut();
}

// --- What a folder holds for it ---------------------------------------------------------------------

/** The folders from `dir` up to its repository's root (a folder with `.git`), or `dir` alone outside one. */
function upToRepo(dir) {
  const dirs = [];
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    dirs.push(d);
    if (fs.existsSync(path.join(d, '.git'))) return dirs;
    if (path.dirname(d) === d) return [path.resolve(dir)];
  }
}

/** What a project makes it start or run by itself when a session opens (MCP servers, hooks, plugins). */
function projectSetup(dirs) {
  const found = new Set();
  for (const dir of dirs) {
    for (const up of upToRepo(dir)) for (const r of AGY_ROOTS) for (const f of AGY_RUNNABLE) {
      const p = path.join(up, r, f);
      if (fs.existsSync(p)) found.add(p);
    }
  }
  return [...found];
}

/** The skills it loads by itself for `cwd`: a project's (nearest first), then its home's `config/skills`. */
function agySkills(cwd) {
  const seen = new Set();
  const out = [];
  const add = (dir, source) => {
    for (const s of ownSkills(dir)) {
      if (seen.has(s.name)) continue;
      seen.add(s.name);
      out.push({ ...s, source });
    }
  };
  for (const up of upToRepo(cwd)) for (const r of AGY_ROOTS) add(path.join(up, r, 'skills'), 'project');
  add(path.join(self.home(), 'config', 'skills'), 'user');
  return out;
}

// --- The commands that only ask it something --------------------------------------------------------

/** One of the lists it answers in print mode without a model (`-p /skills --output-format json`). */
function printList(command, settings) {
  const answer = (name, data, response) =>
    JSON.stringify({
      conversation_id: '',
      status: 'SUCCESS',
      response,
      duration_seconds: 0,
      num_turns: 0,
      usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 },
      command: { name, data },
    }) + '\n';
  if (!signedInWith(settings)) {
    process.stdout.write(JSON.stringify({ conversation_id: '', status: 'ERROR', error: 'Please sign in to use Antigravity. Launch the CLI without arguments to sign in.' }) + '\n');
    process.exitCode = 1;
    return;
  }
  if (command === '/skills') {
    const builtin = { name: 'antigravity-guide', description: 'A guide to the fake Antigravity, built in.', path: path.join(appDir(), 'builtin', 'skills', 'antigravity-guide', 'SKILL.md'), builtin: true, model_invocable: true };
    const skills = [builtin, ...agySkills(process.cwd()).map((s) => ({ name: s.name, description: s.description, path: s.path, builtin: false, model_invocable: true }))];
    return void process.stdout.write(answer('skills', { skills }, skills.map((s) => `${s.name}\t${s.description}\n`).join('')));
  }
  if (command === '/hooks') return void process.stdout.write(answer('hooks', { hooks: [] }, ''));
  if (command === '/agents') return void process.stdout.write(answer('agents', { agents: [] }, ''));
  // Anything else would be a prompt for a model, which no fake has.
  process.stderr.write(`fake antigravity: print mode runs no model here (${command})\n`);
  process.exitCode = 1;
}

/** `acp --login`: Google's sign-in link (no browser over SSH), then the code pasted back, one line. */
function login() {
  process.stdout.write(
    'Open this link in a browser to log in with Google:\n\n  https://accounts.example.invalid/o/oauth2/auth?client_id=e2e-fake-agy&response_type=code\n\nThen paste the authorization code, or the full URL of the page you were redirected to:\n',
  );
  const rl = readline.createInterface({ input: process.stdin });
  let done = false;
  rl.once('line', (code) => {
    done = true;
    rl.close();
    if (!code.trim()) return void process.stderr.write('Error: no authorization code given\n', () => exitAfterLog(1));
    signIn.login(code.trim());
    process.stdout.write('Logged in with Google.\n', () => exitAfterLog(0));
  });
  rl.on('close', () => {
    if (!done) process.stderr.write('Error: no authorization code given\n', () => exitAfterLog(1));
  });
}

function agyStatic(argv) {
  let parsed;
  try {
    parsed = withoutSettings(argv);
  } catch (err) {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exitCode = 1;
    return;
  }
  const { rest, given } = parsed;
  if (rest.includes('--version')) return void process.stdout.write(`${VERSION}\n`);
  if (rest[0] === 'models') {
    const { settings } = settingsFor(given);
    process.stdout.write('Fetching available models...\n');
    if (!signedInWith(settings)) {
      process.stdout.write(`${SIGNED_OUT_MODELS}\n`);
      process.exitCode = 1;
      return;
    }
    const lines = MODELS.flatMap((m) => [...m.levels].reverse().map((l) => `${m.id}-${l}\t${m.name} (${capital(l)})\n`));
    return void process.stdout.write(lines.join(''));
  }
  if (rest[0] === '-p' && rest.includes('--output-format') && rest[rest.indexOf('--output-format') + 1] === 'json') {
    return printList(rest[1], settingsFor(given).settings);
  }
  if (rest[0] === 'plugin' && rest[1] === 'list') return void process.stdout.write('[]\n');
  if (rest[0] === 'acp' && rest.includes('--login')) return login();
  if (rest[0] === 'acp') return agyAcp();
  process.stderr.write(`fake antigravity: unknown command ${argv.join(' ') || '(none: no interactive mode here)'}\n`);
  process.exitCode = 1;
}

// --- `agy acp` ------------------------------------------------------------------------------------

/** What it says of itself at `initialize`: as agy 1.5.6 does (no `mcpCapabilities`: no HTTP MCP servers). */
const CAPABILITIES = {
  loadSession: true,
  promptCapabilities: { image: true, audio: false, embeddedContext: true },
  sessionCapabilities: { resume: {}, close: {}, load: {}, list: {}, additionalDirectories: {} },
  auth: { logout: {} },
  _meta: { antigravity: { tier: true, systemPrompt: { append: true } } },
};
const AUTH_METHODS = [
  { id: 'oauth-personal', name: 'Log in with Google', description: 'Log in with your Google account' },
  { id: 'gemini-api-key', name: 'Gemini API key', description: 'Use an API key with Gemini Developer API' },
];

/** The options it offers when it asks: allow once, or deny once. */
const OPTIONS = [
  { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
  { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
];

/** A model named by its settings (`gemini-fake-flash-high` or a base id) as a model and thinking level. */
function settingsModel(name) {
  const m = typeof name === 'string' ? MODELS.find((x) => name === x.id || x.levels.some((l) => name === `${x.id}-${l}`)) : undefined;
  if (!m) return { model: DEFAULT_MODEL, effort: 'low' };
  const level = m.levels.find((l) => name === `${m.id}-${l}`);
  return { model: m.id, effort: level || 'low' };
}

function configOptions(s) {
  const model = MODELS.find((m) => m.id === s.model);
  return [
    { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: s.model, options: MODELS.map((m) => ({ value: m.id, name: m.name })) },
    { id: 'thought_level', name: 'Thinking Level', category: 'thought_level', type: 'select', currentValue: s.effort, options: model.levels.map((l) => ({ value: l, name: capital(l) })) },
    { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: s.mode, options: MODES.map((m) => ({ value: m.id, name: m.name, description: m.description })) },
  ];
}

/** What a session keeps in its home besides being there: the briefing last appended, and its mode. */
function saveSession(id, s) {
  fs.writeFileSync(sessions.file(id), JSON.stringify({ briefing: s.briefing, mode: s.mode }));
}
function loadSession(id) {
  const kept = readJson(sessions.file(id));
  return kept && typeof kept === 'object' ? kept : {};
}

function agyAcp() {
  const { file, found, settings } = settingsFor();
  const skip = self.has('--dangerously-skip-permissions') || settings.toolPermission === 'always-proceed';
  const rules = {
    commandsAsk: !skip && settings.toolPermission !== 'proceed-in-sandbox',
    writesAsk: !skip,
    outsideReadsAsk: !skip && settings.allowNonWorkspaceAccess !== true,
  };
  // The run's settings as it read them: what decides what it asks about.
  if (self.has('--cli_dir_name')) record({ settings: found ? settings : null, settingsFile: file });
  const signedIn = signedInWith(settings);
  const mode = MODES.some((m) => m.id === settings.agentMode) ? settings.agentMode : 'default';
  const defaults = settingsModel(settings.model);

  const open = (method, p, agent) => {
    if (!signedIn) throw rpcError('Authentication required', -32000);
    const resuming = method === 'session/resume';
    const id = resuming ? p.sessionId : crypto.randomUUID();
    if (resuming && !sessions.resume(id)) throw rpcError(`session not found: ${id}`, -32002);
    if (!resuming) sessions.start(id);
    const kept = resuming ? loadSession(id) : {};
    const append = p._meta && p._meta.antigravity && p._meta.antigravity.systemPrompt && p._meta.antigravity.systemPrompt.append;
    const cwd = p.cwd || process.cwd();
    const extra = Array.isArray(p.additionalDirectories) ? p.additionalDirectories : [];
    const s = {
      cwd,
      // The workspace: where it reads without asking; the working directories among it, where a write may go.
      workspace: [cwd, ...extra],
      others: extra.filter((d) => !notAWorkingDirectory(d)),
      briefing: typeof append === 'string' && append ? append : kept.briefing || '',
      appended: typeof append === 'string' && Boolean(append),
      mode: kept.mode || mode,
      // A resumed session starts again on the default model and thinking level.
      model: defaults.model,
      effort: defaults.effort,
      mcp: (p.mcpServers || []).map((x) => x.name),
      cancelled: false,
    };
    agent.sessions.set(id, s);
    saveSession(id, s);
    recordMcpEnv(
      Object.fromEntries((p.mcpServers || []).map((x) => [x.name, Object.fromEntries((x.env || x.headers || []).map((v) => [v.name, v.value]))])),
      Object.fromEntries((p.mcpServers || []).filter((x) => x.type === 'http').map((x) => [x.name, x.url])),
    );
    // What it would start by itself now, outside any sandbox and without asking (the fake starts nothing).
    const setup = projectSetup(s.workspace);
    if (setup.length) record({ projectSetup: setup });
    return {
      sessionId: id,
      models: {
        availableModels: MODELS.flatMap((m) => m.levels.map((l) => ({ modelId: `${m.id}-${l}`, name: `${m.name} (${capital(l)})` }))),
        currentModelId: `${s.model}-${s.effort}`,
      },
      modes: { currentModeId: s.mode, availableModes: MODES },
      configOptions: configOptions(s),
    };
  };

  acpAgent({
    initialize: () => ({ protocolVersion: 1, agentCapabilities: CAPABILITIES, agentInfo: { name: 'Antigravity ACP Server', version: VERSION }, authMethods: AUTH_METHODS }),
    logout: () => {
      signIn.logout();
      return {};
    },
    'session/new': (p, agent) => open('session/new', p, agent),
    'session/resume': (p, agent) => open('session/resume', p, agent),
    'session/set_config_option': (p, { peer, sessions: live }) => {
      const s = live.get(p.sessionId);
      if (!s) throw rpcError(`session not found: ${p.sessionId}`, -32002);
      if (p.configId === 'model') {
        const m = MODELS.find((x) => x.id === p.value);
        if (!m) throw rpcError(`unknown model ${p.value}`, -32602);
        s.model = m.id;
        if (!m.levels.includes(s.effort)) s.effort = m.levels[0];
      } else if (p.configId === 'thought_level') {
        if (!MODELS.find((x) => x.id === s.model).levels.includes(p.value)) throw rpcError(`unknown thinking level ${p.value}`, -32602);
        s.effort = p.value;
      } else if (p.configId === 'mode') {
        if (!MODES.some((m) => m.id === p.value)) throw rpcError(`unknown mode ${p.value}`, -32602);
        s.mode = p.value;
        saveSession(p.sessionId, s);
      } else throw rpcError(`unknown config option ${p.configId}`, -32602);
      const options = configOptions(s);
      peer.notify('session/update', { sessionId: p.sessionId, update: { sessionUpdate: 'config_option_update', configOptions: options } });
      return { configOptions: options };
    },
    'session/prompt': (p, { peer, sessions: live }) => {
      const s = live.get(p.sessionId);
      if (!s) throw rpcError(`session not found: ${p.sessionId}`, -32002);
      const blocks = p.prompt || [];
      const prompt = blocks.filter((b) => b.type === 'text').map((b) => b.text || '').join('\n');
      const images = blocks.filter((b) => b.type === 'image' && b.data).length;
      record({
        prompt,
        briefing: s.briefing,
        briefingAppended: s.appended,
        images,
        mcp: s.mcp,
        model: s.model,
        effort: s.effort,
        mode: s.mode,
        // What it loads by itself: its home's skills and the project's.
        skills: agySkills(s.cwd).map((x) => x.name),
      });
      s.cancelled = false;
      // What it reads is said only once each read is allowed (a refused one ends the turn first).
      const steps = plan(prompt, { cwd: s.cwd, images, mcp: s.mcp, briefing: s.briefing });
      if (steps[0] && steps[0].type === 'error') throw rpcError(steps[0].text);
      const user = lastUserMessage(prompt);
      const skillFiles = user !== undefined && directivesIn(user).skills ? skillsIn(s.briefing).map((x) => x.file) : [];
      return agyTurn(peer, p.sessionId, s, rules, prompt, steps, skillFiles);
    },
  });
}

/** One prompt's reply: its steps, each tool call as agy reports it, asking where its rules say so. */
async function agyTurn(peer, sessionId, s, rules, prompt, steps, skillFiles) {
  const u = sessionUpdates(peer, sessionId, () => s.cancelled);
  const usage = { inputTokens: 120, outputTokens: 30, cachedReadTokens: 0, cachedWriteTokens: 0, thoughtTokens: 0, totalTokens: 150 };
  const ended = (stopReason) => ({ stopReason, usage });
  u.update({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: prompt } });
  let prefix = '';

  /** A tool call's update, carrying all agy repeats in each (its name, input, kind, title). */
  const report = (call, status, extra = {}) => u.update({ sessionUpdate: 'tool_call_update', ...call, status, ...extra });

  /**
   * Asks about `call` (once it was shown in progress): whether it may run. Refused, cancelled or
   * unanswered, the call fails and the turn is over (`stop` says how it ends).
   */
  const permit = async (call) => {
    report(call, 'pending');
    const asked = requestPermission(peer, sessionId, { sessionUpdate: 'tool_call', ...call, status: 'pending' }, OPTIONS);
    // Stopped while it waits: the request goes unanswered.
    let watch;
    const stopped = new Promise((resolve) => {
      watch = setInterval(() => s.cancelled && resolve({ outcome: { outcome: 'cancelled' } }), 50);
    });
    const answer = await Promise.race([asked, stopped]);
    clearInterval(watch);
    const ok = picked(answer, 'allow');
    report(call, 'in_progress');
    if (!ok) record({ refused: call.name, note: followup(answer) });
    return ok;
  };
  /** The end of a refused call: it failed, and nothing more is said. */
  const refused = (call, extra = {}) => {
    report(call, 'failed', extra);
    return ended(s.cancelled ? 'cancelled' : 'end_turn');
  };
  const inWorkspace = (file) => inside(file, s.workspace);
  let n = 0;
  const callId = () => `${sessionId.slice(0, 8)}-tc-${++n}-${crypto.randomBytes(3).toString('hex')}`;

  for (const step of steps) {
    if (s.cancelled) return ended('cancelled');
    if (step.type === 'fail') return fail(step.text);
    if (step.type === 'think') await u.thought(step.text);
    if (step.type === 'todo') u.plan(step.entries);
    if (step.type === 'tool') {
      // A listing of the working directory: a read in the workspace, which asks nothing.
      const input = { DirectoryPath: s.cwd };
      const call = { toolCallId: callId(), name: 'list_dir', args: input, kind: 'read', title: `Directory ${path.basename(s.cwd)}`, locations: [{ path: s.cwd }], rawInput: input };
      u.toolCall({ ...call, status: 'in_progress' });
      await self.sleep(20);
      report(call, 'completed', { content: [{ type: 'content', content: { type: 'text', text: step.output } }] });
    }
    if (step.type === 'approve') {
      const input = { CommandLine: step.command, WaitMsBeforeAsync: 3000, toolSummary: 'Print a line' };
      const call = { toolCallId: callId(), name: 'run_command', args: input, kind: 'execute', title: step.command, rawInput: input };
      u.toolCall({ ...call, status: 'in_progress' });
      if (rules.commandsAsk && !(await permit(call))) return refused(call, { rawOutput: { output: '' }, content: [{ type: 'content', content: { type: 'text', text: '' } }] });
      const at = new Date().toISOString();
      const output = `Created At: ${at}\nCompleted At: ${at}\nCommand exited with code 0.\n\nCommand output:\ne2e-approval\n`;
      report(call, 'completed', { rawOutput: { output, exit_code: 0 }, content: [{ type: 'content', content: { type: 'text', text: output } }] });
      prefix += 'The command ran: e2e-approval. ';
    }
    if (step.type === 'fetch') {
      // A web page: read without asking (the fake reaches no network: it says what it read).
      const input = { Url: step.url };
      const call = { toolCallId: callId(), name: 'read_url_content', args: input, kind: 'fetch', title: step.url, rawInput: input };
      u.toolCall({ ...call, status: 'in_progress' });
      report(call, 'completed', { content: [{ type: 'content', content: { type: 'text', text: `Content of ${step.url}` } }] });
      prefix += `I read ${step.url}. `;
    }
    if (step.type === 'write') {
      const file = targetOf(step, s.cwd, s.others);
      if (!file) {
        prefix += noOther(step);
        continue;
      }
      const input = { Content: step.content, Path: file };
      const call = { toolCallId: callId(), name: 'write_file', args: input, kind: 'edit', title: `File ${path.relative(s.cwd, file) || path.basename(file)}`, locations: [{ path: file }], rawInput: input };
      u.toolCall({ ...call, status: 'in_progress' });
      const asks = rules.writesAsk && !(s.mode === 'accept-edits' && inWorkspace(file));
      if (asks && !(await permit({ ...call, content: [{ type: 'diff', path: file, newText: step.content }] }))) return refused(call);
      // No sandbox: written wherever it points, unless the file system refuses.
      const ok = tryWrite(file, step.content);
      report(call, ok ? 'completed' : 'failed', ok ? { rawOutput: {}, content: [{ type: 'diff', path: file, newText: step.content }] } : { content: [{ type: 'content', content: { type: 'text', text: `permission denied: ${file}` } }] });
      prefix += wrote(step, ok);
    }
    if (step.type === 'text') {
      // The tool library's skills it was asked to read: outside the workspace a read asks first.
      for (const skill of skillFiles) {
        const input = { Path: skill };
        const call = { toolCallId: callId(), name: 'read_file', args: input, kind: 'read', title: `File ${path.basename(path.dirname(skill))}/${path.basename(skill)}`, locations: [{ path: skill }], rawInput: input };
        u.toolCall({ ...call, status: 'in_progress' });
        if (rules.outsideReadsAsk && !inWorkspace(skill) && !(await permit(call))) return refused(call);
        report(call, 'completed');
      }
      if (!(await u.message(prefix + step.text, step.slow))) return ended('cancelled');
    }
  }
  return ended(s.cancelled ? 'cancelled' : 'end_turn');
}

module.exports = {
  provider: 'antigravity',
  bin: 'agy',
  aliases: [],
  label: 'Antigravity',
  name: 'Antigravity',
  version: VERSION,
  versionRe: /^1\.5\.999$/m,
  /** Its `.gemini` folder: `--gemini-dir` (an account's own, for `agy acp`), else `$HOME/.gemini`. */
  home: (env, args) => {
    const i = args.indexOf('--gemini-dir');
    return i >= 0 && args[i + 1] ? path.resolve(args[i + 1]) : path.join(os.homedir(), '.gemini');
  },
  /** The key it was given (GEMINI_API_KEY), by `keyVerdict`; null for none. */
  apiKey: (env) => (env.GEMINI_API_KEY ? keyVerdict(env.GEMINI_API_KEY) : null),
  main(args) {
    agyStatic(args);
  },
};
