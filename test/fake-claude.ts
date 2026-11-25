import { writeFileSync } from 'node:fs';

/*
 * A stand-in for `claude`, shaped like Claude Code 2.1.319's answers, for tests that run the real
 * adapter or probe without the CLI:
 * - `claude plugin list --json` lists two plugins (`deck@market` on, `lsp@market` off).
 * - `claude -p --input-format stream-json …` answers the control requests `initialize` (with the
 *   built-in `usage` command), `apply_flag_settings` (the permission rules it gets are kept for the
 *   session), `mcp_status`, `get_hooks_listing` and `get_settings` (the effective settings:
 *   `--settings` plus those rules), and a user message with a `system/init` message (its tools,
 *   built-in and `mcp__local__…`, and MCP servers) and a result.
 * The flags change the answers as they do Claude Code's: `--disable-slash-commands` (no commands, not
 * even built-in ones, though `/usage` is still answered),
 * `--strict-mcp-config` (no MCP servers of its own), `--tools ''` (no built-in tools), `--settings` (JSON
 * or a file of it)
 * (`disableAllHooks` marks the hook disabled; `enabledPlugins` false takes away that plugin's
 * command and subagent; `skillOverrides` "off" takes away that command; permission rules deny tools
 * by name, a server's tools by `mcp__local`) and `--setting-sources ''` (only the built-in
 * subagents).
 * FAKE_CLAUDE_LOG names a file that gets a JSON line for each start (its arguments, settings, the
 * `--system-prompt-file`'s text and some variables: the instruction files' switch, and Anthropic's
 * address, keys and sign-in token); FAKE_CLAUDE_PLUGIN_LOG one that gets a line for each `plugin list`,
 * for the rules applied, and for the prompt (with the rules in force when it came).
 * FAKE_CLAUDE_NO_APPLY refuses `apply_flag_settings`, as an older Claude Code would;
 * FAKE_CLAUDE_NO_PLUGINS makes `plugin list` fail; FAKE_CLAUDE_NO_AGENTS leaves `agents` out of
 * the `initialize` answer; FAKE_CLAUDE_OWN_EXPLORE gives it a user's `Explore` that replaces the
 * built-in one (same name, its own description); FAKE_CLAUDE_SLOW_APPLY answers
 * `apply_flag_settings` after two seconds; FAKE_CLAUDE_REJECT names a flag it rejects as an older
 * Claude Code would (exiting with "unknown option"); FAKE_CLAUDE_NO_HOOKS_AS_RUN refuses
 * `get_hooks_listing` when started with `--settings`; FAKE_CLAUDE_OWN_USAGE gives it a skill named
 * `usage` (so `/usage` would reach the model); FAKE_CLAUDE_NO_SESSION_FLAG rejects
 * `--no-session-persistence` as an older Claude Code would; FAKE_CLAUDE_HANG_AS_RUN never answers a
 * user message when started with `--settings` (a server slow to connect, say);
 * FAKE_CLAUDE_NO_SANDBOX exits at start when `--settings` turns on its sandbox with
 * `failIfUnavailable`, as Claude Code does where the sandbox cannot run (no bubblewrap, say).
 * FAKE_CLAUDE_RUN_USAGE (JSON `{cost, input, cacheRead, cacheWrite, output, subagent?: {input,
 * output, cost}, perRun?: boolean, fail?: boolean}`) makes a user message's run count usage as Claude
 * Code does: the session (from `--session-id` or `--resume`) is a file in
 * `CLAUDE_CONFIG_DIR/projects/<the folder, as a name>/`, a resumed run starts from the last
 * `cost-state` record there (and fails without the file), the result's `total_cost_usd` and
 * `modelUsage` are the session's totals and its `usage` the run's main conversation only (a
 * subagent's tokens are in `modelUsage`), and a `cost-state` record of the new totals is written as it
 * ends, also when the run fails (`fail`). With `perRun`, as Claude Code 2.1.323, the result also has
 * `model_usage_since_last_result`: every model's usage of the run alone, with its cost.
 * FAKE_CLAUDE_HOOK_CALL (JSON `{tool_name, tool_input, tool_response?}`) makes a user message's run make
 * that one tool call as Claude Code does with the hooks `initialize` registered (claude 2.1.327): a
 * `hook_callback` for its `PreToolUse` entry whose matcher names the tool (or has none), waiting for the
 * answer; unless that refused it, one for its `PostToolUse` entry; each answer logged (`hook`).
 * FAKE_CLAUDE_STRUCTURED (JSON) is a run's `structured_output` when it was given `--json-schema` (logged,
 * parsed, as `jsonSchema`), as Claude Code 2.1.330's result has it, with no text of its own;
 * FAKE_CLAUDE_RESULT (JSON) goes over a run's result (another `subtype`, say). FAKE_CLAUDE_WAIT makes a
 * user message's run wait, once it has said a word, until an `interrupt` control request (logged), which
 * it answers and then ends the turn with a result carrying its usage, as Claude Code does; with
 * `deaf` it answers the interrupt but goes on waiting.
 * FAKE_CLAUDE_STEER makes a user message's run wait (up to 3 s) for a message sent into it (a user message
 * with a `uuid`, logged as `steered`), as Claude Code 2.1.330 takes one: `fold` folds it into the turn
 * (`command_lifecycle` queued, started, a reply that says what it heard, the result, completed); `late`
 * ends the turn first (a result with `queued_turn_count` 0, as when the message came just as the model
 * answered) and then runs it as a turn of its own (queued, started, its reply, a second result);
 * `refuse` refuses it (`refused`), and `silent` says nothing about it. In these modes it exits as soon as
 * its input ends, so a message whose turn the input's end cut off is never answered.
 * FAKE_CLAUDE_BACKGROUND makes a user message's run start a background subagent, as Claude Code 2.1.331
 * does (`background_tasks_changed` with a `local_agent` task, `task_started` backgrounded), which asks
 * for permission (`can_use_tool` for Bash, `agent_id` set, request id `bg-ask`) before the turn's result
 * comes. Its input ending while the ask waits refuses it (logged `refusedAtInputEnd`) and exits, as
 * Claude Code does ("Tool permission stream closed before response received"). Answered (logged
 * `answered` with the behaviour), the subagent ends (`task_notification`, `background_tasks_changed`
 * with no task) and a turn of its own follows (`init`, "followed up", a second result); it then exits
 * once its input ends (logged `inputEnded`). With `withdraw` it withdraws the ask itself after 100 ms
 * (`control_cancel_request`), as when its own hook decides first, and goes on as if answered; an answer
 * that still comes is logged `lateAnswer`.
 */
export const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const record = (o) => process.env.FAKE_CLAUDE_LOG && fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(o) + '\\n');
if (args[0] === '--version' && process.env.FAKE_CLAUDE_VERSION) {
  process.stdout.write(process.env.FAKE_CLAUDE_VERSION + ' (Claude Code)\\n');
  process.exit(0);
}
if (args[0] === 'plugin' && args[1] === 'list') {
  if (process.env.FAKE_CLAUDE_PLUGIN_LOG) fs.appendFileSync(process.env.FAKE_CLAUDE_PLUGIN_LOG, 'listed\\n');
  if (process.env.FAKE_CLAUDE_NO_PLUGINS) { process.stderr.write('unknown command plugin'); process.exit(1); }
  process.stdout.write(JSON.stringify([{ id: 'deck@market', enabled: true, scope: 'user' }, { id: 'lsp@market', enabled: false, scope: 'project' }]));
  process.exit(0);
}
const flag = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const has = (name) => args.includes(name);
if (process.env.FAKE_CLAUDE_EARLY_EXIT && has('-p')) {
  record({ earlyExit: true });
  process.stderr.write('private diagnostic detail');
  process.exit(1);
}
if (process.env.FAKE_CLAUDE_REJECT && has(process.env.FAKE_CLAUDE_REJECT)) {
  record({ rejected: process.env.FAKE_CLAUDE_REJECT });
  process.stderr.write("error: unknown option '" + process.env.FAKE_CLAUDE_REJECT + "'\\n");
  process.exit(1);
}
if (process.env.FAKE_CLAUDE_NO_SESSION_FLAG && has('--no-session-persistence')) {
  process.stderr.write("error: unknown option '--no-session-persistence'\\n");
  process.exit(1);
}
const settingsArg = flag('--settings');
const settings = settingsArg ? JSON.parse(settingsArg.startsWith('{') ? settingsArg : fs.readFileSync(settingsArg, 'utf8')) : {};
if (process.env.FAKE_CLAUDE_NO_SANDBOX && settings.sandbox && settings.sandbox.enabled && settings.sandbox.failIfUnavailable) {
  process.stderr.write('Error: sandbox required but unavailable: bubblewrap (bwrap) is not installed\\n');
  process.exit(1);
}
const builtinOnly = flag('--setting-sources') === '';
const pluginOff = (name) => name.startsWith('deck:') && (builtinOnly || (settings.enabledPlugins || {})['deck@market'] === false);
const skillOff = (name) => (settings.skillOverrides || {})[name] === 'off';
const noCommands = has('--disable-slash-commands');
const commands = (noCommands || builtinOnly ? [] : ['commit', 'deck:slides'].concat(process.env.FAKE_CLAUDE_OWN_USAGE ? ['usage'] : [])).filter((c) => !skillOff(c));
const strictMcp = has('--strict-mcp-config');
const flagDeny = ((settings.permissions || {}).deny || []);
const agents = ['general-purpose', 'Explore'].concat(builtinOnly ? [] : ['reviewer', 'deck:designer']).filter((a) => !pluginOff(a));
const deny = [];
const envOf = (name) => (process.env[name] === undefined ? null : process.env[name]);
record({
  args,
  settings,
  systemPromptFile: flag('--system-prompt-file') ? fs.readFileSync(flag('--system-prompt-file'), 'utf8') : null,
  env: {
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: process.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS || null,
    ANTHROPIC_BASE_URL: envOf('ANTHROPIC_BASE_URL'),
    ANTHROPIC_AUTH_TOKEN: envOf('ANTHROPIC_AUTH_TOKEN'),
    ANTHROPIC_API_KEY: envOf('ANTHROPIC_API_KEY'),
    CLAUDE_CODE_OAUTH_TOKEN: envOf('CLAUDE_CODE_OAUTH_TOKEN'),
  },
});
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
let hooks = null;
const waiting = new Map();
/** A run that waits for an interrupt (FAKE_CLAUDE_WAIT) is under way. */
let waitingTurn = false;
const callback = (event, input) => {
  const entry = ((hooks || {})[event] || []).find((e) => !e.matcher || e.matcher.split('|').includes(input.tool_name));
  if (!entry) return Promise.resolve(undefined);
  const id = 'hook-' + event;
  out({ type: 'control_request', request_id: id, request: { subtype: 'hook_callback', callback_id: process.env.FAKE_CLAUDE_HOOK_ID || entry.hookCallbackIds[0], input: { hook_event_name: event, cwd: process.cwd(), ...input }, tool_use_id: 'toolu_1' } });
  return new Promise((resolve) => waiting.set(id, resolve));
};
async function hookRun(call) {
  const before = await callback('PreToolUse', { tool_name: call.tool_name, tool_input: call.tool_input });
  record({ hook: 'before', answer: before === undefined ? null : before });
  const denied = before && before.hookSpecificOutput && before.hookSpecificOutput.permissionDecision === 'deny';
  if (!denied) {
    const after = await callback('PostToolUse', { tool_name: call.tool_name, tool_input: call.tool_input, tool_response: call.tool_response || { stdout: 'ran', stderr: '' } });
    record({ hook: 'after', answer: after === undefined ? null : after });
  }
  out({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 'fake-session', total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } });
}
const steerMode = process.env.FAKE_CLAUDE_STEER;
let steerWait = null;
const lifecycle = (uuid, state) => out({ type: 'command_lifecycle', command_uuid: uuid, state, uuid: 'l-' + state, session_id: 'fake-session' });
const said = (text) => out({ type: 'assistant', session_id: 'fake-session', message: { id: 'm-' + text.length, content: [{ type: 'text', text }] } });
const steerResult = (more) => out({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 'fake-session', total_cost_usd: 0.1, usage: { input_tokens: 1, output_tokens: 1 }, queued_turn_count: more });
function steerRun() {
  out({ type: 'system', subtype: 'init', session_id: 'fake-session', tools: [], mcp_servers: [] });
  said('working');
  steerWait = setTimeout(() => { steerWait = null; steerResult(0); }, 3000);
}
function steerIn(m) {
  record({ steered: m });
  const text = typeof m.message.content === 'string' ? m.message.content : '';
  if (steerMode === 'silent') return;
  if (steerWait) { clearTimeout(steerWait); steerWait = null; }
  if (steerMode === 'refuse') { lifecycle(m.uuid, 'refused'); return steerResult(0); }
  if (steerMode === 'late') {
    steerResult(0);
    lifecycle(m.uuid, 'queued');
    return void setTimeout(() => { lifecycle(m.uuid, 'started'); said('heard: ' + text); steerResult(0); lifecycle(m.uuid, 'completed'); }, 100);
  }
  lifecycle(m.uuid, 'queued');
  lifecycle(m.uuid, 'started');
  said('heard: ' + text);
  steerResult(0);
  lifecycle(m.uuid, 'completed');
}
const background = process.env.FAKE_CLAUDE_BACKGROUND;
let bgAsking = false;
let bgDone = false;
function bgEnd() {
  out({ type: 'system', subtype: 'task_notification', task_id: 'bg-task', tool_use_id: 'toolu_bg', status: 'completed', summary: 'sub done', session_id: 'fake-session' });
  out({ type: 'system', subtype: 'background_tasks_changed', tasks: [], session_id: 'fake-session' });
  setTimeout(() => {
    out({ type: 'system', subtype: 'init', session_id: 'fake-session', tools: [], mcp_servers: [] });
    said('followed up');
    out({ type: 'result', subtype: 'success', is_error: false, result: 'followed up', session_id: 'fake-session', total_cost_usd: 0.2, usage: { input_tokens: 2, output_tokens: 2 }, queued_turn_count: 0 });
    bgDone = true;
  }, 30);
}
function backgroundRun() {
  out({ type: 'system', subtype: 'init', session_id: 'fake-session', tools: ['Bash', 'Agent'], mcp_servers: [] });
  out({ type: 'assistant', session_id: 'fake-session', message: { id: 'm-agent', content: [{ type: 'tool_use', id: 'toolu_bg', name: 'Agent', input: { description: 'Background job', prompt: 'go', run_in_background: true } }] } });
  out({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'bg-task', task_type: 'local_agent' }, { task_id: 'bg-shell', task_type: 'local_bash' }], session_id: 'fake-session' });
  out({ type: 'system', subtype: 'task_started', task_id: 'bg-task', tool_use_id: 'toolu_bg', is_backgrounded: true, task_type: 'local_agent', session_id: 'fake-session' });
  out({ type: 'user', session_id: 'fake-session', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_bg', content: 'Async agent launched successfully.' }] }, tool_use_result: { status: 'async_launched' } });
  bgAsking = true;
  out({ type: 'control_request', request_id: 'bg-ask', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'npm test' }, agent_id: 'sub-1' } });
  waiting.set('bg-ask', (response) => {
    if (!bgAsking) return record({ lateAnswer: response.behavior });
    bgAsking = false;
    record({ answered: response.behavior });
    bgEnd();
  });
  if (background === 'withdraw') {
    setTimeout(() => {
      bgAsking = false;
      out({ type: 'control_cancel_request', request_id: 'bg-ask' });
      record({ withdrew: true });
      bgEnd();
    }, 100);
  }
  said('main answered');
  out({ type: 'result', subtype: 'success', is_error: false, result: 'main answered', session_id: 'fake-session', total_cost_usd: 0.1, usage: { input_tokens: 1, output_tokens: 1 }, queued_turn_count: 0 });
}
const input = require('node:readline').createInterface({ input: process.stdin });
if (steerMode) input.on('close', () => process.exit(0));
if (background) {
  input.on('close', () => {
    if (bgAsking) record({ refusedAtInputEnd: true });
    else record({ inputEnded: true, followedUp: bgDone });
    // A late answer to a withdrawn ask is read before this.
    setTimeout(() => process.exit(0), 20);
  });
}
input.on('line', async (line) => {
  const m = JSON.parse(line);
  if (steerMode && m.type === 'user' && m.uuid) return steerIn(m);
  if (m.type === 'control_request' && m.request.subtype === 'cancel_async_message') return record({ cancelled: m.request.message_uuid });
  if (m.type === 'control_response' && waiting.has(m.response.request_id)) {
    const done = waiting.get(m.response.request_id);
    waiting.delete(m.response.request_id);
    return done(m.response.response);
  }
  if (m.type === 'control_request') {
    const ok = (response) => out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response } });
    const no = (error) => out({ type: 'control_response', response: { subtype: 'error', request_id: m.request_id, error } });
    switch (m.request.subtype) {
      case 'initialize':
        hooks = m.request.hooks || null;
        record({ hooks, progressSummaries: m.request.agentProgressSummaries ?? null });
        return ok({
          claude_code_version: '9.9.9',
          commands: commands.filter((c) => !pluginOff(c)).map((name) => ({ name, description: name + ' it', argumentHint: '' })).concat(noCommands ? [] : [{ name: 'compact', description: 'Compact', builtin: true }, { name: 'usage', description: 'Usage', builtin: true }]),
          ...(process.env.FAKE_CLAUDE_NO_AGENTS
            ? {}
            : { agents: agents.map((name) => ({ name, description: name === 'Explore' && process.env.FAKE_CLAUDE_OWN_EXPLORE && !builtinOnly ? 'My own Explore' : 'The ' + name })) }),
        });
      case 'apply_flag_settings':
        if (process.env.FAKE_CLAUDE_NO_APPLY) return no('Unsupported control request subtype: apply_flag_settings');
        deny.push(...(((m.request.settings || {}).permissions || {}).deny || []));
        record({ deny });
        if (process.env.FAKE_CLAUDE_SLOW_APPLY) return void setTimeout(() => ok(undefined), 2000);
        return ok(undefined);
      case 'mcp_status':
        return ok({ mcpServers: strictMcp ? [] : [{ name: 'local', status: 'connected', scope: 'user', config: { type: 'stdio', command: 'x', env: { TOKEN: 'secret' } } }] });
      case 'get_hooks_listing':
        if (process.env.FAKE_CLAUDE_NO_HOOKS_AS_RUN && has('--settings')) return no('Unsupported control request subtype: get_hooks_listing');
        return ok({ hooks: [{ event: 'SessionStart', matcher: '', source: 'userSettings', type: 'command', commandText: 'notify --token secret', ...(settings.disableAllHooks ? { disabled: true } : {}) }] });
      case 'get_settings':
        return ok({ effective: { ...settings, permissions: { deny: flagDeny.concat(deny) } } });
      case 'interrupt':
        record({ interrupt: true });
        ok(undefined);
        if (waitingTurn && process.env.FAKE_CLAUDE_WAIT !== 'deaf') {
          waitingTurn = false;
          out({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: [], session_id: 'fake-session', total_cost_usd: 0.05, usage: { input_tokens: 40, output_tokens: 6 }, model_usage_since_last_result: { 'claude-main': { inputTokens: 30, cacheReadInputTokens: 10, cacheCreationInputTokens: 0, outputTokens: 6, costUSD: 0.05 } } });
        }
        return;
      default:
        return no('Unsupported control request subtype: ' + m.request.subtype);
    }
  }
  if (m.type === 'user') {
    record({ prompt: m.message.content, denied: deny.slice() });
    if (process.env.FAKE_CLAUDE_HANG_AS_RUN && settingsArg) return;
    const rules = flagDeny.concat(deny);
    const tools = (args[args.indexOf('--tools') + 1] === '' && has('--tools') ? [] : ['Bash', 'Read', 'Edit', 'WebSearch'])
      .concat(strictMcp ? [] : ['mcp__local__search', 'mcp__local__fetch'])
      .filter((name) => !rules.some((r) => r === name || (r.startsWith('mcp__') && name.startsWith(r + '__'))));
    if (process.env.FAKE_CLAUDE_RUN_USAGE) return usageRun(JSON.parse(process.env.FAKE_CLAUDE_RUN_USAGE), tools);
    if (process.env.FAKE_CLAUDE_HOOK_CALL) return void hookRun(JSON.parse(process.env.FAKE_CLAUDE_HOOK_CALL));
    if (steerMode) return steerRun();
    if (background) return backgroundRun();
    const plugins = ['deck@market', 'plain@market', 'refused@market', 'cc-plugin-agents-md@builtin'].map((source) => ({ source, name: source.split('@')[0] }));
    const format = process.env.FAKE_CLAUDE_MOD_FORMAT;
    if (format === 'names' || format === 'ambiguous') {
      for (const plugin of plugins) delete plugin.source;
      if (format === 'ambiguous') plugins.push({ name: 'deck' });
    }
    if (has('--debug-to-stderr')) {
      process.stderr.write('2026-11-25T00:00:00.000Z [WARN] private diagnostic detail\\n');
      const log = (text) => process.stderr.write('2026-11-25T00:00:00.000Z [DEBUG] ' + text + '\\n');
      if (settingsArg && format === 'truncated-as-run') {
        await new Promise((done) => process.stderr.write('x'.repeat(4 * 1024 * 1024) + '\\n', done));
      }
      if (process.env.CLAUDE_CODE_DEBUG_LOG_LEVEL === 'debug' && !(settingsArg && format === 'quiet-as-run')) {
        log('query initialized');
        if (!(settingsArg && format === 'empty-as-run')) {
          log('hooks module cc-plugin-agents-md@builtin loaded (native, environment 1, tier builtin); events: session.start');
          log('hooks module refused@market not loaded: private diagnostic detail');
          if (!pluginOff('deck:slides')) log('hooks module deck@market loaded (worker, environment 2, tier user); events: session.start');
        }
      }
    }
    out({ type: 'system', subtype: 'init', session_id: 'fake-session', tools, plugins, mcp_servers: strictMcp ? [] : [{ name: 'local', status: 'connected' }] });
    if (process.env.FAKE_CLAUDE_WAIT) {
      waitingTurn = true;
      return out({ type: 'stream_event', session_id: 'fake-session', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Working' } } });
    }
    const schema = flag('--json-schema');
    if (schema) record({ jsonSchema: JSON.parse(schema) });
    const shaped = schema && process.env.FAKE_CLAUDE_STRUCTURED ? { result: '', structured_output: JSON.parse(process.env.FAKE_CLAUDE_STRUCTURED) } : {};
    out({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 'fake-session', total_cost_usd: 0.25, usage: { input_tokens: 1, output_tokens: 1 }, ...shaped, ...JSON.parse(process.env.FAKE_CLAUDE_RESULT || '{}') });
  }
});
function usageRun(u, tools) {
  const path = require('node:path');
  const sid = flag('--resume') || flag('--session-id');
  const folder = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
  const file = path.join(folder, sid + '.jsonl');
  if (has('--resume') && !fs.existsSync(file)) {
    return out({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: sid, errors: ['No conversation found with session ID: ' + sid] });
  }
  let was = { totalCostUSD: 0, modelUsage: {} };
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\\n')) if (line.includes('"cost-state"')) was = JSON.parse(line);
  }
  const modelUsage = JSON.parse(JSON.stringify(was.modelUsage || {}));
  const perRun = {};
  const add = (into, model, input, cacheRead, cacheWrite, output, cost) => {
    const m = into[model] || { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0 };
    into[model] = { inputTokens: m.inputTokens + input, outputTokens: m.outputTokens + output, cacheReadInputTokens: m.cacheReadInputTokens + cacheRead, cacheCreationInputTokens: m.cacheCreationInputTokens + cacheWrite, costUSD: (m.costUSD || 0) + cost };
  };
  const subCost = u.subagent ? u.subagent.cost || 0 : 0;
  for (const into of [modelUsage, perRun]) {
    add(into, 'claude-main', u.input, u.cacheRead, u.cacheWrite, u.output, u.cost - subCost);
    if (u.subagent) add(into, 'claude-small', u.subagent.input, 0, 0, u.subagent.output, subCost);
  }
  const total = was.totalCostUSD + u.cost;
  fs.mkdirSync(folder, { recursive: true });
  fs.appendFileSync(file, JSON.stringify({ type: 'user', sessionId: sid, message: { role: 'user', content: 'a "cost-state" in a message' } }) + '\\n');
  fs.appendFileSync(file, JSON.stringify({ type: 'cost-state', sessionId: sid, totalCostUSD: total, modelUsage }) + '\\n');
  out({ type: 'system', subtype: 'init', session_id: sid, tools, mcp_servers: [] });
  out({
    type: 'result', session_id: sid, total_cost_usd: total, modelUsage,
    ...(u.fail ? { subtype: 'error_during_execution', is_error: true, errors: ['the model failed'] } : { subtype: 'success', is_error: false, result: 'done' }),
    ...(u.perRun ? { model_usage_since_last_result: perRun } : {}),
    usage: { input_tokens: u.input, cache_read_input_tokens: u.cacheRead, cache_creation_input_tokens: u.cacheWrite, output_tokens: u.output },
  });
}
`;

/** Writes the stand-in to `path`, executable. */
export function writeFakeClaude(path: string): string {
  writeFileSync(path, FAKE_CLAUDE, { mode: 0o755 });
  return path;
}
