import { useState } from 'react';
import { api } from '../api';
import {
  alertPrefsNow,
  browserSupport,
  notifyPermission,
  playChime,
  setAlertPrefs,
  showNotification,
  syncPush,
  unlockSound,
  useAlertPrefs,
  usePushInfo,
} from '../alerts';
import { useT } from '../i18n';
import { sectionId } from '../route';
import { isAppWindow } from '../update';
import { SectionTitle } from './SectionTitle';

/**
 * Settings → Notifications: system notifications (push ones too where the browser has them) and a
 * sound when agents finish or need the user, and for which of those; in this browser only.
 */
export function NotificationsCard() {
  const t = useT();
  const n = t.notifications;
  const prefs = useAlertPrefs();
  const push = usePushInfo();
  const [{ support, push: canPush }] = useState(browserSupport);
  const [permission, setPermission] = useState(notifyPermission);
  const [note, setNote] = useState<{ text: string; error?: boolean }>();
  const [busy, setBusy] = useState(false);
  const app = isAppWindow(navigator.userAgent);
  const notifying = prefs.notify && permission === 'granted';

  const toggleNotify = async (on: boolean) => {
    setNote(undefined);
    if (!on) return setAlertPrefs({ notify: false });
    let allowed = notifyPermission();
    // Asked while the click is still the user's: browsers ask only then.
    if (allowed === 'default') allowed = await Notification.requestPermission();
    setPermission(allowed);
    if (allowed !== 'granted') return setNote({ text: n.denied, error: true });
    setAlertPrefs({ notify: true });
    // Subscribed now, while the tap still counts as the user's (Safari asks for one); the app's own
    // sync of the new choice comes after it.
    void syncPush(api, alertPrefsNow());
  };

  const toggleSound = (on: boolean) => {
    // A click lets the page play sound from now on; it plays once, to hear what it sounds like.
    if (on) {
      unlockSound();
      playChime('done');
    }
    setAlertPrefs({ sound: on });
  };

  const test = async () => {
    setBusy(true);
    setNote(undefined);
    try {
      if (push.active && push.endpoint) {
        await api.pushTest(push.endpoint);
        setNote({ text: n.testSent });
      } else {
        if (prefs.sound) playChime('test');
        await showNotification(n.testTitle, n.testBody, 'relay-test', '/#/settings/notifications');
        setNote({ text: n.testLocal });
      }
    } catch (e) {
      setNote({ text: (e as Error).message, error: true });
    } finally {
      setBusy(false);
    }
  };

  // What turning notifications on gives here, or why it cannot be.
  const reach = app ? n.notifyApp : canPush ? n.notifyPush : n.notifyPage;
  const notifyNote =
    support !== 'ok'
      ? { text: n.support[support], warn: true }
      : permission === 'denied'
        ? { text: n.denied, warn: true }
        : notifying && push.failure
          ? { text: n.pushFailed(push.failure), warn: true }
          : notifying && push.error
            ? { text: push.error, warn: true }
            : { text: notifying && canPush && !push.active ? n.notifyPage : reach };

  return (
    <section className="card" id={sectionId('notifications')}>
      <SectionTitle section="notifications">{n.title}</SectionTitle>
      <p className="muted small">{n.hint}</p>

      <div className="alert-option">
        <label className="check-row">
          <input
            type="checkbox"
            checked={notifying}
            disabled={support !== 'ok' || (permission === 'denied' && !notifying)}
            onChange={(e) => void toggleNotify(e.target.checked)}
          />
          <span>{n.notify}</span>
        </label>
        <p className={notifyNote.warn ? 'warn-line small' : 'muted small'}>{notifyNote.text}</p>
      </div>

      <div className="alert-option">
        <label className="check-row">
          <input type="checkbox" checked={prefs.sound} onChange={(e) => toggleSound(e.target.checked)} />
          <span>{n.sound}</span>
        </label>
        <p className="muted small">{n.soundHint}</p>
      </div>

      <fieldset className="alert-kinds" disabled={!notifying && !prefs.sound}>
        <legend className="small">{n.when}</legend>
        <label className="check-row">
          <input type="checkbox" checked={prefs.done} onChange={(e) => setAlertPrefs({ done: e.target.checked })} />
          <span>{n.done}</span>
        </label>
        <label className="check-row">
          <input type="checkbox" checked={prefs.needs} onChange={(e) => setAlertPrefs({ needs: e.target.checked })} />
          <span>{n.needs}</span>
        </label>
      </fieldset>

      <div className="button-row">
        <button type="button" className="ghost" onClick={() => void test()} disabled={!notifying || busy}>
          {n.test}
        </button>
      </div>
      {note && <p className={note.error ? 'error-line' : 'muted small'}>{note.text}</p>}
    </section>
  );
}
