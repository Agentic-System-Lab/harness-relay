import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { createPortal } from 'react-dom';
import {
  HANDOVER_LIMITS,
  type ApprovalAnswer,
  type HandoverInput,
  type HandoverMode,
  type HandoverPart,
  type MessagePart,
} from '../../shared/types';
import { api } from '../api';
import { sseMessages } from '../appPreview';
import { framePoint, isTap, keyInput, mergeInputs, minutesLeft, modifiersOf, preferredMode, screenEvent, viewportOf } from '../handover';
import { useT } from '../i18n';
import { isAppWindow } from '../update';
import { useDialog } from './useDialog';

type ApprovalPart = Extract<MessagePart, { type: 'approval' }>;

/** Whether this page runs on a Mac (or an iPhone or iPad): its shortcuts are ⌘'s, not Ctrl's. */
const onMac = () => /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);

/** The time now, again every `ms`: what a card's minutes left are counted from. */
function useNow(ms: number, on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms, on]);
  return now;
}

/**
 * An agent handed the chat's browser to the user (`browser_hand_over`): why, in its words; the page;
 * that what they sign in to stays with the chat's browser; and the two ways to take it over, the one the
 * page seems to suit first (a window when the chat is on the computer Harness Relay runs on), with where
 * the window opens. Once started, Done hands it back (with a note to the agent) and Cancel stops it; the
 * screencast's panel opens over the chat. `asks`: the reply's approvals waiting (a page on a new host),
 * which the panel shows too.
 */
export function HandoverCard({
  part,
  convId,
  agentName,
  live,
  asks,
  onApproval,
}: {
  part: HandoverPart;
  convId: string;
  agentName: string;
  live: boolean;
  asks: ApprovalPart[];
  onApproval: ((approvalId: string, answer: ApprovalAnswer) => Promise<void>) | undefined;
}) {
  const t = useT();
  const h = t.browserHandover;
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /** The screencast's panel is open in this browser. */
  const [panel, setPanel] = useState(false);
  const status = (part.status === 'pending' || part.status === 'active') && !live ? 'expired' : part.status;
  const going = status === 'pending' || status === 'active';
  const now = useNow(15_000, going);
  const first = preferredMode(part.modes, { desktop: isAppWindow(navigator.userAgent), hostname: location.hostname });

  // Over (handed back, the time ran out, the turn ended): the panel goes with it.
  useEffect(() => {
    if (!going || part.mode !== 'screencast') setPanel(false);
  }, [going, part.mode]);

  const answer = async (body: Parameters<typeof api.answerHandover>[2]) => {
    setBusy(true);
    setError('');
    try {
      await api.answerHandover(convId, part.id, body);
      if (body.action === 'start' && body.mode === 'screencast') setPanel(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const finish = (action: 'done' | 'cancel') => answer({ action, ...(note.trim() ? { note: note.trim() } : {}) });

  if (!going) {
    const outcome =
      status === 'done'
        ? h.outcome.done
        : status === 'declined'
          ? h.outcome.declined
          : status === 'cancelled'
            ? h.outcome.cancelled
            : part.ended === 'timeout'
              ? h.outcome.timeout
              : part.ended === 'failed'
                ? h.outcome.failed
                : h.outcome.turn;
    const mark = status === 'done' ? '✓' : status === 'declined' || status === 'cancelled' ? '✗' : '–';
    return (
      <div className={`approval-done handover-done ${status === 'done' ? 'allowed' : status === 'expired' ? 'expired' : 'denied'}`}>
        <span className="approval-mark" aria-hidden>
          {mark}
        </span>
        <span className="approval-text">
          <span className="approval-what">{h.heading(agentName)}</span>
          <span className="approval-outcome">
            {outcome}
            {part.mode ? (part.mode === 'window' ? h.inWindow : h.inChat) : ''}
            {part.note ? h.withNote(part.note) : ''}
          </span>
        </span>
      </div>
    );
  }

  const left = part.deadline ? minutesLeft(part.deadline, now) : 0;
  const modes: HandoverMode[] = [first, ...part.modes.filter((m) => m !== first)];
  return (
    <section className="approval-card handover-card" id={`handover-${part.id}`} aria-label={h.label(agentName)}>
      <header className="approval-head">
        <span className="approval-icon" aria-hidden>
          ⇄
        </span>
        <strong>{h.heading(agentName)}</strong>
        <span className="approval-waiting">
          {status === 'active' ? h.inUse : h.waiting}
          {left > 0 && ` · ${h.left(left)}`}
        </span>
      </header>
      <p className="handover-reason">
        <span className="muted">{h.said(agentName)}</span> {part.reason}
      </p>
      {part.url && (
        <p className="handover-url small">
          <span className="muted">{h.page}</span> <code>{part.url}</code>
        </p>
      )}
      {status === 'pending' && (
        <>
          <p className="approval-reason handover-kept">{h.kept}</p>
          <p className="approval-reason">{h.rules}</p>
          <div className="handover-modes">
            {modes.map((m, i) => (
              <div key={m} className="handover-mode">
                <button
                  type="button"
                  className={`${i === 0 ? 'primary' : 'ghost'} small-button`}
                  disabled={busy}
                  onClick={() => void answer({ action: 'start', mode: m })}
                >
                  {m === 'window' ? h.startWindow : h.startScreencast}
                </button>
                <span className="muted small">
                  {m === 'window' ? (part.windowAt === 'desktop' ? h.whereDesktop : h.whereServer) : h.screencastHint}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
      {status === 'active' && <p className="approval-reason">{part.mode === 'window' ? h.activeWindow : h.activeScreencast}</p>}
      <input
        className="approval-note"
        value={note}
        maxLength={HANDOVER_LIMITS.noteMax}
        placeholder={h.notePlaceholder}
        aria-label={h.notePlaceholder}
        onChange={(e) => setNote(e.target.value)}
      />
      {error && <p className="error-line">{error}</p>}
      <div className="approval-actions">
        {status === 'pending' ? (
          <button type="button" className="ghost small-button approval-deny" disabled={busy} onClick={() => void finish('cancel')}>
            {h.decline}
          </button>
        ) : (
          <>
            {part.mode === 'screencast' && (
              <button type="button" className="ghost small-button" onClick={() => setPanel(true)}>
                {h.showPanel}
              </button>
            )}
            <button type="button" className="primary small-button" disabled={busy} onClick={() => void finish('done')}>
              {h.done}
            </button>
            <button type="button" className="ghost small-button approval-deny" disabled={busy} onClick={() => void finish('cancel')}>
              {h.cancel}
            </button>
          </>
        )}
      </div>
      {panel && part.mode === 'screencast' && status === 'active' && (
        <HandoverPanel
          convId={convId}
          handoverId={part.id}
          reason={part.reason}
          asks={asks}
          onApproval={onApproval}
          busy={busy}
          onHide={() => setPanel(false)}
          onDone={() => void finish('done')}
        />
      )}
    </section>
  );
}

/** A mouse button as Chromium's input names it. */
const BUTTON = ['left', 'middle', 'right'] as const;

/**
 * The screencast of the hand-over's page, over the chat (on a phone, the whole screen): its frames, fitted
 * to the panel, with the page laid out to the panel's size; the user's clicks, drags, scrolling and keys
 * sent back (a touch's tap is a click, its drag a scroll); a typing box, which an on-screen keyboard and
 * an input method type into, and paste goes through; the address, Back, Forward and Reload; the windows
 * the page opened (closed: one tab) and the pages refused; and the reply's questions about a new host.
 */
export function HandoverPanel({
  convId,
  handoverId,
  reason,
  asks,
  onApproval,
  busy,
  onHide,
  onDone,
  title,
  doneLabel,
  saveAs,
  onEnded,
}: {
  convId: string;
  handoverId: string;
  /** Why the agent handed it over, in its words: what the user came to do (or what a browser for the user alone is). */
  reason: string;
  asks: ApprovalPart[];
  onApproval: ((approvalId: string, answer: ApprovalAnswer) => Promise<void>) | undefined;
  busy: boolean;
  onHide: () => void;
  onDone: () => void;
  /** The dialog's name, and its Done button's words (a browser for the user alone's own). */
  title?: string;
  doneLabel?: string;
  /**
   * A browser for the user alone: Save selection as one of the secrets card's asks (`onSave`: the server
   * reads the selection on the page and keeps it; nothing of it comes back here).
   */
  saveAs?: { names: { name: string; label?: string }[]; onSave: (name: string) => Promise<void> };
  /** Told when the browser has closed (its stream ended, or it is gone). */
  onEnded?: () => void;
}) {
  const t = useT();
  const p = t.browserHandover.panel;
  const alone = t.browserHandover.alone;
  /** Touch drags select text (to save it) instead of scrolling. */
  const [selecting, setSelecting] = useState(false);
  const [saving, setSaving] = useState<{ busy?: boolean; done?: string; error?: string }>({});
  const dialog = useRef<HTMLDivElement>(null);
  const screen = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const typing = useRef<HTMLInputElement>(null);
  /** The latest frame's size, in the page's own pixels. */
  const frame = useRef({ width: 0, height: 0 });
  const [state, setState] = useState<'connecting' | 'live' | 'lost'>('connecting');
  const [address, setAddress] = useState('');
  const [editing, setEditing] = useState(false);
  const [nav, setNav] = useState({ back: false, forward: false });
  const [notice, setNotice] = useState<{ kind: 'popup' | 'refused'; url?: string } | undefined>();
  useDialog(dialog, onHide);

  // The input waiting to go: one request at a time, in order, the moves merged.
  const queue = useRef<HandoverInput[]>([]);
  const sending = useRef(false);
  const send = (e: HandoverInput) => {
    queue.current.push(e);
    if (sending.current) return;
    sending.current = true;
    void (async () => {
      try {
        while (queue.current.length) {
          const batch = mergeInputs(queue.current.splice(0)).slice(0, HANDOVER_LIMITS.eventsMax);
          await api.handoverInput(convId, handoverId, batch).catch(() => undefined);
        }
      } finally {
        sending.current = false;
      }
    })();
  };
  const sendRef = useRef(send);
  sendRef.current = send;

  const ended = useRef(onEnded);
  ended.current = onEnded;

  // The stream: frames into the image (not through React), the rest into state; again when it drops.
  useEffect(() => {
    const stopped = new AbortController();
    const read = async () => {
      for (let attempt = 0; attempt < 8 && !stopped.signal.aborted; attempt++) {
        try {
          const res = await api.handoverScreen(convId, handoverId, stopped.signal);
          setState('live');
          attempt = 0;
          const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
          let buffer = '';
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            const { messages, rest } = sseMessages(buffer + value);
            buffer = rest;
            for (const message of messages) {
              const e = screenEvent(message);
              if (!e) continue;
              if (e.type === 'frame') {
                frame.current = { width: e.width, height: e.height };
                if (image.current) image.current.src = `data:image/jpeg;base64,${e.data}`;
              } else if (e.type === 'location') {
                setNav({ back: e.back, forward: e.forward });
                setAddress((a) => (document.activeElement?.classList.contains('handover-address') ? a : e.url));
              } else if (e.type === 'notice') setNotice({ kind: e.kind, ...(e.url ? { url: e.url } : {}) });
              else if (e.type === 'ended') return void ended.current?.();
            }
          }
        } catch (error) {
          if (stopped.signal.aborted) return;
          const status = (error as { status?: number }).status;
          if (status === 404 || status === 409) return void ended.current?.();
        }
        if (stopped.signal.aborted) return;
        setState('lost');
        await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)));
      }
    };
    void read();
    return () => stopped.abort();
  }, [convId, handoverId]);

  // The page laid out to the panel's size (a narrow page in a phone's panel), again as it changes.
  useEffect(() => {
    const element = screen.current;
    if (!element) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const size = () => {
      const r = element.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) sendRef.current(viewportOf(r.width, r.height, window.devicePixelRatio || 1));
    };
    const observer = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(size, 200);
    });
    observer.observe(element);
    size();
    return () => {
      observer.disconnect();
      clearTimeout(timer);
    };
  }, []);

  // The wheel (and a trackpad's scrolling) goes to the page, not the chat behind: a listener that may prevent it.
  useEffect(() => {
    const element = screen.current;
    if (!element) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const at = point(e.clientX, e.clientY);
      if (!at) return;
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      sendRef.current({ type: 'wheel', ...at, dx: Math.round(e.deltaX * unit), dy: Math.round(e.deltaY * unit) });
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, []);

  /** Where a point of the screen lands on the page, as fractions of the frame. */
  const point = (x: number, y: number) => {
    const img = image.current;
    if (!img || !frame.current.width) return undefined;
    return framePoint(x, y, img.getBoundingClientRect(), frame.current);
  };

  // A mouse's presses, moves and lets go; a touch's tap (a click) and drag (a scroll).
  const touch = useRef<{ id: number; x: number; y: number; at: number; lastX: number; lastY: number; scrolled: boolean } | undefined>(
    undefined,
  );
  const lastMove = useRef(0);
  const clicks = useRef({ at: 0, x: 0, y: 0, n: 0 });
  const onPointerDown = (e: ReactPointerEvent) => {
    const at = point(e.clientX, e.clientY);
    if (!at) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    if (e.pointerType === 'touch' && !selecting) {
      touch.current = { id: e.pointerId, x: e.clientX, y: e.clientY, at: Date.now(), lastX: e.clientX, lastY: e.clientY, scrolled: false };
      return;
    }
    const c = clicks.current;
    const again = Date.now() - c.at < 500 && Math.hypot(e.clientX - c.x, e.clientY - c.y) < 6;
    clicks.current = { at: Date.now(), x: e.clientX, y: e.clientY, n: again ? Math.min(3, c.n + 1) : 1 };
    send({ type: 'mouse', action: 'down', ...at, button: BUTTON[e.button] ?? 'left', clicks: clicks.current.n, modifiers: modifiersOf(e) });
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    const at = point(e.clientX, e.clientY);
    if (!at) return;
    if (e.pointerType === 'touch' && !selecting) {
      const tc = touch.current;
      if (!tc || tc.id !== e.pointerId) return;
      if (!tc.scrolled && Math.hypot(e.clientX - tc.x, e.clientY - tc.y) < 10) return;
      tc.scrolled = true;
      const start = point(tc.x, tc.y) ?? at;
      send({ type: 'wheel', ...start, dx: Math.round(tc.lastX - e.clientX), dy: Math.round(tc.lastY - e.clientY) });
      tc.lastX = e.clientX;
      tc.lastY = e.clientY;
      return;
    }
    // A drag (a slider a page asks to move) goes at every move; hovering, a few times a second.
    const held = e.buttons & 1 ? 'left' : e.buttons & 2 ? 'right' : e.buttons & 4 ? 'middle' : 'none';
    if (held === 'none' && Date.now() - lastMove.current < 50) return;
    lastMove.current = Date.now();
    send({ type: 'mouse', action: 'move', ...at, button: held, modifiers: modifiersOf(e) });
  };
  const onPointerUp = (e: ReactPointerEvent) => {
    const at = point(e.clientX, e.clientY);
    if (e.pointerType === 'touch' && !selecting) {
      const tc = touch.current;
      touch.current = undefined;
      if (!tc || tc.scrolled || !at) return;
      if (!isTap(tc, { x: e.clientX, y: e.clientY, at: Date.now() })) return;
      send({ type: 'mouse', action: 'down', ...at, button: 'left', clicks: 1 });
      send({ type: 'mouse', action: 'up', ...at, button: 'left', clicks: 1 });
      return;
    }
    if (!at) return;
    send({ type: 'mouse', action: 'up', ...at, button: BUTTON[e.button] ?? 'left', clicks: clicks.current.n, modifiers: modifiersOf(e) });
    // What is typed next goes to the page (no on-screen keyboard opens for a mouse; a finger selecting opens none either).
    if (e.pointerType !== 'touch') typing.current?.focus({ preventScroll: true });
  };

  // The typing box: keys of a hardware keyboard as keys; what an on-screen keyboard or an input method
  // types, and what is pasted, as text; the box itself kept empty but while an input method composes.
  const composing = useRef(false);
  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    const k = keyInput(e.nativeEvent, onMac());
    if (!k || k === 'paste') return;
    e.preventDefault();
    e.stopPropagation();
    send(k);
  };
  const onInput = (e: FormEvent<HTMLInputElement>) => {
    const box = e.currentTarget;
    if (composing.current) return;
    if (box.value) send({ type: 'text', text: box.value.slice(0, HANDOVER_LIMITS.textMax) });
    box.value = '';
  };

  const go = (e: FormEvent) => {
    e.preventDefault();
    let url = address.trim();
    if (!url) return;
    if (!/^[a-z][a-z\d+.-]*:/i.test(url)) url = `https://${url}`;
    send({ type: 'navigate', url });
    setEditing(false);
    typing.current?.focus({ preventScroll: true });
  };

  const waiting = asks.filter((a) => a.status === 'pending' && a.review?.status !== 'reviewing');
  return createPortal(
    <div className="modal-scrim handover-scrim">
      <div ref={dialog} className="modal handover-panel" role="dialog" aria-modal="true" aria-label={title ?? p.title} tabIndex={-1}>
        <header className="handover-bar">
          <button
            type="button"
            className="icon-button"
            disabled={!nav.back}
            onClick={() => send({ type: 'history', to: 'back' })}
            aria-label={p.back}
            title={p.back}
          >
            ←
          </button>
          <button
            type="button"
            className="icon-button"
            disabled={!nav.forward}
            onClick={() => send({ type: 'history', to: 'forward' })}
            aria-label={p.forward}
            title={p.forward}
          >
            →
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={() => send({ type: 'history', to: 'reload' })}
            aria-label={p.reload}
            title={p.reload}
          >
            ↻
          </button>
          <form className="handover-go" onSubmit={go}>
            <input
              className="handover-address"
              value={address}
              aria-label={p.address}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              inputMode="url"
              onFocus={() => setEditing(true)}
              onBlur={() => setEditing(false)}
              onChange={(e) => setAddress(e.target.value)}
            />
            {editing && (
              <button type="submit" className="ghost small-button" onMouseDown={(e) => e.preventDefault()}>
                {p.go}
              </button>
            )}
          </form>
          <button type="button" className="primary small-button" disabled={busy} onClick={onDone}>
            {doneLabel ?? t.browserHandover.done}
          </button>
          <button type="button" className="ghost small-button" onClick={onHide}>
            {p.hide}
          </button>
        </header>
        <p className="handover-why muted small" title={reason}>
          {reason}
        </p>
        {waiting.length > 0 && onApproval && (
          <div className="handover-asks" role="alert">
            <span>{p.asking}</span>
            {waiting.map((a) => (
              <span key={a.id} className="handover-ask">
                <code>{a.detail}</code>
                <button type="button" className="primary small-button" onClick={() => void onApproval(a.id, { allow: true })}>
                  {t.approval.allow}
                </button>
                <button type="button" className="ghost small-button" onClick={() => void onApproval(a.id, { allow: false })}>
                  {t.approval.deny}
                </button>
              </span>
            ))}
          </div>
        )}
        {notice && (
          <p className="handover-notice small" role="status">
            {notice.kind === 'popup' ? p.popup(notice.url ?? '') : p.refused(notice.url ?? '')}
            {notice.kind === 'popup' && notice.url && /^https?:/i.test(notice.url) && (
              <button
                type="button"
                className="ghost small-button"
                onClick={() => {
                  send({ type: 'navigate', url: notice.url! });
                  setNotice(undefined);
                }}
              >
                {p.openHere}
              </button>
            )}
            <button type="button" className="icon-button" onClick={() => setNotice(undefined)} aria-label={t.common.close}>
              ×
            </button>
          </p>
        )}
        <div
          ref={screen}
          className="handover-screen"
          role="application"
          aria-label={p.screen}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => (touch.current = undefined)}
          onContextMenu={(e) => e.preventDefault()}
        >
          <img ref={image} alt={p.screen} draggable={false} />
          {state !== 'live' && <span className="handover-state muted">{state === 'lost' ? p.lost : p.connecting}</span>}
        </div>
        <footer className="handover-foot">
          <input
            ref={typing}
            className="handover-type"
            placeholder={p.typeHere}
            aria-label={p.typeLabel}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            onKeyDown={onKeyDown}
            onInput={onInput}
            onCompositionStart={() => (composing.current = true)}
            onCompositionEnd={(e) => {
              composing.current = false;
              if (e.data) send({ type: 'text', text: e.data.slice(0, HANDOVER_LIMITS.textMax) });
              e.currentTarget.value = '';
            }}
            onPaste={(e) => {
              e.preventDefault();
              const text = e.clipboardData.getData('text/plain');
              if (text) send({ type: 'text', text: text.slice(0, HANDOVER_LIMITS.textMax) });
            }}
          />
          <span className="muted small handover-clip">{p.clipboard}</span>
        </footer>
        {saveAs && (
          <div className="handover-save">
            <button
              type="button"
              className="ghost small-button"
              aria-pressed={selecting}
              title={alone.selectHint}
              onClick={() => setSelecting((v) => !v)}
            >
              {alone.select}
            </button>
            {saveAs.names.map((a) => (
              <button
                key={a.name}
                type="button"
                className="primary small-button"
                disabled={saving.busy}
                title={a.label}
                onClick={async () => {
                  setSaving({ busy: true });
                  try {
                    await saveAs.onSave(a.name);
                    setSaving({ done: a.name });
                  } catch (err) {
                    setSaving({ error: (err as Error).message });
                  }
                }}
              >
                {alone.saveAs(a.name)}
              </button>
            ))}
            {saving.done && (
              <span className="small handover-saved" role="status">
                {alone.saved(saving.done)}
              </span>
            )}
            {saving.error && (
              <span className="error-line small" role="alert">
                {saving.error}
              </span>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
