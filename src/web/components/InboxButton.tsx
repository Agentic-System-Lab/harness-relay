import { useT } from '../i18n';
import { badgeText } from '../inbox';
import { BellIcon } from './icons';

/**
 * The bell that opens the notification inbox, with how many are unread: beside the sidebar's collapse
 * button, and right of the expand button while the sidebar is collapsed (each toggle keeps its place, the bell on its inner side).
 */
export function InboxButton({ unread, onOpen }: { unread: number; onOpen: () => void }) {
  const t = useT();
  const badge = badgeText(unread);
  const label = t.inbox.open(unread);
  return (
    <button
      type="button"
      className={`icon-button inbox-button ${badge ? 'has-unread' : ''}`}
      data-tour="inbox"
      onClick={onOpen}
      aria-label={label}
      aria-haspopup="dialog"
      title={label}
    >
      <BellIcon />
      {badge && (
        <span className="inbox-badge" aria-hidden>
          {badge}
        </span>
      )}
    </button>
  );
}
