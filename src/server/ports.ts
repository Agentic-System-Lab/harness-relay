/**
 * Harness Relay's ports. `npm start` and the desktop app serve the API (and the built UI) on 8787;
 * `npm run dev` serves its API on another port, so a dev server runs beside the Harness Relay you use
 * instead of failing on a port in use, and Vite serves its UI on 5173. `PORT` overrides the API's port
 * in either case. A port is not all two servers must not share: each holds its data folder too
 * (`lockDataDir`), so a dev server beside an `npm start` of the same checkout refuses to start.
 */
export const DEFAULT_PORT = 8787;
/** The address the server listens on unless `HOST` says otherwise: this computer only. */
export const DEFAULT_HOST = '127.0.0.1';
/** The API's port under `npm run dev`. */
export const DEV_API_PORT = 8789;
/** Vite's port under `npm run dev` (`vite.config.ts`), where the dev UI and its sign-in link are. */
export const DEV_WEB_PORT = 5173;

/** Whether this process runs under `npm run dev`: its server and Vite both do. */
export function isDevRun(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.npm_lifecycle_event === 'dev';
}

/** The port the API listens on: `PORT`, else 8787 (`DEV_API_PORT` under `npm run dev`). */
export function apiPort(env: NodeJS.ProcessEnv = process.env): number {
  return Number(env.PORT ?? (isDevRun(env) ? DEV_API_PORT : DEFAULT_PORT));
}
