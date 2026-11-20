import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AppPreviewRequest, AppPreviewSession } from '../../shared/types';
import { api } from '../api';
import { previewErrorDraft, previewFrameError, recordPreviewError, safePreviewSession, type PreviewSelection } from '../appPreview';
import { useT } from '../i18n';
import { useDialog } from './useDialog';

export function AppPreview({
  convId,
  target,
  onClose,
  onFeedback,
}: {
  convId: string;
  target: PreviewSelection;
  onClose: () => void;
  onFeedback: (text: string) => void;
}) {
  const t = useT();
  const p = t.appPreview;
  const panel = useRef<HTMLElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [narrow, setNarrow] = useState(() => matchMedia('(max-width: 1100px)').matches);
  // Keep the frame and its backend state while the phone's user edits an error report.
  const [inChat, setInChat] = useState(false);
  const hidden = narrow && inChat;
  useDialog(panel, onClose, narrow && !hidden);
  useEffect(() => setInChat(false), [target]);
  useEffect(() => {
    const media = matchMedia('(max-width: 1100px)');
    const changed = () => setNarrow(media.matches);
    media.addEventListener('change', changed);
    if (!media.matches) panel.current?.focus();
    return () => media.removeEventListener('change', changed);
  }, []);

  const [mode, setMode] = useState(target.request.mode);
  const [folder, setFolder] = useState(target.folder);
  const [targetError, setTargetError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (target.folder !== undefined) return;
    const lookup = new AbortController();
    setTargetError('');
    api.appPreviewTarget(convId, target.request, lookup.signal).then(
      (result) => {
        if (!lookup.signal.aborted) setFolder(result.folder);
      },
      (error: Error) => {
        if (!lookup.signal.aborted) setTargetError(error.message);
      },
    );
    return () => lookup.abort();
  }, [convId, target, retry]);

  const [session, setSession] = useState<AppPreviewSession>();
  const [phase, setPhase] = useState<'idle' | 'starting' | 'stopping' | 'stopped'>('idle');
  const [loaded, setLoaded] = useState(false);
  const [failure, setFailure] = useState('');
  const [problems, setProblems] = useState<string[]>([]);
  const pending = useRef<AbortController | null>(null);
  const active = useRef<AppPreviewSession | undefined>(undefined);

  useEffect(() => {
    const release = () => {
      pending.current?.abort();
      pending.current = null;
      const owned = active.current;
      active.current = undefined;
      if (owned) void api.stopAppPreview(convId, owned.id).catch(() => {});
    };
    const leave = () => {
      release();
      setSession(undefined);
      setPhase('stopped');
    };
    window.addEventListener('pagehide', leave);
    return () => {
      window.removeEventListener('pagehide', leave);
      release();
    };
  }, [convId]);

  useLayoutEffect(() => {
    if (!session) return;
    const listen = (event: MessageEvent) => {
      const error = previewFrameError(event, frame.current?.contentWindow, session.origin);
      if (error) setProblems((old) => recordPreviewError(old, error));
    };
    window.addEventListener('message', listen);
    return () => window.removeEventListener('message', listen);
  }, [session]);

  const change = async (start: boolean) => {
    if (start && (pending.current || !folder)) return;
    pending.current?.abort();
    const operation = new AbortController();
    pending.current = operation;
    setPhase(start ? 'starting' : 'stopping');
    setFailure('');
    try {
      if (active.current) {
        await api.stopAppPreview(convId, active.current.id);
        if (operation.signal.aborted) return;
        active.current = undefined;
        setSession(undefined);
      }
      if (start) {
        setProblems([]);
        setLoaded(false);
        const request: AppPreviewRequest = { ...target.request, mode, expectedFolder: folder };
        // Start in exactly the folder the user reviewed, even if another matching reply file appeared meanwhile.
        if (request.messageId) request.folder = folder!;
        else if (mode !== 'static' || request.entry === 'package.json') delete request.entry;
        const next = await api.startAppPreview(convId, request, operation.signal);
        if (operation.signal.aborted || !safePreviewSession(next, location.origin)) {
          if (next.id) await api.stopAppPreview(convId, next.id);
          if (!operation.signal.aborted) throw new Error(p.invalid);
          return;
        }
        active.current = next;
        setSession(next);
      }
      setPhase(start ? 'idle' : 'stopped');
    } catch (error) {
      if (!operation.signal.aborted) {
        setFailure((error as Error).message.slice(0, 4000));
        setPhase('idle');
      }
    } finally {
      if (pending.current === operation) pending.current = null;
    }
  };

  const busy = phase === 'starting' || phase === 'stopping';
  const entry = target.request.entry;
  const entryPage = entry && /\.html?$/i.test(entry) ? entry : 'index.html';
  const issues = [targetError, failure, ...problems].filter(Boolean);
  return (
    <>
      {hidden && (
        <button type="button" className="ghost app-preview-return" onClick={() => setInChat(false)}>
          {p.returnToPreview}
        </button>
      )}
      <aside
        hidden={hidden}
        ref={panel}
        className="app-preview"
        role={narrow ? 'dialog' : 'region'}
        aria-modal={narrow || undefined}
        aria-label={p.title}
        tabIndex={-1}
      >
        <header className="drawer-head">
          <h2>{p.title}</h2>
          <button type="button" className="icon-button" aria-label={t.common.close} onClick={onClose}>
            ×
          </button>
        </header>
        <div className="app-preview-settings">
          <div className="app-preview-source">
            <span className="muted small">
              {p.folder} · {target.label}
            </span>
            <code dir="auto">{folder ?? (targetError ? target.request.folder || '.' : t.common.loading)}</code>
          </div>
          <label className="app-preview-mode">
            {p.mode}
            <select
              value={mode}
              onChange={(e) => {
                setMode(e.target.value as AppPreviewRequest['mode']);
                setFailure('');
              }}
              disabled={busy || !!session}
            >
              <option value="static">{p.static}</option>
              <option value="build">{p.build}</option>
              <option value="server">{p.server}</option>
            </select>
          </label>
          <div className="app-preview-run">
            <span className="muted small">{mode === 'static' ? p.page : p.command}</span>
            <code>{mode === 'static' ? entryPage : mode === 'build' ? 'npm run build' : 'npm start'}</code>
          </div>
          {mode !== 'static' && <p className="muted small">{mode === 'build' ? p.buildHint : p.serverHint}</p>}
          <div className="app-preview-actions">
            {targetError ? (
              <button type="button" className="ghost small-button" onClick={() => setRetry((n) => n + 1)}>
                {p.retry}
              </button>
            ) : (
              <button type="button" className="primary small-button" disabled={busy || !folder} onClick={() => void change(true)}>
                {session ? p.rebuild : p.start}
              </button>
            )}
            {session && (
              <button
                type="button"
                className="ghost small-button"
                disabled={busy || !loaded}
                onClick={() => frame.current?.contentWindow?.postMessage('relay-preview-reload', session.origin)}
              >
                {p.reload}
              </button>
            )}
            {(session || busy) && (
              <button type="button" className="ghost small-button" disabled={phase === 'stopping'} onClick={() => void change(false)}>
                {p.stop}
              </button>
            )}
          </div>
        </div>
        {(busy || (session && !loaded) || phase === 'stopped') && (
          <p className="muted small app-preview-status" role="status">
            {phase === 'starting' ? p.starting : phase === 'stopping' ? p.stopping : phase === 'stopped' ? p.stopped : p.loading}
          </p>
        )}
        {(targetError || failure) && (
          <pre className="error-line app-preview-error" role="alert">
            {targetError || failure}
          </pre>
        )}
        {session && (
          <iframe
            tabIndex={0}
            key={session.id}
            ref={frame}
            title={p.frameTitle}
            src={session.url}
            onLoad={() => setLoaded(true)}
            sandbox="allow-scripts allow-forms allow-same-origin"
            referrerPolicy="no-referrer"
          />
        )}
        {issues.length > 0 && (
          <div className="app-preview-problems">
            {problems.length > 0 && (
              <>
                <strong>{p.errors}</strong>
                <ul role="log">
                  {problems.map((text) => (
                    <li key={text}>{text}</li>
                  ))}
                </ul>
              </>
            )}
            <button
              type="button"
              className="ghost small-button"
              onClick={() => {
                if (narrow) setInChat(true);
                onFeedback(previewErrorDraft(p.errors, folder || target.request.folder || '.', issues, target.agentName));
              }}
            >
              {p.feedback}
            </button>
          </div>
        )}
      </aside>
    </>
  );
}
