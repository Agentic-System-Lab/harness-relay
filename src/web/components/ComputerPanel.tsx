import { useEffect, useRef, useState } from 'react';
import { HANDOVER_LIMITS, type ComputerInput, type ComputerView } from '../../shared/types';
import { api } from '../api';
import { sseMessages } from '../appPreview';
import {
  computerEvent,
  computerKey,
  DOUBLE_MS,
  isDouble,
  mergeComputerInputs,
  pressInput,
  viewerReachable,
  wheelInput,
  type Press,
} from '../computer';
import { framePoint } from '../handover';
import { useT } from '../i18n';
import { isAppWindow } from '../update';
import { PanelDivider } from './PanelDivider';
import { useDialog } from './useDialog';

/** Keys the panel offers in a menu, for a phone's keyboard that has none of them. */
const MENU_KEYS = ['enter', 'tab', 'escape', 'backspace', 'up', 'down', 'left', 'right', 'ctrl+c', 'ctrl+v', 'ctrl+l', 'alt+tab', 'super'];

/**
 * The chat's computer (a Cua desktop) beside the chat, where the app preview goes: its screen as Harness
 * Relay takes it (a frame every moment while the panel is open), who has control, what was done on it
 * lately. The user takes control of it (the agents' calls wait) and hands it back; while they have it, their
 * clicks, drags, scrolling, keys and typing go to it. Cua's own viewer opens in a tab, for a page on the
 * computer Harness Relay runs on.
 */
export function ComputerPanel({
  convId,
  onClose,
  onResize,
}: {
  convId: string;
  onClose: () => void;
  /** The divider was moved (shared with the app preview: one width for the panel beside the chat). */
  onResize?: (width: number | undefined, final: boolean) => void;
}) {
  const t = useT();
  const c = t.computer;
  const [view, setView] = useState<ComputerView>();
  const [link, setLink] = useState<'connecting' | 'live' | 'lost'>('connecting');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [typed, setTyped] = useState('');
  const [hasFrame, setHasFrame] = useState(false);
  /** The frame's width over its height: the screen keeps its shape. */
  const [ratio, setRatio] = useState<number>();
  const image = useRef<HTMLImageElement>(null);
  const panel = useRef<HTMLElement>(null);
  // On a narrow screen the panel covers the chat, as a dialog.
  const [narrow, setNarrow] = useState(() => matchMedia('(max-width: 1100px)').matches);
  useEffect(() => {
    const media = matchMedia('(max-width: 1100px)');
    const changed = () => setNarrow(media.matches);
    media.addEventListener('change', changed);
    return () => media.removeEventListener('change', changed);
  }, []);
  useDialog(panel, onClose, narrow);
  const screen = useRef<HTMLDivElement>(null);
  const frame = useRef({ width: 0, height: 0 });
  const mine = view?.control === 'user';
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);

  // The stream: frames into the image (not through React), the state into React; again when it drops.
  useEffect(() => {
    const stopped = new AbortController();
    const read = async () => {
      for (let attempt = 0; attempt < 8 && !stopped.signal.aborted; attempt++) {
        try {
          const res = await api.computerScreen(convId, stopped.signal);
          setLink('live');
          attempt = 0;
          const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
          let buffer = '';
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            const { messages, rest } = sseMessages(buffer + value);
            buffer = rest;
            for (const message of messages) {
              const e = computerEvent(message);
              if (e?.type === 'frame') {
                frame.current = { width: e.width, height: e.height };
                if (image.current) image.current.src = `data:${e.mimeType};base64,${e.data}`;
                setRatio(e.width && e.height ? e.width / e.height : undefined);
                setHasFrame(true);
              } else if (e?.type === 'state') setView(e.view);
            }
          }
        } catch {
          if (stopped.signal.aborted) return;
        }
        if (stopped.signal.aborted) return;
        setLink('lost');
        await new Promise((r) => setTimeout(r, 1000 * Math.min(attempt + 1, 5)));
      }
    };
    void read();
    return () => stopped.abort();
  }, [convId]);

  // The input waiting to go: one request at a time, in order, merged.
  const queue = useRef<ComputerInput[]>([]);
  const sending = useRef<Promise<void> | undefined>(undefined);
  const send = (e: ComputerInput) => {
    queue.current.push(e);
    if (sending.current) return;
    sending.current = (async () => {
      try {
        while (queue.current.length) {
          const { batch, rest } = mergeComputerInputs(queue.current.splice(0));
          queue.current.unshift(...rest);
          await api.computerInput(convId, batch).then(
            () => setError(''),
            (err: Error) => setError(err.message),
          );
        }
      } finally {
        sending.current = undefined;
      }
    })();
  };

  // A click waits a moment for a second one, which makes them a double click.
  const pendingClick = useRef<{ input: ComputerInput & { at: number }; timer: ReturnType<typeof setTimeout> }>(undefined);
  const click = (input: ComputerInput) => {
    const now = performance.now();
    const pending = pendingClick.current;
    if (pending && isDouble(pending.input, { ...input, at: now })) {
      clearTimeout(pending.timer);
      pendingClick.current = undefined;
      if (input.type === 'click') send({ ...input, double: true });
      return;
    }
    if (pending) {
      clearTimeout(pending.timer);
      send(pending.input);
    }
    if (input.type !== 'click' || input.button) {
      pendingClick.current = undefined;
      send(input);
      return;
    }
    const timer = setTimeout(() => {
      pendingClick.current = undefined;
      send(input);
    }, DOUBLE_MS);
    pendingClick.current = { input: { ...input, at: now }, timer };
  };
  useEffect(() => () => clearTimeout(pendingClick.current?.timer), []);

  const point = (x: number, y: number, clamp = false) => {
    const box = image.current?.getBoundingClientRect();
    if (!box) return undefined;
    return framePoint(x, y, box, frame.current, clamp);
  };
  const press = useRef<Press>(undefined);
  const wheel = useRef({ x: 0, y: 0 });

  const act = async (fn: () => Promise<ComputerView | unknown>) => {
    setBusy(true);
    setError('');
    try {
      const next = await fn();
      if (next && typeof next === 'object' && 'status' in next) setView(next as ComputerView);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const handover = view?.handover;
  const take = () =>
    act(() =>
      handover?.status === 'pending'
        ? api.answerHandover(handover.convId, handover.id, { action: 'start', mode: 'computer' })
        : api.computerAction(convId, 'take'),
    );
  const handBack = () =>
    act(async () => {
      const text = note.trim().slice(0, HANDOVER_LIMITS.noteMax) || undefined;
      const r = await api.computerAction(convId, 'return', text);
      setNote('');
      return r;
    });
  const decline = () =>
    handover &&
    act(() => api.answerHandover(handover.convId, handover.id, { action: 'cancel', ...(note.trim() ? { note: note.trim() } : {}) }));
  const openViewer = () =>
    act(async () => {
      const { url } = await api.computerViewer(convId);
      window.open(url, '_blank', 'noopener,noreferrer');
    });

  const status = view?.status ?? 'off';
  const showViewer = status === 'ready' && viewerReachable({ desktop: isAppWindow(navigator.userAgent), hostname: location.hostname });

  return (
    <>
      {!narrow && onResize && <PanelDivider panel={panel} onResize={onResize} label={c.resize} title={t.appPreview.resizeTitle} />}
      <aside
        ref={panel}
        className="app-preview computer-panel"
        role={narrow ? 'dialog' : 'region'}
        aria-modal={narrow || undefined}
        aria-label={c.title}
        tabIndex={-1}
      >
        <header className="drawer-head">
          <h2>{c.title}</h2>
          <span className={`computer-status ${status}`}>{c.status[status]}</span>
          {showViewer && (
            <button type="button" className="ghost small-button" title={c.viewerHint} disabled={busy} onClick={() => void openViewer()}>
              {c.viewer}
            </button>
          )}
          <button type="button" className="icon-button" aria-label={t.common.close} onClick={onClose}>
            ×
          </button>
        </header>
        {view && !view.available && status === 'off' ? (
          <p className="muted computer-note">{c.notInstalled}</p>
        ) : (
          <>
            {view?.folder && (
              <p className="muted small computer-note" dir="auto">
                {c.shared(view.folder)}
              </p>
            )}
            {handover && (
              <div className="computer-handover" role="status">
                <p>
                  <strong>{c.asks(handover.agentName)}</strong> {handover.reason}
                </p>
              </div>
            )}
            <div className="computer-bar">
              <span className="muted small">{mine ? c.user : c.agents}</span>
              {status === 'ready' && !mine && (
                <button type="button" className="primary small-button" disabled={busy} onClick={() => void take()}>
                  {c.take}
                </button>
              )}
              {mine && (
                <button type="button" className="primary small-button" disabled={busy} onClick={() => void handBack()}>
                  {c.handBack}
                </button>
              )}
              {handover?.status === 'pending' && (
                <button type="button" className="ghost small-button approval-deny" disabled={busy} onClick={() => void decline()}>
                  {t.browserHandover.decline}
                </button>
              )}
              {(status === 'off' || status === 'failed') && view?.available && (
                <button
                  type="button"
                  className="ghost small-button"
                  disabled={busy}
                  onClick={() => void act(() => api.computerAction(convId, 'start'))}
                >
                  {c.start}
                </button>
              )}
              {status === 'ready' && (
                <button
                  type="button"
                  className="ghost small-button"
                  disabled={busy}
                  onClick={() => void act(() => api.computerAction(convId, 'stop'))}
                >
                  {c.stop}
                </button>
              )}
            </div>
            {handover && (
              <input
                className="approval-note"
                value={note}
                maxLength={HANDOVER_LIMITS.noteMax}
                placeholder={c.notePlaceholder}
                aria-label={c.notePlaceholder}
                onChange={(e) => setNote(e.target.value)}
              />
            )}
            {status === 'off' && <p className="muted small computer-note">{c.off}</p>}
            {status === 'starting' && (
              <p className="muted small computer-note" role="status">
                {view?.startedAt ? c.startingFor(Math.floor((Date.now() - view.startedAt) / 60_000)) : c.starting} {c.firstTime}
              </p>
            )}
            {status === 'failed' && view?.error && (
              <p className="error-line computer-note" role="alert">
                {view.error}
              </p>
            )}
            {error && (
              <p className="error-line computer-note" role="alert">
                {error}
              </p>
            )}
            {link !== 'live' && (
              <p className="muted small computer-note" role="status">
                {link === 'lost' ? c.lost : c.connecting}
              </p>
            )}
            <div
              ref={screen}
              className={`computer-screen ${mine ? 'controlled' : ''}`}
              hidden={!hasFrame}
              style={ratio ? { aspectRatio: String(ratio) } : undefined}
              tabIndex={mine ? 0 : -1}
              role={mine ? 'application' : 'img'}
              aria-label={mine ? c.screenControl : c.screen}
              onContextMenu={(e) => mine && e.preventDefault()}
              onPointerDown={(e) => {
                if (!mine) return;
                const at = point(e.clientX, e.clientY);
                if (!at) return;
                e.preventDefault();
                screen.current?.focus();
                e.currentTarget.setPointerCapture(e.pointerId);
                press.current = { ...at, at: performance.now(), button: e.button === 2 ? 'right' : e.button === 1 ? 'middle' : 'left' };
              }}
              onPointerUp={(e) => {
                const start = press.current;
                press.current = undefined;
                if (!mine || !start) return;
                const end = point(e.clientX, e.clientY, true) ?? start;
                click(pressInput(start, end));
              }}
              onPointerCancel={() => {
                press.current = undefined;
              }}
              onWheel={(e) => {
                if (!mine) return;
                const at = point(e.clientX, e.clientY);
                if (!at) return;
                const input = wheelInput(e.deltaX, e.deltaY, at, wheel.current, e.deltaMode === 1);
                if (input) send(input);
              }}
              onKeyDown={(e) => {
                if (!mine) return;
                const k = computerKey(e.nativeEvent, mac);
                if (!k) return;
                e.preventDefault();
                send('keys' in k ? { type: 'key', keys: k.keys } : { type: 'text', text: k.text });
              }}
              onPaste={(e) => {
                if (!mine) return;
                const text = e.clipboardData.getData('text/plain');
                if (!text) return;
                e.preventDefault();
                send({ type: 'text', text: text.slice(0, HANDOVER_LIMITS.textMax) });
              }}
            >
              <img ref={image} alt="" draggable={false} />
            </div>
            {mine && (
              <form
                className="computer-type"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!typed) return;
                  send({ type: 'text', text: typed.slice(0, HANDOVER_LIMITS.textMax) });
                  setTyped('');
                }}
              >
                <input value={typed} placeholder={c.typeHere} aria-label={c.typeLabel} onChange={(e) => setTyped(e.target.value)} />
                <button type="submit" className="ghost small-button" disabled={!typed}>
                  {c.send}
                </button>
                <select
                  aria-label={c.keys}
                  value=""
                  onChange={(e) => {
                    if (e.target.value) send({ type: 'key', keys: e.target.value });
                  }}
                >
                  <option value="">{c.keys}</option>
                  {MENU_KEYS.map((k) => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ))}
                </select>
              </form>
            )}
            {view && view.recent.length > 0 && (
              <details className="computer-recent">
                <summary>{c.recent}</summary>
                <ol>
                  {[...view.recent].reverse().map((a, i) => (
                    <li key={a.at + ':' + i}>
                      <time className="muted small">{new Date(a.at).toLocaleTimeString()}</time>{' '}
                      <strong>{a.who === 'agent' ? '@' + (a.by ?? '') : a.who === 'user' ? c.you : 'Harness Relay'}</strong>{' '}
                      <span dir="auto">{a.what}</span>
                    </li>
                  ))}
                </ol>
              </details>
            )}
          </>
        )}
      </aside>
    </>
  );
}
