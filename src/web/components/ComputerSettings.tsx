import { type ReactNode, useCallback, useEffect, useState } from 'react';
import type { ComputerSettingsView } from '../../shared/types';
import { api } from '../api';
import { logTail } from '../clis';
import { useT } from '../i18n';
import { AppDependencyInstall, DownloadProgress } from './AppDependencyInstall';
import { AppRow } from './AppRow';

/**
 * Settings → Common apps → Computer (Cua): installing Cua on its own (Harness Relay's copy, or the user's
 * own when new enough), then its desktop image (downloaded by itself once Cua is installed here, with its
 * progress; a button for a Cua installed before, or a download that failed), whether this computer can run
 * its Linux desktops (`cua runtime doctor`, on the user's click: it takes seconds), the chats' computers to
 * delete, and which CLIs' agents get the tools.
 */
export function ComputerSettings({ access }: { access: ReactNode }) {
  const t = useT();
  const r = t.apps.computerRow;
  const [view, setView] = useState<ComputerSettingsView>();
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const [removing, setRemoving] = useState<string>();
  // Removed (or not completely) is said only in the page that asked: a later visit shows the row as it is.
  const [removedHere, setRemovedHere] = useState(false);

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
  // While Cua is being removed, its steps as they go; while its desktop image downloads, how far it is.
  const uninstalling = view?.removal?.state === 'running';
  const downloading = view?.image?.job?.state === 'running';
  useEffect(() => {
    if (!uninstalling && !downloading) return;
    const timer = setInterval(() => void load(), 1500);
    return () => clearInterval(timer);
  }, [uninstalling, downloading, load]);
  const downloadImage = async () => {
    try {
      setView(await api.downloadComputerImage());
      setError('');
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const removeCua = async () => {
    if (!confirm(r.confirmRemoveCua(view?.computers.length ?? 0))) return;
    try {
      setRemovedHere(true);
      setView(await api.removeCua());
      setError('');
    } catch (err) {
      setError((err as Error).message);
    }
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
      <p className="small muted">
        {[view && !view.cua ? r.installs(view.installs) : '', r.where].filter(Boolean).join(t.filesEdit.sentenceGap)}
      </p>
      {view && !view.cua && <AppDependencyInstall name="cua" onReady={() => load()} checkAgain={false} />}
      {view?.cua && view.image && !uninstalling && <ComputerImage image={view.image} onDownload={() => void downloadImage()} />}
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
      {view?.removal && (uninstalling || removedHere) && (
        <div className="computer-removal" role="status">
          <p className={view.removal.state === 'failed' ? 'error-line' : 'small'}>
            {view.removal.state === 'running'
              ? r.removing
              : view.removal.state === 'success'
                ? r.removed
                : `${r.removalFailed} ${view.removal.error ?? ''}`}
          </p>
        </div>
      )}
      {(view?.cua || view?.computers.length) && !uninstalling ? (
        <button type="button" className="ghost small-button approval-deny" onClick={() => void removeCua()}>
          {r.removeCua}
        </button>
      ) : null}
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

/**
 * The desktop image computers are made from: its download as it goes (bytes once Docker's pull says, else
 * that it is being prepared), downloaded, or a button to download it (again, after a failure: why, and its log).
 */
function ComputerImage({ image, onDownload }: { image: NonNullable<ComputerSettingsView['image']>; onDownload: () => void }) {
  const t = useT();
  const r = t.apps.computerRow;
  const job = image.job;
  const failed = job?.state === 'failed';
  return (
    <div className="computer-image">
      <h5>{r.image}</h5>
      {job?.state === 'running' ? (
        <>
          <p className="small">{r.imageDownloading}</p>
          {job.progress ? (
            <DownloadProgress done={job.progress.done} total={job.progress.total} />
          ) : (
            <p className="small muted" role="status">
              {r.imagePreparing}
            </p>
          )}
        </>
      ) : image.downloadedAt ? (
        <p className="small muted" role="status">
          {r.imageReady}
        </p>
      ) : (
        <>
          {failed && (
            <p className="error-line" role="alert">
              {r.imageFailed} {job.error ?? ''}
            </p>
          )}
          {failed && job.log && (
            <details className="sub">
              <summary>{t.apps.installLog}</summary>
              <pre className="cli-install-log">{logTail(job.log)}</pre>
            </details>
          )}
          <p className="small muted">{r.imageMissing}</p>
          <button type="button" className="ghost small-button" onClick={onDownload}>
            {failed ? t.apps.retryInstall : r.imageDownload}
          </button>
        </>
      )}
    </div>
  );
}

/** A folder's last part, as a list names it. */
const folderName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
