import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { PublishedApp, PublishPlan } from '../../shared/types';
import { api } from '../api';
import { useT } from '../i18n';
import {
  canPublish,
  configurable,
  databaseLines,
  databaseTicked,
  initialRows,
  publishRequest,
  renamable,
  rowsValid,
  stillPublishing,
  type EnvRow,
} from '../publish';
import { settingsHref } from '../route';
import { GhHelp } from './GhHelp';
import { LogoSpinner } from './Logo';
import { useDialog } from './useDialog';

/**
 * Publishing a running preview to the user's own Render and Neon accounts: what it would create and
 * the app's variables, confirmed as public, then its steps until it is live (`publish/` on the server).
 */
export function PublishDialog({ convId, sessionId, onClose }: { convId: string; sessionId: string; onClose: () => void }) {
  const t = useT();
  const p = t.publish;
  const dialog = useRef<HTMLDivElement>(null);
  useDialog(dialog, onClose);
  const [plan, setPlan] = useState<PublishPlan>();
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [rows, setRows] = useState<EnvRow[]>([]);
  const [database, setDatabase] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [sending, setSending] = useState(false);
  const [app, setApp] = useState<PublishedApp>();
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setError('');
    api.publishPlan(convId, sessionId).then(
      (next) => {
        if (controller.signal.aborted) return;
        setPlan(next);
        setName(next.name);
        setRows(initialRows(next));
        setDatabase(databaseTicked(next));
        // A publish of this folder still under way (the dialog opened again): its steps, not the form.
        if (next.existing?.state === 'publishing') setApp(next.existing);
      },
      (err: Error) => {
        if (!controller.signal.aborted) setError(err.message);
      },
    );
    return () => controller.abort();
  }, [convId, sessionId, reload]);

  // While it publishes: its steps, every two seconds, until it is live or failed.
  useEffect(() => {
    if (!app || !stillPublishing(app)) return;
    let gone = false;
    const timer = setTimeout(() => {
      api.publishedApp(app.id).then(
        (next) => !gone && setApp(next),
        // Gone (unpublished meanwhile) or unreachable: say so, and stop asking.
        (err: Error) => !gone && setApp({ ...app, state: 'failed', error: err.message }),
      );
    }, 2000);
    return () => {
      gone = true;
      clearTimeout(timer);
    };
  }, [app]);

  const send = async () => {
    if (!plan || sending) return;
    setSending(true);
    setError('');
    try {
      setApp(await api.publishPreview(convId, sessionId, publishRequest(plan, name, rows, database)));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  };

  const setRow = (i: number, change: Partial<EnvRow>) => setRows((old) => old.map((r, n) => (n === i ? { ...r, ...change } : r)));
  const regions = t.publish.card.regions;
  const existing = plan?.existing;
  // A failed first publish is set up again as a new one: until its repository exists, its name; until its service exists, its variables.
  const updating = Boolean(existing?.serviceId);
  const started = Boolean(app);
  const ready = plan && canPublish(plan, name, rows, database, confirmed) && !sending && !started;
  const repo = existing?.repo ?? `${plan?.github.login ?? '…'}/${name}`;

  return createPortal(
    <div className="modal-scrim" onClick={onClose}>
      <div
        ref={dialog}
        className="modal publish-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="publish-title"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="drawer-head">
          <h2 id="publish-title">{p.title}</h2>
          <button type="button" className="icon-button" aria-label={t.common.close} onClick={onClose}>
            ×
          </button>
        </header>
        <p className="muted small">{p.intro}</p>
        {!plan && !error && <p role="status">{p.loading}</p>}
        {plan && !started && (
          <>
            {plan.missing.length > 0 && (
              <div className="publish-setup" role="alert">
                <p>{p.setupNeeded}</p>
                <ul>
                  {plan.missing.map((m) => (
                    <li key={m}>{p.setup[m]}</li>
                  ))}
                </ul>
                <a href={settingsHref('publish')} onClick={onClose}>
                  {p.openSettings}
                </a>
              </div>
            )}
            {plan.github.problem && <GhHelp problem={plan.github.problem} retry={p.publish} onSignedIn={() => setReload((n) => n + 1)} />}
            {renamable(plan) && (
              <label className="publish-name">
                <span>{p.name}</span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value.toLowerCase())}
                  maxLength={40}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoComplete="off"
                  aria-describedby="publish-name-hint"
                />
                <span id="publish-name-hint" className="muted small">
                  {p.nameHint}
                </span>
              </label>
            )}
            <section className="publish-summary" aria-label={updating ? p.willUpdate : p.willCreate}>
              <h3>{updating ? p.willUpdate : p.willCreate}</h3>
              <ul>
                <li>{existing?.repoUrl ? p.repoPush(repo) : p.repoNew(plan.github.login ?? '…', name)}</li>
                <li>
                  {plan.serviceType === 'static_site' ? p.staticSite : p.webService}
                  {plan.serviceType === 'web_service' && <span className="muted"> · {p.region(regions[plan.region])}</span>}
                  {existing?.url && (
                    <>
                      {' · '}
                      <a href={existing.url} target="_blank" rel="noreferrer">
                        {existing.url}
                      </a>
                    </>
                  )}
                </li>
                {configurable(plan) &&
                  databaseLines(plan).map((d) => (
                    <li key={d.service}>
                      {p.database(d.service, d.database, d.version)}
                      {d.init && <div className="muted small">{p.initScripts(d.init)}</div>}
                      {d.skipped && <div className="warn-text small">{p.skippedScripts(d.skipped)}</div>}
                    </li>
                  ))}
              </ul>
              {plan.databaseOptional && configurable(plan) && (
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={database}
                    disabled={databaseTicked(plan)}
                    onChange={(e) => setDatabase(e.target.checked)}
                  />
                  {p.addDatabase}
                </label>
              )}
              {plan.databaseOptional && configurable(plan) && databaseTicked(plan) && <p className="muted small">{p.databaseMade}</p>}
              {database && !plan.neonReady && !plan.missing.length && (
                <p className="warn-text small">
                  {p.setup.neon} · <a href={settingsHref('publish')}>{p.openSettings}</a>
                </p>
              )}
              {(plan.commands.build || plan.commands.start || plan.commands.publish || plan.commands.dockerfile) && (
                <dl className="publish-commands">
                  <dt>{p.commands}</dt>
                  {plan.commands.dockerfile && (
                    <dd>
                      {p.dockerfile}
                      <code>{plan.commands.dockerfile}</code>
                    </dd>
                  )}
                  {plan.commands.build && (
                    <dd>
                      {p.build}
                      <code>{plan.commands.build}</code>
                    </dd>
                  )}
                  {plan.commands.start && (
                    <dd>
                      {p.start}
                      <code>{plan.commands.start}</code>
                    </dd>
                  )}
                  {plan.commands.publish && (
                    <dd>
                      {p.publishDir}
                      <code>{plan.commands.publish}</code>
                    </dd>
                  )}
                </dl>
              )}
            </section>
            {updating ? (
              <p className="muted small">{p.envKept}</p>
            ) : (
              <fieldset className="publish-env">
                <legend>{p.env}</legend>
                <p className="muted small">{p.envHint}</p>
                {existing && <p className="warn-text small">{p.envAgain}</p>}
                {rows.map((r, i) => (
                  <div className="publish-env-row" key={i}>
                    <input
                      aria-label={p.envKey}
                      value={r.key}
                      readOnly={r.source !== 'user'}
                      onChange={(e) => setRow(i, { key: e.target.value })}
                      spellCheck={false}
                      autoCapitalize="off"
                      autoComplete="off"
                    />
                    {r.source === 'database' ? (
                      <span className="muted small publish-env-db">{p.envDatabase}</span>
                    ) : (
                      <input
                        aria-label={`${p.envValue} ${r.key}`}
                        value={r.value}
                        onChange={(e) => setRow(i, { value: e.target.value })}
                        spellCheck={false}
                        autoCapitalize="off"
                        autoComplete="off"
                      />
                    )}
                    {r.source === 'user' && (
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={p.envRemove(r.key)}
                        onClick={() => setRows((old) => old.filter((_, n) => n !== i))}
                      >
                        ×
                      </button>
                    )}
                  </div>
                ))}
                {!rowsValid(rows) && <p className="error-line small">{p.envInvalid}</p>}
                <button
                  type="button"
                  className="ghost small-button"
                  onClick={() => setRows((old) => [...old, { key: '', value: '', source: 'user' }])}
                >
                  {p.envAdd}
                </button>
              </fieldset>
            )}
            <ul className="publish-notes muted small">
              {plan.serviceType === 'web_service' && <li>{p.freeNotes}</li>}
              {plan.serviceType === 'web_service' && <li>{p.networkNote}</li>}
              {!updating && <li>{p.githubAccess}</li>}
            </ul>
            <label className="check-row publish-confirm">
              <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
              {p.confirmPublic}
            </label>
          </>
        )}
        {app && (
          <section className="publish-progress" aria-label={p.publishing}>
            <ol>
              {(app.steps ?? []).map((s) => (
                <li key={s.id} className={`publish-step ${s.id} ${s.state}`}>
                  {/* A step under way turns the app's mark, as everything in progress does; the others keep their dot. */}
                  {s.state === 'running' && <LogoSpinner size={14} />}
                  <span className="publish-step-name">{p.steps[s.id]}</span>
                  <span className="muted small">
                    {p.stepStates[s.state]}
                    {s.id === 'build' && s.detail && s.state === 'running' ? ` · ${p.deploy(s.detail)}` : ''}
                  </span>
                </li>
              ))}
            </ol>
            {app.state === 'live' && (
              <p role="status" className="publish-live">
                {p.live}:{' '}
                {app.url && (
                  <a href={app.url} target="_blank" rel="noreferrer">
                    {app.url}
                  </a>
                )}
              </p>
            )}
            {app.state === 'failed' && (
              <p role="alert" className="error-line">
                {p.failed}: {app.error}
              </p>
            )}
            <p className="small">
              {app.dashboardUrl && (
                <a href={app.dashboardUrl} target="_blank" rel="noreferrer">
                  {p.openDashboard}
                </a>
              )}
              {app.dashboardUrl && app.repoUrl && ' · '}
              {app.repoUrl && (
                <a href={app.repoUrl} target="_blank" rel="noreferrer">
                  {p.openRepo}
                </a>
              )}
            </p>
          </section>
        )}
        {error && (
          <p role="alert" className="error-line">
            {error}
          </p>
        )}
        <div className="form-actions">
          {!started && (
            <button type="button" className="primary small-button" disabled={!ready} onClick={() => void send()}>
              {sending ? p.publishing : updating ? p.publishUpdate : p.publish}
            </button>
          )}
          {app?.state === 'failed' && (
            <button
              type="button"
              className="primary small-button"
              onClick={() => {
                setApp(undefined);
                setConfirmed(false);
                setReload((n) => n + 1);
              }}
            >
              {p.retry}
            </button>
          )}
          <button type="button" className="ghost small-button" onClick={onClose}>
            {t.common.close}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
