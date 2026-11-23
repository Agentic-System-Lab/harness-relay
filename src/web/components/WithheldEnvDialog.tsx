import { useRef } from 'react';
import { createPortal } from 'react-dom';
import { PROVIDER_LABEL, type Provider } from '../../shared/types';
import { useT } from '../i18n';
import { settingsHref } from '../route';
import { useDialog } from './useDialog';

/**
 * Says once in this browser, as New chat opens, which keys of the environment Harness Relay was
 * started with some CLI is no longer given (src/web/agentEnv.ts, `showNotice`), and where to pass
 * them on again: Settings, that CLI's card, Environment variables. Any way of closing it answers it.
 */
export function WithheldEnvDialog({ items, onClose }: { items: { provider: Provider; names: string[] }[]; onClose: () => void }) {
  const t = useT();
  const n = t.agentEnv.notice;
  const dialog = useRef<HTMLDivElement>(null);
  useDialog(dialog, onClose);

  return createPortal(
    <div className="modal-scrim" onClick={onClose}>
      <div
        ref={dialog}
        className="modal update-dialog withheld-env-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="withheld-env-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="drawer-head">
          <h2 id="withheld-env-title">{n.title}</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label={t.common.close}>
            ×
          </button>
        </header>
        <p>{n.body}</p>
        <ul className="withheld-env-list small">
          {items.map((i) => (
            <li key={i.provider}>{n.item(PROVIDER_LABEL[i.provider], i.names.join(t.agentEnv.sep))}</li>
          ))}
        </ul>
        <p className="muted small">{n.hint}</p>
        <footer className="update-foot">
          <span className="update-buttons">
            <a className="ghost withheld-env-open" href={settingsHref(items[0]!.provider)} onClick={onClose}>
              {n.open}
            </a>
            <button type="button" className="primary" onClick={onClose}>
              {n.ok}
            </button>
          </span>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
