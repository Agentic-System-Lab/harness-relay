import { useEffect, useState } from 'react';
import type { FolderHandoffs } from '../../shared/types';
import { refusedHostsToTell } from '../../shared/handoffs';
import { api } from '../api';
import { useI18n } from '../i18n';
import { sectionId } from '../route';
import { relativeTime } from '../util';
import { SectionTitle } from './SectionTitle';
import '../handoffs.css';

type Note = { text: string; error?: boolean };

/** One secret's row: its name, when it was set, a field to replace it, and removing it. Never its value. */
function SecretRow({
  folder,
  name,
  setAt,
  disabled,
  onChanged,
  onNote,
}: {
  folder: string;
  name: string;
  setAt: number;
  disabled: boolean;
  onChanged: () => Promise<void>;
  onNote: (n: Note) => void;
}) {
  const { t } = useI18n();
  const c = t.handoffs.settings;
  const [replacing, setReplacing] = useState(false);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const act = async (call: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    onNote({ text: '' });
    try {
      await call();
      setValue('');
      setReplacing(false);
      await onChanged();
      if (done) onNote({ text: done });
    } catch (e) {
      onNote({ text: (e as Error).message, error: true });
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="handoff-setting-row">
      <div className="handoff-setting-head">
        <code>{name}</code>
        <span className="muted small">{c.setAt(relativeTime(setAt, t))}</span>
        <span className="handoff-setting-actions">
          <button type="button" className="ghost small-button" disabled={busy || disabled} onClick={() => setReplacing((r) => !r)}>
            {replacing ? c.cancel : c.replace}
          </button>
          <button
            type="button"
            className="ghost small-button"
            disabled={busy}
            onClick={() => window.confirm(c.confirmSecret(name)) && void act(() => api.deleteHandoffSecret(folder, name))}
          >
            {c.remove}
          </button>
        </span>
      </div>
      {replacing && (
        <div className="input-row">
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={value}
            placeholder={c.newValue}
            aria-label={`${name} ${c.newValue}`}
            onChange={(e) => setValue(e.target.value)}
          />
          <button
            type="button"
            className="primary small-button"
            disabled={busy || !value.trim()}
            onClick={() => void act(() => api.setHandoffSecret(folder, name, value), c.saved)}
          >
            {c.save}
          </button>
        </div>
      )}
    </li>
  );
}

/** Settings → Secrets and fixed commands: by working directory, the secrets' names and the fixed commands. */
export function HandoffsCard() {
  const { t } = useI18n();
  const c = t.handoffs.settings;
  const [view, setView] = useState<{ storage: boolean; folders: FolderHandoffs[] } | null>(null);
  const [note, setNote] = useState<Note>({ text: '' });
  const load = async () => {
    try {
      setView(await api.handoffs());
    } catch (e) {
      setNote({ text: (e as Error).message, error: true });
    }
  };
  useEffect(() => {
    void load();
  }, []);
  const removeCommand = async (id: string, name: string) => {
    if (!window.confirm(c.confirmCommand(name))) return;
    setNote({ text: '' });
    try {
      await api.deleteFixedCommand(id);
      await load();
    } catch (e) {
      setNote({ text: (e as Error).message, error: true });
    }
  };
  return (
    <section className="card" id={sectionId('handoffs')}>
      <SectionTitle section="handoffs">{t.settings.nav.handoffs}</SectionTitle>
      <p className="muted small">{c.intro}</p>
      {view === null ? (
        !note.text && <p className="muted small">{t.common.loading}</p>
      ) : (
        <>
          {!view.storage && <p className="warn-line">{c.noStorage}</p>}
          {!view.folders.length && <p className="muted small">{c.empty}</p>}
          {view.folders.map((f) => (
            <fieldset key={f.folder} className="publish-provider handoff-folder">
              <legend>
                <code>{f.folder}</code>
              </legend>
              {f.secrets.length > 0 && (
                <>
                  <h4 className="handoff-setting-title">{c.secrets}</h4>
                  <ul className="handoff-setting-list">
                    {f.secrets.map((s) => (
                      <SecretRow
                        key={s.name}
                        folder={f.folder}
                        name={s.name}
                        setAt={s.setAt}
                        disabled={!view.storage}
                        onChanged={load}
                        onNote={setNote}
                      />
                    ))}
                  </ul>
                </>
              )}
              {f.commands.length > 0 && (
                <>
                  <h4 className="handoff-setting-title">{c.commands}</h4>
                  <ul className="handoff-setting-list">
                    {f.commands.map((cmd) => (
                      <li key={cmd.id} className="handoff-setting-row">
                        <div className="handoff-setting-head">
                          <strong>{cmd.name}</strong>
                          <span className="handoff-setting-actions">
                            <button type="button" className="ghost small-button" onClick={() => void removeCommand(cmd.id, cmd.name)}>
                              {c.remove}
                            </button>
                          </span>
                        </div>
                        <code className="handoff-run">{cmd.run}</code>
                        <span className="muted small">
                          {[
                            cmd.hosts.length ? cmd.hosts.join(', ') : t.handoffs.command.noHosts,
                            cmd.secrets.length ? cmd.secrets.join(', ') : '',
                            cmd.lastRun
                              ? c.lastRun(
                                  cmd.lastRun.stopped ? t.handoffs.command.stopped : t.handoffs.command.result[cmd.lastRun.status],
                                  relativeTime(cmd.lastRun.at, t),
                                )
                              : c.never,
                            // Hosts the sandbox refused it, also on a run that passed: what needed them may not have been done.
                            cmd.lastRun && refusedHostsToTell(cmd.lastRun).length
                              ? c.lastRefused(refusedHostsToTell(cmd.lastRun).join(', '))
                              : '',
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </fieldset>
          ))}
        </>
      )}
      {note.text && <p className={note.error ? 'error-line' : 'muted small'}>{note.text}</p>}
    </section>
  );
}
