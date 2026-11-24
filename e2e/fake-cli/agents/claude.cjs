'use strict';
/*
 * The fake Claude Code (`claude`): `claude -p --input-format stream-json --output-format stream-json …`
 * (control requests, `get_usage` among them, partial messages, tool calls, `can_use_tool` approvals
 * over stdio), `--version`,
 * `auth status|login|logout`, `plugin list --json`, `mcp list`.
 *
 * Whether a write or a read happens is decided only by what Harness Relay gave it, as with the real
 * one: `--permission-mode`, `--disallowedTools`, the working directory and `--add-dir` folders, and
 * the answers to its `can_use_tool` requests (it reads elsewhere, a skill's SKILL.md say, only by a
 * `Read(//<folder>/**)` rule in `--allowedTools`, or with full access). The skills it loads by
 * itself are its home's skills/ and the projects' .claude/skills/ (`--disable-slash-commands`,
 * `skillOverrides` in `--settings` leave them out).
 *
 * The hooks its `initialize` registers (Harness Relay's team hooks) are called around its command
 * (`e2e:approve`) and its Write (`e2e:write`), as Claude Code 2.1.327 calls them: a `hook_callback` for
 * the `PreToolUse` entry whose matcher names the tool (or has none), whose `permissionDecision: deny`
 * refuses the call with its reason; once it ran, one for the `PostToolUse` entry, whose `decision:
 * block` reason it is told.
 *
 * An `interrupt` control request (Harness Relay's Stop) ends a turn under way at once, with a result
 * (`error_during_execution`) that carries the run's usage, as Claude Code's does.
 *
 * Its usage is counted as Claude Code 2.1.323's: each run that reaches the model costs $0.0012, 120
 * tokens in and 40 out (a failed one too); a kept session's result reports the session's totals
 * (`total_cost_usd`, `modelUsage`), counted on from the last `cost-state` record of its file
 * (`<home>/projects/<folder>/<id>.jsonl`), where a new one is written as the run ends; `usage` and
 * `model_usage_since_last_result` are the run's own.
 *
 * A user message with a `uuid` that comes while a turn runs goes into it (steering), as Claude Code
 * 2.1.330 takes one: `command_lifecycle` queued as it comes, started as the turn takes it in (an
 * `e2e:steer` step waits for one; any other before the result), completed after the result.
 */
const fs = require('node:fs');
const { callMcpTool } = require('../lib/mcp.cjs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { inside, notAWorkingDirectory, ownSkills, targetOf, writeFile } = require('../lib/files.cjs');
const { keyVerdict, planResets, planUsedPercent, sessions, signIn, signedOut } = require('../lib/home.cjs');
const { exitAfterLog, record } = require('../lib/log.cjs');
const { declined, heard, noOther, noteIn, pieceDelay, pieces, plan, recordMcpEnv, steerBox, wrote } = require('../lib/plan.cjs');
const { fail, onLines, out } = require('../lib/rpc.cjs');
const { args, flag, has, home, newId, sleep, values } = require('../lib/self.cjs');

function claudeStatic() {
  if (has('--version')) return void process.stdout.write(`${module.exports.version}\n`);
  if (args[0] === 'auth' && args[1] === 'status') {
    const status = signedOut()
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
    process.stdout.write(
      "Opening browser to sign in…\nIf the browser didn't open, visit: https://claude.example.invalid/e2e-login\nPaste code here if prompted > ",
    );
    const rl = readline.createInterface({ input: process.stdin });
    rl.once('line', (code) => {
      rl.close();
      signIn.login(code.trim());
      process.stdout.write('\nLogin successful.\n', () => exitAfterLog(0));
    });
    return;
  }
  if (args[0] === 'plugin' && args[1] === 'list') return void process.stdout.write('[]\n');
  if (args[0] === 'mcp' && args[1] === 'list') return void process.stdout.write('No MCP servers configured.\n');
  if (args.length === 3 && args[0] === 'mcp' && args[1] === 'get') {
    // Hosted connector settings for this test account, as reported by the real CLI, keyed by the exact connector name it is asked for.
    const fixture = path.join(home(), 'e2e-hosted-connectors.json');
    const inventory = fs.existsSync(fixture) ? JSON.parse(fs.readFileSync(fixture, 'utf8')) : {};
    const result = inventory[args[2]] || { code: 1, stderr: `No MCP server named "${args[2]}".\n` };
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exitCode = result.code;
    return;
  }
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

/** The stdio and HTTP MCP servers this test turn can call, as Claude Code received them. */
function claudeMcpSpecs() {
  const out = {};
  for (const file of values('--mcp-config')) {
    try {
      const servers = JSON.parse(file.trim().startsWith('{') ? file : fs.readFileSync(file, 'utf8')).mcpServers || {};
      for (const [name, s] of Object.entries(servers)) {
        if (s.command) out[name] = { command: s.command, args: s.args || [], env: s.env || {} };
        else if (s.type === 'http' && s.url) out[name] = { url: s.url, headers: s.headers || {} };
      }
    } catch {
      /* not one to read */
    }
  }
  return out;
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

/** The URL of each `--mcp-config` server given as an HTTP server (`"type": "http"`), by server. */
function claudeMcpHttp() {
  const out = {};
  for (const file of values('--mcp-config')) {
    try {
      const servers = JSON.parse(file.trim().startsWith('{') ? file : fs.readFileSync(file, 'utf8')).mcpServers || {};
      for (const [name, s] of Object.entries(servers)) if (s.type === 'http') out[name] = s.url;
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
    keep: Boolean(resume) || persist,
    mode,
    asks,
    noWrite: disallowed.includes('Write'),
    dirs: mode === 'bypassPermissions' ? null : mode === 'acceptEdits' ? [process.cwd(), ...addDirs] : [],
    others: addDirs.filter((d) => !notAWorkingDirectory(d)),
    // Its Read tool, without asking: in its folders and those of its Read rules, anywhere with full access.
    reads: mode === 'bypassPermissions' ? null : [process.cwd(), ...addDirs, ...claudeReadRules()],
    mcpSpecs: claudeMcpSpecs(),
    steer: steerBox(),
  };
  const pending = new Map();
  let busy = false;
  o.lifecycle = (uuid, state) => out({ type: 'command_lifecycle', command_uuid: uuid, state, uuid: newId('life'), session_id: sessionId });

  const reply = (m, response) => out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response } });
  const refuse = (m, error) => out({ type: 'control_response', response: { subtype: 'error', request_id: m.request_id, error } });
  /** `withdrawMs`: it stops waiting then, as Claude Code does when its own rule or hook decided first. */
  o.ask = (request, withdrawMs) =>
    new Promise((resolve) => {
      const requestId = newId('perm');
      pending.set(requestId, resolve);
      out({ type: 'control_request', request_id: requestId, request: { subtype: 'can_use_tool', ...request } });
      if (withdrawMs !== undefined)
        setTimeout(() => {
          if (!pending.delete(requestId)) return;
          out({ type: 'control_cancel_request', request_id: requestId });
          resolve({ behavior: 'allow', withdrawn: true });
        }, withdrawMs);
    });
  // The hooks `initialize` registered, by event: the callback a tool's call goes to, if any.
  o.hooks = {};
  o.hook = (event, input) => {
    const entry = (o.hooks[event] || []).find((e) => !e.matcher || e.matcher.split('|').includes(input.tool_name));
    if (!entry) return Promise.resolve({});
    return new Promise((resolve) => {
      const requestId = newId('hook');
      pending.set(requestId, resolve);
      out({
        type: 'control_request',
        request_id: requestId,
        request: {
          subtype: 'hook_callback',
          callback_id: entry.hookCallbackIds[0],
          input: { hook_event_name: event, cwd: process.cwd(), ...input },
        },
      });
    });
  };

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
          o.hooks = (m.request && m.request.hooks) || {};
          record({ hooks: o.hooks });
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
          return reply(m, undefined);
        case 'interrupt':
          reply(m, undefined);
          // As Claude Code: a turn under way ends at once, with a result that says what it used.
          if (busy) {
            claudeResult(o, { subtype: 'error_during_execution', is_error: true, errors: [] });
            process.stdout.write('', () => exitAfterLog(0));
          }
          return;
        case 'mcp_status':
          return reply(m, { mcpServers: [] });
        case 'get_hooks_listing':
          return reply(m, { hooks: [] });
        case 'get_settings':
          return reply(m, { effective: {} });
        case 'get_usage': {
          // What its /usage shows: no plan limits on an API key (or signed out), else the plan's.
          const plan = !signedOut() && !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN;
          const used = planUsedPercent();
          return reply(m, {
            session: { total_cost_usd: 0 },
            subscription_type: plan ? 'max' : null,
            rate_limits_available: plan,
            rate_limits: plan
              ? {
                  limits: [
                    {
                      kind: 'session',
                      group: 'session',
                      percent: used,
                      resets_at: new Date(planResets.fiveHour()).toISOString(),
                      scope: null,
                      is_active: true,
                    },
                    {
                      kind: 'weekly_all',
                      group: 'weekly',
                      percent: Math.round(used / 2),
                      resets_at: new Date(planResets.week()).toISOString(),
                      scope: null,
                      is_active: true,
                    },
                  ],
                }
              : null,
          });
        }
        default:
          return refuse(m, `Unsupported control request subtype: ${m.request && m.request.subtype}`);
      }
    }
    // Steering: a message of the user's for the running turn.
    if (m.type === 'user' && busy && m.uuid) {
      o.lifecycle(m.uuid, 'queued');
      return o.steer.take(typeof m.message.content === 'string' ? m.message.content : '', m.uuid);
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
    recordMcpEnv(claudeMcpEnv(), claudeMcpHttp());
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
      // What it may do by itself in the turn: its subagents (a deny rule for the whole Agent tool takes
      // them all), its workflows (CLAUDE_CODE_DISABLE_WORKFLOWS) and ultracode, as Claude Code reads them.
      subagents: !((claudeSettings().permissions || {}).deny || []).includes('Agent'),
      workflows: process.env.CLAUDE_CODE_DISABLE_WORKFLOWS !== '1',
      ultracode: claudeSettings().ultracode === true,
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
    if (signedOut())
      return claudeResult(o, { is_error: true, subtype: 'error_during_execution', result: 'Not logged in · Please run /login' }, false);
    await claudeTurn(plan(prompt, turn), o);
  });
}

/** What one run uses. */
const RUN = { cost: 0.0012, input: 120, output: 40 };

/**
 * The session's totals with this run's, kept in its file as a `cost-state` record, as Claude Code
 * does; a session that is not kept (`--no-session-persistence`) has only the run's.
 */
function sessionTotals(o) {
  if (!o.keep) return RUN;
  const file = path.join(home(), 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'), `${o.sessionId}.jsonl`);
  let was = { totalCostUSD: 0, modelUsage: {} };
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) if (line.includes('"cost-state"')) was = JSON.parse(line);
  } catch {
    // its first run
  }
  const m = (was.modelUsage || {})['claude-fake'] || {};
  const totals = {
    cost: Math.round((was.totalCostUSD + RUN.cost) * 1e8) / 1e8,
    input: (m.inputTokens || 0) + RUN.input,
    output: (m.outputTokens || 0) + RUN.output,
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(
    file,
    JSON.stringify({ type: 'cost-state', sessionId: o.sessionId, totalCostUSD: totals.cost, modelUsage: modelUsageOf(totals) }) + '\n',
  );
  return totals;
}

/** `modelUsage` as Claude Code writes it, for `totals` of the one model. */
const modelUsageOf = (totals) => ({
  'claude-fake': {
    inputTokens: totals.input,
    outputTokens: totals.output,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    costUSD: totals.cost,
  },
});

/** The run's result; `spent` false for a run that never reached the model (signed out). */
function claudeResult(o, r, spent = true) {
  const totals = spent ? sessionTotals(o) : { cost: 0, input: 0, output: 0 };
  out({
    type: 'result',
    duration_ms: 50,
    num_turns: 1,
    session_id: o.sessionId,
    total_cost_usd: totals.cost,
    modelUsage: modelUsageOf(totals),
    model_usage_since_last_result: spent ? modelUsageOf(RUN) : {},
    usage: spent
      ? { input_tokens: RUN.input, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: RUN.output }
      : { input_tokens: 0, output_tokens: 0 },
    ...r,
  });
}

async function claudeTurn(steps, o) {
  let n = 0;
  let full = '';
  /** Messages sent into the turn (steering) it took in. */
  const taken = [];
  const tool = async (name, input, run) => {
    const id = `toolu_${++n}_${process.pid}`;
    out({
      type: 'assistant',
      session_id: o.sessionId,
      parent_tool_use_id: null,
      message: { id: `msg_tool_${n}`, role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
    });
    await sleep(20);
    const { content, isError } = await run();
    out({
      type: 'user',
      session_id: o.sessionId,
      parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] },
    });
  };
  const stream = async (kind, text, slow) => {
    const msgId = `msg_${++n}_${process.pid}`;
    const ev = (event) => out({ type: 'stream_event', session_id: o.sessionId, parent_tool_use_id: null, event });
    ev({ type: 'message_start', message: { id: msgId, role: 'assistant', content: [] } });
    ev({
      type: 'content_block_start',
      index: 0,
      content_block: kind === 'text' ? { type: 'text', text: '' } : { type: 'thinking', thinking: '' },
    });
    for (const piece of pieces(text, slow)) {
      ev({
        type: 'content_block_delta',
        index: 0,
        delta: kind === 'text' ? { type: 'text_delta', text: piece } : { type: 'thinking_delta', thinking: piece },
      });
      await sleep(pieceDelay(slow));
    }
    ev({ type: 'content_block_stop', index: 0 });
    ev({ type: 'message_stop' });
    const block = kind === 'text' ? { type: 'text', text } : { type: 'thinking', thinking: text };
    out({
      type: 'assistant',
      session_id: o.sessionId,
      parent_tool_use_id: null,
      message: { id: msgId, role: 'assistant', content: [block] },
    });
  };
  /**
   * A subagent's work, as Claude Code 2.1.330 reports it: its `Agent` call, its own calls with the
   * Agent call's id as their `parent_tool_use_id` (a subagent of its own the same way), what it
   * reported as the Agent call's result (with the line Claude Code adds for the agent that called it),
   * and then a compaction (`system`/`compact_boundary`).
   */
  const subagent = async (step) => {
    const call = (name, input, parent) => {
      const id = `toolu_${++n}_${process.pid}`;
      out({
        type: 'assistant',
        session_id: o.sessionId,
        parent_tool_use_id: parent,
        message: { id: `msg_tool_${n}`, role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
      });
      return id;
    };
    const answer = (id, content, parent) =>
      out({
        type: 'user',
        session_id: o.sessionId,
        parent_tool_use_id: parent,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] },
      });
    const agent = call('Agent', {
      description: 'Look around the project',
      prompt: 'List the folder and read its README.',
      subagent_type: 'Explore',
      model: 'haiku',
      run_in_background: false,
    });
    await sleep(20);
    const list = call('Bash', { command: 'ls', description: 'List the working directory' }, agent);
    await sleep(20);
    answer(list, step.output, agent);
    const read = call('Read', { file_path: path.join(process.cwd(), 'README.md') }, agent);
    await sleep(step.wait || 1000);
    answer(read, '# A fake project', agent);
    const inner = call('Agent', { description: 'Search for TODOs', prompt: 'Find the TODOs.', subagent_type: 'general-purpose' }, agent);
    const grep = call('Grep', { pattern: 'TODO' }, inner);
    await sleep(20);
    answer(grep, 'No matches found', inner);
    answer(inner, [{ type: 'text', text: 'There are no TODOs.' }], agent);
    answer(agent, [
      { type: 'text', text: 'The project has a README and no TODOs.' },
      {
        type: 'text',
        text: `agentId: a${n} (use SendMessage with to: 'a${n}' to continue this agent)\n<usage>subagent_tokens: 10</usage>`,
      },
    ]);
    out({ type: 'system', subtype: 'compact_boundary', session_id: o.sessionId, compact_metadata: { trigger: 'auto', pre_tokens: 1000 } });
  };
  /** The team's before hooks on a call: the reason they refused it, or undefined. */
  const hookBefore = async (tool_name, tool_input) => {
    const a = await o.hook('PreToolUse', { tool_name, tool_input });
    const s = (a && a.hookSpecificOutput) || {};
    return s.permissionDecision === 'deny' ? String(s.permissionDecisionReason || 'Refused by a hook') : undefined;
  };
  /** The team's after hooks on a call that ran: what they told it, or ''. */
  const hookAfter = async (tool_name, tool_input, tool_response) => {
    const a = await o.hook('PostToolUse', { tool_name, tool_input, tool_response });
    return a && a.decision === 'block' && a.reason ? `The team's after hook said: ${String(a.reason).split('\n').slice(-1)[0]} ` : '';
  };
  /** Asks (or not) to use a tool beyond what it may do by itself: { ok, note, withdrawn }. */
  const permission = async (tool_name, input, withdrawMs) => {
    if (!o.asks) return { ok: false, message: `Permission to use ${tool_name} has been denied.` };
    const answer = await o.ask({ tool_name, input, tool_use_id: `toolu_ask_${++n}_${process.pid}` }, withdrawMs);
    return {
      ok: answer.behavior === 'allow',
      withdrawn: Boolean(answer.withdrawn),
      message: answer.message || `Permission to use ${tool_name} has been denied.`,
    };
  };

  for (const step of steps) {
    if (step.type === 'fail') return fail(step.text);
    if (step.type === 'error') return claudeResult(o, { subtype: 'error_during_execution', is_error: true, result: step.text });
    if (step.type === 'think') await stream('thinking', step.text);
    if (step.type === 'todo') {
      await tool(
        'TodoWrite',
        { todos: step.entries.map((e) => ({ content: e.text, status: e.status, activeForm: e.text })) },
        async () => ({
          content: 'Todos have been modified successfully.',
          isError: false,
        }),
      );
    }
    if (step.type === 'tool')
      await tool('Bash', { command: 'ls', description: 'List the working directory' }, async () => ({
        content: step.output,
        isError: false,
      }));
    if (step.type === 'subagent') await subagent(step);
    if (step.type === 'mcp') {
      const spec = o.mcpSpecs[step.server];
      const name = `mcp__${step.server}__${step.tool}`;
      const p = !spec
        ? { ok: false, message: `No MCP server ${step.server}` }
        : o.mode === 'bypassPermissions'
          ? { ok: true }
          : await permission(name, step.args);
      let said = p.message;
      await tool(name, step.args, async () => {
        if (!p.ok) return { content: p.message, isError: true };
        const r = await callMcpTool(spec, step.tool, step.args);
        said = r.text;
        return { content: r.text, isError: r.isError };
      });
      full += `The ${step.tool} tool said: ${said} `;
    }
    if (step.type === 'approve') {
      const input = { command: step.command, description: 'Print a line (an e2e check)' };
      const refused = await hookBefore('Bash', input);
      if (refused) {
        await tool('Bash', input, async () => ({ content: refused, isError: true }));
        full += `The team's hook refused the command: ${refused.split('\n').slice(-1)[0]} `;
        continue;
      }
      const p = o.mode === 'bypassPermissions' ? { ok: true } : await permission('Bash', input, step.withdrawMs);
      await tool('Bash', input, async () => (p.ok ? { content: 'e2e-approval', isError: false } : { content: p.message, isError: true }));
      if (p.withdrawn) full += 'It stopped waiting for an answer and decided by its own rule. ';
      full += p.ok ? 'The command ran: e2e-approval. ' : declined('command', noteIn(p.message));
      if (p.ok) full += await hookAfter('Bash', input, { stdout: 'e2e-approval', stderr: '' });
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
      const refused = await hookBefore('Write', input);
      if (refused) {
        await tool('Write', input, async () => ({ content: refused, isError: true }));
        full += `The team's hook refused writing ${step.path}: ${refused.split('\n').slice(-1)[0]} `;
        continue;
      }
      const p = inside(file, o.dirs) ? { ok: true } : await permission('Write', input);
      await tool('Write', input, async () => {
        if (!p.ok) return { content: p.message, isError: true };
        writeFile(file, step.content);
        return { content: `File created successfully at: ${file}`, isError: false };
      });
      full += wrote(step, p.ok, p.ok ? '' : noteIn(p.message));
      if (p.ok) full += await hookAfter('Write', input, { filePath: file });
    }
    if (step.type === 'steer') {
      const came = await o.steer.wait(step.wait);
      for (const m of came) o.lifecycle(m.id, 'started');
      taken.push(...came);
      if (came.length) await stream('text', heard(came).trim());
      full += heard(came);
    }
    if (step.type === 'text') {
      full += step.text;
      await stream('text', full, step.slow);
    }
  }
  // What came and no step took: taken in before the turn ends.
  const rest = o.steer.rest();
  for (const m of rest) o.lifecycle(m.id, 'started');
  if (rest.length) await stream('text', heard(rest).trim());
  taken.push(...rest);
  claudeResult(o, { subtype: 'success', is_error: false, result: full + heard(rest) });
  for (const m of taken) o.lifecycle(m.id, 'completed');
}

module.exports = {
  provider: 'claude',
  bin: 'claude',
  label: 'Claude Code',
  name: 'Claude',
  version: '2.1.999 (Claude Code)',
  versionRe: /^2\.1\.999 \(Claude Code\)$/m,
  /** Its own folder: CLAUDE_CONFIG_DIR, else ~/.claude. */
  home: (env) => env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
  /** The key it was given (ANTHROPIC_API_KEY), by `keyVerdict`; null for none. */
  apiKey: (env) => (env.ANTHROPIC_API_KEY ? keyVerdict(env.ANTHROPIC_API_KEY) : null),
  main() {
    if (has('--input-format') && flag('--input-format') === 'stream-json') claudeStream();
    else claudeStatic();
  },
};
