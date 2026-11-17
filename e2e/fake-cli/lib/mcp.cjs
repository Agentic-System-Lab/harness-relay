'use strict';
// Calls a tool of an MCP server the fake CLI was given (stdio), as a real CLI does: starts the
// server, `initialize`, `notifications/initialized`, `tools/call`, then ends it. Used for Harness
// Relay's own gateway (`relay`), which is a real program the server wrote.
const { spawn } = require('child_process');

function callMcpTool(spec, tool, args, timeoutMs = 20000) {
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
        } else if (msg.id === 2) {
          if (msg.error) finish({ text: msg.error.message, isError: true });
          else finish({ text: (msg.result.content || []).map((c) => c.text || '').join('\n'), isError: Boolean(msg.result.isError) });
        }
      }
    });
    send({
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-cli', version: '1' } },
    });
  });
}

module.exports = { callMcpTool };
