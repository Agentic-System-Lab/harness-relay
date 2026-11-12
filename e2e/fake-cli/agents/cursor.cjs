'use strict';
/*
 * The fake Cursor (`cursor-agent`, provider id `cursor`): `cursor-agent [--disable-project-configs]
 * [--force] acp` (ACP: `initialize`, `authenticate`, `cursor/list_available_models`, `session/new`,
 * `session/load` with its history replayed first, `session/set_config_option`, `session/prompt`,
 * `session/request_permission`), `--version`, `status --format json`, `login`, `logout`.
 *
 * Cursor has no OS sandbox. What it does is decided only by what Harness Relay gave it, as with the
 * real one (cursor-agent 2026.11.11): `--force` or `approvalMode: "unrestricted"` (run everything),
 * `permissions.allow` / `permissions.deny` and `model.modelId` of `cli-config.json` in
 * CURSOR_CONFIG_DIR (with a project's `.cursor/cli.json` merged over it, unless
 * `--disable-project-configs`), and the answers to its permission requests. Below full access:
 * - a command asks, unless an allow rule (`Shell(echo)`) or a Cursor team's auto-run allowlist
 *   (E2E_FAKE_CURSOR_TEAM_ALLOW, command prefixes) covers it;
 * - its write tool writes inside the workspace (the session's `cwd`) without asking, but for Cursor's
 *   protected files (`.git/config`, `.vscode/**`, `.cursor/*.json`…), and asks anywhere else; a delete
 *   always asks (`e2e:delete=<path>`, Cursor's only);
 * - its read tool reads anywhere;
 * - a deny rule refuses before anything is asked, at every level, and the call is reported
 *   completed with nothing done (as Cursor reports a refused call). Rules match the path as written
 *   (absolute, `\` as `/`), by letter case, without resolving links; `**` is everything, `<dir>/**`
 *   the folder and all under it, a relative pattern is in the workspace.
 * It knows the chat's other working directories only from its briefing (it gets no folder list).
 * Unlike the real one, it does not write in a temporary folder (`/tmp`, macOS' `/private/var/folders`)
 * without asking: the end-to-end tests' folders are all in one, so every write outside the workspace
 * would go through unasked and the tests could not tell what Harness Relay set up.
 *
 * A refusal reaches it as Cursor's own "Rejected: User rejected": it ignores the note Harness Relay
 * sends with it (`_meta.followup_message`). The model's questions (`e2e:ask`) are asked first as
 * Cursor asks them when the client has no `cursor/ask_question`: a permission request with a skip option.
 * A service error (`e2e:error`) is reply text of its own (`"\n\nError: …"`), as Cursor sends one.
 *
 * Homes: the account's folder is CURSOR_CONFIG_DIR, else `$XDG_CONFIG_HOME/cursor`, else ~/.cursor; in
 * a turn CURSOR_CONFIG_DIR is a private folder of that turn's own (deleted after it), whose
 * `acp-sessions` links into the account's folder, which is then the home: sessions
 * (`acp-sessions/<id>/e2e-session.json`, with the briefing they were given) and marks go there.
 * What it writes into CURSOR_CONFIG_DIR's `cli-config.json` (a session's model, an "allow always"
 * rule) goes with that folder, as the real one's does.
 *
 * Its sign-in is one per computer user, as Cursor's (the macOS keychain, an `auth.json` elsewhere),
 * kept in `<XDG_CONFIG_HOME or ~/.config>/cursor/` whatever CURSOR_CONFIG_DIR says: signed in as
 * e2e@example.com (`e2e-auth` names another) until `logout` leaves `e2e-signed-out`, and E2E_FAKE_SIGNED_OUT
 * naming `cursor` signs it out too. A key (CURSOR_API_KEY, CURSOR_AUTH_TOKEN) signs a run in by itself,
 * until `authenticate` runs over it (the real one then drops the key). AGENT_CLI_CREDENTIAL_STORE=memory
 * keeps the shared sign-in out of the run: neither read nor written. `login` completes when a line
 * comes on its stdin (an e-mail address there is the account) or after E2E_FAKE_CURSOR_LOGIN_MS
 * (default 1500; 0: a line only).
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { acpAgent, picked, requestPermission, sessionUpdates } = require('../lib/acp.cjs');
const { inside, targetOf } = require('../lib/files.cjs');
const { keyVerdict } = require('../lib/home.cjs');
const { exitAfterLog, record, tryWrite } = require('../lib/log.cjs');
const { declined, directivesIn, lastUserMessage, noOther, plan, recordMcpEnv, wrote } = require('../lib/plan.cjs');
const { fail, rpcError } = require('../lib/rpc.cjs');
const { args, has, sleep } = require('../lib/self.cjs');

// --- Folders and sign-in -----------------------------------------------------------------------

/** Cursor's config folder for this start: CURSOR_CONFIG_DIR, else `$XDG_CONFIG_HOME/cursor`, else ~/.cursor (`cursorConfigDir()`). */
function configDir(env = process.env) {
  if (env.CURSOR_CONFIG_DIR) return env.CURSOR_CONFIG_DIR;
  return env.XDG_CONFIG_HOME ? path.join(env.XDG_CONFIG_HOME, 'cursor') : path.join(os.homedir(), '.cursor');
}

/** The folder of the sign-in Cursor keeps once per computer user, which CURSOR_CONFIG_DIR does not move. */
const sharedDir = () => path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'cursor');
const memoryStore = () => process.env.AGENT_CLI_CREDENTIAL_STORE === 'memory';
const envKey = () => process.env.CURSOR_API_KEY || process.env.CURSOR_AUTH_TOKEN || '';

/** The shared sign-in's account, or null: signed out, or kept out of this run (`memory`). */
function storedSignIn() {
  if (memoryStore()) return null;
  const out = (process.env.E2E_FAKE_SIGNED_OUT || '').split(',').map((c) => c.trim().toLowerCase());
  if (out.includes('cursor') || fs.existsSync(path.join(sharedDir(), 'e2e-signed-out'))) return null;
  try {
    return fs.readFileSync(path.join(sharedDir(), 'e2e-auth'), 'utf8').trim() || 'e2e@example.com';
  } catch {
    return 'e2e@example.com';
  }
}

const readJson = (file) => {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : undefined;
  } catch {
    return undefined;
  }
};

/** Changes `cli-config.json` in its config folder, as Cursor does when a session's model changes or a rule is always allowed. */
function updateConfig(change) {
  const file = path.join(configDir(), 'cli-config.json');
  const cfg = readJson(file) || { version: 1 };
  change(cfg);
  tryWrite(file, `${JSON.stringify(cfg, null, 2)}\n`);
}

// --- Static commands ---------------------------------------------------------------------------

function cursorStatic() {
  const store = process.env.AGENT_CLI_CREDENTIAL_STORE || null;
  const noBrowser = process.env.NO_OPEN_BROWSER || null;
  if (has('--version')) return void process.stdout.write(`${module.exports.version}\n`);
  if (args[0] === 'status' || args[0] === 'whoami') {
    // The shared sign-in only: a key in the environment signs a run in, not `status`.
    const email = storedSignIn();
    if (args.includes('json')) {
      const status = email
        ? { status: 'authenticated', isAuthenticated: true, userInfo: { email } }
        : { status: 'unauthenticated', isAuthenticated: false, message: 'Not logged in' };
      return void process.stdout.write(JSON.stringify(status) + '\n');
    }
    return void process.stdout.write(email ? `\n ✓ Logged in as ${email}\n` : '\n Not logged in\n');
  }
  if (args[0] === 'login') return cursorLogin(store, noBrowser);
  if (args[0] === 'logout') {
    record({ logout: { store } });
    if (!memoryStore()) {
      fs.mkdirSync(sharedDir(), { recursive: true });
      fs.writeFileSync(path.join(sharedDir(), 'e2e-signed-out'), '');
      fs.rmSync(path.join(sharedDir(), 'e2e-auth'), { force: true });
    }
    return void process.stdout.write('Logged out successfully.\n');
  }
  // The real one takes words it does not know for a prompt (and would start a chat): the fake refuses them at once.
  process.stderr.write(`fake cursor: unknown command ${args.join(' ')}\n`);
  process.exitCode = 1;
}

/**
 * `login`: the link to sign in at (no browser opened with NO_OPEN_BROWSER), then waiting until the
 * browser finishes, here a line on stdin (an e-mail address there is the account) or a moment.
 */
function cursorLogin(store, noBrowser) {
  record({ login: { store, noBrowser } });
  const url = `https://cursor.example.invalid/loginDeepControl?challenge=e2e-${process.pid}`;
  if (!noBrowser) process.stdout.write('Opening the browser…\n');
  process.stdout.write(`\nOpen a browser and navigate to this link: ${url}\n\nWaiting for the browser to finish…\n`);
  const after = Number(process.env.E2E_FAKE_CURSOR_LOGIN_MS ?? 1500);
  let done = false;
  let timer;
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const finish = (said) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    rl.close();
    // In the memory store a sign-in lasts for this process only: nothing is kept.
    if (!memoryStore()) {
      fs.mkdirSync(sharedDir(), { recursive: true });
      fs.rmSync(path.join(sharedDir(), 'e2e-signed-out'), { force: true });
      if (/^[^\s@]+@[^\s@]+$/.test(said)) fs.writeFileSync(path.join(sharedDir(), 'e2e-auth'), said);
      else fs.rmSync(path.join(sharedDir(), 'e2e-auth'), { force: true });
    }
    process.stdout.write('\nLogin successful!\n', () => exitAfterLog(0));
  };
  rl.on('line', (line) => finish(line.trim()));
  rl.on('close', () => {
    if (!done && !(after > 0)) process.stderr.write('Login cancelled.\n', () => exitAfterLog(1));
  });
  if (after > 0) timer = setTimeout(() => finish(''), after);
}

// --- Models and a session's options ------------------------------------------------------------

const EFFORTS = ['low', 'medium', 'high'];

/** Its models, each with its own options (the parameterized model picker): `cursor-fake` has an effort, `cursor-fake-think` a thinking switch. */
const MODELS = [
  { value: 'default', name: 'Auto', levels: {} },
  { value: 'cursor-fake', name: 'Cursor Fake', levels: { effort: 'medium' } },
  // A zero-width space and a double space, as some of Cursor's names have.
  { value: 'cursor-fake-think', name: 'Cursor Fake​  Thinking', levels: { thinking: 'true' } },
];
const modelOf = (id) => MODELS.find((m) => m.value === id);

/** A model's own options, at the values `levels` gives. */
function levelOptions(model, levels) {
  const out = [];
  if ('effort' in model.levels) {
    out.push({
      id: 'effort',
      name: 'Effort',
      category: 'thought_level',
      type: 'select',
      currentValue: levels.effort,
      options: EFFORTS.map((value) => ({ value, name: value[0].toUpperCase() + value.slice(1) })),
    });
  }
  if ('thinking' in model.levels) {
    out.push({ id: 'thinking', name: 'Thinking', category: 'thought_level', type: 'select', currentValue: levels.thinking, options: [{ value: 'false', name: 'Off' }, { value: 'true', name: 'On' }] });
  }
  return out;
}

/** `cursor/list_available_models`: one entry a model with its options, or (no parameterized picker) one a combination. */
function modelList(picker) {
  if (picker) return MODELS.map((m) => ({ value: m.value, name: m.name, configOptions: levelOptions(m, m.levels) }));
  return MODELS.flatMap((m) =>
    'effort' in m.levels ? EFFORTS.map((e) => ({ value: `${m.value}-${e}`, name: `${m.name} ${e}`, configOptions: [] })) : [{ value: m.value, name: m.name, configOptions: [] }],
  );
}

/** A session's options: its mode, its model, and the model's own. */
function sessionOptions(s) {
  return [
    {
      id: 'mode',
      name: 'Mode',
      category: 'mode',
      type: 'select',
      currentValue: s.mode,
      options: [
        { value: 'agent', name: 'Agent' },
        { value: 'ask', name: 'Ask' },
        { value: 'plan', name: 'Plan' },
      ],
    },
    { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: s.model, options: MODELS.map((m) => ({ value: m.value, name: m.name })) },
    ...levelOptions(modelOf(s.model), s.levels),
  ];
}

/** The reasoning effort a session runs at: its model's effort option's value, or null (none, or only a thinking switch). */
const effortOf = (s) => (s.levels.effort === undefined ? null : s.levels.effort);

// --- Permission rules --------------------------------------------------------------------------

/** A glob as Cursor's rules have it: `**` everything, `<dir>/**` the folder and all under it, `*` and `?` within a name. */
function globRe(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') {
        i++;
        re += '(?:.*/)?';
      } else if (re.endsWith('/')) re = `${re.slice(0, -1)}(?:/.*)?`;
      else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

const slashed = (p) => p.replace(/\\/g, '/');

/** Whether a path rule's pattern covers `file` (as written); a relative pattern is in the workspace `cwd`. */
function pathMatch(pattern, file, cwd) {
  const p = slashed(pattern.trim());
  const abs =
    p.startsWith('**') || p.startsWith('/') || /^[A-Za-z]:\//.test(p)
      ? p
      : p === '~' || p.startsWith('~/')
        ? slashed(os.homedir()) + p.slice(1)
        : `${slashed(cwd).replace(/\/+$/, '')}/${p.replace(/^\.\//, '')}`;
  return globRe(abs).test(slashed(file));
}

/** Whether a `Shell(<prefix>)` rule covers `command`: the prefix itself, or it and its arguments (`*` anything). */
function shellMatch(pattern, command) {
  const p = pattern.trim();
  if (p.includes('*')) return new RegExp(`^${p.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(command);
  return command === p || command.startsWith(`${p} `);
}

function ruleMatches(rule, tool, subject, cwd) {
  const m = /^([A-Za-z]+)\(([\s\S]*)\)$/.exec(String(rule).trim());
  if (!m || m[1] !== tool) return false;
  return tool === 'Shell' ? shellMatch(m[2], subject) : pathMatch(m[2], subject, cwd);
}

const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);

/**
 * The rules of a session in `cwd`: those of `cfg` (its config folder's `cli-config.json`), with the
 * project's `.cursor/cli.json` merged over them unless `--disable-project-configs`.
 */
function rulesFor(cwd, cfg) {
  const own = (cfg && cfg.permissions) || {};
  let allow = strings(own.allow);
  let deny = strings(own.deny);
  let approvalMode = cfg && typeof cfg.approvalMode === 'string' ? cfg.approvalMode : null;
  const project = has('--disable-project-configs') ? undefined : readJson(path.join(cwd, '.cursor', 'cli.json'));
  if (project) {
    const perms = project.permissions || {};
    allow = [...allow, ...strings(perms.allow)];
    deny = [...deny, ...strings(perms.deny)];
    if (typeof project.approvalMode === 'string') approvalMode = project.approvalMode;
  }
  const team = (process.env.E2E_FAKE_CURSOR_TEAM_ALLOW || '').split(',').map((x) => x.trim()).filter(Boolean);
  const force = has('--force');
  return {
    cwd,
    allow,
    deny,
    team,
    approvalMode,
    projectConfig: Boolean(project),
    runEverything: force || approvalMode === 'unrestricted',
    denied: (tool, subject) => deny.some((r) => ruleMatches(r, tool, subject, cwd)),
    allowed: (tool, subject) => allow.some((r) => ruleMatches(r, tool, subject, cwd)) || (tool === 'Shell' && team.some((t) => shellMatch(t, subject))),
  };
}

/** The workspace files Cursor asks about before writing, as a write there could make code run later. */
const CURSOR_PROTECTED = ['.git/hooks/**', '.git/config', '.vscode/**', '.claude/*.json', '.cursor/*.json', '*.code-workspace'].map(globRe);

function cursorProtected(file, cwd) {
  const rel = slashed(path.relative(cwd, file));
  return !rel.startsWith('..') && !path.isAbsolute(rel) && CURSOR_PROTECTED.some((re) => re.test(rel));
}

// --- Its own setup: skills, MCP servers ---------------------------------------------------------

/**
 * The skills Cursor loads by itself (`cursorSkills()`): the `skills` folders of `.cursor`, `.claude`,
 * `.codex`, `.grok` and `.agents` in the working directory, then in the home folder, then
 * ~/.cursor/skills-cursor; a folder with a SKILL.md each (links left out), named by its front matter,
 * the first of a name winning.
 */
function cursorSkills(cwd) {
  const home = os.homedir();
  const kinds = ['.cursor', '.claude', '.codex', '.grok', '.agents'];
  const places = [...kinds.map((k) => path.join(path.resolve(cwd), k, 'skills')), ...kinds.map((k) => path.join(home, k, 'skills')), path.join(home, '.cursor', 'skills-cursor')];
  const found = [];
  for (const dir of places) {
    let names = [];
    try {
      names = fs.readdirSync(dir).sort();
    } catch {
      continue;
    }
    for (const n of names) {
      const folder = path.join(dir, n);
      let text;
      try {
        if (!fs.lstatSync(folder).isDirectory()) continue;
        text = fs.readFileSync(path.join(folder, 'SKILL.md'), 'utf8');
      } catch {
        continue;
      }
      const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
      const name = ((fm && /^name:\s*["']?(.+?)["']?\s*$/m.exec(fm[1])) || [])[1] || n;
      if (!found.includes(name)) found.push(name);
    }
  }
  return found;
}

/** The MCP servers of the user's own ~/.cursor/mcp.json (names only), which Cursor loads by itself. */
function ownMcp() {
  const servers = (readJson(path.join(os.homedir(), '.cursor', 'mcp.json')) || {}).mcpServers;
  return servers && typeof servers === 'object' ? Object.keys(servers) : [];
}

/**
 * The working directories besides `cwd` that a briefing names (Harness Relay's `use full paths for
 * the others`; in parallel mode, a worktree of each): Cursor gets no folder list, so only its
 * briefing says where they are.
 */
function briefedOthers(briefing, cwd) {
  const shared = /share these working directories, each with the same access: (.+?)\. You start in /.exec(briefing);
  const dirs = shared ? shared[1].split(', ') : [...briefing.matchAll(/^ {2}- (.+?) \(branch /gm)].map((m) => m[1]);
  return dirs.filter((d) => path.resolve(d) !== path.resolve(cwd));
}

// --- Sessions ----------------------------------------------------------------------------------

/** Where a session is kept: in `acp-sessions`, which in a turn links into the account's folder. */
const sessionFile = (id) => path.join(configDir(), 'acp-sessions', encodeURIComponent(id), 'e2e-session.json');

function saveSession(s) {
  const { id, cwd, briefing, mode, model, levels, history } = s;
  fs.mkdirSync(path.dirname(sessionFile(id)), { recursive: true });
  fs.writeFileSync(sessionFile(id), JSON.stringify({ id, cwd, briefing, mode, model, levels, history }, null, 2));
}

function loadSession(id) {
  return readJson(sessionFile(id));
}

/** The briefing Harness Relay puts at the top of a prompt (`cursorPromptText()`): it has no system prompt over ACP. */
const BRIEFING_RE = /^<harness-relay-briefing>\nStanding instructions from Harness Relay[^\n]*\n\n([\s\S]*?)\n<\/harness-relay-briefing>\n\n/;

/** The lead agent's prompts (`plan()` answers them with JSON only). */
const LEAD_PROMPT = /Reply with only one of these JSON objects|Reply with only this JSON object/;

// --- The ACP agent -----------------------------------------------------------------------------

/** The options Cursor offers when it asks (Harness Relay never answers "allow always"). */
const OPTIONS = [
  { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'allow-always', name: 'Allow always', kind: 'allow_always' },
  { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
];

function cursorAgent() {
  const cfg = readJson(path.join(configDir(), 'cli-config.json'));
  record({
    cwd: process.cwd(),
    configDir: process.env.CURSOR_CONFIG_DIR || null,
    store: process.env.AGENT_CLI_CREDENTIAL_STORE || null,
    noBrowser: process.env.NO_OPEN_BROWSER || null,
    config: cfg || null,
  });
  /** Signed in for this run: by a key until `authenticate` runs (which counts only the shared sign-in then). */
  let authenticated;
  const signedIn = () => (authenticated === undefined ? Boolean(envKey() || storedSignIn()) : authenticated);
  let picker = false;

  const openSession = (s, p, resumed) => {
    s.mcp = (p.mcpServers || []).map((x) => x.name);
    s.rules = rulesFor(s.cwd, cfg);
    s.cancelled = false;
    recordMcpEnv(
      Object.fromEntries((p.mcpServers || []).map((x) => [x.name, Object.fromEntries((x.env || x.headers || []).map((v) => [v.name, v.value]))])),
      Object.fromEntries((p.mcpServers || []).filter((x) => x.type === 'http').map((x) => [x.name, x.url])),
    );
    record({ session: s.id, resumed });
  };

  acpAgent({
    initialize(p) {
      picker = Boolean(p.clientCapabilities && p.clientCapabilities._meta && p.clientCapabilities._meta.parameterizedModelPicker);
      record({ initialize: { picker } });
      return {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          mcpCapabilities: { http: true, sse: false },
          promptCapabilities: { image: true, audio: false, embeddedContext: false },
        },
        authMethods: [{ id: 'cursor_login', name: 'Cursor Login', description: null }],
      };
    },
    authenticate(p) {
      // Over a key, the real one drops the key: only the shared sign-in counts after it.
      const overKey = Boolean(envKey());
      record({ authenticate: { methodId: p.methodId, overKey, noBrowser: process.env.NO_OPEN_BROWSER || null } });
      if (p.methodId !== 'cursor_login') throw rpcError('Invalid params', -32602, { message: `Unknown auth method: ${p.methodId}` });
      authenticated = Boolean(storedSignIn());
      if (!authenticated) {
        throw rpcError('Invalid params', -32602, { message: 'Failed to open browser for login. Please visit: https://cursor.example.invalid/loginDeepControl?challenge=e2e' });
      }
      return {};
    },
    'cursor/list_available_models'() {
      if (!signedIn()) throw rpcError('Authentication required', -32000, { message: 'Not logged in. Run cursor-agent login.' });
      return { models: modelList(picker) };
    },
    'session/new'(p, { peer, sessions: open }) {
      const id = crypto.randomUUID();
      // A session starts on the model in its settings, if it is one of Cursor's.
      const wanted = cfg && cfg.model && typeof cfg.model.modelId === 'string' ? modelOf(cfg.model.modelId) : undefined;
      const model = wanted || modelOf('default');
      const s = { id, cwd: p.cwd || process.cwd(), briefing: '', mode: 'agent', model: model.value, levels: { ...model.levels }, history: [] };
      saveSession(s);
      open.set(id, s);
      openSession(s, p, false);
      announceCommands(peer, open, id);
      return { sessionId: id, configOptions: sessionOptions(s) };
    },
    'session/load'(p, { peer, sessions: open }) {
      const kept = loadSession(p.sessionId);
      if (!kept) throw rpcError('Invalid params', -32602, { message: `Session "${p.sessionId}" not found` });
      const s = { ...kept, id: p.sessionId, cwd: p.cwd || kept.cwd, history: kept.history || [], levels: kept.levels || {} };
      // Its history first, as the real one replays it before it answers.
      s.history.forEach((h, i) => {
        const update = (u) => peer.notify('session/update', { sessionId: s.id, update: u });
        update({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: h.prompt } });
        update({ sessionUpdate: 'tool_call', toolCallId: `replay-${i}-1`, title: '`ls`', kind: 'execute', status: 'completed' });
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: h.reply } });
      });
      open.set(s.id, s);
      openSession(s, p, true);
      announceCommands(peer, open, s.id);
      return { configOptions: sessionOptions(s) };
    },
    'session/set_config_option'(p, { sessions: open }) {
      const s = open.get(p.sessionId);
      if (!s) throw rpcError('Invalid params', -32602, { message: `Session "${p.sessionId}" not found` });
      const { configId, value } = p;
      record({ setOption: { configId, value } });
      const invalid = (what) => rpcError('Invalid params', -32602, { message: `Invalid ${what} value: ${value}` });
      if (configId === 'mode') {
        if (!['agent', 'ask', 'plan'].includes(value)) throw invalid('mode');
        s.mode = value;
      } else if (configId === 'model') {
        const model = modelOf(value);
        if (!model) throw invalid('model');
        if (model.value !== s.model) {
          s.model = model.value;
          s.levels = { ...model.levels };
          // The real one keeps the model it switched to in its settings.
          updateConfig((c) => (c.model = { ...(c.model && typeof c.model === 'object' ? c.model : {}), modelId: model.value }));
        }
      } else if (configId in s.levels) {
        const values = configId === 'effort' ? EFFORTS : ['false', 'true'];
        if (!values.includes(value)) throw invalid(configId);
        s.levels[configId] = value;
      } else {
        throw rpcError('Invalid params', -32602, { message: `Unknown config option: ${configId}` });
      }
      saveSession(s);
      return { configOptions: sessionOptions(s) };
    },
    async 'session/prompt'(p, { peer, sessions: open }) {
      const s = open.get(p.sessionId);
      if (!s) throw rpcError('Invalid params', -32602, { message: `Session "${p.sessionId}" not found` });
      const blocks = p.prompt || [];
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text || '').join('\n');
      const images = blocks.filter((b) => b.type === 'image' && b.data).length;
      const briefed = BRIEFING_RE.exec(text);
      const prompt = briefed ? text.slice(briefed[0].length) : text;
      // A resumed session's prompt carries no briefing when it has not changed: the one it was given holds.
      if (briefed) s.briefing = briefed[1];
      const r = s.rules;
      record({
        prompt,
        briefing: s.briefing,
        briefed: Boolean(briefed),
        images,
        mcp: s.mcp,
        ownMcp: ownMcp(),
        model: s.model,
        effort: effortOf(s),
        mode: s.mode,
        force: has('--force'),
        approvalMode: r.approvalMode,
        deny: r.deny,
        projectConfig: r.projectConfig,
        skills: cursorSkills(s.cwd),
      });
      s.cancelled = false;
      const u = sessionUpdates(peer, s.id, () => s.cancelled);
      // Cursor's service says so in the reply, on a text block of its own.
      if (!signedIn()) {
        u.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '\n\nPlease sign in to continue' } });
        return { stopReason: 'end_turn' };
      }
      const steps = plan(prompt, { cwd: s.cwd, images, mcp: s.mcp, briefing: s.briefing, mayRead: (file) => !r.denied('Read', file) });
      // What only Cursor does: a delete (`e2e:delete=<path>`), and its question before a reply that asks one.
      const user = LEAD_PROMPT.test(prompt) ? undefined : lastUserMessage(prompt);
      const d = user === undefined ? {} : directivesIn(user);
      const last = steps.length && steps[steps.length - 1].type === 'text' ? steps.length - 1 : -1;
      if (last >= 0 && typeof d.delete === 'string') steps.splice(last, 0, { type: 'delete', path: d.delete });
      if (last >= 0 && d.ask) steps.splice(steps.length - 1, 0, { type: 'question', text: 'Which option do you prefer, A or B?' });
      const { result, reply } = await cursorTurn(peer, s, u, steps);
      s.history.push({ prompt: user === undefined ? prompt.slice(0, 200) : user, reply });
      saveSession(s);
      return result;
    },
  });

}

/** The slash commands it has, told just after a session opens (Harness Relay ignores them). */
function announceCommands(peer, open, id) {
  setImmediate(() => {
    if (open.has(id)) peer.notify('session/update', { sessionId: id, update: { sessionUpdate: 'available_commands_update', availableCommands: [] } });
  });
}

/** One prompt's steps, played as Cursor plays its tools: the result and the reply's text. */
async function cursorTurn(peer, s, u, steps) {
  const r = s.rules;
  const others = briefedOthers(s.briefing, s.cwd);
  let n = 0;
  const nextId = () => `tool_${++n}\nfc_${n}`;
  let prefix = '';
  let reply = '';
  const done = (stopReason) => ({ result: { stopReason }, reply });
  const update = (toolCallId, rest) => u.update({ sessionUpdate: 'tool_call_update', toolCallId, ...rest });

  /**
   * Asks Harness Relay about `toolCall` (sent as a `tool_call` first): whether it was allowed. The
   * note with a refusal is not Cursor's to read. `rule`: what "allow always" would keep.
   */
  const ask = async (toolCall, rule) => {
    const answer = await requestPermission(peer, s.id, toolCall, OPTIONS);
    const outcome = answer && answer.outcome;
    const said = outcome && outcome.outcome === 'selected' ? outcome.optionId : 'cancelled';
    record({ permission: { toolCallId: toolCall.toolCallId, kind: toolCall.kind, title: toolCall.title, answer: said } });
    if (picked(answer, 'allow-always')) {
      // Never answered by Harness Relay: the real one would keep the rule in its settings, as here.
      updateConfig((c) => {
        c.permissions = c.permissions && typeof c.permissions === 'object' ? c.permissions : {};
        c.permissions.allow = [...strings(c.permissions.allow), rule];
      });
      r.allow.push(rule);
    }
    return picked(answer, 'allow-once') || picked(answer, 'allow-always');
  };

  for (const step of steps) {
    if (s.cancelled) return done('cancelled');
    if (step.type === 'fail') return fail(step.text);
    if (step.type === 'error') {
      u.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `\n\nError: ${step.text}` } });
      return done('end_turn');
    }
    if (step.type === 'think') await u.thought(step.text);
    if (step.type === 'todo') u.plan(step.entries);
    if (step.type === 'tool') {
      const id = nextId();
      u.toolCall({ toolCallId: id, title: `List \`${s.cwd}\``, kind: 'read', status: 'in_progress', rawInput: { path: s.cwd } });
      await sleep(20);
      if (r.denied('Read', s.cwd)) update(id, { status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'Access denied by permissions' } }] });
      else update(id, { status: 'completed', content: [{ type: 'content', content: { type: 'text', text: step.output } }] });
    }
    if (step.type === 'approve') {
      const id = nextId();
      const title = `\`${step.command}\``;
      u.toolCall({ toolCallId: id, title, kind: 'execute', status: 'pending', rawInput: { command: step.command } });
      let ok;
      // Ask and Plan modes run nothing; a deny rule refuses before anything is asked.
      if (s.mode !== 'agent' || r.denied('Shell', step.command)) ok = false;
      else if (r.runEverything || r.allowed('Shell', step.command)) ok = true;
      else {
        const why = r.allow.some((x) => x.startsWith('Shell(')) ? 'Not in the shell allowlist' : 'Shell allowlist is empty';
        ok = await ask({ toolCallId: id, title, kind: 'execute', status: 'pending', content: [{ type: 'content', content: { type: 'text', text: why } }] }, `Shell(${step.command.split(' ')[0]})`);
      }
      const printed = `${step.command.replace(/^echo\s+/, '')}\n`;
      // A refused call is reported completed, with nothing else.
      update(id, ok ? { status: 'completed', rawOutput: { exitCode: 0, stdout: printed, stderr: '' } } : { status: 'completed' });
      prefix += ok ? `The command ran: ${printed.trim()}. ` : declined('command', '');
    }
    if (step.type === 'write') {
      const file = targetOf(step, s.cwd, others);
      if (!file) {
        prefix += noOther(step);
        continue;
      }
      const id = nextId();
      // Its write tool says the file only in its second update.
      u.toolCall({ toolCallId: id, title: 'Edit File', kind: 'edit', status: 'pending', rawInput: {} });
      const title = `Edit \`${file}\``;
      update(id, { title, rawInput: { path: file } });
      let oldText = null;
      try {
        oldText = fs.readFileSync(file, 'utf8');
      } catch {
        /* a new file */
      }
      const diff = { type: 'diff', path: file, oldText, newText: step.content };
      let ok;
      if (s.mode !== 'agent' || r.denied('Write', file)) ok = false;
      else if (r.runEverything || (inside(file, [s.cwd]) && !cursorProtected(file, s.cwd))) ok = true;
      else ok = await ask({ toolCallId: id, title, kind: 'edit', status: 'pending', content: [diff] }, `Write(${slashed(file)})`);
      const written = ok && tryWrite(file, step.content);
      if (written) update(id, { status: 'completed', content: [diff] });
      else if (ok) update(id, { status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'Permission denied' } }] });
      else update(id, { status: 'completed' });
      prefix += wrote(step, written);
    }
    if (step.type === 'delete') {
      const file = path.resolve(s.cwd, step.path);
      const id = nextId();
      // Cursor reports a delete as an edit, titled so.
      const title = `Delete \`${file}\``;
      u.toolCall({ toolCallId: id, title, kind: 'edit', status: 'pending', rawInput: { path: file } });
      let ok;
      if (s.mode !== 'agent' || r.denied('Write', file)) ok = false;
      else ok = r.runEverything || (await ask({ toolCallId: id, title, kind: 'edit', status: 'pending' }, `Write(${slashed(file)})`));
      let gone = false;
      if (ok) {
        try {
          fs.rmSync(file);
          gone = true;
        } catch {
          /* not there, or not ours */
        }
      }
      update(id, { status: 'completed' });
      prefix += gone ? `I deleted ${step.path}. ` : `I may not delete ${step.path} here. `;
    }
    if (step.type === 'question') {
      // Asked as a permission request with a skip option, as Cursor does without `cursor/ask_question`.
      const answer = await requestPermission(peer, s.id, { toolCallId: `question_${++n}`, title: step.text, kind: 'other', status: 'pending' }, [
        { optionId: 'a', name: 'A', kind: 'allow_once' },
        { optionId: 'b', name: 'B', kind: 'allow_once' },
        { optionId: '__ask_question_skip__', name: 'Skip', kind: 'reject_once' },
      ]);
      record({ question: { answer: answer && answer.outcome ? answer.outcome.optionId || answer.outcome.outcome : null } });
    }
    if (step.type === 'text') {
      const said = prefix + step.text;
      if (!(await u.message(said, step.slow))) return done('cancelled');
      reply += said;
    }
  }
  return done('end_turn');
}

module.exports = {
  provider: 'cursor',
  bin: 'cursor-agent',
  aliases: ['agent'],
  label: 'Cursor',
  name: 'Cursor',
  version: '2026.11.99-fake',
  versionRe: /^2026\.11\.99-fake$/m,
  /**
   * The account's folder: `CURSOR_CONFIG_DIR`, else `$XDG_CONFIG_HOME/cursor`, else ~/.cursor
   * (`cursorConfigDir()`). In a turn `CURSOR_CONFIG_DIR` is a private folder of that turn's own, whose
   * `acp-sessions` links into the account's folder, which is then the home.
   */
  home(env) {
    const config = configDir(env);
    try {
      return path.dirname(fs.realpathSync(path.join(config, 'acp-sessions')));
    } catch {
      return config;
    }
  },
  /** The key it was given (CURSOR_API_KEY, CURSOR_AUTH_TOKEN), by `keyVerdict`; null for none. */
  apiKey: (env) => (env.CURSOR_API_KEY || env.CURSOR_AUTH_TOKEN ? keyVerdict(env.CURSOR_API_KEY || env.CURSOR_AUTH_TOKEN) : null),
  main() {
    if (args.includes('acp')) cursorAgent();
    else cursorStatic();
  },
};
