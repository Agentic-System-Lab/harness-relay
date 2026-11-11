// The desktop app's updates in the chat: Settings' Version card, and the dialog that offers a new
// version once. Pure, so it can be tested without a DOM.

import type { UpdateStatus } from '../shared/types';
import type { Messages } from './i18n';

/** The version this browser was offered and dismissed (Later, or Update), so it is not offered again. */
export const DISMISSED_KEY = 'relay:updateDismissed';

/** The version this browser dismissed, if any (storage may be unavailable: then none). */
export function readDismissed(): string | null {
  try {
    return localStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
}

export function writeDismissed(version: string): void {
  try {
    localStorage.setItem(DISMISSED_KEY, version);
  } catch {
    /* offered again next time */
  }
}

/**
 * Whether this page is in the desktop app's own window (Electron), where the app's dialogs show: not
 * another browser signed in to it, such as a phone's.
 */
export function isAppWindow(userAgent: string): boolean {
  return /\bElectron\//.test(userAgent);
}

/**
 * Whether to offer the newer version with a dialog: in the app's own window, once per version (not one
 * this browser dismissed), and not while an update is under way.
 */
export function shouldOffer(status: UpdateStatus | undefined, dismissed: string | null, appWindow: boolean): boolean {
  return !!status?.available && appWindow && !status.progress && status.available.version !== dismissed;
}

/** How soon to ask the server again: often while something changes (a check, an update under way), else now and then. */
export function pollDelay(status: UpdateStatus | undefined): number {
  return status?.checking || status?.progress ? 2000 : 60_000;
}

/** What Settings' Version card says of updates, and whether it is good news, news, or trouble. */
export function updateLine(s: UpdateStatus, t: Messages, lang: string): { text: string; tone: 'ok' | 'news' | 'muted' | 'warn' } {
  const v = t.settings.version;
  if (!s.updates) return { text: v.noUpdates, tone: 'muted' };
  const p = s.progress;
  if (p) return { text: p.kind === 'downloading' ? v.downloading(p.percent) : p.kind === 'waiting' ? v.waiting : v.installing, tone: 'news' };
  if (s.checking) return { text: v.checking, tone: 'muted' };
  if (s.available) return { text: v.available(s.available.version), tone: 'news' };
  if (s.checkFailed) return { text: v.checkFailed, tone: 'warn' };
  if (s.checkedAt === undefined) return { text: v.notChecked, tone: 'muted' };
  const at = new Date(s.checkedAt).toLocaleString(lang, { dateStyle: 'medium', timeStyle: 'short' });
  return { text: v.upToDate(at), tone: 'ok' };
}
