/*
 * The program a CLI runs as its own hook command for the team's hooks (`src/server/hooks.ts`), for a CLI
 * whose hooks are commands (Codex, Copilot and Muse Code): the server writes a copy for each turn into its own temporary
 * folder, beside the turn's token (`ToolGateway.hookProgram()`), where sandboxed commands can neither
 * read nor change it. It takes the gateway's socket, the token's file, when it runs (`before` or
 * `after`) and how many seconds it waits for an answer as its arguments, since a CLI may give its
 * hooks no environment of its own; reads the call the CLI gives it on stdin; passes it to the server
 * over the socket; and prints what the server answers, exiting with its code. Copilot runs the
 * same source inline, with the token in the hook command's own environment. It decides nothing itself.
 *
 * It fails closed: before a call, anything that keeps it from an answer (no token, no server, a bad
 * answer, none within its time limit, a call too large to pass on whole) refuses the call, with exit 2 and the reason on stderr, which a CLI with hooks in Claude
 * Code's manner takes as a refusal (a CLI may let the call go on when a hook fails otherwise). After
 * a call it says nothing then. Plain JavaScript with Node's built-ins only, as Node runs it directly.
 */

/**
 * The most of the call (as JSON) the program passes on. A call larger than this is refused before it
 * runs, never cut: a hook that decides about a command must see all of it. After a call, its result
 * and then its arguments are left out to fit.
 */
export const HOOK_SHIM_MAX = 3 * 1024 * 1024;

export const HOOK_INLINE_TOKEN_ENV = 'RELAY_HOOK_TOKEN';

export const HOOK_SHIM_SOURCE = `// Harness Relay's hook program (written by the server; do not edit).
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';

const [socketPath, tokenFile, when, limitSec] = process.argv.slice(2);
const MAX = ${HOOK_SHIM_MAX};

let over = false;
function done(code, stdout, stderr) {
  if (over) return;
  over = true;
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  process.exitCode = code;
}
function failed(why) {
  if (when === 'before') done(2, '', "Refused: the team's hook could not be asked (" + why + ').');
  else done(0);
}
// Its own time limit (seconds, its fourth argument): no answer by then is a refusal, before the CLI's
// time limit for its hook ends (a CLI may let the call go on then). It exits, whatever is still open.
const limit = Number(limitSec);
if (limit > 0) {
  setTimeout(() => {
    failed('no answer in time');
    process.exit(when === 'before' ? 2 : 0);
  }, limit * 1000).unref();
}

let input = '';
let tooLarge = false;
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  if (input.length <= 4 * MAX) input += chunk;
  else tooLarge = true;
});
process.stdin.on('end', () => {
  let payload;
  try {
    if (tooLarge) throw new Error('too large');
    payload = JSON.parse(input || '{}');
  } catch {
    return failed(tooLarge ? 'the call is too large for it to read' : 'its input is not JSON');
  }
  let token = '';
  try {
    token = tokenFile ? readFileSync(tokenFile, 'utf8').trim() : process.env.${HOOK_INLINE_TOKEN_ENV};
    if (!token) return failed('the turn is over');
  } catch {
    return failed('the turn is over');
  }
  const lineOf = (p) => JSON.stringify({ id: 1, method: 'hook', when, payload: p });
  let line = lineOf(payload);
  if (line.length > MAX) {
    // Before a call, nothing is left out: the hooks would decide about what they did not see.
    if (when === 'before') return failed('the call is too large for it to read');
    const short = { ...payload, tool_response: '', toolResult: undefined,
      ...(typeof payload.error === 'string' ? { error: '' } : {}) };
    line = lineOf(short);
    if (line.length > MAX) line = lineOf({ ...short, tool_input: {}, toolArgs: {} });
    if (line.length > MAX) return failed('the call is too large for it to read');
  }
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
