import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../i18n';
import { REPO, REPO_URL } from '../star';
import { StarIcon } from './icons';
import { useDialog } from './useDialog';

interface Props {
  onClose: () => void;
}

/**
 * Asks the user, if Harness Relay serves them well, to star its repository on GitHub: a picture of
 * the repository's page with its Star button being pressed, and a link to it (a new tab; in the
 * desktop app, the system's browser). Opened by the star beside Report a problem in the sidebar.
 * Rendered on the page's body, as the sidebar is moved on a phone (a transform), which would carry
 * a fixed dialog with it.
 */
export function StarDialog({ onClose }: Props) {
  const t = useT();
  const s = t.star;
  const dialog = useRef<HTMLDivElement>(null);
  /** The link was followed: the dialog thanks the user. */
  const [went, setWent] = useState(false);
  useDialog(dialog, onClose);

  return createPortal(
    <div className="modal-scrim" onClick={onClose}>
      <div
        ref={dialog}
        className="modal star-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="star-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="drawer-head">
          <h2 id="star-title">{s.title}</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label={t.common.close}>
            ×
          </button>
        </header>
        <p>{s.body}</p>

        <figure className="star-demo">
          <StarPicture />
          <figcaption className="muted small">{s.how}</figcaption>
        </figure>

        {went && (
          <p className="small star-thanks" role="status">
            {s.thanks}
          </p>
        )}
        <footer className="star-foot">
          <button type="button" className="ghost" onClick={onClose}>
            {s.later}
          </button>
          <a className="primary star-go" href={REPO_URL} target="_blank" rel="noopener noreferrer" onClick={() => setWent(true)}>
            <StarIcon size={16} />
            <span>{s.open}</span>
          </a>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

/**
 * The repository's page in a browser, its Star button pressed by the pointer: the star fills and the
 * button reads Starred, as GitHub shows it (in English, whatever the language: so does GitHub). For
 * the eye only; the caption says it in words. With reduced motion, the pointer rests on Star.
 */
function StarPicture() {
  const [owner, name] = REPO.split('/');
  return (
    <div className="star-picture" aria-hidden="true">
      <div className="star-picture-bar">
        <i />
        <i />
        <i />
        <span className="star-picture-address">github.com/{REPO}</span>
      </div>
      <div className="star-picture-page">
        <span className="star-picture-repo">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 19.5v-15A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5 1.5 1.5 0 0 0 6.5 21H19v-3" />
          </svg>
          <span>{owner}</span> <span className="muted">/</span> <b>{name}</b>
        </span>
        <span className="star-picture-button">
          <span className="star-picture-stars">
            <StarIcon size={15} />
            <span className="star-picture-filled">
              <StarIcon size={15} />
            </span>
          </span>
          <span className="star-picture-labels">
            <span className="star-picture-off">Star</span>
            <span className="star-picture-on">Starred</span>
          </span>
          <svg className="star-picture-pointer" width="18" height="18" viewBox="0 0 24 24">
            <path d="M5 2.5v17l4.4-4.1 2.9 6.6 2.6-1.1-2.9-6.5 6-.4z" fill="#fff" stroke="#18181b" strokeWidth="1.5" strokeLinejoin="round" />
          </svg>
        </span>
      </div>
    </div>
  );
}
