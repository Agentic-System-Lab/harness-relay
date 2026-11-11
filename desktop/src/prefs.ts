/**
 * The desktop app's own settings, in desktop.json in its user-data folder. Everything else (the
 * conversations, the server's settings) is the server's, in its data folder.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DEFAULT_PORT } from '../../src/server/ports';

export interface DesktopPrefs {
  /** Keep the computer from going to sleep while the app runs (so the phone can reach it). */
  keepAwake: boolean;
  /** The port the server listens on (also the one shared with the tailnet). */
  port: number;
  /**
   * This computer's tailnet name, last seen: the server answers to it from the start, also when the
   * app starts at login before Tailscale has connected (the phone would get "Forbidden host").
   */
  tailnetName?: string;
  /** The size the chat's window had when it was last closed. */
  window?: { width: number; height: number };
}

export const DEFAULT_PREFS: DesktopPrefs = { keepAwake: false, port: DEFAULT_PORT };

/** A host name: lowercase labels of letters, digits and hyphens. */
const HOST_NAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** The settings in `text`; anything missing or not valid is the default. */
export function parsePrefs(text: string | undefined): DesktopPrefs {
  let raw: Partial<Record<keyof DesktopPrefs, unknown>> = {};
  try {
    const v = text ? JSON.parse(text) : {};
    if (v && typeof v === 'object' && !Array.isArray(v)) raw = v;
  } catch {
    /* a damaged file: the defaults */
  }
  const port = raw.port;
  const name = typeof raw.tailnetName === 'string' ? raw.tailnetName.trim().toLowerCase() : '';
  const win = raw.window as { width?: unknown; height?: unknown } | undefined;
  const side = (v: unknown, min: number) => (typeof v === 'number' && Number.isInteger(v) && v >= min && v <= 10_000 ? v : undefined);
  const width = side(win?.width, 360);
  const height = side(win?.height, 400);
  return {
    keepAwake: typeof raw.keepAwake === 'boolean' ? raw.keepAwake : DEFAULT_PREFS.keepAwake,
    port: typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535 ? port : DEFAULT_PREFS.port,
    ...(HOST_NAME.test(name) ? { tailnetName: name } : {}),
    ...(width && height ? { window: { width, height } } : {}),
  };
}

export function loadPrefs(file: string): DesktopPrefs {
  let text: string | undefined;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    /* none yet */
  }
  return parsePrefs(text);
}

/** Written to a temporary file first, so a crash never leaves half a file. */
export function savePrefs(file: string, prefs: DesktopPrefs): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(prefs, null, 2)}\n`);
  renameSync(tmp, file);
}
