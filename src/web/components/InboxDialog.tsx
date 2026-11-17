import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { InboxItem, InboxSummary } from '../../shared/types';
import { api } from '../api';
import { useT } from '../i18n';
import { inboxLine, inboxTone, markedRead } from '../inbox';
import { hashFor } from '../route';
import { relativeTime } from '../util';
import { useDialog } from './useDialog';

interface Props {
  /** The latest summary the page has: the list loads again when it changes. */
  summary: InboxSummary;
  onClose: () => void;
  /** Notifications were read or cleared: the page asks for the summary again. */
  onChanged: () => void;
  /** One was opened: on a phone the sidebar's drawer closes too (also for the chat already shown). */
  onOpened: () => void;
}

/**
 * The notification inbox (the bell beside the sidebar's collapse button): what the team told the user,
 * the newest first, kept by the server for every signed-in browser (src/server/inbox.ts). Each one
 * opens its chat, which marks that chat's notifications read; the footer marks them all read, or
 * clears them. Rendered on the page's body, as the sidebar is moved on a phone (a transform), which
 * would carry a fixed dialog with it.
 */
export function InboxDialog({ summary, onClose, onChanged, onOpened }: Props) {
  const t = useT();
  const m = t.inbox;
  const dialog = useRef<HTMLDivElement>(null);
  const [items, setItems] = useState<InboxItem[]>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  useDialog(dialog, onClose);

  // Loaded as it opens, and again when the summary changes (a notification came, or some were read
  // or cleared in another browser).
  const changes = `${summary.unread}:${summary.newest ?? ''}:${summary.unreadIn.join(',')}`;
  useEffect(() => {
    let live = true;
    api
      .notifications()
      .then((list) => {
        if (!live) return;
        setItems(list);
        setError(undefined);
      })
      .catch((e: unknown) => live && setError(m.failed((e as Error).message)));
    return () => {
      live = false;
    };
  }, [changes, m]);

  const unread = items?.filter((i) => !i.read).length ?? 0;

  const markAll = async () => {
    if (!items) return;
    setBusy(true);
    setItems(markedRead(items, { all: true }));
    try {
      await api.readNotifications({ all: true });
    } catch (e) {
      setError(m.actionFailed((e as Error).message));
    } finally {
      setBusy(false);
      onChanged();
    }
  };

  const clear = async () => {
    if (!confirm(m.confirmClear)) return;
    setBusy(true);
    try {
      await api.clearNotifications();
      setItems([]);
    } catch (e) {
      setError(m.actionFailed((e as Error).message));
    } finally {
      setBusy(false);
      onChanged();
    }
  };

  // The link opens the chat; what the team said in it is seen then.
  const open = (item: InboxItem) => {
    void api
      .readNotifications({ conversationId: item.conversationId })
      .catch(() => undefined)
      .finally(onChanged);
    onClose();
    onOpened();
  };

  return createPortal(
    <div className="modal-scrim" onClick={onClose}>
      <div
        ref={dialog}
        className="modal inbox-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="inbox-title"
        aria-describedby="inbox-hint"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="drawer-head">
          <h2 id="inbox-title">
            {m.title}
            {unread > 0 && <span className="inbox-count">{m.unread(unread)}</span>}
          </h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label={t.common.close}>
            ×
          </button>
        </header>
        <p id="inbox-hint" className="muted small">
          {m.hint}
        </p>
        {error && (
          <p className="error-line" role="alert">
            {error}
          </p>
        )}
        <div className="inbox-body">
          {items === undefined ? (
            !error && <p className="muted small">{m.loading}</p>
          ) : items.length === 0 ? (
            <p className="inbox-empty muted">{m.empty}</p>
          ) : (
            <ul className="inbox-list">
              {items.map((i) => (
                <li key={i.id}>
                  <a className={`inbox-item ${i.read ? '' : 'unread'}`} href={hashFor({ page: 'chat', id: i.conversationId })} onClick={() => open(i)}>
                    <span className={`inbox-tone ${inboxTone(i.kind)}`} aria-hidden />
                    <span className="inbox-main">
                      <span className="inbox-top">
                        <span className="inbox-title">{i.title}</span>
                        <time className="inbox-time" dateTime={new Date(i.createdAt).toISOString()} title={new Date(i.createdAt).toLocaleString()}>
                          {relativeTime(i.createdAt, t)}
                        </time>
                      </span>
                      <span className="inbox-line">
                        {!i.read && <span className="visually-hidden">{m.unreadMark}: </span>}
                        {inboxLine(i, t.notifications)}
                      </span>
                      {i.text && <span className="inbox-text">{i.text}</span>}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
        <footer className="inbox-foot">
          <button type="button" className="ghost small-button" disabled={busy || !items?.length} onClick={() => void clear()}>
            {m.clear}
          </button>
          <button type="button" className="primary small-button" disabled={busy || unread === 0} onClick={() => void markAll()}>
            {m.markAllRead}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
