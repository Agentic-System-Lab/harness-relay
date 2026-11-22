import { useState } from 'react';
import { api } from '../api';
import { commandActions, filledValues, formOf, proposalOf, runTone, waitingAsks, type CommandPart, type SecretsPart } from '../handoffs';
import { useT } from '../i18n';
import { CommandIcon, KeyIcon } from './icons';
import '../handoffs.css';

/*
 * The cards of what an agent hands to the user (docs/architecture.md, "Secrets and fixed commands"):
 * the secrets a reply asks for, and a fixed command it proposes. A value typed here goes to the server
 * once and is never shown again: the card keeps none, and the server never sends one back.
 */

/** Runs a card's call, with its busy state and its error in the card. */
function useCall(): { busy: boolean; error: string; call: (fn: () => Promise<unknown>) => Promise<boolean> } {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const call = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, call };
}

/** The secrets a reply asks for: a masked field for each, Save and Don't give. */
export function SecretsCard({
  part,
  convId,
  messageId,
  agentName,
}: {
  part: SecretsPart;
  convId: string;
  messageId: string;
  agentName: string;
}) {
  const t = useT();
  const c = t.handoffs.secrets;
  const [values, setValues] = useState<Record<string, string>>({});
  const [shown, setShown] = useState<Record<string, boolean>>({});
  const { busy, error, call } = useCall();
  const waiting = waitingAsks(part);
  const filled = filledValues(waiting, values);
  const answer = async (decline: boolean) => {
    const done = await call(() => api.answerSecrets(convId, messageId, part.id, decline ? { decline: true } : { values: filled }));
    // The values leave the page once sent.
    if (done) setValues({});
  };
  return (
    <section className={`outbox-card handoff-card ${waiting.length ? '' : 'handoff-done'}`} aria-label={c.label(agentName)}>
      <header className="approval-head">
        <span className="approval-icon" aria-hidden>
          <KeyIcon size={16} />
        </span>
        <strong>{c.title}</strong>
        {!waiting.length && <span className="approval-waiting">{c.status[part.asks[0]?.status ?? 'saved']}</span>}
      </header>
      <p className="muted small">{c.folder(part.folder)}</p>
      <ul className="handoff-asks">
        {part.asks.map((a) => {
          const id = `secret-${part.id}-${a.name}`;
          return (
            <li key={a.name} className={`handoff-ask handoff-${a.status}`}>
              <label htmlFor={id}>
                <code>{a.name}</code>
                {a.label && <span> · {a.label}</span>}
              </label>
              {a.reason && <p className="small">{a.reason}</p>}
              {a.status === 'waiting' ? (
                <>
                  {a.had && <p className="muted small">{c.had}</p>}
                  <div className="input-row">
                    <input
                      id={id}
                      type={shown[a.name] ? 'text' : 'password'}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder={c.placeholder}
                      value={values[a.name] ?? ''}
                      onChange={(e) => setValues((v) => ({ ...v, [a.name]: e.target.value }))}
                      disabled={busy}
                    />
                    <button
                      type="button"
                      className="ghost small-button"
                      aria-pressed={Boolean(shown[a.name])}
                      onClick={() => setShown((s) => ({ ...s, [a.name]: !s[a.name] }))}
                    >
                      {shown[a.name] ? c.hide : c.show}
                    </button>
                  </div>
                </>
              ) : (
                <p className="muted small">{c.status[a.status]}</p>
              )}
            </li>
          );
        })}
      </ul>
      {waiting.length > 0 && (
        <>
          <p className="muted small">{c.hint}</p>
          {error && <p className="error-line">{error}</p>}
          <div className="approval-actions">
            <button
              type="button"
              className="primary small-button"
              disabled={busy || !Object.keys(filled).length}
              onClick={() => void answer(false)}
            >
              {c.save}
            </button>
            <button type="button" className="ghost small-button" disabled={busy} onClick={() => void answer(true)}>
              {c.decline}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

/** A fixed command a reply proposes: save it (or edit it first) or not; once saved, try it and tell the team. */
export function CommandCard({
  part,
  convId,
  messageId,
  agentName,
}: {
  part: CommandPart;
  convId: string;
  messageId: string;
  agentName: string;
}) {
  const t = useT();
  const c = t.handoffs.command;
  const { busy, error, call } = useCall();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(() => formOf(part.proposal));
  const [extra, setExtra] = useState('');
  const [diff, setDiff] = useState<{ changed: string[]; diff: string } | null>(null);
  const actions = commandActions(part);
  const p = part.proposal;
  const run = part.run;
  const edited = editing ? proposalOf(form) : undefined;
  const save = () =>
    call(async () => {
      await api.commandCard(convId, messageId, part.id, 'save', editing ? edited : undefined);
      setEditing(false);
    });
  const tryIt = (approve: boolean) =>
    call(async () => {
      await api.tryCommand(convId, part.commandId!, { ...(extra.trim() ? { extra } : {}), ...(approve ? { approve: true } : {}) });
      setDiff(null);
    });
  const toggleDiff = () => (diff ? setDiff(null) : void call(async () => setDiff(await api.commandDiff(convId, part.commandId!))));
  const field = (key: keyof typeof form, label: string, hint?: string, multiline = false) => (
    <label className="field">
      <span>{label}</span>
      {multiline ? (
        <textarea rows={2} value={form[key]} onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))} spellCheck={false} />
      ) : (
        <input value={form[key]} onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))} spellCheck={false} />
      )}
      {hint && <span className="muted small">{hint}</span>}
    </label>
  );
  const tone = run ? runTone(run) : undefined;
  return (
    <section className={`outbox-card handoff-card handoff-command-${part.status}`} aria-label={c.label(agentName)}>
      <header className="approval-head">
        <span className="approval-icon" aria-hidden>
          <CommandIcon size={16} />
        </span>
        <strong>{c.title(p.name)}</strong>
        <span className="approval-waiting">{c.status[part.status]}</span>
      </header>
      {editing ? (
        <div className="handoff-form">
          {field('name', c.name)}
          {field('run', c.run, undefined, true)}
          {field('hosts', c.hosts, c.hostsHint)}
          {field('secrets', c.secrets, c.secretsHint)}
          {field('cwd', c.folder, c.cwdHint)}
        </div>
      ) : (
        <dl className="outbox-fields">
          <div>
            <dt>{c.run}</dt>
            <dd>
              <code className="handoff-run">{p.run}</code>
            </dd>
          </div>
          <div>
            <dt>{c.folder}</dt>
            <dd>{p.cwd ? `${part.folder}/${p.cwd}` : part.folder}</dd>
          </div>
          <div>
            <dt>{c.hosts}</dt>
            <dd>{p.hosts.length ? p.hosts.join(', ') : c.noHosts}</dd>
          </div>
          {p.secrets.length > 0 && (
            <div>
              <dt>{c.secrets}</dt>
              <dd>
                {p.secrets.map((s) => (
                  <code key={s} className="handoff-secret-name">
                    {s}
                  </code>
                ))}
              </dd>
            </div>
          )}
        </dl>
      )}
      {actions.decide && <p className="muted small">{c.hint}</p>}
      {run && tone && (
        <div className={`handoff-run-result handoff-${tone.tone}`} role="status">
          <div>
            <strong>{c.result[run.status]}</strong>
            {tone.code && run.exitCode !== undefined && <span className="muted small"> · {c.exitCode(run.exitCode)}</span>}
          </div>
          {run.reason && <p className="small">{run.reason}</p>}
          {run.status === 'changed' && (
            <>
              <p className="small">{c.changedHint}</p>
              {run.changed && run.changed.length > 0 && (
                <ul className="handoff-changed">
                  {run.changed.map((f) => (
                    <li key={f}>
                      <code>{f}</code>
                    </li>
                  ))}
                </ul>
              )}
              <button type="button" className="ghost small-button" disabled={busy} onClick={toggleDiff}>
                {diff ? c.hideDiff : c.showDiff}
              </button>
              {diff &&
                (diff.diff ? <pre className="outbox-body handoff-diff">{diff.diff}</pre> : <p className="muted small">{c.noDiff}</p>)}
            </>
          )}
          {run.output && (
            <>
              <p className="muted small">{c.output}</p>
              <pre className="outbox-body">{run.output}</pre>
            </>
          )}
        </div>
      )}
      {error && <p className="error-line">{error}</p>}
      {actions.decide && (
        <div className="approval-actions">
          {editing ? (
            <>
              <button type="button" className="primary small-button" disabled={busy || !edited} onClick={() => void save()}>
                {c.save}
              </button>
              <button
                type="button"
                className="ghost small-button"
                disabled={busy}
                onClick={() => {
                  setEditing(false);
                  setForm(formOf(p));
                }}
              >
                {c.cancel}
              </button>
            </>
          ) : (
            <>
              <button type="button" className="primary small-button" disabled={busy} onClick={() => void save()}>
                {c.save}
              </button>
              <button type="button" className="ghost small-button" disabled={busy} onClick={() => setEditing(true)}>
                {c.edit}
              </button>
              <button
                type="button"
                className="ghost small-button"
                disabled={busy}
                onClick={() => void call(() => api.commandCard(convId, messageId, part.id, 'dismiss'))}
              >
                {c.dismiss}
              </button>
            </>
          )}
        </div>
      )}
      {part.status === 'saved' && (
        <div className="handoff-try">
          {actions.tryIt && !actions.approve && (
            <label className="field">
              <span>{c.extra}</span>
              <input value={extra} onChange={(e) => setExtra(e.target.value)} placeholder={c.extraPlaceholder} spellCheck={false} />
            </label>
          )}
          <div className="approval-actions">
            {actions.approve ? (
              <button type="button" className="primary small-button" disabled={busy} onClick={() => void tryIt(true)}>
                {c.approve}
              </button>
            ) : (
              <button type="button" className="primary small-button" disabled={busy || !actions.tryIt} onClick={() => void tryIt(false)}>
                {run?.status === 'running' ? c.running : c.tryIt}
              </button>
            )}
            {actions.share && (
              <button
                type="button"
                className="ghost small-button"
                disabled={busy}
                onClick={() => void call(() => api.commandCard(convId, messageId, part.id, 'share'))}
              >
                {c.share}
              </button>
            )}
            <button
              type="button"
              className="ghost small-button"
              disabled={busy}
              onClick={() => void call(() => api.commandCard(convId, messageId, part.id, 'continue'))}
            >
              {c.continue}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
