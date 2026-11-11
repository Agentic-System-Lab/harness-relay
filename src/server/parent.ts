import type { DesktopToServer, DesktopUpdate, ServerToDesktop } from '../shared/types';

/**
 * The desktop app (desktop/) runs the server in an Electron utility process, which has
 * `process.parentPort` to talk to the app. Started any other way (`npm start`, `npm run dev`), the
 * server has no parent to talk to.
 */
interface ParentPort {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (event: { data: unknown }) => void): unknown;
}

export interface DesktopParent {
  send(message: ServerToDesktop): void;
  /** Called when the app asks the server to stop (before it quits, or to restart it). */
  onShutdown(fn: () => void): void;
  /**
   * Answers the app's requests for a sign-in link (it opens the chat with one). Only the app can ask:
   * the port is private to the two processes, and the link never goes through the log.
   */
  onSignInLink(fn: () => string): void;
  /** Answers the app's requests for how many conversations have agents at work (`fn`). */
  onBusy(fn: () => number): void;
  /** Told what the app says of its updates, each time that changes. */
  onUpdate(fn: (update: DesktopUpdate) => void): void;
}

/** The desktop app that started this server, or undefined when nothing did. */
export function desktopParent(proc: { parentPort?: unknown } = process as { parentPort?: unknown }): DesktopParent | undefined {
  const port = proc.parentPort as ParentPort | undefined;
  if (!port || typeof port.postMessage !== 'function' || typeof port.on !== 'function') return undefined;
  return {
    send: (message) => port.postMessage(message),
    onShutdown(fn) {
      port.on('message', (event) => {
        if ((event?.data as DesktopToServer | undefined)?.type === 'shutdown') fn();
      });
    },
    onSignInLink(fn) {
      port.on('message', (event) => {
        if ((event?.data as DesktopToServer | undefined)?.type === 'sign-in-link') port.postMessage({ type: 'sign-in-link', link: fn() } satisfies ServerToDesktop);
      });
    },
    onBusy(fn) {
      port.on('message', (event) => {
        if ((event?.data as DesktopToServer | undefined)?.type === 'busy') port.postMessage({ type: 'busy', conversations: fn() } satisfies ServerToDesktop);
      });
    },
    onUpdate(fn) {
      port.on('message', (event) => {
        const message = event?.data as DesktopToServer | undefined;
        if (message?.type === 'update' && message.update && typeof message.update === 'object') fn(message.update);
      });
    },
  };
}
