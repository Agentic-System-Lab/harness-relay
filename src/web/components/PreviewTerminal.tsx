import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import type { PreviewTerminalEvent } from '../../shared/types';
import { api } from '../api';
import { base64Bytes, sseMessages, terminalEvent } from '../appPreview';
import { useT } from '../i18n';

/** How much of what the terminal showed the panel keeps as text, for a message to an agent. */
const KEPT_TEXT = 64 * 1024;

/**
 * A container preview's terminal: what the app writes, and what the user types into it. It reads
 * the server's stream (SSE through fetch, with the key) and reconnects when it drops; the server
 * replays the terminal so far on each new stream.
 */
export function PreviewTerminal({
  convId,
  sessionId,
  hidden,
  output,
  onEvent,
}: {
  convId: string;
  sessionId: string;
  hidden: boolean;
  /** The terminal's text so far, raw, for the panel's error report. */
  output: MutableRefObject<string>;
  onEvent: (event: PreviewTerminalEvent) => void;
}) {
  const t = useT();
  const box = useRef<HTMLDivElement>(null);
  const fit = useRef<FitAddon | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const report = useRef(onEvent);
  report.current = onEvent;

  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const term = new Terminal({
      convertEol: false,
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      scrollback: 5000,
      // The code blocks' background, in both themes (`--code-bg`).
      theme: { background: '#0d1117', foreground: '#e6edf3', cursor: '#e6edf3' },
      // An app's link opens only when clicked, in a tab of its own, never with this page as its opener.
      linkHandler: {
        activate: (_event, uri) => {
          if (/^https?:\/\//i.test(uri)) window.open(uri, '_blank', 'noopener,noreferrer');
        },
      },
    });
    const fitter = new FitAddon();
    fit.current = fitter;
    term.loadAddon(fitter);
    term.open(element);
    const stopped = new AbortController();
    const decoder = new TextDecoder();

    // Keystrokes in order, a batch at a time.
    let pending = '';
    let sending: Promise<unknown> = Promise.resolve();
    const flush = () => {
      if (!pending) return;
      const input = pending;
      pending = '';
      sending = sending.then(() => api.appPreviewTerminalSend(convId, sessionId, { input }).catch(() => {}));
    };
    const typed = term.onData((data) => {
      pending += data;
      queueMicrotask(flush);
    });
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const resized = term.onResize(({ cols, rows }) => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => void api.appPreviewTerminalSend(convId, sessionId, { cols, rows }).catch(() => {}), 150);
    });
    const observer = new ResizeObserver(() => {
      if (element.offsetParent !== null) fitter.fit();
    });
    observer.observe(element);

    const read = async () => {
      for (let attempt = 0; attempt < 6 && !stopped.signal.aborted; attempt++) {
        let closed = false;
        try {
          const res = await api.appPreviewTerminal(convId, sessionId, stopped.signal);
          setReconnecting(false);
          attempt = 0;
          const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
          let buffer = '';
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            const { messages, rest } = sseMessages(buffer + value);
            buffer = rest;
            for (const message of messages) {
              const event = terminalEvent(message);
              if (!event) continue;
              if (event.type === 'output') {
                const bytes = base64Bytes(event.data);
                if (event.replay) {
                  term.reset();
                  output.current = '';
                }
                term.write(bytes);
                output.current = (output.current + decoder.decode(bytes, { stream: true })).slice(-KEPT_TEXT);
              } else {
                if (event.type === 'closed') closed = true;
                report.current(event);
              }
            }
          }
        } catch (error) {
          if (stopped.signal.aborted) return;
          // The preview is gone (stopped, expired, another browser's): nothing to reconnect to.
          if ((error as { status?: number }).status === 404 || (error as { status?: number }).status === 403) closed = true;
        }
        if (closed || stopped.signal.aborted) return;
        setReconnecting(true);
        await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
      }
    };
    void read();
    requestAnimationFrame(() => {
      if (element.offsetParent !== null) fitter.fit();
    });
    return () => {
      stopped.abort();
      clearTimeout(resizeTimer);
      observer.disconnect();
      typed.dispose();
      resized.dispose();
      fit.current = null;
      term.dispose();
    };
  }, [convId, sessionId, output]);

  // A terminal hidden behind the page has no size: it is measured again when it shows.
  useEffect(() => {
    if (hidden) return;
    const frame = requestAnimationFrame(() => fit.current?.fit());
    return () => cancelAnimationFrame(frame);
  }, [hidden]);

  return (
    <div className="app-preview-terminal" hidden={hidden}>
      {reconnecting && (
        <p className="muted small" role="status">
          {t.appPreview.reconnecting}
        </p>
      )}
      <div
        ref={box}
        className="app-preview-terminal-screen"
        role="group"
        aria-label={t.appPreview.terminalLabel}
        // Escape and Tab are the app's (a TUI's, a shell's), not the panel's or the dialog's.
        onKeyDown={(e) => {
          if (e.key === 'Escape' || e.key === 'Tab') e.stopPropagation();
        }}
      />
    </div>
  );
}
