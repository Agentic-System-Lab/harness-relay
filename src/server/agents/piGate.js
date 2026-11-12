// Harness Relay's gate for Pi: a Pi extension (plain ES module, no imports) that stops every tool call
// and asks Harness Relay over Pi's RPC before it runs. Loaded by src/server/agents/pi.ts, by its
// absolute path in Harness Relay's own folder (never from the agent's home, which a run may write):
// `pi --mode rpc --no-extensions -e <this file>`. See docs/open-agents.md, "Pi".
//
// - Each call becomes an `input` dialog: Pi sends `{"type":"extension_ui_request","method":"input",
//   "title":"harness-relay:tool_call","placeholder":"<JSON {toolCallId,toolName,input,parentToolCallId?}>"}`
//   and Harness Relay answers `{"type":"extension_ui_response","id":…,"value":"<JSON {allow, reason?}>"}`.
// - It fails closed: no client to ask, a cancelled dialog (the turn was stopped), an answer that is not
//   `{"allow":true}` or anything that throws blocks the call, with a reason the model sees.
// - MCP tools go through the same `tool_call` event, so they are asked about too.
// - It registers the command `harness-relay-gate`, which Harness Relay looks for (`get_commands`)
//   before it sends a prompt: a run where the gate did not load does not start.

const TITLE = 'harness-relay:tool_call';

export default function harnessRelayGate(pi) {
  pi.registerCommand('harness-relay-gate', {
    description: 'Harness Relay asks about every tool call before it runs (loaded by Harness Relay).',
    handler: async () => undefined,
  });

  pi.on('tool_call', async (event, ctx) => {
    if (!ctx.hasUI) return { block: true, reason: 'Not run: Harness Relay could not be asked about this tool call.' };
    const request = { toolCallId: event.toolCallId, toolName: event.toolName, input: event.input };
    if (event.parentToolCallId) request.parentToolCallId = event.parentToolCallId;
    let raw;
    try {
      raw = await ctx.ui.input(TITLE, JSON.stringify(request), { signal: ctx.signal });
    } catch (err) {
      return { block: true, reason: `Not run: asking Harness Relay failed (${err && err.message ? err.message : String(err)}).` };
    }
    let answer;
    try {
      answer = JSON.parse(typeof raw === 'string' ? raw : '');
    } catch {
      return { block: true, reason: 'Not run: the turn was stopped before Harness Relay answered.' };
    }
    if (answer && answer.allow === true) return undefined;
    const reason = answer && typeof answer.reason === 'string' && answer.reason.trim() ? answer.reason.trim() : 'Not run: Harness Relay refused this tool call.';
    return { block: true, reason };
  });
}
