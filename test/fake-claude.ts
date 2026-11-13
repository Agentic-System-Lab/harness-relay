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
 * FAKE_CLAUDE_LOG names a file that gets a JSON line for each start (its arguments, settings and some
 * variables: the instruction files' switch, and Anthropic's address, keys and sign-in token),
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
 */
export const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const record = (o) => process.env.FAKE_CLAUDE_LOG && fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(o) + '\\n');
if (args[0] === 'plugin' && args[1] === 'list') {
  if (process.env.FAKE_CLAUDE_NO_PLUGINS) { process.stderr.write('unknown command plugin'); process.exit(1); }
  process.stdout.write(JSON.stringify([{ id: 'deck@market', enabled: true, scope: 'user' }, { id: 'lsp@market', enabled: false, scope: 'project' }]));
  process.exit(0);
}
const flag = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const has = (name) => args.includes(name);
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
  env: {
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: process.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS || null,
    ANTHROPIC_BASE_URL: envOf('ANTHROPIC_BASE_URL'),
    ANTHROPIC_AUTH_TOKEN: envOf('ANTHROPIC_AUTH_TOKEN'),
    ANTHROPIC_API_KEY: envOf('ANTHROPIC_API_KEY'),
    CLAUDE_CODE_OAUTH_TOKEN: envOf('CLAUDE_CODE_OAUTH_TOKEN'),
  },
});
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.type === 'control_request') {
    const ok = (response) => out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response } });
    const no = (error) => out({ type: 'control_response', response: { subtype: 'error', request_id: m.request_id, error } });
    switch (m.request.subtype) {
      case 'initialize':
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
    out({ type: 'system', subtype: 'init', session_id: 'fake-session', tools, mcp_servers: strictMcp ? [] : [{ name: 'local', status: 'connected' }] });
    out({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 'fake-session', total_cost_usd: 0.25, usage: { input_tokens: 1, output_tokens: 1 } });
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
