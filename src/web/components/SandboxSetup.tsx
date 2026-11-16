import { useState } from 'react';
import { PROVIDER_LABEL, type SandboxNeedView, type SandboxSetupView } from '../../shared/types';
import { api } from '../api';
import { logTail } from '../clis';
import { useT } from '../i18n';
import { sectionId } from '../route';
import { byHand, canInstall, setupRunning, usersText } from '../sandboxSetup';
import { useSandboxSetup } from '../useSandboxSetup';
import { CopyButton } from './CopyButton';
import { SectionTitle } from './SectionTitle';

/** One missing thing, in words: what it is, and whose sandboxes run it. */
function NeedItem({ need }: { need: SandboxNeedView }) {
  const t = useT();
  const s = t.sandboxSetup;
  const what = need.kind === 'packages' ? s.needs.packages(need.items.join(s.sep)) : need.kind === 'apparmor' ? s.needs.apparmor(need.items[0] ?? '') : s.needs.node(need.items[0] ?? '');
  return (
    <li>
      <span>{what}</span>
      <span className="muted">{s.for(usersText(need.for, (p) => PROVIDER_LABEL[p], s.open, s.sep))}</span>
      {need.blocked && <span className="muted small block">{s.blocked[need.blocked]}</span>}
    </li>
  );
}

/**
 * What the sandboxes lack here, how it gets installed, the install under way (with its output and
 * Cancel) or how the last one ended, and what to run by hand for what Harness Relay cannot install
 * here. The Install button is the caller's (Settings' card, New chat's dialog).
 */
export function SandboxSetupBody({ view, onView }: { view: SandboxSetupView | undefined; onView: (v: SandboxSetupView) => void }) {
  const t = useT();
  const s = t.sandboxSetup;
  const [error, setError] = useState('');
  if (!view) return <p className="muted small">{s.checking}</p>;
  const job = view.job;
  const running = setupRunning(view);
  const manual = byHand(view);
  const cancel = async () => {
    setError('');
    try {
      onView(await api.cancelSandboxSetup());
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <div className="sandbox-setup">
      {view.needs.length ? (
        <>
          <p className="small">{s.missing}</p>
          <ul className="sandbox-needs small">
            {view.needs.map((n) => (
              <NeedItem key={n.kind} need={n} />
            ))}
          </ul>
          {view.admin && view.needs.some((n) => n.kind !== 'node' && !n.blocked) && !running && <p className="muted small">{s.admin[view.admin]}</p>}
        </>
      ) : (
        <p className="muted small">{job?.state === 'success' ? s.done : view.platform === 'win32' ? s.windows : s.allSet}</p>
      )}
      {running && job && (
        <div className="login-panel running" aria-live="polite">
          <div className="login-state">
            <span className="pulse" />
            <strong>{s.installing}</strong>
            {view.cancellable && (
              <button className="ghost small-button" onClick={() => void cancel()}>
                {s.cancel}
              </button>
            )}
          </div>
          <pre className="cli-install-log">{logTail(job.log) || s.noOutput}</pre>
        </div>
      )}
      {job?.state === 'failed' && (
        <div className="login-panel failed">
          <div className="login-state">
            <strong>{s.failed}</strong>
          </div>
          {job.error && <p className="error-line">{job.error}</p>}
          <details className="login-output">
            <summary className="small muted">{s.output}</summary>
            <pre>{job.log.trim() || s.noOutput}</pre>
          </details>
        </div>
      )}
      {job?.state === 'cancelled' && <p className="muted small">{s.cancelled}</p>}
      {job?.state === 'success' && view.needs.length > 0 && <p className="small">{s.partlyDone}</p>}
      {!running &&
        manual.map((n) => (
          <div key={n.kind} className="sandbox-by-hand">
            <p className="muted small">{n.blocked === 'packageManager' ? s.packagesToInstall : s.byHand}</p>
            <pre className="cli-install-log">{n.command}</pre>
            <CopyButton text={() => n.command} className="ghost small-button" />
          </div>
        ))}
      {error && (
        <p className="error-line" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** Starts the install; the view it answers with, or the error's words. */
export async function startSandboxSetup(onView: (v: SandboxSetupView) => void): Promise<string> {
  try {
    onView(await api.installSandboxSetup());
    return '';
  } catch (err) {
    return (err as Error).message;
  }
}

/** Settings → Sandboxes: what the sandboxes lack here, and Install. */
export function SandboxSetupCard() {
  const t = useT();
  const s = t.sandboxSetup;
  const { view, setView } = useSandboxSetup();
  const [error, setError] = useState('');
  return (
    <section className="card" id={sectionId('sandboxes')}>
      <SectionTitle section="sandboxes">{s.title}</SectionTitle>
      <p className="muted small">{s.hint}</p>
      <SandboxSetupBody view={view} onView={setView} />
      {canInstall(view) && (
        <div className="button-row">
          <button className="primary" onClick={() => void startSandboxSetup(setView).then(setError)}>
            {s.install}
          </button>
        </div>
      )}
      {error && (
        <p className="error-line" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
