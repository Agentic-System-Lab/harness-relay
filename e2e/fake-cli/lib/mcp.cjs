'use strict';
// Calls a tool of an MCP server the fake CLI was given, as a real CLI does: `initialize`,
// `notifications/initialized`, `tools/call`. A stdio server (`command`) is started and then ended; an
// HTTP one (`url`, with its `headers`) is sent each message in a POST of its own (MCP's Streamable
// HTTP, answered with JSON). Used for Harness Relay's own gateway (`relay`): the program the server
// wrote, or its loopback endpoint, reached as the CLI's other requests are (through the sandbox's
// proxy, which `NODE_USE_ENV_PROXY` has Node's `fetch` use, below full access).
const { spawn } = require('child_process');

const INITIALIZE = {
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-cli', version: '1' } },
};

function toolResult(msg) {
  if (msg.error) return { text: msg.error.message, isError: true };
  return { text: (msg.result.content || []).map((c) => c.text || '').join('\n'), isError: Boolean(msg.result.isError) };
}

async function callHttpTool(spec, tool, args, timeoutMs) {
  const signal = AbortSignal.timeout(timeoutMs);
  let session;
  const post = async (msg) => {
    const res = await fetch(spec.url, {
      method: 'POST',
      headers: {
        ...(spec.headers || {}),
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(session ? { 'mcp-session-id': session } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', ...msg }),
      signal,
    });
    session = res.headers.get('mcp-session-id') || session;
    if (!res.ok) throw new Error(`the MCP server answered ${res.status}`);
    return msg.id === undefined ? undefined : res.json();
  };
  try {
    await post({ id: 1, ...INITIALIZE });
    await post({ method: 'notifications/initialized' });
    return toolResult(await post({ id: 2, method: 'tools/call', params: { name: tool, arguments: args } }));
  } catch (err) {
    return { text: `could not reach the MCP server: ${err.message}`, isError: true };
  }
}

function callMcpTool(spec, tool, args, timeoutMs = 20000) {
  if (spec.url) return callHttpTool(spec, tool, args, timeoutMs);
  return new Promise((resolve) => {
    const child = spawn(spec.command, spec.args || [], { env: { ...process.env, ...(spec.env || {}) }, stdio: ['pipe', 'pipe', 'ignore'] });
    let buf = '';
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.stdin.end();
      child.kill();
      resolve(r);
    };
    const timer = setTimeout(() => finish({ text: 'the MCP server did not answer', isError: true }), timeoutMs);
    const send = (msg) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
    child.on('error', (err) => finish({ text: `could not start the MCP server: ${err.message}`, isError: true }));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
        const msg = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        if (msg.id === 1) {
          send({ method: 'notifications/initialized' });
          send({ id: 2, method: 'tools/call', params: { name: tool, arguments: args } });
        } else if (msg.id === 2) finish(toolResult(msg));
      }
    });
    send({ id: 1, ...INITIALIZE });
  });
}

module.exports = { callMcpTool };
