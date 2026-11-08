import { useEffect, useState } from 'react';
import { AGENTSVIEW_DEFAULT_URL, SUGGESTED_AGENT_HOME, type SettingsUpdate, type SettingsView } from '../../shared/types';
import { api } from '../api';
import { useT } from '../i18n';
import { sectionId } from '../route';
import { SectionTitle } from './SectionTitle';

type Note = { text: string; error?: boolean };

/**
 * Where the CLIs keep their own sign-in, settings and sessions when Harness Relay runs them, and
 * AgentsView, which shows each conversation as one thread with the agents' sessions under it.
 */
export function SessionsCard({
  settings,
  onSettings,
  onHomeChanged,
}: {
  settings: SettingsView;
  onSettings: (s: SettingsView) => void;
  /** The CLIs' homes moved: their sign-in status is another one now. */
  onHomeChanged: () => void;
}) {
  const t = useT();
  const [home, setHome] = useState(settings.agentHome);
  const [viewUrl, setViewUrl] = useState(settings.agentsViewUrl);
  const [viewLink, setViewLink] = useState(settings.agentsViewLink);
  const [homeNote, setHomeNote] = useState<Note>({ text: '' });
  const [viewNote, setViewNote] = useState<Note>({ text: '' });

  // Saving another setting returns the same values: keep unsaved edits then.
  useEffect(() => setHome(settings.agentHome), [settings.agentHome]);
  useEffect(() => setViewUrl(settings.agentsViewUrl), [settings.agentsViewUrl]);
  useEffect(() => setViewLink(settings.agentsViewLink), [settings.agentsViewLink]);

  const save = async (update: SettingsUpdate, setNote: (n: Note) => void, done: (s: SettingsView) => string) => {
    try {
      const s = await api.updateSettings(update);
      onSettings(s);
      setNote({ text: done(s) });
      return s;
    } catch (e) {
      setNote({ text: (e as Error).message, error: true });
      return undefined;
    }
  };

  const saveHome = async (value: string) => {
    const before = settings.agentHome;
    const s = await save({ agentHome: value }, setHomeNote, (s) =>
      // The same folder spelled another way (~/… for the full path) changes nothing.
      s.agentHome === before ? '' : s.agentHome ? t.settings.agentHomeSaved(s.agentHome) : t.settings.agentHomeOff,
    );
    if (!s) return;
    setHome(s.agentHome);
    if (s.agentHome !== before) onHomeChanged();
  };

  const saveViewUrl = () =>
    save({ agentsViewUrl: viewUrl }, setViewNote, (s) => (s.agentsViewUrl ? t.settings.agentsViewSaved : t.settings.agentsViewOff));
  const saveViewLink = () => save({ agentsViewLink: viewLink }, setViewNote, () => t.settings.agentsViewLinkSaved);
  // Opened from this browser, which may be on another device: the address for that when there is one.
  const openUrl = settings.agentsViewLink || settings.agentsViewUrl;

  return (
    <section className="card" id={sectionId('sessions')}>
      <SectionTitle section="sessions">{t.settings.sessions}</SectionTitle>
      <p className="muted small">{t.settings.sessionsHint}</p>

      <div className="settings-part">
        <h4>{t.settings.agentHome}</h4>
        <p className="muted small">{t.settings.agentHomeHint}</p>
        <div className="input-row">
          <input value={home} onChange={(e) => setHome(e.target.value)} placeholder={SUGGESTED_AGENT_HOME} spellCheck={false} />
          <button className="primary" onClick={() => saveHome(home)} disabled={home.trim() === settings.agentHome}>
            {t.common.save}
          </button>
        </div>
        {!settings.agentHome && !home.trim() && (
          <div className="button-row">
            <button className="ghost" onClick={() => saveHome(SUGGESTED_AGENT_HOME)}>
              {t.settings.agentHomeUse(SUGGESTED_AGENT_HOME)}
            </button>
          </div>
        )}
        {homeNote.text && <p className={homeNote.error ? 'error-line' : 'muted small'}>{homeNote.text}</p>}
      </div>

      <div className="settings-part">
        <h4>{t.settings.agentsView}</h4>
        <p className="muted small">{t.settings.agentsViewHint}</p>
        <div className="input-row">
          <input value={viewUrl} onChange={(e) => setViewUrl(e.target.value)} placeholder={AGENTSVIEW_DEFAULT_URL} spellCheck={false} />
          <button className="primary" onClick={saveViewUrl} disabled={viewUrl.trim() === settings.agentsViewUrl}>
            {t.common.save}
          </button>
        </div>
        <details className="sub" open={Boolean(settings.agentsViewLink) || undefined}>
          <summary>{t.settings.agentsViewLink}</summary>
          <div className="sub-body">
            <p className="muted small">{t.settings.agentsViewLinkHint}</p>
            <div className="input-row">
              <input
                value={viewLink}
                onChange={(e) => setViewLink(e.target.value)}
                placeholder="https://my-computer.tail1234.ts.net:9999"
                spellCheck={false}
              />
              <button className="primary" onClick={saveViewLink} disabled={viewLink.trim() === settings.agentsViewLink}>
                {t.common.save}
              </button>
            </div>
          </div>
        </details>
        {openUrl && (
          <p className="small">
            <a href={openUrl} target="_blank" rel="noreferrer">
              {t.settings.agentsViewOpen}
            </a>
          </p>
        )}
        {settings.agentsViewError && <p className="warn-line">{t.settings.agentsViewFailed(settings.agentsViewError)}</p>}
        {viewNote.text && <p className={viewNote.error ? 'error-line' : 'muted small'}>{viewNote.text}</p>}
      </div>
    </section>
  );
}
