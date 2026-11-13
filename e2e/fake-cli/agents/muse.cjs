'use strict';
/*
 * The fake Muse Code (Meta's `muse`, provider id `muse`; 1.4.18 as Harness Relay drives it): `muse
 * acp` (ACP: `initialize`, `session/new`, `session/resume`, `session/set_config_option` of the
 * session's mode, `session/prompt`, `session/cancel`, and `session/request_permission` naming the call
 * by its `toolCallId` only, its details in the `tool_call` update before), and what the server asks
 * it besides: `--version`, `usage`, `login`, `logout`, `skills list --json`, `mcp list --json`.
 * Anything else exits at once with an error.
 *
 * Its folders are XDG's, on every system as the real one's: its config folder `$XDG_CONFIG_HOME/muse`
 * (else ~/.config/muse: `settings.json`, `trust.json`), and its data folder `$XDG_DATA_HOME/muse` (else
 * ~/.local/share/muse), which is its home here: its sessions (`e2e-sessions/`, with the mode each was
 * left in and the profile and sandbox it was made with), its marks and its sign-in. A turn's config
 * folder is one Harness Relay made for that turn alone (with a `trust.json` naming its working
 * directories untrusted below full access), while the data folder stays the account's. It is signed
 * in until signed out in its home (`logout`, E2E_FAKE_SIGNED_OUT) as the other fakes are, or by
 * META_API_KEY, which comes before any sign-in; signed out, `session/new` fails as the real one's does
 * ("log in to Muse before opening a session"), and `usage` says "not logged in".
 *
 * What it does is decided only by what Harness Relay set up, as with the real one:
 * - the permission profile its config folder's `settings.json` names (`permissions.default_profile`:
 *   Muse's `:auto-review`, `:ask-me`, `:read-only`, `:unrestricted`, or one of the settings' profiles
 *   that `extends` one), whose `"deny"` filesystem rules refuse its file tools and its commands those
 *   paths; a profile it cannot use fails `session/new` (closed). `:auto-review` lets its approval judge
 *   (an LLM, here approving whatever comes to it) answer what it would ask, unless
 *   MUSE_DISABLE_APPROVAL_JUDGE=1; `:read-only` refuses every write; `:unrestricted` asks nothing. A
 *   resumed session keeps the profile and sandbox it was made with, whatever this start's are, as the
 *   real one does (Harness Relay resumes one only with the same: `museGrant` in its adapter);
 * - the session's mode (`session/set_config_option` `mode`; a new session starts in `onRequest`, a
 *   resumed one in the mode it was left in): `allowAll` asks nothing; `onRequest` asks before a command
 *   that writes (twice when it writes outside the workspace), a web fetch, and a write in `.git`,
 *   `.muse` or `.agents`; `promptUnmatched` asks before every command and file write too;
 *   `denyUnmatched` refuses what would ask. A command that reaches the network asks again for it, in
 *   its sandbox, once it runs: an update titled `network <command>`, then a request for the same call
 *   (allow once, for the session, for the host, or reject); refused, its request is never sent;
 * - its flags: `--disable-write` (no `write_file` or `edit_file` at all), `--disable-sandbox`,
 *   `--trust-workspace`, `--model`, `-c reasoning_effort=…` and `-c run.developer_prompt=…` (the
 *   briefing, a JSON string; on Windows a long one comes on top of the prompt instead). It refuses
 *   `-c permissions…`, as the real one does ("permission-profile selection is wire surface");
 * - its sandbox, on unless `--disable-sandbox`: a command writes only in the workspace (the session's
 *   `cwd` and `additionalDirectories`), not in `.git`, `.muse` or `.agents` there, nor in a denied path:
 *   anywhere else a write it was allowed fails ("Operation not permitted"). On Linux a sandboxed command
 *   leaves an empty folder in each workspace folder for each path its bubblewrap mounts over, as the
 *   real one's does. Its file tools write in the workspace only, on every profile ("path escapes
 *   workspace", "absolute path is outside the workspace"), without asking;
 * - the answers to its permission requests: allow-once, or reject-once (`abort`); a refused or
 *   unanswered call fails with Muse's own words ("The user rejected this action…"), with no note
 *   from Harness Relay, and the turn carries on. A web fetch and a command's network are offered
 *   allow-for-the-session and allow-for-the-host too.
 * Unlike the real one, its sandbox does not let commands write in the temporary folder (`/tmp`,
 * macOS' `/private/var/folders`): the tests' folders are all in one, so a write next door would go
 * through and the tests could not tell what Harness Relay set up.
 *
 * Its tools, as the real one's: a listing is `search` (a glob), a command `bash` (each prints what
 * `echo e2e-approval` would), a write `write_file` (and when that is refused outside the workspace, a
 * `bash` command that writes there, as a model tries next), a web page `web_fetch` (nothing is
 * fetched), a to-do list a `plan` update, a tool library skill's SKILL.md `read_file`. It logs its
 * settings and trust at each start of `muse acp`, and each prompt with what it runs with (its mode,
 * profile, sandbox, model, effort, trust, its settings' own MCP servers, and the skills it loads by
 * itself: a bundled one, its data folder's `skills/`, and in a trusted workspace the project's
 * `.muse/skills` and `.agents/skills`). Its settings' MCP servers are where `muse mcp add` writes them,
 * `mcpServers` (`type` `stdio` or `streamable-http`), or the older `mcp_servers` (`transport`).
 * `skills list` answers only for a folder whose trust is decided (`trust.json`), as the real one asks
 * a terminal otherwise.
 *
 * On Windows its installer's launcher (`muse.cmd`, running `.muse-launcher.ps1`) starts the binary
 * `muse-bin-<version>.exe` its `.muse-version` names: the fake answers to that name too.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { acpAgent, picked, requestPermission, sessionUpdates } = require('../lib/acp.cjs');
const { inside, notAWorkingDirectory, ownSkills, realLocation, targetOf } = require('../lib/files.cjs');
const { keyVerdict, sessions, signIn, signedOut } = require('../lib/home.cjs');
const { exitAfterLog, record, tryWrite } = require('../lib/log.cjs');
const { declined, directivesIn, lastUserMessage, noOther, plan, recordMcpEnv, skillsIn, wrote } = require('../lib/plan.cjs');
const { fail, rpcError } = require('../lib/rpc.cjs');
const { args, flag, has, sleep } = require('../lib/self.cjs');

const VERSION = '1.4.999';
const BUILD = `${VERSION}-R1`;

// --- Its folders, settings and sign-in -----------------------------------------------------------

/** Its config folder: `$XDG_CONFIG_HOME/muse`, else ~/.config/muse. */
const configDir = () => path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'muse');
/** Its data folder: `$XDG_DATA_HOME/muse`, else ~/.local/share/muse (its home here). */
const dataDir = (env = process.env) => path.join(env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'muse');

const readJson = (file) => {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : undefined;
  } catch {
    return undefined;
  }
};

/** Signed in: by META_API_KEY, else by the sign-in its home keeps. */
const signedIn = () => Boolean(process.env.META_API_KEY) || !signedOut();

/** Its `-c key=value` settings for this start, each value read as JSON where it is (`"medium"`), else as written. */
function configArgs() {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '-c' && args[i] !== '--config') continue;
    const kv = args[++i] || '';
    const eq = kv.indexOf('=');
    const key = eq < 0 ? kv : kv.slice(0, eq);
    const raw = eq < 0 ? '' : kv.slice(eq + 1);
    let value = raw;
    try {
      value = JSON.parse(raw);
    } catch {
      /* a bare word */
    }
    out[key] = value;
  }
  return out;
}

/** Muse's own permission profiles. */
const BUILTIN = [':auto-review', ':ask-me', ':read-only', ':unrestricted'];

/**
 * The permission profile its settings name, as `{ id, base, deny }` (`base`: the built-in one it is,
 * or extends; `deny`: the paths its `"deny"` rules name). Throws, as Muse fails closed, on one it
 * cannot use.
 */
function profileOf(settings) {
  const perms = (settings && settings.permissions) || {};
  const id = typeof perms.default_profile === 'string' && perms.default_profile ? perms.default_profile : ':auto-review';
  if (BUILTIN.includes(id)) return { id, base: id, deny: [] };
  const p = perms.profiles && perms.profiles[id];
  if (!p || typeof p !== 'object') throw new Error(`Named permission profiles are unavailable: profile \`${id}\` is not defined`);
  if (!BUILTIN.includes(p.extends)) throw new Error(`Named permission profiles are unavailable: profile \`${id}\` extends unknown profile \`${p.extends}\``);
  const deny = [];
  for (const [file, rule] of Object.entries(p.filesystem || {})) {
    if (rule === 'deny') deny.push(file);
    else if (rule !== 'read' && rule !== 'write') throw new Error(`Named permission profiles are unavailable: unknown filesystem access \`${rule}\` for ${file}`);
    else if (!fs.existsSync(file)) throw new Error(`Named permission profiles are unavailable: \`${rule}\` on ${file} cannot be enforced (no live matcher)`);
  }
  if (p.extends === ':read-only' && deny.length) throw new Error(`Named permission profiles are unavailable: deny cannot be enforced on top of :read-only (${deny[0]})`);
  return { id, base: p.extends, deny };
}

/** The project root a workspace's trust is kept for: its repository's root, else the folder itself. */
function projectRoot(dir) {
  for (let at = path.resolve(dir); ; at = path.dirname(at)) {
    if (fs.existsSync(path.join(at, '.git'))) return at;
    if (path.dirname(at) === at) return path.resolve(dir);
  }
}

/**
 * Its trust in the workspace `cwd` (the folder, or its repository's root): `trusted` with
 * `--trust-workspace`, else the decision `trust.json` in its config folder keeps (`trusted` or
 * `untrusted`), else undefined: not decided yet.
 */
function trustOf(cwd) {
  if (has('--trust-workspace')) return 'trusted';
  const projects = (readJson(path.join(configDir(), 'trust.json')) || {}).projects || {};
  const at = new Set([realLocation(cwd), realLocation(projectRoot(cwd))]);
  const hit = Object.entries(projects).find(([p, v]) => v && (v.decision === 'trusted' || v.decision === 'untrusted') && at.has(realLocation(p)));
  return hit ? hit[1].decision : undefined;
}
const trusted = (cwd) => trustOf(cwd) === 'trusted';

/** The MCP servers its settings hold: `mcpServers` (what `muse mcp add` writes), then the older `mcp_servers`, each name once. */
function settingsMcp(settings) {
  const out = [];
  for (const key of ['mcpServers', 'mcp_servers']) {
    const list = settings && settings[key];
    if (!list || typeof list !== 'object' || Array.isArray(list)) continue;
    for (const [name, c] of Object.entries(list)) {
      if (out.some((x) => x.name === name)) continue;
      const kind = String((c && (c.type || c.transport)) || (c && c.url ? 'streamable-http' : 'stdio'));
      out.push({ name, type: /http/.test(kind) ? 'streamable-http' : 'stdio', enabled: !(c && c.enabled === false) });
    }
  }
  return out;
}

/** The skills it loads by itself for `cwd`: a bundled one, its data folder's, and in a trusted workspace the project's. */
function skillList(cwd) {
  const entry = (name, description, scope, file) => ({
    id: `${scope}:${name}`,
    name,
    display_name: name,
    description,
    short_description: null,
    scope,
    source: { type: 'local' },
    path: file,
    activation: 'on',
    diagnostics: [],
    provenance: null,
    context_cost: { startup_bytes: 120, startup_estimated_tokens: 30, invoke_bytes: null, invoke_estimated_tokens: null },
  });
  const out = [entry('muse-guide', 'A guide to the fake Muse Code, built in.', 'bundled', 'bundled://muse-core/skills/muse-guide/SKILL.md')];
  const add = (dir, scope) => {
    for (const s of ownSkills(dir)) if (!out.some((x) => x.name === s.name)) out.push(entry(s.name, s.description, scope, s.path));
  };
  if (trusted(cwd)) for (const r of ['.muse', '.agents']) add(path.join(projectRoot(cwd), r, 'skills'), 'project');
  add(path.join(dataDir(), 'skills'), 'user');
  return out;
}

// --- The commands that only ask it something -------------------------------------------------------

function museStatic() {
  if (has('--version') || has('-V')) return void process.stdout.write(`Muse Code ${VERSION} (${BUILD})\n`);
  const [command, sub] = args;
  if (command === 'usage') return usage();
  if (command === 'login') return login();
  if (command === 'logout') return logout();
  if (command === 'skills' && sub === 'list' && has('--json')) {
    // A folder whose trust is not decided: the real one asks a terminal, which a probe has none of.
    if (!trustOf(process.cwd())) {
      process.stderr.write(`muse skills list: decide whether to trust ${projectRoot(process.cwd())} first: run \`muse\` there in a terminal\n`);
      process.exitCode = 1;
      return;
    }
    return void process.stdout.write(`${JSON.stringify({ skills: skillList(process.cwd()), diagnostics: [] }, null, 2)}\n`);
  }
  if (command === 'mcp' && sub === 'list' && has('--json')) {
    return void process.stdout.write(`${JSON.stringify({ servers: settingsMcp(readJson(path.join(configDir(), 'settings.json'))) })}\n`);
  }
  // The real one would start its terminal UI (no arguments) or take words for a prompt: the fake refuses at once.
  process.stderr.write(`fake muse: unknown command ${args.join(' ') || '(none: no interactive mode here)'}\n`);
  process.exitCode = 1;
}

/** `muse usage`: the subscription allowance, which needs no model turn. */
function usage() {
  if (process.env.META_API_KEY) return void process.stdout.write('No subscription allowance (api_key)\n\n');
  if (signedOut()) {
    process.stderr.write('muse usage: not logged in: run `muse login` first\n');
    process.exitCode = 1;
    return;
  }
  process.stdout.write('Tier: free\nWindow: 2% used, resets in 4h\nWeekly: 1% used, resets in 6d\n');
}

/**
 * `muse login`: Meta's device sign-in, a page and a code to confirm there; approved when a line comes
 * on its stdin (an e-mail address there is the account) or after a moment, as in a browser.
 */
function login() {
  const code = 'E2EF-AKE1';
  process.stdout.write(`Open this page to sign in:\n  https://auth.example.invalid/oauth/device/?code=${code}\nconfirm this code matches:\n  ${code}\n\nWaiting for approval…\n`);
  let done = false;
  let timer;
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const finish = (said) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    rl.close();
    signIn.login(said);
    process.stdout.write('You are logged in.\n', () => exitAfterLog(0));
  };
  rl.on('line', (line) => finish(line.trim()));
  timer = setTimeout(() => finish(''), 1500);
}

/** `muse logout`: drops the sign-in it keeps (not a META_API_KEY). */
function logout() {
  if (signedOut()) return void process.stdout.write('no stored Meta credential to remove\n');
  signIn.logout();
  process.stdout.write('logged out: removed the stored Meta credential\n');
}

// --- `muse acp` -------------------------------------------------------------------------------------

const MODES = [
  { id: 'allowAll', name: 'Allow all', description: 'Run every action without asking for approval' },
  { id: 'promptUnmatched', name: 'Ask before unmatched actions', description: 'Ask for approval when no permission rule covers the action' },
  { id: 'onRequest', name: 'Ask on request', description: 'Ask for approval only when the action requires it' },
  { id: 'denyUnmatched', name: 'Deny unmatched actions', description: 'Refuse any action no permission rule covers' },
];
const DEFAULT_MODEL = 'muse-spark-1.3';

/** What it says of itself at `initialize`, as muse 1.4.18 does. */
const INITIALIZE = {
  protocolVersion: 1,
  agentCapabilities: {
    loadSession: true,
    promptCapabilities: { image: true, audio: false, embeddedContext: true },
    mcpCapabilities: { http: true, sse: false },
    sessionCapabilities: { list: {}, resume: {}, additionalDirectories: {} },
  },
  authMethods: [{ id: 'muse-login', name: 'Log in to Muse', description: 'Sign in with a device code shown in your browser.' }],
  agentInfo: { name: 'muse', version: VERSION },
};

/** What it offers when it asks: allow once, or reject. */
const OPTIONS = [
  { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'abort', name: 'Reject', kind: 'reject_once' },
];
/** What it offers for a host: a web page's, or a command's network: allow once, for the session, for the host, or reject. */
const NETWORK_OPTIONS = [
  OPTIONS[0],
  { optionId: 'allow_session', name: 'Allow for this session', kind: 'allow_always' },
  { optionId: 'allow_local_network', name: 'Always allow this network destination', kind: 'allow_always' },
  OPTIONS[1],
];

/** What the model is told of a call that was refused, as Muse words it. */
const REJECTED = "tool denied: approval aborted\nThe user rejected this action. Don't retry it unless they ask.";

/** The briefing as Harness Relay gives it (`museBriefing`): what is inside its wrapper. */
const WRAPPED = /^<harness-relay-briefing>\n[^\n]*\n\n([\s\S]*?)\n\n[^\n]*\n<\/harness-relay-briefing>$/;
/** The briefing on top of a prompt (on Windows, when it is too long for the command line). */
const ON_TOP = /^(<harness-relay-briefing>\n[\s\S]*?\n<\/harness-relay-briefing>)\n\n/;
const unwrap = (text) => (WRAPPED.exec(text) || [])[1] ?? text;

function sessionOptions(s) {
  return [
    { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: s.mode, options: MODES.map((m) => ({ value: m.id, name: m.name, description: m.description })) },
    { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: s.model || DEFAULT_MODEL, options: [{ value: s.model || DEFAULT_MODEL, name: s.model || DEFAULT_MODEL }] },
  ];
}
const modesOf = (s) => ({ currentModeId: s.mode, availableModes: MODES });

/** Keeps a session in its home: the mode it was left in, and the profile and sandbox it was made with. */
function saveSession(id, s) {
  fs.writeFileSync(sessions.file(id), JSON.stringify({ cwd: s.cwd, mode: s.mode, profile: s.rules.profile, sandbox: s.rules.sandbox }));
}

function museAcp() {
  const cfg = configArgs();
  const refused = Object.keys(cfg).find((k) => k === 'permissions' || k.startsWith('permissions.'));
  if (refused) return void process.stderr.write(`error: -c ${refused}: permission-profile selection is wire surface\n`, () => exitAfterLog(2));
  const settingsFile = path.join(configDir(), 'settings.json');
  const settings = readJson(settingsFile);
  // The settings and trust it starts with: what decides what runs without asking, and what it loads.
  const trust = readJson(path.join(configDir(), 'trust.json'));
  record({ settings: settings || null, settingsFile, trust: trust || null, judgeOff: process.env.MUSE_DISABLE_APPROVAL_JUDGE === '1' });
  const developerPrompt = typeof cfg['run.developer_prompt'] === 'string' ? cfg['run.developer_prompt'] : '';
  const model = flag('--model') || null;
  const effort = typeof cfg.reasoning_effort === 'string' ? cfg.reasoning_effort : null;

  const open = (method, p, agent) => {
    if (!signedIn()) throw rpcError('log in to Muse before opening a session', -32000);
    let profile;
    try {
      profile = profileOf(settings);
    } catch (err) {
      throw rpcError(err.message, -32603);
    }
    const resuming = method === 'session/resume';
    const id = resuming ? String(p.sessionId || '') : crypto.randomUUID();
    if (resuming && !sessions.resume(id)) throw rpcError(`session ${id} not found`, -32020, { kind: 'sessionNotFound', retryable: false, sessionId: id });
    if (!resuming) sessions.start(id);
    const kept = resuming ? readJson(sessions.file(id)) || {} : {};
    const cwd = p.cwd || process.cwd();
    const extra = Array.isArray(p.additionalDirectories) ? p.additionalDirectories : [];
    const s = {
      cwd,
      // The workspace: where its file tools and its sandbox let it write; the working directories among it.
      workspace: [cwd, ...extra],
      others: extra.filter((d) => !notAWorkingDirectory(d)),
      mode: MODES.some((m) => m.id === kept.mode) ? kept.mode : 'onRequest',
      model,
      effort,
      briefing: unwrap(developerPrompt),
      mcp: (p.mcpServers || []).map((x) => x.name),
      // A resumed session keeps the profile and sandbox it was made with, not this start's.
      rules: {
        profile: resuming && kept.profile ? kept.profile : profile,
        judge: (resuming && kept.profile ? kept.profile : profile).base === ':auto-review' && process.env.MUSE_DISABLE_APPROVAL_JUDGE !== '1',
        sandbox: resuming && typeof kept.sandbox === 'boolean' ? kept.sandbox : !has('--disable-sandbox'),
        writeTools: !has('--disable-write'),
      },
      cancelled: false,
    };
    agent.sessions.set(id, s);
    saveSession(id, s);
    recordMcpEnv(
      Object.fromEntries((p.mcpServers || []).map((x) => [x.name, Object.fromEntries((x.env || x.headers || []).map((v) => [v.name, v.value]))])),
      Object.fromEntries((p.mcpServers || []).filter((x) => x.type === 'http').map((x) => [x.name, x.url])),
    );
    // Its slash commands, told once the session is open (Harness Relay ignores them).
    setImmediate(() => agent.peer.notify('session/update', { sessionId: id, update: { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'compact', description: "Compact the conversation's context" }] } }));
    return { ...(resuming ? {} : { sessionId: id }), modes: modesOf(s), configOptions: sessionOptions(s) };
  };

  acpAgent({
    initialize: () => INITIALIZE,
    'session/new': (p, agent) => open('session/new', p, agent),
    'session/resume': (p, agent) => open('session/resume', p, agent),
    'session/set_config_option': (p, { peer, sessions: live }) => {
      const s = live.get(p.sessionId);
      if (!s) throw rpcError(`session ${p.sessionId} not found`, -32020, { kind: 'sessionNotFound', retryable: false, sessionId: p.sessionId });
      record({ setOption: { configId: p.configId, value: p.value } });
      if (p.configId === 'mode') {
        if (!MODES.some((m) => m.id === p.value)) throw rpcError(`unknown mode ${p.value}`, -32602);
        s.mode = p.value;
        saveSession(p.sessionId, s);
        peer.notify('session/update', { sessionId: p.sessionId, update: { sessionUpdate: 'current_mode_update', currentModeId: s.mode } });
      } else if (p.configId === 'model') {
        if (typeof p.value !== 'string' || !p.value) throw rpcError(`unknown model ${p.value}`, -32602);
        s.model = p.value;
      } else throw rpcError(`unknown config option ${p.configId}`, -32602);
      return { configOptions: sessionOptions(s) };
    },
    'session/prompt': (p, { peer, sessions: live }) => {
      const s = live.get(p.sessionId);
      if (!s) throw rpcError(`session ${p.sessionId} not found`, -32020, { kind: 'sessionNotFound', retryable: false, sessionId: p.sessionId });
      const blocks = p.prompt || [];
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text || '').join('\n');
      const images = blocks.filter((b) => b.type === 'image' && b.data).length;
      const top = ON_TOP.exec(text);
      if (top) s.briefing = unwrap(top[1]);
      const prompt = top ? text.slice(top[0].length) : text;
      const r = s.rules;
      record({
        prompt,
        briefing: s.briefing,
        briefingOnTop: Boolean(top),
        images,
        mcp: s.mcp,
        model: s.model,
        effort: s.effort,
        mode: s.mode,
        profile: r.profile.id,
        profileBase: r.profile.base,
        deny: r.profile.deny,
        judge: r.judge,
        sandbox: r.sandbox,
        writeTools: r.writeTools,
        trusted: trusted(s.cwd),
        // What it loads by itself: its settings' MCP servers, its bundled and own skills, and a trusted project's.
        ownMcp: settingsMcp(settings).map((x) => x.name),
        skills: skillList(s.cwd).map((x) => x.name),
      });
      s.cancelled = false;
      const denied = (file) => r.profile.deny.some((d) => inside(file, [d]));
      const steps = plan(prompt, { cwd: s.cwd, images, mcp: s.mcp, briefing: s.briefing, mayRead: (file) => !denied(file) });
      if (steps[0] && steps[0].type === 'error') throw rpcError(steps[0].text);
      const user = lastUserMessage(prompt);
      const skillFiles = user !== undefined && directivesIn(user).skills ? skillsIn(s.briefing).map((x) => x.file) : [];
      return museTurn(peer, p.sessionId, s, steps, skillFiles, denied);
    },
  });
}

// --- A turn -----------------------------------------------------------------------------------------

/** The folders of `.git`, `.muse` and `.agents` in the workspace, which it asks before writing, and its sandbox keeps read-only. */
function configPath(file, workspace) {
  return workspace.some((dir) => {
    if (!inside(file, [dir])) return false;
    const first = path.relative(realLocation(dir), realLocation(file)).split(/[\\/]/)[0];
    return ['.git', '.muse', '.agents'].includes(first);
  });
}

/**
 * What its sandbox leaves in each workspace folder on Linux, as muse 1.4.18's bubblewrap does: an empty
 * folder for each path it mounts over (`.agents` and `.muse` kept read-only, `.hg`, `.sl` and `.eden`
 * hidden) where there was none.
 */
function leaveMountPoints(workspace) {
  if (process.platform !== 'linux') return;
  for (const dir of workspace) {
    for (const name of ['.agents', '.muse', '.hg', '.sl', '.eden']) {
      try {
        fs.mkdirSync(path.join(dir, name));
      } catch {
        /* there already, or not ours to make */
      }
    }
  }
}

/** A shell word, quoted where the shell would split it. */
const shellWord = (s) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** One prompt's reply: its steps, each tool call as Muse reports it, asking where its profile and mode say so. */
async function museTurn(peer, sessionId, s, steps, skillFiles, denied) {
  const u = sessionUpdates(peer, sessionId, () => s.cancelled);
  const r = s.rules;
  let n = 0;
  const callId = () => `${crypto.randomUUID().slice(0, 18)}${String(++n).padStart(4, '0')}-${crypto.randomBytes(4).toString('hex')}`;
  const meta = () => ({ 'dev.muse': { providerToolCallId: `call_1_${n}` } });
  const update = (toolCallId, rest) => u.update({ sessionUpdate: 'tool_call_update', toolCallId, _meta: meta(), ...rest });
  const text = (t) => ({ type: 'content', content: { type: 'text', text: t } });
  const ended = (stopReason) => {
    u.update({ sessionUpdate: 'usage_update', used: 120, size: 0, _meta: { 'dev.muse': { contextSizeUnknown: true } } });
    return { stopReason };
  };
  let prefix = '';
  u.update({ sessionUpdate: 'session_info_update', _meta: { 'dev.muse': { branch: 'main' } } });

  /**
   * Whether a call of this kind asks first (`command`, `write-command`, `network`, `fetch`,
   * `config-write`, `file-write`): its mode's and profile's say.
   */
  const asks = (what) => {
    if (s.mode === 'allowAll' || r.profile.base === ':unrestricted') return false;
    if (what === 'command' || what === 'file-write') return s.mode === 'promptUnmatched' || s.mode === 'denyUnmatched';
    return true;
  };
  /**
   * The answer to a call that asks: refused by `denyUnmatched`, approved by the judge, else Harness
   * Relay's (an unanswered request counts as refused, and so does a stop while it waits).
   */
  const permit = async (toolCallId, options = OPTIONS) => {
    if (s.mode === 'denyUnmatched') return false;
    if (r.judge) return true;
    const asked = requestPermission(peer, sessionId, { toolCallId }, options);
    let watch;
    const stopped = new Promise((resolve) => {
      watch = setInterval(() => s.cancelled && resolve({ outcome: { outcome: 'cancelled' } }), 50);
    });
    const answer = await Promise.race([asked, stopped]);
    clearInterval(watch);
    const ok = picked(answer, 'allow_once') || picked(answer, 'allow_session');
    record({ permission: { toolCallId, answer: answer && answer.outcome ? answer.outcome.optionId || answer.outcome.outcome : null } });
    return ok;
  };
  /** A refused call's end, as Muse reports it: failed, then Muse's words to the model. */
  const rejected = (id, extra = {}) => {
    update(id, { status: 'failed', _meta: { 'dev.muse': { status: 'rejected' } } });
    update(id, { status: 'failed', ...extra, content: [...(extra.content || []), text(REJECTED)], rawOutput: REJECTED });
  };

  /**
   * A `bash` command: `writes` the files it writes (`content` each), `network` the host it reaches
   * (`registry.npmjs.org:443`), `output` what it prints. Asked about where its mode says so (twice when
   * it writes outside the workspace), then run in its sandbox, whose proxy asks again for its network
   * once it reaches it: `{ allowed, ok }` (`allowed`: neither it nor its network was refused).
   */
  const bash = async (command, description, { writes = [], content = '', network = '', output = '' } = {}) => {
    const id = callId();
    const asking = asks(writes.length ? 'write-command' : 'command');
    const code = text(`\`\`\`\n${command}\n\`\`\``);
    const input = { command, description };
    if (asking) u.toolCall({ toolCallId: id, title: `bash ${command}`, name: 'bash', kind: 'execute', status: 'pending', rawInput: input, _meta: meta() });
    else u.toolCall({ toolCallId: id, title: description, name: 'bash', kind: 'execute', status: 'in_progress', content: [code], rawInput: input, _meta: meta() });
    if (asking) {
      let ok = await permit(id);
      // A command that writes outside the workspace is asked about twice, as the real one asks.
      if (ok && writes.some((f) => !inside(f, s.workspace))) ok = await permit(id);
      if (!ok) {
        rejected(id, { title: description, content: [code] });
        return { allowed: false, ok: false };
      }
      update(id, { status: 'in_progress' });
    }
    update(id, { title: description, status: 'in_progress', content: [code] });
    await sleep(20);
    if (r.sandbox) leaveMountPoints(s.workspace);
    let out = '';
    let exit = 0;
    let reason;
    let allowed = true;
    // Its network goes through its sandbox's proxy, which asks for the host once the command reaches
    // it: an update saying so, then a request for the same call. `:read-only` has no network at all;
    // without a sandbox nothing asks.
    if (network && r.sandbox) {
      if (r.profile.base === ':read-only') {
        out = 'npm error network request failed: Could not resolve host\n';
        exit = 6;
      } else if (asks('network')) {
        u.update({ sessionUpdate: 'tool_call_update', toolCallId: id, title: `network ${command}` });
        if (!(await permit(id, NETWORK_OPTIONS))) {
          allowed = false;
          out = 'npm error code E403\nnpm error 403 Forbidden\n';
          exit = 1;
          reason = `user denied network access to ${network} \u2014 any HTTP 403 in the output is the sandbox proxy's denial of that request, not a response from the remote server; the request was never sent. Do not retry or route around the denial.`;
        }
      }
    }
    if (!exit) out = output;
    // Its sandbox: writes in the workspace only (not its `.git`, `.muse`, `.agents`, nor a denied path), none with `:read-only`.
    const mayWrite = (file) => !denied(file) && (!r.sandbox || (r.profile.base !== ':read-only' && inside(file, s.workspace) && !configPath(file, s.workspace)));
    for (const file of exit ? [] : writes) {
      if (mayWrite(file) && tryWrite(file, content)) continue;
      out += `/bin/sh: ${file}: Operation not permitted\n`;
      exit = 1;
      reason = `The sandbox blocked a write to ${file}: it is outside this session's writable roots (workspace, /tmp, $TMPDIR). Options: ask the user to allow it (permission profile)`;
    }
    const raw = JSON.stringify(
      {
        chunk_id: `exec-1-${n}`,
        command,
        description,
        exit_code: exit,
        terminal_status: exit ? 'failed' : 'completed',
        ...(reason ? { terminal_reason: reason } : {}),
        output: out,
        original_output_bytes: Buffer.byteLength(out),
        original_output_tokens: Math.ceil(out.length / 4),
        truncated: false,
      },
      null,
      2,
    );
    if (out) update(id, { title: description, status: 'in_progress', content: [code, text(out)], rawOutput: out });
    update(id, { title: description, status: exit ? 'failed' : 'completed', content: [code, text(exit ? `${out}exit code ${exit}` : out)], rawOutput: raw });
    return { allowed, ok: exit === 0 };
  };

  /** A `write_file` call: `{ ok }`, with `outside` when it was refused for being outside the workspace. */
  const writeTool = async (file, shown, content) => {
    const id = callId();
    const input = { path: shown, content };
    const call = { toolCallId: id, title: `write_file ${shown}`, name: 'write_file', kind: 'edit', locations: [{ path: file }], rawInput: input, _meta: meta() };
    const failed = (why) => {
      update(id, { status: 'failed', content: [text(`tool failed: ${why}`)], rawOutput: `tool failed: ${why}`, _meta: { 'dev.muse': { status: 'failed' } } });
      return { ok: false };
    };
    const asking = inside(file, s.workspace) && !denied(file) && r.profile.base !== ':read-only' && (configPath(file, s.workspace) ? asks('config-write') : asks('file-write'));
    u.toolCall({ ...call, status: asking ? 'pending' : 'in_progress' });
    await sleep(20);
    if (!inside(file, s.workspace)) {
      failed(path.isAbsolute(shown) ? 'absolute path is outside the workspace' : 'path escapes workspace');
      return { ok: false, outside: true };
    }
    if (denied(file) || r.profile.base === ':read-only') return failed('tool policy denied filesystem write');
    if (asking && !(await permit(id))) {
      rejected(id);
      return { ok: false, refused: true };
    }
    let oldText = '';
    try {
      oldText = fs.readFileSync(file, 'utf8');
    } catch {
      /* a new file */
    }
    if (asking) update(id, { status: 'in_progress' });
    if (!tryWrite(file, content)) return failed(`permission denied: ${file}`);
    const said = `wrote ${Buffer.byteLength(content)} bytes to ${file}`;
    update(id, { status: 'completed', content: [text(said), { type: 'diff', path: file, oldText, newText: content }], rawOutput: said });
    return { ok: true };
  };

  for (const step of steps) {
    if (s.cancelled) return ended('cancelled');
    if (step.type === 'fail') return fail(step.text);
    if (step.type === 'think') await u.thought(step.text);
    if (step.type === 'todo') u.plan(step.entries);
    if (step.type === 'tool') {
      // A listing of the working directory: its `search` tool with a glob, a read that asks nothing.
      const id = callId();
      u.toolCall({ toolCallId: id, title: `search ${s.cwd}`, name: 'search', kind: 'search', status: 'in_progress', locations: [{ path: s.cwd }], rawInput: { glob: '*', path: s.cwd }, _meta: meta() });
      await sleep(20);
      if (denied(s.cwd)) update(id, { status: 'failed', content: [text('tool failed: absolute path is outside the workspace')] });
      else update(id, { status: 'completed', content: [text(step.output)], rawOutput: step.output });
    }
    if (step.type === 'approve') {
      const publish = step.command.startsWith('npm publish');
      const ran = await bash(step.command, 'Print a line (an e2e check)', { network: publish ? 'registry.npmjs.org:443' : '', output: 'e2e-approval\n' });
      prefix += !ran.allowed ? declined('command', '') : ran.ok ? 'The command ran: e2e-approval. ' : 'The command failed. ';
      if (s.cancelled) return ended('cancelled');
    }
    if (step.type === 'fetch') {
      const id = callId();
      u.toolCall({ toolCallId: id, title: `web_fetch ${step.url}`, name: 'web_fetch', kind: 'fetch', status: 'in_progress', rawInput: { url: step.url }, _meta: meta() });
      // Every host is asked about (its network is proxy-only); nothing is fetched.
      const ok = !asks('fetch') || (await permit(id, NETWORK_OPTIONS));
      if (ok) update(id, { status: 'completed', content: [text(`Fetched ${step.url}`)], rawOutput: `Fetched ${step.url}` });
      else rejected(id);
      prefix += ok ? `I fetched ${step.url}. ` : `I may not fetch ${step.url} here. `;
    }
    if (step.type === 'write') {
      const file = targetOf(step, s.cwd, s.others);
      if (!file) {
        prefix += noOther(step);
        continue;
      }
      // Without its file tools (read-only) there is nothing to write with.
      if (!r.writeTools) {
        prefix += wrote(step, false);
        continue;
      }
      const shown = step.other ? file : step.path;
      let done = await writeTool(file, shown, step.content);
      // Refused outside the workspace, it tries a command that writes there, which its sandbox (if any) refuses.
      if (done.outside) {
        const command = `printf ${shellWord(step.content.replace(/\n/g, '\\n'))} > ${shellWord(shown)}`;
        done = await bash(command, `Write ${shown}`, { writes: [file], content: step.content });
      }
      prefix += wrote(step, done.ok);
      if (s.cancelled) return ended('cancelled');
    }
    if (step.type === 'text') {
      // The tool library's skills it was asked to read: its `read_file` reads anywhere but a denied path.
      for (const skill of skillFiles) {
        const id = callId();
        u.toolCall({ toolCallId: id, title: `read_file ${skill}`, name: 'read_file', kind: 'read', status: 'in_progress', locations: [{ path: skill }], rawInput: { path: skill }, _meta: meta() });
        if (denied(skill)) update(id, { status: 'failed', content: [text('tool failed: absolute path is outside the workspace')] });
        else update(id, { status: 'completed', content: [text(`read ${skill}`)], rawOutput: `read ${skill}` });
      }
      if (!(await u.message(prefix + step.text, step.slow))) return ended('cancelled');
    }
  }
  return ended(s.cancelled ? 'cancelled' : 'end_turn');
}

module.exports = {
  provider: 'muse',
  bin: 'muse',
  aliases: [],
  /** The binary its Windows launcher starts, `muse-bin-<version>.exe` (as the name it runs under: lower case, no `.exe`). */
  aliasRe: /^muse-bin-\d+\.\d+\.\d+-r\d+(\.\d+)?$/,
  label: 'Muse Code',
  name: 'Muse',
  version: `Muse Code ${VERSION} (${BUILD})`,
  versionRe: /^Muse Code 1\.4\.999 \(1\.4\.999-R1\)$/m,
  /** Its data folder, `$XDG_DATA_HOME/muse` (else ~/.local/share/muse): an account's stays its own in a turn, whose config folder is the turn's. */
  home: (env) => dataDir(env),
  /** The key it was given (META_API_KEY), by `keyVerdict`; null for none. */
  apiKey: (env) => (env.META_API_KEY ? keyVerdict(env.META_API_KEY) : null),
  main() {
    if (args[0] === 'acp') museAcp();
    else museStatic();
  },
};
