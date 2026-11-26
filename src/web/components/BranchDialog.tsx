import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { BranchPoint, ConversationBranchKind } from '../../shared/types';
import { api } from '../api';
import { useI18n } from '../i18n';
import { BranchIcon, PlusIcon } from './icons';
import { useDialog } from './useDialog';

export function BranchDialog({
  id,
  title,
  messageId,
  onCreated,
  onClose,
}: {
  id: string;
  title: string;
  messageId?: string;
  onCreated: (id: string) => void;
  onClose: () => void;
}) {
  const { t, lang } = useI18n();
  const s = t.branchDialog;
  const heading = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const [point, setPoint] = useState<BranchPoint | null>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const creating = useRef(false);
  const close = () => {
    if (!creating.current) onClose();
  };
  useDialog(dialog, close);

  useEffect(() => {
    let current = true;
    api.branchPoint(id, messageId).then(
      (reply) => {
        if (current) setPoint(reply);
      },
      (e: Error) => {
        if (current) setError(e.message);
      },
    );
    return () => {
      current = false;
    };
  }, [id, messageId]);

  const create = async (kind: ConversationBranchKind) => {
    if (!point || creating.current) return;
    const sourceRoute = window.location.hash;
    creating.current = true;
    setBusy(true);
    setError('');
    try {
      const chat = await api.branch(id, point.id, kind);
      if (dialog.current?.isConnected && sourceRoute === window.location.hash) onCreated(chat.id);
    } catch (e) {
      creating.current = false;
      setBusy(false);
      setError((e as Error).message);
    }
  };

  return createPortal(
    <div className="modal-scrim" onClick={close}>
      <div
        className="modal branch-dialog"
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={heading}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="drawer-head">
          <h2 id={heading}>{s.title}</h2>
          <button type="button" className="icon-button" disabled={busy} onClick={close} aria-label={t.common.close}>
            ×
          </button>
        </header>
        <p className="branch-origin">{title}</p>
        {point && (
          <>
            <div className="branch-point">
              <span className="small muted">
                {s.through} ·{' '}
                <time dateTime={new Date(point.createdAt).toISOString()}>{new Date(point.createdAt).toLocaleString(lang)}</time>
              </span>
              {point.excerpt && <p>{point.excerpt}</p>}
            </div>
            <div className="branch-choices">
              <button type="button" disabled={busy} onClick={() => void create('topic')}>
                <PlusIcon size={18} />
                <span>
                  <strong>{s.topic}</strong>
                  <small>{s.topicHint}</small>
                </span>
              </button>
              <button type="button" disabled={busy} onClick={() => void create('child')}>
                <BranchIcon size={18} />
                <span>
                  <strong>{s.child}</strong>
                  <small>{s.childHint}</small>
                </span>
              </button>
            </div>
          </>
        )}
        {!point && !error && <p role="status">{point === null ? s.noReply : t.common.loading}</p>}
        {busy && <p role="status">{s.copying}</p>}
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>,
    document.body,
  );
}
