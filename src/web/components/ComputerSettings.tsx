import { type ReactNode, useCallback, useEffect, useState } from 'react';
import type { ComputerSettingsView } from '../../shared/types';
import { api } from '../api';
import { useT } from '../i18n';
import { AppDependencyInstall } from './AppDependencyInstall';
import { AppRow } from './AppRow';

/**
 * Settings → Common apps → Computer (Cua): installing Cua on its own (Harness Relay's copy, or the user's
 * own when new enough), whether this computer can run its Linux desktops (`cua runtime doctor`, on the
 * user's click: it takes seconds), the chats' computers to delete, and which CLIs' agents get the tools.
 */
export function ComputerSettings({ access }: { access: ReactNode }) {
  const t = useT();
  const r = t.apps.computerRow;
  const [view, setView] = useState<ComputerSettingsView>();
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const [removing, setRemoving] = useState<string>();

  const load = useCallback(async (check = false) => {
    try {
      setView(await api.computerSettings(check));
      setError('');
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const check = async () => {
    setChecking(true);
    await load(true);
    setChecking(false);
  };
  const remove = async (name: string, folder: string) => {
    if (!confirm(r.confirmRemove(folder))) return;
    setRemoving(name);
    try {
      await api.deleteComputerNamed(name);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRemoving(undefined);
    }
  };

  return (
    <AppRow
      name={r.name}
      description={t.apps.details.computer}
      label={view?.cua ? t.apps.manage : t.apps.options}
      status={view?.cua ? r.version(view.cua.version, view.cua.own) : undefined}
    >
      {view?.cua && !view.cua.own && <p className="small muted">{r.theirs(view.cua.path)}</p>}
      {view?.tooOld && <p className="small">{r.tooOld(view.tooOld.version ?? '', view.tooOld.path, view.installs)}</p>}
      {view && !view.cua && (
        <>
          <p className="small muted">{r.installs(view.installs)}</p>
          <AppDependencyInstall name="cua" onReady={() => load()} />
        </>
      )}
      <p className="small muted">{r.where}</p>
      {view?.cua && (
        <div className="computer-runtime">
          <button type="button" className="ghost small-button" disabled={checking} onClick={() => void check()}>
            {checking ? r.checking : r.check}
          </button>
          {view.runtime && (
            <p className={`small ${view.runtime.ready ? 'muted' : 'error-line'}`} role="status">
              {view.runtime.ready ? r.ready(view.runtime.detail) : r.notReady(view.runtime.detail)}
            </p>
          )}
        </div>
      )}
      {view?.cua && (
        <div className="computer-list">
          <h5>{r.computers}</h5>
          {view.computers.length ? (
            <ul className="lib-list">
              {view.computers.map((x) => (
                <li key={x.name} className="lib-row">
                  <div>
                    <strong dir="auto">{x.folder ? folderName(x.folder) : r.noFolder}</strong>
                    {x.folder && (
                      <span className="small muted" dir="auto">
                        {x.folder}
                      </span>
                    )}
                    <span className="small muted">
                      {r.status[x.status]} · {r.chats(x.chats.length)}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="ghost small-button"
                    disabled={removing === x.name}
                    aria-label={r.removeLabel(x.folder ?? x.name)}
                    onClick={() => void remove(x.name, x.folder ?? x.name)}
                  >
                    {r.remove}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="small muted">{r.none}</p>
          )}
        </div>
      )}
      {access}
      {error && (
        <p role="alert" className="error-line">
          {error}
        </p>
      )}
    </AppRow>
  );
}

/** A folder's last part, as a list names it. */
const folderName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
