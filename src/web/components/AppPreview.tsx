import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { PREVIEW_NO_RECIPE, type AppPreviewRequest, type AppPreviewSession, type PreviewDockerView } from '../../shared/types';
import { api, ApiError } from '../api';
import {
  NO_TERMINAL,
  CHAT_MIN_WIDTH,
  nextTerminalState,
  PREVIEW_MIN_WIDTH,
  previewErrorDraft,
  previewFrameError,
  previewWidth,
  recordPreviewError,
  safePreviewSession,
  startsByItself,
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
import { ChevronIcon, ExternalIcon } from './icons';

// xterm.js comes only with a container preview's terminal.
const PreviewTerminal = lazyPart(() => import('./PreviewTerminal').then((m) => m.PreviewTerminal));

export function AppPreview({
  convId,
  target,
  collapsed = false,
  onCollapse,
  onResize,
  onClose,
  onFeedback,
}: {
  convId: string;
  target: PreviewSelection;
  /** Hidden: from the chat's header, or on a phone while the user edits a report. It keeps running. */
  collapsed?: boolean;
  onCollapse?: (hidden: boolean) => void;
  /** The divider was moved: a width (`final` once the drag ends, to keep it), or undefined for the default one. */
  onResize?: (width: number | undefined, final: boolean) => void;
  onClose: () => void;
  onFeedback: (text: string) => void;
}) {
  const t = useT();
  const p = t.appPreview;
  const panel = useRef<HTMLElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [narrow, setNarrow] = useState(() => matchMedia('(max-width: 1100px)').matches);
  /** The panel's width and the most it may take, for the divider's value. */
  const [measured, setMeasured] = useState<{ width: number; max: number }>();
  /** Ends a drag of the divider under way. */
  const dragEnd = useRef<(() => void) | null>(null);
  // Hidden, it keeps the frame and its backend state (on a phone, while the user edits a report).
  const hidden = collapsed;
  useDialog(panel, onClose, narrow && !hidden);
  useEffect(() => {
    const media = matchMedia('(max-width: 1100px)');
    const changed = () => setNarrow(media.matches);
    media.addEventListener('change', changed);
    // Opened by Relay itself while the user may be typing: the focus stays where it is.
    if (!media.matches && !target.auto) panel.current?.focus();
    return () => media.removeEventListener('change', changed);
  }, []);

  useEffect(() => {
    const box = panel.current;
    if (!box || narrow || collapsed) {
      dragEnd.current?.();
      return;
    }
    const measure = () => {
      const container = box.offsetParent;
      if (container)
        setMeasured({
          width: Math.round(box.getBoundingClientRect().width),
          max: Math.max(PREVIEW_MIN_WIDTH, Math.round(container.getBoundingClientRect().width) - CHAT_MIN_WIDTH),
        });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    if (box.offsetParent) observer.observe(box.offsetParent);
    return () => {
      observer.disconnect();
      dragEnd.current?.();
    };
  }, [narrow, collapsed]);

  const [mode, setMode] = useState<AppPreviewRequest['mode']>();
  const [folder, setFolder] = useState(target.folder);
  const pinnedFolder = useRef(target.folder);
  const [docker, setDocker] = useState<PreviewDockerView>();
  const [setupOpen, setSetupOpen] = useState(false);
  const [session, setSession] = useState<AppPreviewSession>();
  const [phase, setPhase] = useState<'idle' | 'starting' | 'stopping' | 'stopped'>(target.autoStart === false ? 'idle' : 'starting');
  const [loaded, setLoaded] = useState(false);
  const [failure, setFailure] = useState('');
  const [noRecipe, setNoRecipe] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const pending = useRef<AbortController | null>(null);
  /** Looking the target up for a preview that waits for Start preview. */
  const looking = useRef<AbortController | null>(null);
  const active = useRef<AppPreviewSession | undefined>(undefined);
  // What it runs from and its buttons fold away while it runs: the page gets the room.
  const [detailsOpen, setDetailsOpen] = useState(false);
  /** Opened by Relay itself, it waits for Start preview (see `startsByItself`). */
  const [held, setHeld] = useState(target.autoStart === false);
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

  const change = async (start: boolean, quiet = false) => {
    if (start && pending.current) return;
    if (start && !quiet) setHeld(false);
    looking.current?.abort();
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
        // Opened by Relay itself, it found another way to run than the chat looked up (a Dockerfile
        // since): what may not start by itself waits for the user.
        if (quiet && !startsByItself(resolved.mode, target.permission ?? 'read-only')) {
          setHeld(true);
          setPhase('idle');
          return;
        }
        if (resolved.mode !== 'static') {
          const status = await api.previewDocker(operation.signal);
          if (operation.signal.aborted) return;
          if (status.state !== 'ready') {
            setDocker(status);
            // Opened by Relay itself: the dialog waits for the user's Set up Docker.
            setSetupOpen(!quiet);
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

  /** Where a preview that waits for Start preview would run from, and how. */
  const look = async () => {
    looking.current?.abort();
    const operation = new AbortController();
    looking.current = operation;
    setPhase('idle');
    try {
      const resolved = await api.appPreviewTarget(convId, { ...target.request, expectedFolder: pinnedFolder.current }, operation.signal);
      if (operation.signal.aborted) return;
      pinnedFolder.current = resolved.folder;
      setFolder(resolved.folder);
      setMode(resolved.mode);
    } catch (error) {
      if (!operation.signal.aborted) {
        setFailure((error as Error).message.slice(0, 4000));
        setNoRecipe(error instanceof ApiError && error.code === PREVIEW_NO_RECIPE);
      }
    } finally {
      if (looking.current === operation) looking.current = null;
    }
  };

  // Reopening the same reply is a fresh preview. StrictMode cancels the first target lookup
  // before it can create a session. An aborted start that still returns is deleted by its own ID.
  const startSelected = useRef(change);
  startSelected.current = change;
  const lookSelected = useRef(look);
  lookSelected.current = look;
  useEffect(() => {
    pinnedFolder.current = target.folder;
    setFolder(target.folder);
    setMode(undefined);
    setDocker(undefined);
    setSetupOpen(false);
    setSession(undefined);
    setDetailsOpen(false);
    setHeld(target.autoStart === false);
    if (target.autoStart === false) void lookSelected.current();
    else void startSelected.current(true, target.auto);
    const release = () => {
      looking.current?.abort();
      looking.current = null;
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
  // runs by reloading that frame, once it has loaded the page. A frame just made still holds a blank
  // document of this page's origin: a message for the preview's would not reach it (and the browser
  // says so), nor is there anything to reload yet.
  const pageSeen = useRef(false);
  const frameLoaded = useRef(false);
  frameLoaded.current = loaded;
  useEffect(() => {
    pageSeen.current = false;
  }, [session]);
  useEffect(() => {
    if (!session?.terminal || !term.page) return;
    if (!pageSeen.current) {
      setFramed(true);
      setView('page');
    } else if (frameLoaded.current) frame.current?.contentWindow?.postMessage('relay-preview-reload', session.origin);
    pageSeen.current = true;
  }, [term.page, session]);
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
  const collapsible = Boolean(session) || busy;
  const showDetails = detailsOpen || !collapsible;
  const waiting = held && !session && !busy && phase === 'idle' && !failure && !docker;
  const pageShown = Boolean(session) && (!container || framed);
  const shownFolder = folder ?? target.request.folder;
  const folderName = shownFolder?.split(/[\\/]/).filter(Boolean).pop() || shownFolder || '.';
  const detailsId = 'app-preview-details';
  // Arrow keys move the divider as a drag does: left widens the panel.
  const resizeBy = (delta: number) => {
    const box = panel.current;
    const container = box?.offsetParent;
    if (!box || !container || !onResize) return;
    onResize(previewWidth(box.getBoundingClientRect().width + delta, container.getBoundingClientRect().width), true);
  };
  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    const container = panel.current?.offsetParent;
    if (event.button !== 0 || !container || !onResize) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    // The page and the terminal would take the pointer over them: see .resizing-preview.
    document.body.classList.add('resizing-preview');
    let last: number | undefined;
    const move = (e: PointerEvent) => {
      const box = container.getBoundingClientRect();
      last = previewWidth(box.right - e.clientX, box.width);
      onResize(last, false);
    };
    const end = () => {
      document.body.classList.remove('resizing-preview');
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      handle.removeEventListener('lostpointercapture', end);
      dragEnd.current = null;
      // Kept once, when the drag ends.
      if (last !== undefined) onResize(last, true);
    };
    dragEnd.current = end;
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
    handle.addEventListener('lostpointercapture', end);
  };
  // A new tab for the page: opened within the click (one opened after waiting for the server is a
  // blocked popup), cut off from this page, then sent to its single-use address.
  const openTab = async () => {
    if (!session) return;
    const tab = window.open('', '_blank');
    if (!tab) return setFailure(p.tabBlocked);
    tab.opener = null;
    try {
      const { url } = await api.appPreviewTab(convId, session.id);
      if (!safePreviewSession({ ...session, url }, location.origin)) throw new Error(p.invalid);
      tab.location.replace(url);
    } catch (error) {
      tab.close();
      setFailure((error as Error).message.slice(0, 4000));
    }
  };
  return (
    <>
      {hidden && narrow && (
        <button type="button" className="ghost app-preview-return" onClick={() => onCollapse?.(false)}>
          {p.returnToPreview}
        </button>
      )}
      {!narrow && !hidden && onResize && (
        <div
          className="app-preview-resize"
          role="separator"
          aria-orientation="vertical"
          aria-label={p.resize}
          aria-valuemin={PREVIEW_MIN_WIDTH}
          aria-valuemax={measured?.max}
          aria-valuenow={measured?.width}
          title={p.resizeTitle}
          tabIndex={0}
          onPointerDown={startResize}
          onDoubleClick={() => onResize(undefined, true)}
          onKeyDown={(e) => {
            const step = e.shiftKey ? 128 : 32;
            if (e.key === 'ArrowLeft') resizeBy(step);
            else if (e.key === 'ArrowRight') resizeBy(-step);
            else if (e.key === 'Home' || e.key === 'Enter') onResize(undefined, true);
            else return;
            e.preventDefault();
          }}
        />
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
          {pageShown && (
            <button type="button" className="ghost small-button app-preview-tab" title={p.openTabTitle} onClick={() => void openTab()}>
              <ExternalIcon size={14} />
              {p.openTab}
            </button>
          )}
          {canPublish && (
            <button type="button" className="ghost small-button app-preview-publish" onClick={() => setPublishing(true)}>
              {t.publish.button}
            </button>
          )}
          <button type="button" className="icon-button" aria-label={t.common.close} onClick={onClose}>
            ×
          </button>
        </header>
        {(collapsible || container) && (
          <div className="app-preview-bar">
            {collapsible && (
              <button
                type="button"
                className={`app-preview-summary ${showDetails ? 'open' : ''}`}
                aria-expanded={showDetails}
                aria-controls={detailsId}
                title={showDetails ? p.hideDetails : p.showDetails}
                onClick={() => setDetailsOpen((open) => !open)}
              >
                <ChevronIcon size={14} />
                <span className="app-preview-summary-text" dir="auto">
                  {folderName} · {target.label}
                </span>
              </button>
            )}
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
          </div>
        )}
        {showDetails && (
          <div className="app-preview-settings" id={detailsId}>
            <div className="app-preview-source">
              <span className="muted small">
                {p.folder} · {target.label}
              </span>
              <code dir="auto">{folder ?? (failure ? target.request.folder || '.' : t.common.loading)}</code>
            </div>
            {mode === 'server' && <p className="muted small">{p.serverHint}</p>}
            {mode === 'container' && <p className="muted small">{p.containerHint}</p>}
            {waiting && <p className="muted small app-preview-waiting">{p.waitsForYou}</p>}
            <div className="app-preview-actions">
              {(!busy || session) && (
                <button
                  type="button"
                  className="primary small-button"
                  disabled={busy || !!docker}
                  onClick={() => {
                    // The details stay open: the button the user just pressed keeps the focus.
                    setDetailsOpen(true);
                    void change(true);
                  }}
                >
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
        {session?.partial && (
          <p className="muted small app-preview-partial" role="note">
            {p.partial}
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
                if (narrow) onCollapse?.(true);
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
                if (narrow) onCollapse?.(true);
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
          <PublishDialog convId={convId} sessionId={session.id} partial={session.partial} onClose={() => setPublishing(false)} />
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
