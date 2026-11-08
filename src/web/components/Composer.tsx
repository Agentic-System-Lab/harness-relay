import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import { ATTACHMENT_LIMITS, PROVIDER_LABEL, isInlineImage, type AgentConfig } from '../../shared/types';
import type { AttachmentUpload } from '../api';
import { enterSends, isTouchScreen } from '../chat';
import { useT } from '../i18n';
import { PROVIDER_COLOR, formatBytes, initials } from '../util';
import { insertTranscript } from '../voice';
import { PaperclipIcon } from './icons';
import { VoiceButton } from './VoiceInput';

interface Pending {
  id: string;
  file: File;
  /** Preview URL for images. */
  url?: string;
}

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** Pasted screenshots are all called "image.png"; give them a time-stamped name. */
function pastedName(file: File): string {
  if (file.name && file.name !== 'image.png') return file.name;
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const ext = file.type.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
  return `pasted-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.${ext}`;
}

interface Props {
  agents: AgentConfig[];
  /** The team is replying: what is sent waits for the next turn, and Stop is offered. */
  running: boolean;
  canContinue: boolean;
  /** The team is being designed or waits for confirmation: what is sent waits for it (no Continue, no interrupting). */
  locked?: boolean;
  placeholder: string;
  /** `interrupt`: stop the team and send this now (Cmd/Ctrl+Enter while it replies). */
  onSend: (text: string, attachments: AttachmentUpload[], interrupt: boolean) => Promise<boolean>;
  onStop: () => void;
  onContinue: () => Promise<unknown>;
  /** Text to put back in the composer (a withdrawn message to edit); a new object each time. */
  restore?: { text: string };
  /** An agent asked the user something: Continue lets the team go on without the answer. */
  skipQuestion?: boolean;
}

const MOD_KEY = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent) ? '⌘' : 'Ctrl';

const TOKEN = /(^|[\s(（])@([\p{L}\p{N}_-]*)$/u;

export function Composer({
  agents,
  running,
  canContinue,
  locked = false,
  placeholder,
  onSend,
  onStop,
  onContinue,
  restore,
  skipQuestion = false,
}: Props) {
  const t = useT();
  const [text, setText] = useState('');
  const [caret, setCaret] = useState(0);
  const [pick, setPick] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [files, setFiles] = useState<Pending[]>([]);
  const [notice, setNotice] = useState('');
  const [dragging, setDragging] = useState(false);
  const [preparing, setPreparing] = useState(false);
  // A ref, not just state: a quick double Enter / click arrives before React re-renders.
  const sendingRef = useRef(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const textRef = useRef(text);
  textRef.current = text;

  // Free the image previews when the composer goes away.
  const filesRef = useRef(files);
  filesRef.current = files;
  useEffect(() => () => filesRef.current.forEach((f) => f.url && URL.revokeObjectURL(f.url)), []);

  const addFiles = (list: File[]) => {
    if (!list.length) return;
    setNotice('');
    const accepted: Pending[] = [];
    for (const file of list) {
      if (files.length + accepted.length >= ATTACHMENT_LIMITS.maxFiles) {
        setNotice(t.composer.tooManyFiles(ATTACHMENT_LIMITS.maxFiles));
        break;
      }
      if (file.size > ATTACHMENT_LIMITS.maxBytes) {
        setNotice(t.composer.fileTooLarge(file.name, formatBytes(ATTACHMENT_LIMITS.maxBytes)));
        continue;
      }
      const named = file.name && file.name !== 'image.png' ? file : new File([file], pastedName(file), { type: file.type });
      accepted.push({ id: crypto.randomUUID(), file: named, url: isInlineImage(named.type) ? URL.createObjectURL(named) : undefined });
    }
    setFiles((prev) => [...prev, ...accepted]);
  };

  const removeFile = (id: string) => {
    const gone = files.find((f) => f.id === id);
    if (gone?.url) URL.revokeObjectURL(gone.url);
    setFiles((prev) => prev.filter((f) => f.id !== id));
    setNotice('');
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = [...e.clipboardData.files];
    if (!pasted.length) return;
    // A copied image may come with text (e.g. from a web page): keep the text, attach the image.
    if (!e.clipboardData.getData('text/plain')) e.preventDefault();
    addFiles(pasted);
  };

  const onDragOver = (e: DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    setDragging(true);
  };

  const onDrop = (e: DragEvent) => {
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    setDragging(false);
    addFiles([...e.dataTransfer.files]);
    ref.current?.focus();
  };

  // A withdrawn message comes back for editing, ahead of anything typed since.
  useEffect(() => {
    if (!restore) return;
    setText((cur) => (cur.trim() ? `${restore.text}\n${cur}` : restore.text));
    requestAnimationFrame(() => ref.current?.focus());
  }, [restore]);

  // Auto-grow the textarea. Empty, it stays one line: Safari counts a wrapped placeholder in
  // scrollHeight, and the placeholder is cut to one line (styles.css) so it fits on a phone.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    if (text) el.style.height = `${Math.min(el.scrollHeight, 260)}px`;
  }, [text]);

  const token = TOKEN.exec(text.slice(0, caret));
  const query = token?.[2]?.toLowerCase() ?? '';
  const options = token && !dismissed ? agents.filter((a) => a.name.toLowerCase().startsWith(query)) : [];
  const menuOpen = options.length > 0;

  const insertMention = (a: AgentConfig) => {
    const before = text.slice(0, caret).replace(/@([\p{L}\p{N}_-]*)$/u, `@${a.name} `);
    const next = before + text.slice(caret);
    setText(next);
    setPick(0);
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(before.length, before.length);
      setCaret(before.length);
    });
  };

  /** A voice transcript goes where the caret is (or replaces the selection); it is not sent by itself. */
  const insertVoice = (piece: string) => {
    const el = ref.current;
    const cur = textRef.current;
    const start = el ? el.selectionStart : cur.length;
    const end = el ? el.selectionEnd : cur.length;
    const next = insertTranscript(cur, start, end, piece);
    setText(next.text);
    setCaret(next.caret);
    setNotice('');
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(next.caret, next.caret);
    });
  };

  // While the team replies (or its design waits), a message waits for the next turn: sending is always fine.
  const canSend = (text.trim().length > 0 || files.length > 0) && !preparing;

  /** Run one send (or Continue) at a time. */
  const once = async (fn: () => Promise<void>) => {
    if (sendingRef.current) return;
    sendingRef.current = true;
    setPreparing(true);
    try {
      await fn();
    } finally {
      sendingRef.current = false;
      setPreparing(false);
    }
  };

  const submit = (interrupt = false) =>
    once(async () => {
      const trimmed = text.trim();
      if (!canSend) return;
      let attachments: AttachmentUpload[];
      try {
        attachments = await Promise.all(
          files.map(async (f) => ({ name: f.file.name, mimeType: f.file.type || 'application/octet-stream', data: await toBase64(f.file) })),
        );
      } catch {
        setNotice(t.composer.readFailed);
        return;
      }
      const ok = await onSend(trimmed, attachments, interrupt && running && !locked);
      if (ok) {
        setText('');
        setCaret(0);
        files.forEach((f) => f.url && URL.revokeObjectURL(f.url));
        setFiles([]);
        setNotice('');
      }
    });

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return; // IME (注音/拼音) candidate selection
    if (menuOpen) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setPick((p) => (p + (e.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        insertMention(options[Math.min(pick, options.length - 1)]!);
        return;
      }
      if (e.key === 'Escape') {
        setDismissed(true);
        return;
      }
    }
    // On a phone or tablet Enter starts a new line, and the send button sends.
    if (enterSends(e, isTouchScreen())) {
      e.preventDefault();
      void submit(e.metaKey || e.ctrlKey);
    }
  };

  const c = t.composer;
  const hint = isTouchScreen()
    ? locked ? c.hintConfirmTouch : running ? c.hintBusyTouch : c.hintTouch
    : locked ? c.hintConfirm : running ? c.hintBusy(MOD_KEY) : c.hint;

  return (
    <div
      className="composer-wrap"
      onDragOver={onDragOver}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={onDrop}
    >
      {notice && <p className="error-line composer-notice">{notice}</p>}
      {menuOpen && (
        <ul className="mention-menu" role="listbox">
          {options.map((a, i) => (
            <li
              key={a.id}
              role="option"
              aria-selected={i === pick}
              className={i === pick ? 'on' : ''}
              onMouseDown={(e) => {
                e.preventDefault();
                insertMention(a);
              }}
              style={{ ['--accent' as string]: PROVIDER_COLOR[a.provider] }}
            >
              <span className="avatar sm">{initials(a.name)}</span>
              <strong>@{a.name}</strong>
              <span className="muted small">{PROVIDER_LABEL[a.provider]}</span>
              <span className="muted small ellipsis">{a.role.split('\n')[0]}</span>
            </li>
          ))}
        </ul>
      )}
      <div className={`composer ${dragging ? 'dragging' : ''}`}>
        {files.length > 0 && (
          <ul className="attach-tray" aria-label={t.composer.attachments}>
            {files.map((f) => (
              <li key={f.id} className={f.url ? 'attach-thumb' : 'attach-chip'} title={f.file.name}>
                {f.url ? (
                  <img src={f.url} alt={f.file.name} />
                ) : (
                  <>
                    <PaperclipIcon size={14} />
                    <span className="ellipsis">{f.file.name}</span>
                    <span className="muted">{formatBytes(f.file.size)}</span>
                  </>
                )}
                <button type="button" className="attach-remove" onClick={() => removeFile(f.id)} aria-label={t.composer.removeFile(f.file.name)}>
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="composer-row">
          <button
            type="button"
            className="icon-button attach-button"
            onClick={() => picker.current?.click()}
            aria-label={t.composer.attach}
            title={t.composer.attach}
          >
            <PaperclipIcon />
          </button>
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              addFiles([...(e.target.files ?? [])]);
              e.target.value = '';
            }}
          />
          <textarea
            ref={ref}
            value={text}
            rows={1}
            placeholder={placeholder}
            onChange={(e) => {
              setText(e.target.value);
              setCaret(e.target.selectionStart);
              setDismissed(false);
              setPick(0);
            }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
          />
          <div className="composer-actions">
            <VoiceButton onText={insertVoice} onError={setNotice} />
            {running ? (
              <button className="stop" onClick={onStop} aria-label={t.composer.stopLabel}>
                {t.composer.stop}
              </button>
            ) : (
              canContinue &&
              !locked && (
                <button
                  className="ghost"
                  disabled={preparing}
                  onClick={() => void once(async () => void (await onContinue()))}
                  title={skipQuestion ? t.composer.skipTitle : t.composer.continueTitle}
                >
                  {skipQuestion ? t.composer.skip : t.composer.continue}
                </button>
              )
            )}
            {/* Never replaced by Stop: what is sent while the team replies waits for the next turn. */}
            <button
              className="send"
              onClick={() => void submit()}
              disabled={!canSend}
              aria-label={running && !locked ? t.composer.queueLabel : t.composer.sendLabel}
              title={running && !locked ? t.composer.queueLabel : undefined}
            >
              ↑
            </button>
          </div>
        </div>
      </div>
      <p className="composer-hint muted small">{hint}</p>
    </div>
  );
}
