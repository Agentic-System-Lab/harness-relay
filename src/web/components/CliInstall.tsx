import { useState } from 'react';
import { PROVIDER_LABEL, type CliInstallView, type Provider, type ProviderStatus } from '../../shared/types';
import { api } from '../api';
import { cliInstallShown, logTail } from '../clis';
import { useT } from '../i18n';

/**
 * A CLI's install from its card in Settings: an Install button when the CLI is not found (or why it
 * cannot be installed here), its install under way with the installer's output, and Remove for a CLI
 * Harness Relay installed, which deletes only the folder it installed it in (`src/server/cliInstall.ts`).
 * `onChanged`: a removal (or an install refused) changed the CLI's status and executable path.
 */
export function CliInstall({
  provider,
  status,
  view,
  onView,
  onChanged,
}: {
  provider: Provider;
  status?: ProviderStatus;
  view?: CliInstallView;
  onView: (view: CliInstallView) => void;
  onChanged: () => Promise<void>;
}) {
  const t = useT();
  const i = t.settings.cliInstall;
  const label = PROVIDER_LABEL[provider];
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; error?: boolean }>({ text: '' });
  const shown = cliInstallShown(status, view);

  const act = async (fn: () => Promise<CliInstallView>, ok?: string, changed = false) => {
    setBusy(true);
    setNote({ text: '' });
    try {
      onView(await fn());
      if (changed) await onChanged();
      if (ok) setNote({ text: ok });
    } catch (e) {
      setNote({ text: (e as Error).message, error: true });
    } finally {
      setBusy(false);
    }
  };

  if (shown.kind === 'none' || !view) return note.text ? <p className="muted small">{note.text}</p> : null;
  const job = view.job;

  if (shown.kind === 'ours') {
    return (
      <div className="cli-install ours">
        <span className="muted small">
          {i.installedHere(view.dir)}
          {!shown.inUse && i.notInUse}
        </span>
        <button
          className="ghost small-button"
          disabled={busy}
          onClick={() => confirm(i.confirmRemove(label, view.dir)) && void act(() => api.removeCli(provider), i.removed(label), true)}
        >
          {i.remove}
        </button>
        {note.text && <p className={note.error ? 'error-line' : 'muted small'}>{note.text}</p>}
      </div>
    );
  }

  if (shown.kind === 'blocked') {
    return (
      <div className="cli-install">
        <p className="muted small">{i.blocked[shown.block](label)}</p>
      </div>
    );
  }

  if (shown.kind === 'running' && job) {
    return (
      <div className="cli-install login-panel running" aria-live="polite">
        <div className="login-state">
          <span className="pulse" />
          <strong>{i.installing(label)}</strong>
          <button className="ghost small-button" disabled={busy} onClick={() => void act(() => api.cancelCliInstall(provider))}>
            {i.cancel}
          </button>
        </div>
        <pre className="cli-install-log">{logTail(job.log) || i.noOutput}</pre>
        {note.text && <p className={note.error ? 'error-line' : 'muted small'}>{note.text}</p>}
      </div>
    );
  }

  // Not found: offer to install it (again, after a failed or cancelled install).
  const ended = shown.kind === 'offer' && shown.retry ? job : undefined;
  return (
    <div className="cli-install">
      {ended?.state === 'failed' && (
        <div className="login-panel failed">
          <div className="login-state">
            <strong>{i.failed}</strong>
          </div>
          {ended.error && <p className="error-line">{ended.error}</p>}
          <details className="login-output" open>
            <summary className="small muted">{i.output}</summary>
            <pre>{ended.log.trim() || i.noOutput}</pre>
          </details>
        </div>
      )}
      {ended?.state === 'cancelled' && <p className="muted small">{i.cancelled}</p>}
      <div className="button-row">
        <button className="primary" disabled={busy} onClick={() => void act(() => api.installCli(provider))}>
          {ended ? i.retry : i.install(label)}
        </button>
      </div>
      <code className="small">{view.command}</code>
      <p className="muted small">
        {i.into(view.dir)}
        {view.method === 'script' && i.scriptHome}
      </p>
      {note.text && <p className={note.error ? 'error-line' : 'muted small'}>{note.text}</p>}
    </div>
  );
}
