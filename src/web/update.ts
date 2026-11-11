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
 * this browser dismissed with Later, nor one closed otherwise while the page is open: `closed`), and
 * not while an update is under way.
 */
export function shouldOffer(status: UpdateStatus | undefined, dismissed: string | null, appWindow: boolean, closed?: string): boolean {
  const version = status?.available?.version;
  return !!version && appWindow && !status.progress && version !== dismissed && version !== closed;
}

/**
 * Whether the dialog offering a new version shows: it opens only while no other dialog (nor the tour)
 * is open, the user is not typing, and nothing holds dialogs back (`held`: a voice recording), so it
 * never takes keys meant for something else; once it shows it stays while the version is on offer.
 */
export function offerShows(showing: boolean, o: { offerable: boolean; tourOpen: boolean; dialogsOpen: number; typing: boolean; held?: boolean }): boolean {
  return showing ? o.offerable : o.offerable && !o.tourOpen && o.dialogsOpen === 0 && !o.typing && !o.held;
}

/** How long after a key typed into a text field the user still counts as typing. */
export const TYPING_PAUSE_MS = 5000;

/** Whether a key went to something the user types into (a text field, a text area, an editable element). */
export function typesText(target: { tagName?: string; isContentEditable?: boolean; type?: string } | null): boolean {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName?.toLowerCase();
  if (tag === 'textarea') return true;
  return tag === 'input' && !['button', 'checkbox', 'radio', 'submit', 'reset', 'file', 'range', 'color', 'image'].includes((target.type ?? 'text').toLowerCase());
}

/** How soon to ask the server again after an Update (the app's own dialog may start one any time now). */
export const AFTER_UPDATE_MS = 60_000;

/**
 * How soon to ask the server again: often while a check, a download or an install goes on, or for a
 * while after Update was pressed (until `fastUntil`); else now and then (also while an update waits for
 * the conversations, which can take as long as they reply).
 */
export function pollDelay(status: UpdateStatus | undefined, now = 0, fastUntil = 0): number {
  const moving = status?.checking || status?.progress?.kind === 'downloading' || status?.progress?.kind === 'installing';
  return moving || now < fastUntil ? 2000 : 60_000;
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
