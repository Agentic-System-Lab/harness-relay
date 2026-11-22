import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { PREVIEW_NO_RECIPE, type AppPreviewRequest, type AppPreviewSession, type PreviewDockerView } from '../../shared/types';
import { api, ApiError } from '../api';
import {
  NO_TERMINAL,
  nextTerminalState,
  previewErrorDraft,
  previewFrameError,
  recordPreviewError,
  safePreviewSession,
  terminalTail,
  type PreviewSelection,
  type TerminalState,
} from '../appPreview';
import { useT } from '../i18n';
import { Deferred, lazyPart } from './Deferred';
import { useDialog } from './useDialog';
import { PreviewDockerDialog } from './PreviewDockerDialog';

// The publish dialog comes only when the user opens it.
const PublishDialog = lazyPart(() => import('./PublishDialog').then((m) => m.PublishDialog));

// xterm.js comes only with a container preview's terminal.
const PreviewTerminal = lazyPart(() => import('./PreviewTerminal').then((m) => m.PreviewTerminal));

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

  const [mode, setMode] = useState<AppPreviewRequest['mode']>();
  const [folder, setFolder] = useState(target.folder);
  const pinnedFolder = useRef(target.folder);
  const [docker, setDocker] = useState<PreviewDockerView>();
  const [setupOpen, setSetupOpen] = useState(false);
  const [session, setSession] = useState<AppPreviewSession>();
  const [phase, setPhase] = useState<'idle' | 'starting' | 'stopping' | 'stopped'>('starting');
  const [loaded, setLoaded] = useState(false);
  const [failure, setFailure] = useState('');
  const [noRecipe, setNoRecipe] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const pending = useRef<AbortController | null>(null);
  const active = useRef<AppPreviewSession | undefined>(undefined);
  // A container preview: its terminal, its page once it serves one, and the command it runs.
  const [term, setTerm] = useState<TerminalState>(NO_TERMINAL);
  const [view, setView] = useState<'page' | 'terminal'>('terminal');
  const [framed, setFramed] = useState(false);
  const [commandLine, setCommandLine] = useState('');
  const [running, setRunning] = useState(false);
  const terminalOutput = useRef('');
  const [publishing, setPublishing] = useState(false);
  // A new preview, or none: the dialog was for the one before.
  useEffect(() => setPublishing(false), [session]);

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
    if (start && pending.current) return;
    pending.current?.abort();
    const operation = new AbortController();
    pending.current = operation;
    setPhase(start ? 'starting' : 'stopping');
    setFailure('');
    setNoRecipe(false);
    try {
      let request: AppPreviewRequest | undefined;
      if (start) {
        const selection = { ...target.request, expectedFolder: pinnedFolder.current };
        if (selection.messageId && pinnedFolder.current !== undefined) selection.folder = pinnedFolder.current;
        const resolved = await api.appPreviewTarget(convId, selection, operation.signal);
        if (operation.signal.aborted) return;
        pinnedFolder.current = resolved.folder;
        setFolder(resolved.folder);
        setMode(resolved.mode);
        if (resolved.mode !== 'static') {
          const status = await api.previewDocker(operation.signal);
          if (operation.signal.aborted) return;
          if (status.state !== 'ready') {
            setDocker(status);
            setSetupOpen(true);
            setPhase('idle');
            return;
          }
        }
        setDocker(undefined);
        setSetupOpen(false);
        request = { ...selection, entry: resolved.entry, mode: resolved.mode, expectedFolder: resolved.folder };
        if (request.messageId) request.folder = resolved.folder;
      }
      if (active.current) {
        await api.stopAppPreview(convId, active.current.id);
        if (operation.signal.aborted) return;
        active.current = undefined;
        setSession(undefined);
      }
      if (request) {
        setProblems([]);
        setLoaded(false);
        setTerm(NO_TERMINAL);
        setView('terminal');
        setFramed(false);
        setCommandLine('');
        terminalOutput.current = '';
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
        setNoRecipe(error instanceof ApiError && error.code === PREVIEW_NO_RECIPE);
        setPhase('idle');
      }
    } finally {
      if (pending.current === operation) pending.current = null;
    }
  };

  // Reopening the same reply is a fresh preview. StrictMode cancels the first target lookup
  // before it can create a session. An aborted start that still returns is deleted by its own ID.
  const startSelected = useRef(change);
  startSelected.current = change;
  useEffect(() => {
    pinnedFolder.current = target.folder;
    setFolder(target.folder);
    setMode(undefined);
    setDocker(undefined);
    setSetupOpen(false);
    setSession(undefined);
    void startSelected.current(true);
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
      setSetupOpen(false);
      setPhase('stopped');
    };
    window.addEventListener('pagehide', leave);
    return () => {
      window.removeEventListener('pagehide', leave);
      release();
    };
  }, [convId, target]);

  // The page opens once the app serves one: the first time in a frame (its one-time ticket), later
  // runs by reloading that frame.
  const pageSeen = useRef(false);
  useEffect(() => {
    pageSeen.current = false;
  }, [session]);
  useEffect(() => {
    if (!session?.terminal || !term.page) return;
    if (!framed) setFramed(true);
    else frame.current?.contentWindow?.postMessage('relay-preview-reload', session.origin);
    if (!pageSeen.current) setView('page');
    pageSeen.current = true;
  }, [term.page, session, framed]);
  useEffect(() => {
    if (term.command !== undefined && term.phase === 'running') setCommandLine(term.command);
  }, [term.command, term.phase]);

  const runAgain = async (command?: string) => {
    if (!session) return;
    setRunning(true);
    try {
      await api.appPreviewRun(convId, session.id, command);
      setView('terminal');
    } catch (error) {
      setFailure((error as Error).message.slice(0, 4000));
    } finally {
      setRunning(false);
    }
  };

  const busy = phase === 'starting' || phase === 'stopping';
  const container = Boolean(session?.terminal);
  const broken = container && (term.phase === 'failed' || (term.phase === 'exited' && term.code !== 0));
  const issues = [failure, ...problems, ...(broken ? [terminalTail(terminalOutput.current)] : [])].filter(Boolean);
  const showPage = !container || view === 'page';
  const status = container
    ? term.phase === 'building' || term.phase === undefined
      ? p.building
      : term.phase === 'starting'
        ? p.startingServices
        : term.phase === 'running'
          ? term.page
            ? undefined
            : p.waitingForPage
          : term.phase === 'exited'
            ? p.exited(term.code ?? 0)
            : p.failed
    : undefined;
  const canRun = container && !term.closed && (term.phase === 'running' || term.phase === 'exited') && !running;
  // Published only once its page answered: a container's port opened, the others' page loaded.
  const canPublish = Boolean(session) && !busy && (container ? term.page && term.phase === 'running' : loaded);
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
            <code dir="auto">{folder ?? (failure ? target.request.folder || '.' : t.common.loading)}</code>
          </div>
          {mode === 'server' && <p className="muted small">{p.serverHint}</p>}
          {mode === 'container' && <p className="muted small">{p.containerHint}</p>}
          <div className="app-preview-actions">
            {(!busy || session) && (
              <button type="button" className="primary small-button" disabled={busy || !!docker} onClick={() => void change(true)}>
                {session ? p.rebuild : failure ? p.retry : p.start}
              </button>
            )}
            {docker && !setupOpen && (
              <button type="button" className="ghost small-button" onClick={() => setSetupOpen(true)}>
                {p.dockerTitle}
              </button>
            )}
            {session && (!container || term.page) && (
              <button
                type="button"
                className="ghost small-button"
                disabled={busy || !loaded}
                onClick={() => frame.current?.contentWindow?.postMessage('relay-preview-reload', session.origin)}
              >
                {p.reload}
              </button>
            )}
            {canRun && (
              <button type="button" className="ghost small-button" onClick={() => void runAgain()}>
                {p.runAgain}
              </button>
            )}
            {/* Before Stop, which stays the last control before the page that Tab reaches next. */}
            {canPublish && (
              <button type="button" className="ghost small-button" onClick={() => setPublishing(true)}>
                {t.publish.button}
              </button>
            )}
            {(session || busy) && (
              <button type="button" className="ghost small-button" disabled={phase === 'stopping'} onClick={() => void change(false)}>
                {p.stop}
              </button>
            )}
          </div>
          {canRun && (
            <form
              className="app-preview-command"
              onSubmit={(e) => {
                e.preventDefault();
                if (commandLine.trim()) void runAgain(commandLine.trim());
              }}
            >
              <label className="muted small" htmlFor="app-preview-command">
                {p.command}
              </label>
              <input
                id="app-preview-command"
                value={commandLine}
                onChange={(e) => setCommandLine(e.target.value)}
                spellCheck={false}
                autoCapitalize="off"
                autoComplete="off"
              />
              <button type="submit" className="ghost small-button" disabled={!commandLine.trim()}>
                {p.runCommand}
              </button>
              <button type="button" className="ghost small-button" onClick={() => void runAgain('/bin/sh')}>
                {p.shell}
              </button>
            </form>
          )}
        </div>
        {container && (
          <div className="segmented app-preview-views" role="radiogroup" aria-label={p.views}>
            <button
              type="button"
              role="radio"
              aria-checked={view === 'page'}
              className={view === 'page' ? 'on' : ''}
              disabled={!framed}
              onClick={() => setView('page')}
            >
              {p.page}
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={view === 'terminal'}
              className={view === 'terminal' ? 'on' : ''}
              onClick={() => setView('terminal')}
            >
              {p.terminal}
            </button>
          </div>
        )}
        {(busy || (session && !container && !loaded) || phase === 'stopped' || (container && status && !busy)) && (
          <p className="muted small app-preview-status" role="status">
            {phase === 'starting'
              ? p.starting
              : phase === 'stopping'
                ? p.stopping
                : phase === 'stopped'
                  ? p.stopped
                  : container
                    ? status
                    : p.loading}
          </p>
        )}
        {failure && (
          <pre className="error-line app-preview-error" role="alert">
            {failure}
          </pre>
        )}
        {noRecipe && (
          <div className="app-preview-actions app-preview-recipe">
            <button
              type="button"
              className="ghost small-button"
              onClick={() => {
                if (narrow) setInChat(true);
                const where = folder || target.request.folder || '.';
                onFeedback(`${target.agentName ? '@' + target.agentName + ' ' : ''}${p.noRecipeDraft(where)}`);
              }}
            >
              {p.noRecipe}
            </button>
          </div>
        )}
        {session && (!container || framed) && (
          <iframe
            tabIndex={0}
            key={session.id}
            ref={frame}
            hidden={!showPage}
            title={p.frameTitle}
            src={session.url}
            onLoad={() => setLoaded(true)}
            sandbox="allow-scripts allow-forms allow-same-origin"
            referrerPolicy="no-referrer"
          />
        )}
        {session?.terminal && (
          <Deferred inPage>
            <PreviewTerminal
              key={session.id}
              convId={convId}
              sessionId={session.id}
              hidden={view !== 'terminal'}
              output={terminalOutput}
              onEvent={(event) => setTerm((state) => nextTerminalState(state, event))}
            />
          </Deferred>
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
      {publishing && session && (
        <Deferred onClose={() => setPublishing(false)}>
          <PublishDialog convId={convId} sessionId={session.id} onClose={() => setPublishing(false)} />
        </Deferred>
      )}
      {setupOpen && docker && (
        <PreviewDockerDialog
          initial={docker}
          onClose={() => setSetupOpen(false)}
          onReady={() => {
            setSetupOpen(false);
            setDocker(undefined);
            void change(true);
          }}
        />
      )}
    </>
  );
}
