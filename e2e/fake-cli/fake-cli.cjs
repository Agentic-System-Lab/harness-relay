'use strict';
/*
 * A stand-in for the `claude`, `codex` and `grok` CLIs, for the end-to-end tests. Which one it is
 * comes from the name it runs under (`claude`, `codex.exe`, …): `e2e/fake-cli/build.ts` installs it
 * under all three names (a script on macOS and Linux, a Node single executable on Windows).
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
 *   `e2e:template=…`; one Claude member by default) and the group of a new conversation (the first
 *   group named in its first message);
 * - a turn: a short reply that names the agent and repeats the user's latest message, streamed in
 *   pieces, changed by the directives in that message (see DIRECTIVES below). A directive written as
 *   `e2e:<name>@<cli>` is for that CLI only, `e2e:write=notes.md@codex` say.
 *
 * E2E_FAKE_LOG names a file that gets a JSON line for each start (the CLI, its arguments) and each
 * prompt, for the tests to read.
 */
const fs = require('node:fs');
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
record({ args });

// --- What it says ----------------------------------------------------------------------------------

/**
 * The directives a user message can hold. Each one is `e2e:<name>`, with `=<value>` for some, and
 * `@<cli>` to keep it to one CLI.
 */
const DIRECTIVES = {
  think: 'show some thinking first',
  tool: 'list the working directory with a tool first',
  todo: 'show a to-do list',
  approve: 'ask before running a command (`echo e2e-approval`), then say whether it ran',
  write: 'write the file named (relative to the working directory), when the permission allows it',
  ask: 'end the reply with a question for the user ([ASK_USER])',
  handoff: 'mention the member named, to hand the floor to it (not when that member is speaking)',
  slow: 'stream the reply slowly (about ten seconds), to be stopped',
  fail: 'fail the turn with an error',
  flaky: 'fail the first time this message is answered, answer the next time (a retry)',
  markdown: 'answer with a heading, a list, a table and a code block',
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

/** The file permission the briefing gives the agent. */
function permissionOf(briefing) {
  if (/^READ-ONLY\./m.test(briefing) || /READ-ONLY\. You may read files/.test(briefing)) return 'read-only';
  if (/Full access: you may edit files and run commands without approval/.test(briefing)) return 'full';
  if (/You may read and edit files inside the working directory/.test(briefing)) return 'edit';
  return 'read-only';
}

/** The last message the user wrote, in a turn prompt's chat. */
function lastUserMessage(prompt) {
  let last;
  for (const m of prompt.matchAll(/<message from="user"[^>]*>\n([\s\S]*?)\n<\/message>/g)) last = m[1];
  return last;
}

function tag(prompt, name) {
  const m = new RegExp(`<${name}>\\n([\\s\\S]*?)\\n</${name}>`).exec(prompt);
  return m ? m[1] : '';
}

/** The lead agent's answer: the team for a question. */
function planReply(prompt) {
  const question = tag(prompt, 'question');
  const d = directivesIn(question);
  if (typeof d.template === 'string') {
    return { choice: 'template', templateId: d.template, reason: 'The fake lead agent picked this template, as the question asked.' };
  }
  const providers = (typeof d.team === 'string' ? d.team : 'claude')
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .filter((p) => ['claude', 'codex', 'grok'].includes(p));
  const count = {};
  const agents = (providers.length ? providers : ['claude']).map((provider) => {
    count[provider] = (count[provider] || 0) + 1;
    const base = provider[0].toUpperCase() + provider.slice(1);
    return {
      name: count[provider] > 1 ? `${base}${count[provider]}` : base,
      provider,
      role: `Answer the question as ${base}.`,
    };
  });
  const mode = ['roundtable', 'parallel', 'relay'].includes(d.mode) ? d.mode : 'roundtable';
  return {
    choice: 'custom',
    name: typeof d.name === 'string' ? d.name.replace(/_/g, ' ') : 'E2E team',
    description: 'A team picked by the fake lead agent.',
    mode,
    rounds: Number(d.rounds) || 1,
    maxHops: Number(d.hops) || 8,
    agents,
    reason: 'The fake lead agent picked the members the question asked for.',
  };
}

/** The lead agent's answer: the group a new conversation goes in (0: none). */
function groupReply(prompt) {
  const message = tag(prompt, 'message').toLowerCase();
  const groups = [...prompt.matchAll(/^(\d+)\. ("(?:[^"\\]|\\.)*")/gm)].map((m) => ({ n: Number(m[1]), name: JSON.parse(m[2]) }));
  const hit = groups.find((g) => message.includes(g.name.toLowerCase()));
  return { group: hit ? hit.n : 0 };
}

/** The lead agent's answer to "change the team": the team as it is, with a reason. */
function reviseReply(prompt) {
  const team = /<current_team>\n([\s\S]*?)\n<\/current_team>/.exec(prompt) || /<team>\n([\s\S]*?)\n<\/team>/.exec(prompt);
  let current = {};
  try {
    current = team ? JSON.parse(team[1]) : {};
  } catch {
    /* answered without it */
  }
  const agents = (current.agents || current.members || []).map((a) => ({ name: a.name, provider: a.provider }));
  return { mode: current.mode || 'roundtable', rounds: current.rounds || 1, maxHops: current.maxHops || 8, agents, reason: 'The fake lead agent kept the team as it is.' };
}

const json = (value) => '```json\n' + JSON.stringify(value, null, 2) + '\n```';

/**
 * The steps of a reply: `think`, `text` (streamed in pieces), `tool` (a tool call and its result),
 * `todo`, `approve` (a command the user is asked about), `write` (a file) and `fail`.
 */
function plan(prompt, briefing, cwd) {
  if (/Reply with only one of these JSON objects/.test(prompt)) return [{ type: 'text', text: json(planReply(prompt)) }];
  if (/Reply with only this JSON object: \{"group"/.test(prompt)) return [{ type: 'text', text: JSON.stringify(groupReply(prompt)) }];
  if (/Reply with only this JSON object, in a ```json code block, with the whole team/.test(prompt)) {
    return [{ type: 'text', text: json(reviseReply(prompt)) }];
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
  if (d.tool) steps.push({ type: 'tool', kind: 'list', output: safeList(cwd) });
  if (d.approve) steps.push({ type: 'approve', command: 'echo e2e-approval' });
  if (typeof d.write === 'string') {
    const permission = permissionOf(briefing);
    steps.push({ type: 'write', path: d.write, content: `Written by ${me} (${LABEL}).\n`, allowed: permission !== 'read-only' });
  }
  const answered = /You asked the user a question and their reply is among the messages above/.test(prompt);
  let text = answered ? `Thanks, ${me} got your answer: “${said}”.` : `Hello from ${me} (${LABEL}). You said: “${said}”.`;
  if (d.markdown) {
    text +=
      '\n\n## Fake findings\n\n- first point\n- second point\n\n| CLI | Fake |\n| --- | --- |\n| ' +
      LABEL +
      ' | yes |\n\n```js\nconst answer = 42;\n```';
  }
  if (typeof d.handoff === 'string' && d.handoff.toLowerCase() !== me.toLowerCase()) text += ` @${d.handoff}, over to you.`;
  if (d.ask) text += '\n\nWhich option do you prefer, A or B? [ASK_USER]';
  steps.push({ type: 'text', text, slow: Boolean(d.slow) });
  return steps;
}

/** Whether this CLI sees `text` for the first time (remembered in its home, which is the test's own). */
function firstTime(text) {
  const home = process.env.CLAUDE_CONFIG_DIR && CLI === 'claude' ? process.env.CLAUDE_CONFIG_DIR : CLI === 'codex' ? process.env.CODEX_HOME : grokHome();
  const mark = path.join(home || require('node:os').tmpdir(), `e2e-seen-${require('node:crypto').createHash('sha1').update(text).digest('hex')}`);
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

/** Pieces of `text` to stream: a few words each, or many small ones for a slow reply. */
function pieces(text, slow) {
  const words = text.split(/(?<=\s)/);
  if (slow) {
    const out = [];
    for (let i = 0; i < 40; i++) out.push(i === 0 ? text : ' …');
    return out;
  }
  const out = [];
  for (let i = 0; i < words.length; i += 3) out.push(words.slice(i, i + 3).join(''));
  return out.length ? out : [text];
}
const pieceDelay = (slow) => (slow ? 250 : 15);

function writeFile(cwd, rel, content) {
  const file = path.resolve(cwd, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

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

const unknownMethod = (method) => Object.assign(new Error(`unknown method ${method}`), { code: -32601 });

/** Ends the CLI with an error, once its message is out (pipes are asynchronous on macOS and Windows). */
function fail(text) {
  process.stdout.write('', () => process.stderr.write(text + '\n', () => process.exit(1)));
  return new Promise(() => {});
}

// --- claude ------------------------------------------------------------------------------------------

function claudeStatic() {
  if (has('--version')) return void process.stdout.write('2.1.999 (Claude Code)\n');
  if (args[0] === 'auth' && args[1] === 'status') {
    return void process.stdout.write(
      JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'e2e@example.com', subscriptionType: 'max' }, null, 2) + '\n',
    );
  }
  if (args[0] === 'plugin' && args[1] === 'list') return void process.stdout.write('[]\n');
  if (args[0] === 'mcp' && args[1] === 'list') return void process.stdout.write('No MCP servers configured.\n');
  process.stderr.write(`fake claude: unknown command ${args.join(' ')}\n`);
  process.exitCode = 1;
}

function claudeStream() {
  const sessionId = flag('--resume') || flag('--session-id') || newId('claude-session');
  const briefing = flag('--append-system-prompt') || '';
  const mode = flag('--permission-mode') || 'default';
  const asks = flag('--permission-prompt-tool') === 'stdio';
  const pending = new Map();
  let busy = false;

  const reply = (m, response) => out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response } });
  const refuse = (m, error) => out({ type: 'control_response', response: { subtype: 'error', request_id: m.request_id, error } });
  const ask = (request) =>
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
            commands: [
              { name: 'compact', description: 'Compact the conversation', argumentHint: '', builtin: true },
              { name: 'usage', description: 'Show usage', argumentHint: '', builtin: true },
            ],
            agents: [
              { name: 'general-purpose', description: 'The general-purpose agent' },
              { name: 'Explore', description: 'The Explore agent' },
            ],
            models: [],
          });
        case 'apply_flag_settings':
          return reply(m, undefined);
        case 'mcp_status':
          return reply(m, { mcpServers: [] });
        case 'get_hooks_listing':
          return reply(m, { hooks: [] });
        case 'get_settings':
          return reply(m, { effective: {} });
        case 'interrupt':
          return reply(m, undefined);
        default:
          return refuse(m, `Unsupported control request subtype: ${m.request && m.request.subtype}`);
      }
    }
    if (m.type !== 'user' || busy) return;
    busy = true;
    const content = m.message && m.message.content;
    const prompt = typeof content === 'string' ? content : (Array.isArray(content) ? content : []).map((b) => b.text || '').join('\n');
    record({ prompt, briefing, mode });
    out({
      type: 'system',
      subtype: 'init',
      session_id: sessionId,
      cwd: process.cwd(),
      tools: ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'TodoWrite'],
      mcp_servers: [],
      model: flag('--model') || 'claude-fake',
      permissionMode: mode,
    });
    await claudeTurn(plan(prompt, briefing, process.cwd()), { sessionId, mode, asks, ask });
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

  for (const step of steps) {
    if (step.type === 'fail') return fail(step.text);
    if (step.type === 'think') await stream('thinking', step.text);
    if (step.type === 'todo') {
      await tool('TodoWrite', { todos: step.entries.map((e) => ({ content: e.text, status: e.status, activeForm: e.text })) }, async () => ({
        content: 'Todos have been modified successfully.',
        isError: false,
      }));
    }
    if (step.type === 'tool') await tool('Bash', { command: 'ls', description: 'List the working directory' }, async () => ({ content: step.output, isError: false }));
    if (step.type === 'approve') {
      let ran = o.mode === 'bypassPermissions';
      let message = 'Permission to use Bash has been denied.';
      if (!ran && o.asks) {
        const answer = await o.ask({ tool_name: 'Bash', input: { command: step.command, description: 'Print a line (an e2e check)' }, tool_use_id: `toolu_ask_${process.pid}` });
        ran = answer.behavior === 'allow';
        if (!ran && answer.message) message = answer.message;
      }
      await tool('Bash', { command: step.command, description: 'Print a line (an e2e check)' }, async () =>
        ran ? { content: 'e2e-approval', isError: false } : { content: message, isError: true },
      );
      full += ran ? 'The command ran: e2e-approval. ' : 'The command was declined. ';
    }
    if (step.type === 'write') {
      const file = path.resolve(process.cwd(), step.path);
      const allowed = step.allowed && o.mode !== 'manual' && o.mode !== 'dontAsk';
      await tool('Write', { file_path: file, content: step.content }, async () => {
        if (!allowed) return { content: 'Permission to use Write has been denied.', isError: true };
        writeFile(process.cwd(), step.path, step.content);
        return { content: `File created successfully at: ${file}`, isError: false };
      });
      full += allowed ? `I wrote ${step.path}. ` : `I may not write ${step.path} here. `;
    }
    if (step.type === 'text') {
      const text = full + step.text;
      full = text;
      await stream('text', text, step.slow);
    }
  }
  out({
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 50,
    num_turns: 1,
    result: full,
    session_id: o.sessionId,
    total_cost_usd: 0.0012,
    usage: { input_tokens: 120, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 40 },
  });
}

// --- codex -------------------------------------------------------------------------------------------

function codexStatic() {
  if (has('--version')) return void process.stdout.write('codex-cli 0.999.0\n');
  if (args[0] === 'login' && args[1] === 'status') return void process.stderr.write('Logged in using ChatGPT\n');
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

function codexAppServer() {
  const threads = new Map();
  let peer;
  peer = rpcPeer(
    false,
    async (method, p) => {
      switch (method) {
        case 'initialize':
          return { userAgent: 'codex_cli_rs/0.999.0 (fake)', codexHome: process.env.CODEX_HOME || '' };
        case 'thread/start':
        case 'thread/resume': {
          const id = method === 'thread/resume' ? p.threadId : newId('thread');
          threads.set(id, { cwd: p.cwd || process.cwd(), briefing: p.developerInstructions || '', approval: p.approvalPolicy || 'never', sandbox: p.sandbox, profile: p.permissions });
          return {
            thread: { id, preview: '', modelProvider: 'openai', createdAt: Math.floor(Date.now() / 1000), cwd: p.cwd },
            model: p.model || 'gpt-fake-codex',
            ...(typeof p.permissions === 'string' ? { activePermissionProfile: { id: p.permissions } } : {}),
          };
        }
        case 'turn/start': {
          const t = threads.get(p.threadId);
          if (!t) throw new Error(`no thread ${p.threadId}`);
          const prompt = (p.input || []).map((i) => i.text || '').join('\n');
          record({ prompt, briefing: t.briefing, approval: t.approval, sandbox: t.sandbox || t.profile });
          const turnId = newId('turn');
          track(sleep(5).then(() => codexTurn(peer, p.threadId, turnId, t, plan(prompt, t.briefing, t.cwd))));
          return { turn: { id: turnId, items: [], status: 'inProgress', error: null } };
        }
        case 'turn/interrupt':
          interrupted.add(p.turnId);
          return {};
        case 'skills/list':
          return { data: [] };
        case 'config/read':
          return { config: { mcp_servers: {} }, origins: {} };
        case 'hooks/list':
          return { data: [] };
        case 'plugin/installed':
          return { marketplaces: [] };
        case 'mcpServerStatus/list':
          return { data: [] };
        default:
          throw unknownMethod(method);
      }
    },
    () => {},
  );
}

const interrupted = new Set();

async function codexTurn(peer, threadId, turnId, t, steps) {
  const note = (method, params) => peer.notify(method, { threadId, turnId, ...params });
  let n = 0;
  let prefix = '';
  const item = async (started, finish) => {
    note('item/started', { item: started });
    await sleep(20);
    note('item/completed', { item: await finish() });
  };
  const stopped = () => interrupted.has(turnId);
  const permission = permissionOf(t.briefing);
  const sandboxed = permission !== 'full';
  for (const step of steps) {
    if (stopped()) break;
    if (step.type === 'fail') return fail(step.text);
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
      await item({ ...base, status: 'inProgress', aggregatedOutput: null, exitCode: null }, async () => ({ ...base, status: 'completed', aggregatedOutput: step.output, exitCode: 0, durationMs: 5 }));
    }
    if (step.type === 'approve') {
      const id = `call_${++n}`;
      const base = { type: 'commandExecution', id, command: step.command, cwd: t.cwd, processId: null, commandActions: [] };
      note('item/started', { item: { ...base, status: 'inProgress', aggregatedOutput: null, exitCode: null } });
      let ran = !sandboxed;
      if (!ran && t.approval !== 'never') {
        const answer = await peer.request('item/commandExecution/requestApproval', { threadId, turnId, itemId: id, command: step.command, cwd: t.cwd, reason: 'Print a line (an e2e check)' }).catch(() => ({}));
        ran = answer && (answer.decision === 'accept' || answer.decision === 'acceptForSession' || answer.decision === 'approved');
      }
      note('item/completed', {
        item: ran ? { ...base, status: 'completed', aggregatedOutput: 'e2e-approval\n', exitCode: 0 } : { ...base, status: 'declined', aggregatedOutput: null, exitCode: null },
      });
      prefix += ran ? 'The command ran: e2e-approval. ' : 'The command was declined. ';
    }
    if (step.type === 'write') {
      const id = `patch_${++n}`;
      const file = path.resolve(t.cwd, step.path);
      const changes = [{ path: file, kind: { type: 'add' }, diff: step.content }];
      const allowed = step.allowed;
      await item({ type: 'fileChange', id, changes, status: 'inProgress' }, async () => {
        if (allowed) writeFile(t.cwd, step.path, step.content);
        return { type: 'fileChange', id, changes, status: allowed ? 'completed' : 'declined' };
      });
      prefix += allowed ? `I wrote ${step.path}. ` : `I may not write ${step.path} here. `;
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

function grokHome() {
  return process.env.GROK_HOME || path.join(require('node:os').homedir(), '.grok');
}

function grokTrusted(folder) {
  try {
    const store = fs.readFileSync(path.join(grokHome(), 'trusted_folders.toml'), 'utf8');
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

function grokStatic() {
  if (has('--version')) return void process.stdout.write('grok 1.0.999\n');
  if (args[0] === 'models') return void process.stdout.write('Default model: grok-fake\n\nModels:\n* grok-fake\n- grok-fake-mini\n');
  if (args[0] === 'inspect') {
    const cwd = process.cwd();
    const root = projectRoot(cwd);
    return void process.stdout.write(
      JSON.stringify({ cwd: fs.realpathSync(cwd), projectRoot: root, projectTrusted: grokTrusted(root), skills: [], mcpServers: [], projectInstructions: [], hooks: [] }) + '\n',
    );
  }
  process.stderr.write(`fake grok: unknown command ${args.join(' ')}\n`);
  process.exitCode = 1;
}

function grokAgent() {
  const sessions = new Map();
  let peer;
  peer = rpcPeer(
    true,
    async (method, p) => {
      switch (method) {
        case 'initialize':
          return { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true }, mcpCapabilities: { http: true } }, authMethods: [] };
        case 'session/new':
        case 'session/resume': {
          const id = method === 'session/resume' ? p.sessionId : newId('grok-session');
          const meta = p._meta || {};
          sessions.set(id, { cwd: p.cwd || process.cwd(), briefing: meta.rules || '', yolo: Boolean(meta.yoloMode), cancelled: false });
          return {
            ...(method === 'session/new' ? { sessionId: id } : {}),
            configOptions: [
              { id: 'model', currentValue: 'grok-fake' },
              { id: 'reasoning_effort', currentValue: 'medium' },
            ],
          };
        }
        case 'session/set_config_option':
          return {};
        case 'session/prompt': {
          const s = sessions.get(p.sessionId);
          if (!s) throw new Error(`no session ${p.sessionId}`);
          const prompt = (p.prompt || []).map((b) => b.text || '').join('\n');
          record({ prompt, briefing: s.briefing, yolo: s.yolo, sandbox: process.env.GROK_SANDBOX || null });
          s.cancelled = false;
          return grokTurn(peer, p.sessionId, s, plan(prompt, s.briefing, s.cwd));
        }
        default:
          throw unknownMethod(method);
      }
    },
    (method, p) => {
      if (method === 'session/cancel' && sessions.has(p.sessionId)) sessions.get(p.sessionId).cancelled = true;
    },
  );
}

async function grokTurn(peer, sessionId, s, steps) {
  const update = (u) => peer.notify('session/update', { sessionId, update: u });
  let n = 0;
  let prefix = '';
  const permit = async (toolCall) => {
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
    return Boolean(answer && answer.outcome && answer.outcome.outcome === 'selected' && answer.outcome.optionId === 'allow-once');
  };
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
      update({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed', content: [{ type: 'content', content: { type: 'text', text: step.output } }] });
    }
    if (step.type === 'approve') {
      const id = `tc_${++n}`;
      const call = { toolCallId: id, title: 'run_terminal_cmd', kind: 'execute', status: 'pending', rawInput: { command: step.command }, _meta: { 'x.ai/tool': { name: 'run_terminal_cmd' } } };
      update({ sessionUpdate: 'tool_call', ...call });
      const ran = s.yolo || (await permit(call));
      update({
        sessionUpdate: 'tool_call_update',
        toolCallId: id,
        status: ran ? 'completed' : 'failed',
        content: [{ type: 'content', content: { type: 'text', text: ran ? 'e2e-approval' : 'Not executed: the user declined it.' } }],
      });
      prefix += ran ? 'The command ran: e2e-approval. ' : 'The command was declined. ';
    }
    if (step.type === 'write') {
      const id = `tc_${++n}`;
      const file = path.resolve(s.cwd, step.path);
      const call = { toolCallId: id, title: 'write_file', kind: 'edit', status: 'pending', rawInput: { path: file, content: step.content }, _meta: { 'x.ai/tool': { name: 'write_file' } } };
      update({ sessionUpdate: 'tool_call', ...call });
      const allowed = step.allowed && (s.yolo || (await permit(call)));
      if (allowed) writeFile(s.cwd, step.path, step.content);
      update({
        sessionUpdate: 'tool_call_update',
        toolCallId: id,
        status: allowed ? 'completed' : 'failed',
        content: [{ type: 'content', content: { type: 'text', text: allowed ? `Wrote ${file}` : 'Not executed.' } }],
      });
      prefix += allowed ? `I wrote ${step.path}. ` : `I may not write ${step.path} here. `;
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
