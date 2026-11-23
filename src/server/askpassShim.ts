/*
 * The password helper of an interactive command (`src/server/interactive.ts`): the program `sudo -A`
 * (`SUDO_ASKPASS`), ssh (`SSH_ASKPASS`, with `SSH_ASKPASS_REQUIRE=force`) and git (`GIT_ASKPASS`) run
 * to ask for a password, with the prompt as their only argument, reading the answer from its output.
 * The server writes a copy for each session into the session's own folder in Harness Relay's temporary
 * folder (`data/tmp`, which sandboxed commands can neither read nor change), beside the session's token,
 * with a fixed shell script that starts it with Node.js (`ASKPASS_SCRIPT`), since those programs run one
 * file. Where to ask is in the command's environment (`RELAY_ASKPASS_*`), which they pass on: the gateway's
 * socket and the token's file. It passes the prompt to the server over the socket, which asks the user on
 * the command's card for one hidden line, and prints that line; anything that keeps it from an answer
 * (the session over, a refusal, no server) makes it exit 1, which those programs take as no password.
 * Plain JavaScript with Node's built-ins only, as Node runs it directly. It decides nothing itself.
 */

import { INTERACTIVE_LIMITS } from '../shared/types';
import { SOCKET_REACH_SOURCE } from './gatewayShim';

/** The environment variables the script and the helper read: the Node.js, the helper's file, the socket, the token's file. */
export const ASKPASS_ENV = {
  node: 'RELAY_ASKPASS_NODE',
  program: 'RELAY_ASKPASS_PROGRAM',
  socket: 'RELAY_ASKPASS_SOCKET',
  token: 'RELAY_ASKPASS_TOKEN_FILE',
} as const;

/** The program those programs run: fixed text, everything it needs in its environment. */
export const ASKPASS_SCRIPT = `#!/bin/sh
# Harness Relay's password helper (written by the server; do not edit).
exec "$${ASKPASS_ENV.node}" "$${ASKPASS_ENV.program}" "$@"
`;

export const ASKPASS_SHIM_SOURCE = `// Harness Relay's password helper (written by the server; do not edit).
import { readFileSync } from 'node:fs';
import { Socket, connect } from 'node:net';
import { basename, dirname } from 'node:path';

${SOCKET_REACH_SOURCE}

const prompt = String(process.argv[2] || '').slice(0, ${INTERACTIVE_LIMITS.prompt * 4});
let over = false;
function fail(why) {
  if (over) return;
  over = true;
  process.stderr.write("Harness Relay's password helper: " + why + '\\n');
  process.exit(1);
}
let token = '';
try {
  token = readFileSync(process.env.${ASKPASS_ENV.token} || '', 'utf8').trim();
} catch {
  /* the session is over */
}
if (!token) fail('this command is over');
let buffer = '';
const sock = reach(process.env.${ASKPASS_ENV.socket} || '');
sock.setEncoding('utf8');
sock.on('connect', () => sock.write(JSON.stringify({ token }) + '\\n' + JSON.stringify({ id: 1, method: 'askpass', prompt }) + '\\n'));
sock.on('data', (chunk) => {
  buffer += chunk;
  const i = buffer.indexOf('\\n');
  if (i < 0 || over) return;
  let msg;
  try {
    msg = JSON.parse(buffer.slice(0, i));
  } catch {
    return fail('its answer could not be read');
  }
  sock.end();
  if (!msg || msg.error || !msg.result || typeof msg.result.line !== 'string') return fail(String((msg && msg.error) || 'no answer'));
  over = true;
  process.stdout.write(msg.result.line + '\\n');
});
sock.on('error', (err) => fail('Harness Relay is not reachable: ' + (err && err.message)));
sock.on('close', () => fail('no answer'));
`;
