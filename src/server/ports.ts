/**
 * Harness Relay's ports. `npm start` and the desktop app serve the API (and the built UI) on 8787;
 * `npm run dev` serves its API on another port, so a dev server runs beside the Harness Relay you use
 * instead of failing on a port in use, and Vite serves its UI on 5173. When one of those two is taken
 * (by another checkout's `npm run dev`, say), `npm run dev` takes the next free one: `scripts/dev.ts`
 * finds both before either starts and hands them to the server and Vite (`PORT`, `RELAY_DEV_WEB_PORT`),
 * so that Vite's proxy, the sign-in link and the relay sandbox name the ports really used. `PORT`
 * overrides the API's port in either case. A port is not all two servers must not share: each holds
 * its data folder too (`lockDataDir`), so a dev server beside an `npm start` of the same checkout
 * refuses to start.
 */
export const DEFAULT_PORT = 8787;
/** The address the server listens on unless `HOST` says otherwise: this computer only. */
export const DEFAULT_HOST = '127.0.0.1';
/** The API's port under `npm run dev`, when it is free (`scripts/dev.ts` takes the next one otherwise). */
export const DEV_API_PORT = 8789;
/** Vite's port under `npm run dev` (`vite.config.ts`), where the dev UI and its sign-in link are, when it is free. */
export const DEV_WEB_PORT = 5173;

/** Whether this process runs under `npm run dev`: its server and Vite both do. */
export function isDevRun(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.npm_lifecycle_event === 'dev';
}

/** The port the API listens on: `PORT`, else 8787 (`DEV_API_PORT` under `npm run dev`). */
export function apiPort(env: NodeJS.ProcessEnv = process.env): number {
  return Number(env.PORT ?? (isDevRun(env) ? DEV_API_PORT : DEFAULT_PORT));
}

/** Browsers also apply the parent page's frame-src when an embedded app navigates its own frame. */
export function previewFramePolicy(port: number, domain?: string): string {
  return 'frame-src about: http://*.localhost:' + port + (domain ? ' https://*.' + domain : '');
}

/**
 * Vite's port under `npm run dev`: `RELAY_DEV_WEB_PORT`, which `scripts/dev.ts` sets to the one it
 * found free, else 5173.
 */
export function devWebPort(env: NodeJS.ProcessEnv = process.env): number {
  const port = Number(env.RELAY_DEV_WEB_PORT);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : DEV_WEB_PORT;
}
