import { useState } from 'react';
import { useT } from '../i18n';
import { changed, quietTour, readGuide, unread } from '../tour';
import { StepsIcon } from './icons';

/**
 * The question the home page asks about the guided tour's topics this browser has not read (or that
 * changed since it read them): Show me opens the tour at the first of them; Not now stops asking
 * until a topic changes. Left unanswered, it asks again the next time the page opens.
 */
export function TourNudge({ onShow, onLater }: { onShow: () => void; onLater: () => void }) {
  const t = useT();
  const [state] = useState(() => {
    try {
      return readGuide();
    } catch {
      return null;
    }
  });
  const left = unread(state);
  if (!left.length) return null;
  const text = left.every((id) => changed(state, id)) ? t.tour.ask.changed(left.length) : t.tour.ask.unread(left.length);
  return (
    <aside className="tour-nudge" aria-label={t.tour.title}>
      <span className="tour-nudge-icon" aria-hidden="true">
        <StepsIcon size={18} />
      </span>
      <p role="status">{text}</p>
      <div className="tour-nudge-actions">
        <button
          type="button"
          className="ghost small-button"
          onClick={() => {
            quietTour();
            onLater();
          }}
        >
          {t.tour.ask.later}
        </button>
        <button type="button" className="primary small-button" onClick={onShow}>
          {t.tour.ask.show}
        </button>
      </div>
    </aside>
  );
}
