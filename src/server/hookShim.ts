/*
 * The program a CLI runs as its own hook command for the team's hooks (`src/server/hooks.ts`), for a CLI
 * whose hooks are commands (Muse Code): the server writes a copy for each turn into its own temporary
 * folder, beside the turn's token (`ToolGateway.hookProgram()`), where sandboxed commands can neither
 * read nor change it. It takes the gateway's socket, the token's file and when it runs (`before` or
 * `after`) as its arguments, since a CLI may give its hooks no environment of its own; reads the call
 * the CLI gives it on stdin; passes it to the server over the socket; and prints what the server
 * answers, exiting with its code. It decides nothing itself.
 *
 * It fails closed: before a call, anything that keeps it from an answer (no token, no server, a bad
 * answer) refuses the call, with exit 2 and the reason on stderr, which a CLI with hooks in Claude
 * Code's manner takes as a refusal (a CLI may let the call go on when a hook fails otherwise). After
 * a call it says nothing then. Plain JavaScript with Node's built-ins only, as Node runs it directly.
 */

/** The most of the call (as JSON) the program passes on: a large file's content is cut before it is sent. */
export const HOOK_SHIM_MAX = 512 * 1024;

export const HOOK_SHIM_SOURCE = `// Harness Relay's hook program (written by the server; do not edit).
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';

const [socketPath, tokenFile, when] = process.argv.slice(2);
const MAX = ${HOOK_SHIM_MAX};

function done(code, stdout, stderr) {
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  process.exitCode = code;
}
function failed(why) {
  if (when === 'before') done(2, '', "Refused: the team's hook could not be asked (" + why + ').');
  else done(0);
}

// A long string is cut, so that a large file's content does not keep the call from going.
function cut(v, depth) {
  if (typeof v === 'string') return v.length > 20000 ? v.slice(0, 20000) + '…' : v;
  if (depth > 8 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.slice(0, 200).map((x) => cut(x, depth + 1));
  const out = {};
  for (const k of Object.keys(v).slice(0, 200)) out[k] = cut(v[k], depth + 1);
  return out;
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  if (input.length < 8 * MAX) input += chunk;
});
process.stdin.on('end', () => {
  let payload;
  try {
    payload = cut(JSON.parse(input || '{}'), 0);
  } catch {
    return failed('its input is not JSON');
  }
  let token = '';
  try {
    token = readFileSync(tokenFile || '', 'utf8').trim();
  } catch {
    return failed('the turn is over');
  }
  let line = JSON.stringify({ id: 1, method: 'hook', when, payload });
  if (line.length > MAX) line = JSON.stringify({ id: 1, method: 'hook', when, payload: { ...payload, tool_input: {}, tool_response: '' } });
  let buffer = '';
  let answered = false;
  const sock = connect(socketPath || '');
  sock.setEncoding('utf8');
  sock.on('connect', () => sock.write(JSON.stringify({ token }) + '\\n' + line + '\\n'));
  sock.on('data', (chunk) => {
    buffer += chunk;
    const i = buffer.indexOf('\\n');
    if (i < 0 || answered) return;
    answered = true;
    let msg;
    try {
      msg = JSON.parse(buffer.slice(0, i));
    } catch {
      sock.destroy();
      return failed('its answer could not be read');
    }
    sock.end();
    if (!msg || msg.error || !msg.result) return failed(String((msg && msg.error) || 'no answer'));
    const r = msg.result;
    done(typeof r.code === 'number' ? r.code : 0, typeof r.stdout === 'string' ? r.stdout : '', typeof r.stderr === 'string' ? r.stderr : '');
  });
  sock.on('error', (err) => {
    if (!answered) {
      answered = true;
      failed('Harness Relay is not reachable: ' + (err && err.message));
    }
  });
  sock.on('close', () => {
    if (!answered) {
      answered = true;
      failed('Harness Relay ended the connection');
    }
  });
});
`;
