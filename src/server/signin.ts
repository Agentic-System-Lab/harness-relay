import { CODE_FRAGMENT } from '../shared/auth';
import { DEV_WEB_PORT } from './ports';

/**
 * The link that signs a browser in with a code: the built UI on the server's own address, or Vite's
 * (`npm run dev`) when the UI is not built. A server listening on every address is opened on this
 * computer's.
 */
export function signInLink(code: string, at: { host: string; port: number; dev?: boolean }): string {
  if (at.dev) return `http://localhost:${DEV_WEB_PORT}/#${CODE_FRAGMENT}${code}`;
  const host = ['0.0.0.0', '::', ''].includes(at.host) ? '127.0.0.1' : at.host.includes(':') ? `[${at.host}]` : at.host;
  return `http://${host}:${at.port}/#${CODE_FRAGMENT}${code}`;
}
