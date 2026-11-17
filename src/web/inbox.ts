// The notification inbox in the page: the bell beside the sidebar's collapse button (and beside the
// expand button, on its right, while the sidebar is collapsed), its unread count, and the dialog it opens
// (components/InboxDialog.tsx). The server keeps the notifications (src/server/inbox.ts); this module
// holds the page's pure decisions, tested in test/inbox-web.test.ts.

import { NEEDS_KINDS } from '../shared/notify';
import type { AlertKind, InboxItem, InboxSummary } from '../shared/types';
import type { Messages } from './i18n';
import type { Route } from './route';

/** Before the first summary comes: nothing unread. */
export const EMPTY_INBOX: InboxSummary = { unread: 0, unreadIn: [] };

/** The most the bell's badge counts; above it, "99+". */
export const BADGE_MAX = 99;

/** The bell's badge: none at zero, the count up to `BADGE_MAX`, then `99+`. */
export function badgeText(unread: number): string {
  if (!(unread > 0)) return '';
  return unread > BADGE_MAX ? `${BADGE_MAX}+` : String(Math.floor(unread));
}

/** Whether two summaries say the same (a poll that changed nothing keeps the page as it is). */
export function sameSummary(a: InboxSummary, b: InboxSummary): boolean {
  return (
    a.unread === b.unread &&
    a.newest === b.newest &&
    a.unreadIn.length === b.unreadIn.length &&
    a.unreadIn.every((id, i) => b.unreadIn[i] === id)
  );
}

/**
 * The conversation whose notifications are read now: the chat on screen, while it has unread ones and
 * the user can see it (the page in front and its window focused, as the alerts count it). Undefined
 * otherwise, also while a mark for it is still on its way (`marking`).
 */
export function readOnView(
  route: Route,
  summary: InboxSummary,
  page: { visible: boolean; focused: boolean },
  marking?: string,
): string | undefined {
  if (route.page !== 'chat' || !page.visible || !page.focused) return undefined;
  if (marking === route.id || !summary.unreadIn.includes(route.id)) return undefined;
  return route.id;
}

/** What a notification says happened, in the page's language ("Claude finished replying"). */
export function inboxLine(item: Pick<InboxItem, 'kind' | 'agent'>, m: Messages['notifications']): string {
  return m.alert[item.kind](item.agent);
}

/** How a notification is marked: the team needs the user, a reply ended with an error, or a reply is done. */
export function inboxTone(kind: AlertKind): 'needs' | 'error' | 'done' {
  if (NEEDS_KINDS.includes(kind)) return 'needs';
  return kind === 'error' ? 'error' : 'done';
}

/** The list with these marked read, as the server will have it (shown before its answer). */
export function markedRead(items: InboxItem[], which: { ids?: string[]; conversationId?: string; all?: boolean }): InboxItem[] {
  const hit = (i: InboxItem) =>
    which.all || which.ids?.includes(i.id) || (which.conversationId !== undefined && i.conversationId === which.conversationId);
  return items.map((i) => (!i.read && hit(i) ? { ...i, read: true } : i));
}
