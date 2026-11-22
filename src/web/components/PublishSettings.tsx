import { useEffect, useState } from 'react';
import { RENDER_REGIONS, type PublishedApp, type PublishSettingsView, type RenderRegion } from '../../shared/types';
import { api } from '../api';
import { useI18n } from '../i18n';
import { hashFor, sectionId } from '../route';
import { SectionTitle } from './SectionTitle';

type Note = { text: string; error?: boolean };

/** A key's row: what is saved (masked), a field for a new one, and removing it. */
function KeyField({
  label,
  masked,
  disabled,
  onSave,
  onRemove,
}: {
  label: string;
  masked: string;
  disabled?: boolean;
  onSave: (key: string) => Promise<boolean>;
  onRemove: () => Promise<boolean>;
}) {
  const { t } = useI18n();
  const c = t.publish.card;
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async (call: () => Promise<boolean>) => {
    setBusy(true);
    if (await call()) setKey('');
    setBusy(false);
  };
  return (
    <div className="field">
      <span>
        {c.apiKey} · <span className="muted small">{masked ? c.saved(masked) : t.settings.backends.notSet}</span>
      </span>
      <div className="input-row">
        <input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          autoComplete="off"
          aria-label={`${label} ${c.apiKey}`}
          disabled={disabled}
        />
        <button className="primary" onClick={() => void run(() => onSave(key.trim()))} disabled={busy || disabled || !key.trim()}>
          {busy ? c.checking : c.save}
        </button>
        {masked && (
          <button className="ghost" onClick={() => void run(onRemove)} disabled={busy}>
            {c.remove}
          </button>
        )}
      </div>
    </div>
  );
}

/** A published app's row: its address, where it came from, and unpublishing it (its databases too, when ticked). */
function AppRow({ app, onGone, onNote }: { app: PublishedApp; onGone: (id: string) => void; onNote: (note: Note) => void }) {
  const { t, lang } = useI18n();
  const c = t.publish.card;
  const [asking, setAsking] = useState(false);
  const [database, setDatabase] = useState(false);
  const [busy, setBusy] = useState(false);
  const when = (ms: number) => new Date(ms).toLocaleString(lang, { dateStyle: 'medium', timeStyle: 'short' });
  const remove = async () => {
    setBusy(true);
    onNote({ text: '' });
    try {
      await api.unpublishApp(app.id, database);
      onGone(app.id);
      onNote({ text: c.repoKept(app.repo) });
    } catch (e) {
      onNote({ text: (e as Error).message, error: true });
      setBusy(false);
    }
  };
  return (
    <li className="share-row publish-app">
      <div className="share-row-text">
        {app.url ? (
          <a className="share-row-title" href={app.url} target="_blank" rel="noreferrer" title={app.url}>
            {app.name}
          </a>
        ) : (
          <span className="share-row-title">{app.name}</span>
        )}
        <span className={`small ${app.state === 'failed' ? 'warn-text' : 'muted'}`}>
          {c.states[app.state]}
          {app.publishedAt ? ` · ${c.published(when(app.publishedAt))}` : ''}
          {app.databases.length ? ` · ${c.databases(app.databases.length)}` : ''}
        </span>
        {app.state === 'failed' && app.error && <span className="small warn-text">{app.error}</span>}
        <span className="muted small">
          <code dir="auto">{app.folder}</code> ·{' '}
          {app.conversationGone ? c.chatGone : <a href={hashFor({ page: 'chat', id: app.conversationId })}>{c.openChat}</a>}
          {app.dashboardUrl && (
            <>
              {' · '}
              <a href={app.dashboardUrl} target="_blank" rel="noreferrer">
                {t.publish.openDashboard}
              </a>
            </>
          )}
          {app.repoUrl && (
            <>
              {' · '}
              <a href={app.repoUrl} target="_blank" rel="noreferrer">
                {t.publish.openRepo}
              </a>
            </>
          )}
        </span>
        {asking && (
          <div className="publish-unpublish" role="group" aria-label={c.unpublish}>
            <p className="small">{c.confirmUnpublish(app.name)}</p>
            {app.databases.length > 0 && (
              <label className="check-row small">
                <input type="checkbox" checked={database} disabled={busy} onChange={(e) => setDatabase(e.target.checked)} />
                {c.deleteDatabase}
              </label>
            )}
            <div className="button-row">
              <button type="button" className="ghost small-button danger" disabled={busy} onClick={() => void remove()}>
                {busy ? c.unpublishing : c.confirm}
              </button>
              <button type="button" className="ghost small-button" disabled={busy} onClick={() => setAsking(false)}>
                {t.common.cancel}
              </button>
            </div>
          </div>
        )}
      </div>
      {!asking && (
        <button
          type="button"
          className="ghost small-button danger"
          disabled={app.state === 'publishing'}
          onClick={() => {
            setDatabase(false);
            setAsking(true);
          }}
        >
          {c.unpublish}
        </button>
      )}
    </li>
  );
}

/**
 * Settings → Publish to the cloud: the Render and Neon keys (kept in the credential store, only their
 * masked ends shown), Render's workspace and region, Neon's organization, and the apps published from
 * previews, each with its address and **Unpublish**.
 */
export function PublishCard() {
  const { t } = useI18n();
  const c = t.publish.card;
  const [view, setView] = useState<PublishSettingsView | null>(null);
  const [note, setNote] = useState<Note>({ text: '' });

  useEffect(() => {
    api.publishSettings().then(setView, (e: Error) => setNote({ text: e.message, error: true }));
  }, []);

  // While an app publishes, its row follows it until it is live or failed.
  const publishing = Boolean(view?.apps.some((a) => a.state === 'publishing'));
  useEffect(() => {
    if (!publishing) return;
    let gone = false;
    const timer = setTimeout(() => {
      api.publishSettings().then(
        (next) => !gone && setView(next),
        () => {},
      );
    }, 5000);
    return () => {
      gone = true;
      clearTimeout(timer);
    };
  }, [publishing, view]);

  const apply = async (call: () => Promise<PublishSettingsView>): Promise<boolean> => {
    setNote({ text: '' });
    try {
      setView(await call());
      return true;
    } catch (e) {
      setNote({ text: (e as Error).message, error: true });
      return false;
    }
  };

  return (
    <section className="card" id={sectionId('publish')}>
      <SectionTitle section="publish">{c.title}</SectionTitle>
      <p className="muted small">{c.hint}</p>
      {view === null ? (
        !note.text && <p className="muted small">{t.common.loading}</p>
      ) : (
        <>
          {!view.storage && <p className="warn-line">{c.noStorage}</p>}
          <fieldset className="publish-provider">
            <legend>{c.render}</legend>
            <p className="muted small">{c.renderHint}</p>
            <KeyField
              label={c.render}
              masked={view.render.keyMasked}
              disabled={!view.storage}
              onSave={(key) => apply(() => api.setRenderKey(key))}
              onRemove={() => apply(() => api.removeRender())}
            />
            {view.render.owners.length > 1 && (
              <label className="field">
                <span>{c.workspace}</span>
                <select value={view.render.ownerId ?? ''} onChange={(e) => void apply(() => api.updateRender({ ownerId: e.target.value }))}>
                  {!view.render.ownerId && <option value="">{c.chooseWorkspace}</option>}
                  {view.render.owners.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {view.render.owners.length === 1 && <p className="muted small">{c.workspaceIs(view.render.owners[0]!.name)}</p>}
            <label className="field">
              <span>{c.region}</span>
              <select
                value={view.render.region}
                onChange={(e) => void apply(() => api.updateRender({ region: e.target.value as RenderRegion }))}
              >
                {RENDER_REGIONS.map((r) => (
                  <option key={r} value={r}>
                    {c.regions[r]}
                  </option>
                ))}
              </select>
            </label>
          </fieldset>
          <fieldset className="publish-provider">
            <legend>{c.neon}</legend>
            <p className="muted small">{c.neonHint}</p>
            <KeyField
              label={c.neon}
              masked={view.neon.keyMasked}
              disabled={!view.storage}
              onSave={(key) => apply(() => api.setNeonKey(key))}
              onRemove={() => apply(() => api.removeNeon())}
            />
            {view.neon.orgs.length > 1 && (
              <label className="field">
                <span>{c.org}</span>
                <select value={view.neon.orgId ?? ''} onChange={(e) => void apply(() => api.updateNeon({ orgId: e.target.value }))}>
                  {!view.neon.orgId && <option value="">{c.chooseOrg}</option>}
                  {view.neon.orgs.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {view.neon.orgs.length === 1 && <p className="muted small">{c.orgIs(view.neon.orgs[0]!.name)}</p>}
            <p className="muted small">{c.neonRegion}</p>
          </fieldset>
          <fieldset className="publish-provider">
            <legend>{c.github}</legend>
            <p className="muted small">{c.githubHint}</p>
          </fieldset>
          <h4 className="publish-apps-title">{c.apps}</h4>
          {view.apps.length === 0 ? (
            <p className="muted small">{c.empty}</p>
          ) : (
            <ul className="share-list">
              {view.apps.map((a) => (
                <AppRow
                  key={a.id}
                  app={a}
                  onNote={setNote}
                  onGone={(id) => setView((v) => (v ? { ...v, apps: v.apps.filter((x) => x.id !== id) } : v))}
                />
              ))}
            </ul>
          )}
        </>
      )}
      {note.text && <p className={note.error ? 'error-line share-note' : 'muted small'}>{note.text}</p>}
    </section>
  );
}
