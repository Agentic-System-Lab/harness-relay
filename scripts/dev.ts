/*
 * `npm run dev`: the API server (`tsx watch`, restarted on every change) and Vite, which serves the UI
 * and proxies `/api/` to the API, run together by concurrently as before. Their ports are found first
 * (scripts/dev/ports.ts: 8789 and 5173, else the first free ones after them; `PORT` and
 * `RELAY_DEV_WEB_PORT` taken as they are) and handed to both in their environment: Vite takes exactly
 * that port (`strictPort` in vite.config.ts) and proxies to the API's, and the server prints its
 * sign-in link for Vite's, names its session cookie after it, keeps agents in the relay sandbox from
 * both and never passes them on to an agent's CLI.
 *
 * Run as `node --import tsx` (no `tsx` process in front, whose signal relay may kill this one before it
 * passes a signal on), and always run: what can be tested is in scripts/dev/.
 */
import { spawn } from 'node:child_process';
import { DEV_COMMAND, concurrentlyBin, passSignals } from './dev/concurrently';
import { DevPortError, devEnv, devPorts, type DevPorts } from './dev/ports';

if (process.argv.length > 2) {
  console.error('[dev] npm run dev takes no arguments: set PORT or RELAY_DEV_WEB_PORT for other ports.');
  process.exit(2);
}
let ports: DevPorts;
try {
  ports = await devPorts(process.env);
} catch (err) {
  if (!(err instanceof DevPortError)) throw err;
  console.error(`[dev] ${err.message}`);
  process.exit(1);
}
for (const note of ports.notes) console.log(`[dev] ${note}`);
const child = spawn(process.execPath, [concurrentlyBin(), ...DEV_COMMAND], { stdio: 'inherit', env: devEnv(process.env, ports) });
passSignals(child);
child.on('error', (err) => {
  console.error(`[dev] could not start concurrently: ${err.message}`);
  process.exit(1);
});
child.on('exit', (code) => process.exit(code ?? 1));
