'use strict';
/*
 * A stand-in for the `claude`, `codex` and `grok` CLIs, for the end-to-end tests. Which one it is
 * comes from the name it runs under (`claude`, `codex.exe`, …): `e2e/support/fake-cli.ts` installs
 * it under all three names (a script on macOS and Linux, a Node single executable on Windows).
 *
 * It speaks each CLI's own protocol as Harness Relay drives it, with no model behind it:
 * - claude: `claude -p --input-format stream-json --output-format stream-json …` (control requests,
 *   partial messages, tool calls, `can_use_tool` approvals over stdio), `--version`, `auth status`,
 *   `plugin list --json`;
 * - codex: `codex app-server` (JSON-RPC without the version field: threads, turns, items, approval
 *   requests), `--version`, `login status`, `debug models`;
 * - grok: `grok agent --no-leader stdio` (ACP: sessions, `session/update`, `session/request_permission`),
 *   `--version`, `models`, `inspect --json`.
 *
 * What it answers depends on the prompt, as a model's would:
 * - the lead agent's prompts: the team for a question (`e2e:team=…`, `e2e:mode=…`, `e2e:rounds=…`,
 *   `e2e:name=…`, `e2e:template=…`, `e2e:badplan`; one Claude member by default), the group of a new
 *   conversation (the first group named in its first message), and a changed team (`e2e:add=<cli>`);
 * - a turn: a short reply that names the agent and repeats the user's latest message, streamed in
 *   pieces, changed by the directives in that message (see DIRECTIVES below). A directive written as
 *   `e2e:<name>@<cli>` is for that CLI only, `e2e:write=notes.md@codex` say.
 *
 * Like a model that ignores its briefing, it always tries what a directive asks; whether that
 * happens is decided only by what Harness Relay gave the CLI, as with the real ones:
 * - Claude Code: `--permission-mode`, `--disallowedTools`, the working directory and `--add-dir`
 *   folders, and the answers to its `can_use_tool` requests (it reads elsewhere, a skill's SKILL.md
 *   say, only by a `Read(//<folder>/**)` rule in `--allowedTools`, or with full access);
 * - Codex: the thread's sandbox (`sandbox`, or the permission profile it names, with its `write`
 *   entries; `writable_roots`), its `approvalPolicy`, and the answers to its approval requests;
 * - Grok: yolo mode, the answers to `session/request_permission`, and the folders of the sandbox
 *   profile GROK_SANDBOX names in its sandbox.toml (`read_write`); without a sandbox (yolo mode, and
 *   on Windows, where Grok has none) the other working directories its briefing names.
 * So a test that writes in another folder, or in a read-only chat, tells whether the adapter set
 * the CLI up right.
 *
 * Sessions are kept in the CLI's home (the test's own), and resuming one it never started fails, as
 * the real CLIs do. E2E_FAKE_SIGNED_OUT (a list: `codex,grok`) makes those CLIs signed out. E2E_FAKE_LOG
 * names a file that gets a JSON line for each start (its arguments), each session started or resumed
 * and each prompt (with the images and MCP servers the turn got), and the values (environment or
 * headers) the tool library's MCP servers were given, for the tests to read.
 *
 * Each home (an account's) also keeps its sign-in: signed in until signed out there (`auth logout`,
 * `logout`), and claude's `auth login` signs in again with the code pasted. A start logs its home and
 * its API key's fingerprint; a turn its model and effort, and the skills the CLI loaded by itself, read
 * from where the real one finds them and left out as Harness Relay asks: Claude Code's home skills/
 * and the projects' .claude/skills/ (`--disable-slash-commands`, `skillOverrides` in `--settings`),
 * Codex's home skills/ (`skills.include_instructions`, `skills.config` in `-c` or the thread's config),
 * and for Grok the project's .claude/skills/, only in a folder it trusts (GROK_CLAUDE_SKILLS_ENABLED).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

const isSea = (() => {
  try {
    return require('node:sea').isSea();
  } catch {
    return false;
  }
})();
const CLI = path
  .basename(isSea ? process.execPath : process.argv[1])
  .replace(/\.(exe|cjs|js)$/i, '')
  .toLowerCase();
const args = process.argv.slice(2);
const LABEL = { claude: 'Claude Code', codex: 'Codex', grok: 'Grok' }[CLI];
if (!LABEL) {
  process.stderr.write(`fake-cli: run me as claude, codex or grok (not ${CLI})\n`);
  process.exit(2);
}

const has = (name) => args.includes(name);
const flag = (name) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let seq = 0;
const newId = (prefix) => `${prefix}-${process.pid}-${Date.now().toString(36)}-${++seq}`;

function record(entry) {
  const file = process.env.E2E_FAKE_LOG;
  if (!file) return;
  try {
    fs.appendFileSync(file, JSON.stringify({ cli: CLI, pid: process.pid, at: Date.now(), ...entry }) + '\n');
  } catch {
    /* the log is a convenience */
  }
}
// The home it runs in too: each account of a CLI has one of its own. And the API key it was given
// (ANTHROPIC_API_KEY, XAI_API_KEY), as a fingerprint only: the key itself stays out of the log.
const apiKey = process.env[{ claude: 'ANTHROPIC_API_KEY', grok: 'XAI_API_KEY' }[CLI] || ''];
record({ args, home: home(), apiKey: apiKey ? require('node:crypto').createHash('sha256').update(apiKey).digest('hex').slice(0, 16) : null });

/** The CLI's own folder, as the real one finds it. */
function home() {
  const own = { claude: 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME', grok: 'GROK_HOME' }[CLI];
  return process.env[own] || path.join(os.homedir(), `.${CLI}`);
}

/**
 * Its sign-in, kept in its home as the real ones keep theirs: signed in (as e2e@example.com) until
 * signed out there (`auth logout`, `logout`), which leaves `e2e-signed-out`; signing in again
 * (`auth login`) takes it away, as the account the code pasted names when it is an email address.
 */
const signIn = {
  out: () => path.join(home(), 'e2e-signed-out'),
  account: () => path.join(home(), 'e2e-account'),
  email() {
    try {
      return fs.readFileSync(this.account(), 'utf8').trim() || 'e2e@example.com';
    } catch {
      return 'e2e@example.com';
    }
  },
  logout() {
    fs.mkdirSync(home(), { recursive: true });
    fs.writeFileSync(this.out(), '');
    fs.rmSync(this.account(), { force: true });
  },
  login(code) {
    fs.mkdirSync(home(), { recursive: true });
    fs.rmSync(this.out(), { force: true });
    if (/^[^\s@]+@[^\s@]+$/.test(code)) fs.writeFileSync(this.account(), code);
    else fs.rmSync(this.account(), { force: true });
  },
};

const signedOut =
  (process.env.E2E_FAKE_SIGNED_OUT || '')
    .split(',')
    .map((c) => c.trim().toLowerCase())
    .includes(CLI) || fs.existsSync(signIn.out());

/** Sessions, kept in the CLI's home: started ones can be resumed, others cannot. */
const sessions = {
  file: (id) => path.join(home(), 'e2e-sessions', encodeURIComponent(id)),
  start(id) {
    fs.mkdirSync(path.dirname(this.file(id)), { recursive: true });
    fs.writeFileSync(this.file(id), '');
    record({ session: id, resumed: false });
  },
  resume(id) {
    if (!fs.existsSync(this.file(id))) return false;
    record({ session: id, resumed: true });
    return true;
  },
};

// --- What it says ----------------------------------------------------------------------------------

/**
 * The directives a user message can hold. Each one is `e2e:<name>`, with `=<value>` for some, and
 * `@<cli>` to keep it to one CLI.
 */
const DIRECTIVES = {
  think: 'show some thinking first',
  tool: 'list the working directory with a tool first',
  todo: 'show a to-do list',
  approve: 'run a command that needs approval (`echo e2e-approval`), then say whether it ran',
  write: 'write the file named (relative to the working directory)',
  writeother: 'write the file named in the first other working directory the CLI was given (none: it says so)',
  ask: 'end the reply with a question for the user ([ASK_USER])',
  handoff: 'mention the member named, to hand the floor to it (not when that member is speaking)',
  slow: 'stream the reply slowly (about ten seconds), to be stopped',
  fail: 'exit with an error on stderr',
  error: "fail the turn inside the CLI's protocol (Claude's error result, a failed Codex turn, a Grok JSON-RPC error)",
  flaky: 'fail the first time this message is answered, answer the next time (a retry)',
  markdown: 'answer with a heading, a list, a table and a code block',
  memory: "say the tool library's memory notes its briefing holds",
  skills: "read the SKILL.md of each tool library skill its briefing lists, and say its first line (or that it may not)",
};

function directivesIn(text) {
  const found = {};
  for (const m of text.matchAll(/\be2e:([a-z]+)(?:=([^\s@]+))?(?:@([a-z]+))?/gi)) {
    const [, name, value, only] = m;
    if (only && only.toLowerCase() !== CLI) continue;
    found[name.toLowerCase()] = value === undefined ? true : value;
  }
  return found;
}

const withoutDirectives = (text) => text.replace(/\be2e:\S+/gi, '').replace(/\s+/g, ' ').trim();

/** The last message the user wrote, in a turn prompt's chat (without the list of files it attached). */
function lastUserMessage(prompt) {
  let last;
  for (const m of prompt.matchAll(/<message from="user"[^>]*>\n([\s\S]*?)\n<\/message>/g)) last = m[1];
  return last === undefined ? undefined : last.replace(/\s*<attachments>[\s\S]*?<\/attachments>/g, '');
}

function tag(prompt, name) {
  const m = new RegExp(`<${name}>\\n([\\s\\S]*?)\\n</${name}>`).exec(prompt);
  return m ? m[1] : '';
}

const capital = (provider) => provider[0].toUpperCase() + provider.slice(1);
const providersIn = (list) =>
  String(list)
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .filter((p) => ['claude', 'codex', 'grok'].includes(p));

/** The lead agent's answer: the team for a question (not JSON at all with `e2e:badplan`). */
function planReply(prompt) {
  const question = tag(prompt, 'question');
  const d = directivesIn(question);
  if (d.badplan) return 'I would rather not choose a team for this one.';
  if (typeof d.template === 'string') {
    return json({ choice: 'template', templateId: d.template, reason: 'The fake lead agent picked this template, as the question asked.' });
  }
  const providers = typeof d.team === 'string' ? providersIn(d.team) : [];
  const count = {};
  const agents = (providers.length ? providers : ['claude']).map((provider) => {
    count[provider] = (count[provider] || 0) + 1;
    const base = capital(provider);
    return { name: count[provider] > 1 ? `${base}${count[provider]}` : base, provider, role: `Answer the question as ${base}.` };
  });
  const mode = ['roundtable', 'parallel', 'relay'].includes(d.mode) ? d.mode : 'roundtable';
  return json({
    choice: 'custom',
    name: typeof d.name === 'string' ? d.name.replace(/_/g, ' ') : 'E2E team',
    description: 'A team picked by the fake lead agent.',
    mode,
    rounds: Number(d.rounds) || 1,
    maxHops: Number(d.hops) || 8,
    agents,
    reason: 'The fake lead agent picked the members the question asked for.',
  });
}

/** The lead agent's answer: the group a new conversation goes in (0: none). */
function groupReply(prompt) {
  const message = tag(prompt, 'message').toLowerCase();
  const groups = [...prompt.matchAll(/^(\d+)\. ("(?:[^"\\]|\\.)*")/gm)].map((m) => ({ n: Number(m[1]), name: JSON.parse(m[2]) }));
  const hit = groups.find((g) => message.includes(g.name.toLowerCase()));
  return JSON.stringify({ group: hit ? hit.n : 0 });
}

/** The lead agent's answer to "change the team": the team, with a member of each CLI `e2e:add` names. */
function reviseReply(prompt) {
  let team = {};
  try {
    team = JSON.parse(tag(prompt, 'team'));
  } catch {
    /* answered without it */
  }
  const agents = (team.agents || []).map((a) => ({ name: a.name, provider: a.provider }));
  const d = directivesIn(tag(prompt, 'request'));
  const added = typeof d.add === 'string' ? providersIn(d.add) : [];
  for (const provider of added) {
    let name = capital(provider);
    for (let n = 2; agents.some((a) => a.name.toLowerCase() === name.toLowerCase()); n++) name = `${capital(provider)}${n}`;
    agents.push({ name, provider, role: `Help the team as ${capital(provider)}.` });
  }
  return json({
    mode: team.mode || 'roundtable',
    rounds: team.rounds || 1,
    maxHops: team.maxHops || 8,
    agents,
    reason: added.length ? 'The fake lead agent added the members asked for.' : 'The fake lead agent kept the team as it is.',
  });
}

const json = (value) => '```json\n' + JSON.stringify(value, null, 2) + '\n```';

/**
 * The steps of a reply: `think`, `text` (streamed in pieces), `tool` (a tool call and its result),
 * `todo`, `approve` (a command that needs approval), `write` (a file), `fail` (exit) and `error` (a
 * failure in the protocol). `turn`: what the turn got besides its prompt (`cwd`, `images`, `mcp`,
 * `briefing`), and `mayRead(file)` where the CLI reads only some folders without asking (Claude Code).
 */
function plan(prompt, turn) {
  if (/Reply with only one of these JSON objects/.test(prompt)) return [{ type: 'text', text: planReply(prompt) }];
  if (/Reply with only this JSON object: \{"group"/.test(prompt)) return [{ type: 'text', text: groupReply(prompt) }];
  if (/Reply with only this JSON object, in a ```json code block, with the whole team/.test(prompt)) {
    return [{ type: 'text', text: reviseReply(prompt) }];
  }

  const me = (/your turn, @([^\s.,!?:;]+)/.exec(prompt) || [])[1] || LABEL;
  const user = lastUserMessage(prompt);
  if (user === undefined) {
    // No new word from the user: a later round, or a teammate handed over.
    if (/Reply with \[PASS\] if you have nothing new to add/.test(prompt)) return [{ type: 'text', text: '[PASS]' }];
    return [{ type: 'text', text: `${me} (${LABEL}) here, following on from my teammate.` }];
  }
  const d = directivesIn(user);
  const said = withoutDirectives(user);
  const steps = [];
  if (d.fail) return [{ type: 'fail', text: `fake ${CLI}: failing as asked (e2e:fail)` }];
  if (d.error) return [{ type: 'error', text: `fake ${CLI}: the model returned an error (e2e:error)` }];
  if (d.flaky && firstTime(user)) return [{ type: 'fail', text: `fake ${CLI}: failing this once (e2e:flaky)` }];
  if (d.think) steps.push({ type: 'think', text: `${me} is thinking about “${said}”.` });
  if (d.todo) {
    steps.push({
      type: 'todo',
      entries: [
        { text: 'Read the question', status: 'completed' },
        { text: 'Write the answer', status: 'in_progress' },
        { text: 'Check it', status: 'pending' },
      ],
    });
  }
  if (d.tool) steps.push({ type: 'tool', kind: 'list', output: safeList(turn.cwd) });
  if (d.approve) steps.push({ type: 'approve', command: 'echo e2e-approval' });
  const content = `Written by ${me} (${LABEL}).\n`;
  if (typeof d.write === 'string') steps.push({ type: 'write', path: d.write, content });
  if (typeof d.writeother === 'string') steps.push({ type: 'write', path: d.writeother, other: true, content });
  const answered = /You asked the user a question and their reply is among the messages above/.test(prompt);
  let text = answered ? `Thanks, ${me} got your answer: “${said}”.` : `Hello from ${me} (${LABEL}). You said: “${said}”.`;
  if (turn.images) text += ` I got ${turn.images} image${turn.images === 1 ? '' : 's'}.`;
  if (turn.mcp && turn.mcp.length) text += ` My tool library's MCP servers: ${turn.mcp.join(', ')}.`;
  if (d.memory) text += memoryIn(turn.briefing) ? ` My memory: “${memoryIn(turn.briefing)}”.` : ' I have no memory notes.';
  if (d.skills) text += readSkills(turn);
  if (d.markdown) {
    text += '\n\n## Fake findings\n\n- first point\n- second point\n\n| CLI | Fake |\n| --- | --- |\n| ' + LABEL + ' | yes |\n\n```js\nconst answer = 42;\n```';
  }
  if (typeof d.handoff === 'string' && d.handoff.toLowerCase() !== me.toLowerCase()) text += ` @${d.handoff}, over to you.`;
  if (d.ask) text += '\n\nWhich option do you prefer, A or B? [ASK_USER]';
  steps.push({ type: 'text', text, slow: Boolean(d.slow) });
  return steps;
}

/** Whether this CLI sees `text` for the first time (remembered in its home, which is the test's own). */
function firstTime(text) {
  const mark = path.join(home(), `e2e-seen-${require('node:crypto').createHash('sha1').update(text).digest('hex')}`);
  if (fs.existsSync(mark)) return false;
  fs.mkdirSync(path.dirname(mark), { recursive: true });
  fs.writeFileSync(mark, '');
  return true;
}

function safeList(dir) {
  try {
    return fs.readdirSync(dir).filter((n) => n !== '.git').sort().join('\n') || '(empty)';
  } catch (err) {
    return String(err.message || err);
  }
}

/**
 * The skills a CLI loads by itself from one of its skills folders (its home's, a project's): a
 * `<name>/SKILL.md` each, with the description its front matter gives.
 */
function ownSkills(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const file = path.join(dir, name, 'SKILL.md');
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return [];
    }
    return [{ name, description: ((/^description:\s*(.+)$/m.exec(text) || [])[1] || '').trim(), path: file }];
  });
}

/** The tool library's memory a briefing holds (its `<memory>` block), on one line; '' when none. */
function memoryIn(briefing) {
  const m = /<memory>\n([\s\S]*?)\n<\/memory>/.exec(briefing || '');
  return m ? m[1].replace(/\s+/g, ' ').trim() : '';
}

/** The tool library's skills a briefing lists (`- name: description (…/SKILL.md)` under `# Skills`). */
function skillsIn(briefing) {
  const section = /# Skills\n.*\n((?:- .*(?:\n|$))+)/.exec(briefing || '');
  if (!section) return [];
  return section[1].split('\n').flatMap((line) => {
    const m = /^- (.+?)(?:: .*)? \((.+SKILL\.md)\)$/.exec(line);
    return m ? [{ name: m[1], file: m[2] }] : [];
  });
}

/** Reads each skill's SKILL.md, as an agent does when a task matches: its first line after the front matter. */
function readSkills(turn) {
  const skills = skillsIn(turn.briefing);
  if (!skills.length) return ' I was given no skills.';
  return skills
    .map((s) => {
      if (turn.mayRead && !turn.mayRead(s.file)) return ` I may not read the skill ${s.name}.`;
      try {
        const body = fs.readFileSync(s.file, 'utf8').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
        const first = body.split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '';
        return ` I read the skill ${s.name}: “${first}”.`;
      } catch (err) {
        return ` I could not read the skill ${s.name} (${err.code || err.message}).`;
      }
    })
    .join('');
}

/** Records the values the tool library's MCP servers were given (by server: env, or an HTTP server's headers). */
function recordMcpEnv(servers) {
  if (Object.keys(servers).length) record({ mcpEnv: servers });
}

/** Pieces of `text` to stream: a few words each, or many small ones for a slow reply. */
function pieces(text, slow) {
  if (slow) {
    const out = [];
    for (let i = 0; i < 40; i++) out.push(i === 0 ? text : ' …');
    return out;
  }
  const words = text.split(/(?<=\s)/);
  const out = [];
  for (let i = 0; i < words.length; i += 3) out.push(words.slice(i, i + 3).join(''));
  return out.length ? out : [text];
}
const pieceDelay = (slow) => (slow ? 250 : 15);

/** The note the user gave with a decline, as Harness Relay passes it on ("Their message: …"). */
function noteIn(message) {
  const m = /Their message: (.*?)(?: Do not retry|$)/s.exec(String(message || ''));
  return m ? m[1].trim() : '';
}
const declined = (what, note) => `The ${what} was declined${note ? ` (the user said: ${note})` : ''}. `;

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** A path by its real location, also when it does not exist yet (its nearest existing folder's). */
function realLocation(p) {
  let at = path.resolve(p);
  const rest = [];
  while (!fs.existsSync(at)) {
    const up = path.dirname(at);
    if (up === at) break;
    rest.unshift(path.basename(at));
    at = up;
  }
  let real = at;
  try {
    real = fs.realpathSync.native(at);
  } catch {
    /* as it is */
  }
  const full = path.join(real, ...rest);
  return process.platform === 'win32' ? full.toLowerCase() : full;
}

/** Whether `file` is inside one of `dirs` (null: anywhere, as with full access). */
function inside(file, dirs) {
  if (dirs === null) return true;
  const f = realLocation(file);
  return dirs.some((d) => {
    const r = realLocation(d);
    return f === r || f.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
  });
}

/**
 * The file a write step goes to, or none for a write in another working directory when the CLI was
 * given none. `others`: the working directories it was given besides its own.
 */
function targetOf(step, cwd, others) {
  if (step.other && !others.length) return undefined;
  return path.resolve(step.other ? others[0] : cwd, step.path);
}
const noOther = (step) => `I was given no other working directory for ${step.path}. `;
const wrote = (step, ok, note) => (ok ? `I wrote ${step.path}. ` : `I may not write ${step.path} here${note ? ` (the user said: ${note})` : ''}. `);

/** Variadic values of a flag (`--add-dir a b`), up to the next flag. */
function values(name) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== name) continue;
    for (let j = i + 1; j < args.length && !args[j].startsWith('--'); j++) out.push(args[j]);
  }
  return out;
}

/** Folders a turn may also use that are not working directories: the chat's attachments. */
const notAWorkingDirectory = (dir) => /[\\/]attachments[\\/]/.test(dir + path.sep);

// --- Line-delimited JSON on stdio -------------------------------------------------------------------

const out = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

/** Work under way (a turn), which an end of stdin lets finish, as the real CLIs do. */
const inFlight = new Set();
function track(promise) {
  const p = Promise.resolve(promise).catch((err) => {
    process.stderr.write(`fake ${CLI}: ${err && err.stack ? err.stack : err}\n`, () => process.exit(1));
  });
  inFlight.add(p);
  p.finally(() => inFlight.delete(p));
  return p;
}

function onLines(handle) {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    track(handle(msg));
  });
  rl.on('close', async () => {
    while (inFlight.size) await Promise.allSettled([...inFlight]);
    process.stdout.write('', () => process.exit(0));
  });
}

/** A JSON-RPC peer (codex leaves out the version field, ACP has it). */
function rpcPeer(versionField, onRequest, onNotification) {
  const pending = new Map();
  let next = 1;
  const send = (msg) => out(versionField ? { jsonrpc: '2.0', ...msg } : msg);
  onLines(async (msg) => {
    if (typeof msg.method !== 'string') {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || 'error'));
      else p.resolve(msg.result);
      return;
    }
    if (msg.id === undefined || msg.id === null) return onNotification(msg.method, msg.params || {});
    try {
      const result = await onRequest(msg.method, msg.params || {});
      send({ id: msg.id, result: result === undefined ? null : result });
    } catch (err) {
      send({ id: msg.id, error: { code: err.code || -32603, message: err.message || String(err) } });
    }
  });
  return {
    notify: (method, params) => send({ method, params }),
    request: (method, params) =>
      new Promise((resolve, reject) => {
        const id = `fake-${next++}`;
        pending.set(id, { resolve, reject });
        send({ id, method, params });
      }),
  };
}

const rpcError = (message, code = -32603) => Object.assign(new Error(message), { code });

/** Ends the CLI with an error, once its message is out (pipes are asynchronous on macOS and Windows). */
function fail(text) {
  process.stdout.write('', () => process.stderr.write(text + '\n', () => process.exit(1)));
  return new Promise(() => {});
}

// --- claude ------------------------------------------------------------------------------------------

function claudeStatic() {
  if (has('--version')) return void process.stdout.write('2.1.999 (Claude Code)\n');
  if (args[0] === 'auth' && args[1] === 'status') {
    const status = signedOut
      ? { loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' }
      : { loggedIn: true, authMethod: 'claude.ai', email: signIn.email(), subscriptionType: 'max' };
    return void process.stdout.write(JSON.stringify(status, null, 2) + '\n');
  }
  if (args[0] === 'auth' && args[1] === 'logout') {
    signIn.logout();
    return void process.stdout.write('Successfully logged out from your Anthropic account.\n');
  }
  if (args[0] === 'auth' && args[1] === 'login') {
    // As Claude Code's own flow: a page to open, then the code it shows, pasted here.
    process.stdout.write('Opening browser to sign in…\nIf the browser didn\'t open, visit: https://claude.example.invalid/e2e-login\nPaste code here if prompted > ');
    const rl = readline.createInterface({ input: process.stdin });
    rl.once('line', (code) => {
      rl.close();
      signIn.login(code.trim());
      process.stdout.write('\nLogin successful.\n', () => process.exit(0));
    });
    return;
  }
  if (args[0] === 'plugin' && args[1] === 'list') return void process.stdout.write('[]\n');
  if (args[0] === 'mcp' && args[1] === 'list') return void process.stdout.write('No MCP servers configured.\n');
  process.stderr.write(`fake claude: unknown command ${args.join(' ')}\n`);
  process.exitCode = 1;
}

/** The servers of an `--mcp-config` file (names only: their secrets stay where they are). */
function claudeMcp() {
  return values('--mcp-config').flatMap((file) => {
    try {
      return Object.keys(JSON.parse(file.trim().startsWith('{') ? file : fs.readFileSync(file, 'utf8')).mcpServers || {});
    } catch {
      return [];
    }
  });
}

/** The values each `--mcp-config` server is given (env, or an HTTP server's headers), by server. */
function claudeMcpEnv() {
  const out = {};
  for (const file of values('--mcp-config')) {
    try {
      const servers = JSON.parse(file.trim().startsWith('{') ? file : fs.readFileSync(file, 'utf8')).mcpServers || {};
      for (const [name, s] of Object.entries(servers)) out[name] = s.env || s.headers || {};
    } catch {
      /* not one to read */
    }
  }
  return out;
}

/** The folders of the `Read(//<folder>/**)` rules in --allowedTools (Windows' C:\… is written /c/…). */
function claudeReadRules() {
  return values('--allowedTools').flatMap((rule) => {
    const m = /^Read\(\/(\/.*?)\/\*\*\)$/.exec(rule);
    if (!m) return [];
    return [process.platform === 'win32' && /^\/[a-z]\//i.test(m[1]) ? `${m[1][1]}:${m[1].slice(2)}` : m[1]];
  });
}

/** The --settings layer it was given: a file, or JSON on the command line. */
function claudeSettings() {
  const v = flag('--settings');
  if (!v) return {};
  try {
    return JSON.parse(v.trim().startsWith('{') ? v : fs.readFileSync(v, 'utf8')) || {};
  } catch {
    return {};
  }
}

/**
 * The skills Claude Code loads by itself: its home's skills/ and each working directory's
 * .claude/skills/ (the --add-dir ones too); none with --disable-slash-commands, and not those the
 * --settings layer turns off (`skillOverrides`).
 */
function claudeSkills() {
  if (has('--disable-slash-commands')) return [];
  const off = claudeSettings().skillOverrides || {};
  const projects = [process.cwd(), ...values('--add-dir').filter((d) => !notAWorkingDirectory(d))];
  const dirs = [path.join(home(), 'skills'), ...projects.map((d) => path.join(d, '.claude', 'skills'))];
  return dirs.flatMap(ownSkills).filter((s) => off[s.name] !== 'off');
}

function claudeStream() {
  const resume = flag('--resume');
  const sessionId = resume || flag('--session-id') || newId('claude-session');
  if (resume && !sessions.resume(resume)) return void fail(`No conversation found with session ID: ${resume}`);
  const persist = !resume && !has('--no-session-persistence') && Boolean(flag('--session-id'));
  const briefing = flag('--append-system-prompt') || '';
  const mode = flag('--permission-mode') || 'default';
  const asks = flag('--permission-prompt-tool') === 'stdio';
  // Its file tools: none of those --disallowedTools names; without asking, in the working directory
  // and the --add-dir folders in edit mode (acceptEdits), and anywhere with full access.
  const disallowed = values('--disallowedTools');
  const addDirs = values('--add-dir');
  const o = {
    sessionId,
    mode,
    asks,
    noWrite: disallowed.includes('Write'),
    dirs: mode === 'bypassPermissions' ? null : mode === 'acceptEdits' ? [process.cwd(), ...addDirs] : [],
    others: addDirs.filter((d) => !notAWorkingDirectory(d)),
    // Its Read tool, without asking: in its folders and those of its Read rules, anywhere with full access.
    reads: mode === 'bypassPermissions' ? null : [process.cwd(), ...addDirs, ...claudeReadRules()],
  };
  const pending = new Map();
  let busy = false;

  const reply = (m, response) => out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response } });
  const refuse = (m, error) => out({ type: 'control_response', response: { subtype: 'error', request_id: m.request_id, error } });
  o.ask = (request) =>
    new Promise((resolve) => {
      const requestId = newId('perm');
      pending.set(requestId, resolve);
      out({ type: 'control_request', request_id: requestId, request: { subtype: 'can_use_tool', ...request } });
    });

  onLines(async (m) => {
    if (m.type === 'control_response') {
      const r = m.response || {};
      const resolve = pending.get(r.request_id);
      if (resolve) {
        pending.delete(r.request_id);
        resolve(r.subtype === 'success' ? r.response || {} : { behavior: 'deny', message: String(r.error || 'error') });
      }
      return;
    }
    if (m.type === 'control_request') {
      switch (m.request && m.request.subtype) {
        case 'initialize':
          return reply(m, {
            claude_code_version: '2.1.999',
            // With its skills left out it lists no commands, its own ones included.
            commands: has('--disable-slash-commands')
              ? []
              : [
                  { name: 'compact', description: 'Compact the conversation', argumentHint: '', builtin: true },
                  { name: 'usage', description: 'Show usage', argumentHint: '', builtin: true },
                  ...claudeSkills().map((s) => ({ name: s.name, description: s.description, argumentHint: '' })),
                ],
            agents: [
              { name: 'general-purpose', description: 'The general-purpose agent' },
              { name: 'Explore', description: 'The Explore agent' },
            ],
            models: [],
          });
        case 'apply_flag_settings':
        case 'interrupt':
          return reply(m, undefined);
        case 'mcp_status':
          return reply(m, { mcpServers: [] });
        case 'get_hooks_listing':
          return reply(m, { hooks: [] });
        case 'get_settings':
          return reply(m, { effective: {} });
        default:
          return refuse(m, `Unsupported control request subtype: ${m.request && m.request.subtype}`);
      }
    }
    if (m.type !== 'user' || busy) return;
    busy = true;
    const content = m.message && m.message.content;
    const blocks = Array.isArray(content) ? content : [];
    const prompt = typeof content === 'string' ? content : blocks.map((b) => b.text || '').join('\n');
    const turn = {
      cwd: process.cwd(),
      images: blocks.filter((b) => b.type === 'image').length,
      mcp: claudeMcp(),
      briefing,
      mayRead: (file) => inside(file, o.reads),
    };
    recordMcpEnv(claudeMcpEnv());
    if (persist) sessions.start(sessionId);
    record({
      prompt,
      briefing,
      mode,
      images: turn.images,
      mcp: turn.mcp,
      model: flag('--model') || null,
      effort: flag('--effort') || null,
      skills: claudeSkills().map((s) => s.name),
    });
    out({
      type: 'system',
      subtype: 'init',
      session_id: sessionId,
      cwd: process.cwd(),
      tools: ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'TodoWrite'].filter((t) => !disallowed.includes(t)),
      mcp_servers: turn.mcp.map((name) => ({ name, status: 'connected' })),
      model: flag('--model') || 'claude-fake',
      permissionMode: mode,
    });
    if (signedOut) return claudeResult(o, { is_error: true, subtype: 'error_during_execution', result: 'Not logged in · Please run /login' });
    await claudeTurn(plan(prompt, turn), o);
  });
}

function claudeResult(o, r) {
  out({
    type: 'result',
    duration_ms: 50,
    num_turns: 1,
    session_id: o.sessionId,
    total_cost_usd: 0.0012,
    usage: { input_tokens: 120, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 40 },
    ...r,
  });
}

async function claudeTurn(steps, o) {
  let n = 0;
  let full = '';
  const tool = async (name, input, run) => {
    const id = `toolu_${++n}_${process.pid}`;
    out({ type: 'assistant', session_id: o.sessionId, parent_tool_use_id: null, message: { id: `msg_tool_${n}`, role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
    await sleep(20);
    const { content, isError } = await run();
    out({ type: 'user', session_id: o.sessionId, parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } });
  };
  const stream = async (kind, text, slow) => {
    const msgId = `msg_${++n}_${process.pid}`;
    const ev = (event) => out({ type: 'stream_event', session_id: o.sessionId, parent_tool_use_id: null, event });
    ev({ type: 'message_start', message: { id: msgId, role: 'assistant', content: [] } });
    ev({ type: 'content_block_start', index: 0, content_block: kind === 'text' ? { type: 'text', text: '' } : { type: 'thinking', thinking: '' } });
    for (const piece of pieces(text, slow)) {
      ev({ type: 'content_block_delta', index: 0, delta: kind === 'text' ? { type: 'text_delta', text: piece } : { type: 'thinking_delta', thinking: piece } });
      await sleep(pieceDelay(slow));
    }
    ev({ type: 'content_block_stop', index: 0 });
    ev({ type: 'message_stop' });
    const block = kind === 'text' ? { type: 'text', text } : { type: 'thinking', thinking: text };
    out({ type: 'assistant', session_id: o.sessionId, parent_tool_use_id: null, message: { id: msgId, role: 'assistant', content: [block] } });
  };
  /** Asks (or not) to use a tool beyond what it may do by itself: { ok, note }. */
  const permission = async (tool_name, input) => {
    if (!o.asks) return { ok: false, message: `Permission to use ${tool_name} has been denied.` };
    const answer = await o.ask({ tool_name, input, tool_use_id: `toolu_ask_${++n}_${process.pid}` });
    return { ok: answer.behavior === 'allow', message: answer.message || `Permission to use ${tool_name} has been denied.` };
  };

  for (const step of steps) {
    if (step.type === 'fail') return fail(step.text);
    if (step.type === 'error') return claudeResult(o, { subtype: 'error_during_execution', is_error: true, result: step.text });
    if (step.type === 'think') await stream('thinking', step.text);
    if (step.type === 'todo') {
      await tool('TodoWrite', { todos: step.entries.map((e) => ({ content: e.text, status: e.status, activeForm: e.text })) }, async () => ({
        content: 'Todos have been modified successfully.',
        isError: false,
      }));
    }
    if (step.type === 'tool') await tool('Bash', { command: 'ls', description: 'List the working directory' }, async () => ({ content: step.output, isError: false }));
    if (step.type === 'approve') {
      const input = { command: step.command, description: 'Print a line (an e2e check)' };
      const p = o.mode === 'bypassPermissions' ? { ok: true } : await permission('Bash', input);
      await tool('Bash', input, async () => (p.ok ? { content: 'e2e-approval', isError: false } : { content: p.message, isError: true }));
      full += p.ok ? 'The command ran: e2e-approval. ' : declined('command', noteIn(p.message));
    }
    if (step.type === 'write') {
      const file = targetOf(step, process.cwd(), o.others);
      if (!file) {
        full += noOther(step);
        continue;
      }
      // Without a Write tool (read-only) there is nothing to call.
      if (o.noWrite) {
        full += wrote(step, false);
        continue;
      }
      const input = { file_path: file, content: step.content };
      const p = inside(file, o.dirs) ? { ok: true } : await permission('Write', input);
      await tool('Write', input, async () => {
        if (!p.ok) return { content: p.message, isError: true };
        writeFile(file, step.content);
        return { content: `File created successfully at: ${file}`, isError: false };
      });
      full += wrote(step, p.ok, p.ok ? '' : noteIn(p.message));
    }
    if (step.type === 'text') {
      full += step.text;
      await stream('text', full, step.slow);
    }
  }
  claudeResult(o, { subtype: 'success', is_error: false, result: full });
}

// --- codex -------------------------------------------------------------------------------------------

function codexStatic() {
  if (has('--version')) return void process.stdout.write('codex-cli 0.999.0\n');
  if (args[0] === 'login' && args[1] === 'status') return void process.stderr.write(signedOut ? 'Not logged in\n' : 'Logged in using ChatGPT\n');
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
          recordMcpEnv(
            Object.fromEntries(
              Object.entries(config.mcp_servers || {})
                .filter(([, s]) => s && s.enabled !== false && (s.command || s.url))
                .map(([name, s]) => [name, s.env || s.http_headers || {}]),
            ),
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
          const steps = signedOut ? [{ type: 'error', text: 'Not logged in. Run codex login.' }] : plan(prompt, { cwd: t.cwd, images, mcp: t.mcp, briefing: t.briefing });
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
  note('thread/tokenUsage/updated', { tokenUsage: { last: { inputTokens: 150, cachedInputTokens: 0, outputTokens: 30, reasoningOutputTokens: 5, totalTokens: 185 }, total: {} } });
  note('turn/completed', { turn: { id: turnId, items: [], status: stopped() ? 'interrupted' : 'completed', error: null } });
}

// --- grok --------------------------------------------------------------------------------------------

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
  if (has('--version')) return void process.stdout.write('grok 1.0.999\n');
  if (args[0] === 'models') {
    if (signedOut) {
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

function grokAgent() {
  const open = new Map();
  let peer;
  peer = rpcPeer(
    true,
    async (method, p) => {
      switch (method) {
        case 'initialize':
          return { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true }, mcpCapabilities: { http: true } }, authMethods: [] };
        case 'session/new':
        case 'session/resume': {
          if (signedOut) throw rpcError('Authentication required: not authenticated. Run grok login.');
          const id = method === 'session/resume' ? p.sessionId : newId('grok-session');
          if (method === 'session/resume' && !sessions.resume(id)) throw rpcError(`Session not found: ${id}`);
          if (method === 'session/new') sessions.start(id);
          const meta = p._meta || {};
          const cwd = p.cwd || process.cwd();
          const writes = grokWrites(cwd, Boolean(meta.yoloMode));
          // No sandbox: nothing but the briefing names the other folders.
          if (!writes.dirs) writes.others = briefedOthers(meta.rules || '', cwd);
          open.set(id, { cwd, briefing: meta.rules || '', yolo: Boolean(meta.yoloMode), cancelled: false, mcp: (p.mcpServers || []).map((s) => s.name), ...writes });
          recordMcpEnv(Object.fromEntries((p.mcpServers || []).map((s) => [s.name, Object.fromEntries((s.env || s.headers || []).map((v) => [v.name, v.value]))])));
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
        case 'session/set_config_option': {
          const s = open.get(p.sessionId);
          const key = { model: 'model', reasoning_effort: 'effort' }[p.configId];
          if (!s || !key) throw rpcError(`unknown config option ${p.configId}`, -32602);
          s[key] = p.value;
          return {};
        }
        case 'session/prompt': {
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
        }
        default:
          throw rpcError(`unknown method ${method}`, -32601);
      }
    },
    (method, p) => {
      if (method === 'session/cancel' && open.has(p.sessionId)) open.get(p.sessionId).cancelled = true;
    },
  );
}

async function grokTurn(peer, sessionId, s, steps) {
  const update = (u) => peer.notify('session/update', { sessionId, update: u });
  let n = 0;
  let prefix = '';
  /** Asks before a tool call (unless yolo): { ok, note }. */
  const permit = async (toolCall) => {
    if (s.yolo) return { ok: true };
    const answer = await peer
      .request('session/request_permission', {
        sessionId,
        toolCall,
        options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
        ],
      })
      .catch(() => ({ outcome: { outcome: 'cancelled' } }));
    const ok = Boolean(answer && answer.outcome && answer.outcome.outcome === 'selected' && answer.outcome.optionId === 'allow-once');
    return { ok, note: ok ? '' : noteIn(answer && answer._meta && answer._meta.followup_message) };
  };
  const done = (id, ok, text) =>
    update({ sessionUpdate: 'tool_call_update', toolCallId: id, status: ok ? 'completed' : 'failed', content: [{ type: 'content', content: { type: 'text', text } }] });
  for (const step of steps) {
    if (s.cancelled) return { stopReason: 'cancelled' };
    if (step.type === 'fail') return fail(step.text);
    if (step.type === 'think') {
      for (const piece of pieces(step.text)) {
        update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: piece } });
        await sleep(pieceDelay());
      }
    }
    if (step.type === 'todo') {
      update({ sessionUpdate: 'plan', entries: step.entries.map((e) => ({ content: e.text, status: e.status, priority: 'medium' })) });
    }
    if (step.type === 'tool') {
      const id = `tc_${++n}`;
      update({ sessionUpdate: 'tool_call', toolCallId: id, title: 'list_dir', kind: 'read', status: 'in_progress', rawInput: { path: '.' }, _meta: { 'x.ai/tool': { name: 'list_dir' } } });
      await sleep(20);
      done(id, true, step.output);
    }
    if (step.type === 'approve') {
      const id = `tc_${++n}`;
      const call = { toolCallId: id, title: 'run_terminal_cmd', kind: 'execute', status: 'pending', rawInput: { command: step.command }, _meta: { 'x.ai/tool': { name: 'run_terminal_cmd' } } };
      update({ sessionUpdate: 'tool_call', ...call });
      const p = await permit(call);
      done(id, p.ok, p.ok ? 'e2e-approval' : 'Not executed: the user declined it.');
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
      update({ sessionUpdate: 'tool_call', ...call });
      // Asked first, as Grok asks; then its sandbox refuses a folder outside the profile.
      const p = await permit(call);
      const ok = p.ok && inside(file, s.dirs);
      if (ok) writeFile(file, step.content);
      done(id, ok, ok ? `Wrote ${file}` : p.ok ? 'Not executed: Operation not permitted.' : 'Not executed.');
      prefix += wrote(step, ok, p.note);
    }
    if (step.type === 'text') {
      for (const piece of pieces(prefix + step.text, step.slow)) {
        if (s.cancelled) return { stopReason: 'cancelled' };
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: piece } });
        await sleep(pieceDelay(step.slow));
      }
      update({ sessionUpdate: 'response_completed' });
    }
  }
  return { stopReason: 'end_turn', _meta: { usage: { inputTokens: 90, outputTokens: 25 } } };
}

// --- Which command ------------------------------------------------------------------------------------

if (CLI === 'claude') {
  if (has('--input-format') && flag('--input-format') === 'stream-json') claudeStream();
  else claudeStatic();
} else if (CLI === 'codex') {
  if (args.includes('app-server')) codexAppServer();
  else codexStatic();
} else if (args[0] === 'agent' && args.includes('stdio')) {
  grokAgent();
} else {
  grokStatic();
}
