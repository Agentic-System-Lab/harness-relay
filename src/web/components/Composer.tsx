import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { addressedFollowUp, inferFollowUp, type FollowUpSource } from '../../shared/followUp';
import { PROVIDER_LABEL, type AgentConfig } from '../../shared/types';
import type { AttachmentUpload } from '../api';
import { enterSends, isTouchScreen, restoredText } from '../chat';
import { useT } from '../i18n';
import { PROVIDER_COLOR, initials } from '../util';
import { insertTranscript } from '../voice';
import { AttachmentPicker, AttachmentTray, readUploads, useMessageFiles, type PendingFile } from './MessageFiles';
import { VoiceButton } from './VoiceInput';

interface Props {
  sources: FollowUpSource[];
  followUpChoice?: { id: string };
  selectedName?: string;
  onChooseFollowUp: (id?: string) => void;
  autoFocus?: boolean;
  agents: AgentConfig[];
  /** The team is replying: what is sent waits for the next turn, and Stop is offered. */
  running: boolean;
  /** A fixed command's run of this chat holds its folder: Stop is offered. */
  commandRunning?: boolean;
  /**
   * Something holds the chat's folder while no run goes (a fixed or interactive command, Files deleting):
   * nothing is sent (Send, Enter and Continue), which the placeholder and the line under the box say (the
   * placeholder is the reason given); what is typed stays for later.
   */
  held?: boolean;
  canContinue: boolean;
  /** The team is being designed or waits for confirmation: what is sent waits for it (no Continue, no interrupting). */
  locked?: boolean;
  /** The lead agent reviews the team's replies: sending stops the review and sends the message now. */
  reviewing?: boolean;
  /** Steering is on: while the team replies, what is sent goes into the running turn when it can. */
  steering?: boolean;
  placeholder: string;
  /** `interrupt`: stop the team and send this now (Cmd/Ctrl+Enter while it replies). */
  onSend: (text: string, attachments: AttachmentUpload[], interrupt: boolean, followUp?: string) => Promise<boolean>;
  onStop: () => void;
  onContinue: () => Promise<unknown>;
  /**
   * Text to put in the composer (a withdrawn message to edit, or a lead review's next step, `once`);
   * a new object each time.
   */
  restore?: { text: string; once?: boolean };
  /** An agent asked the user something: Continue lets the team go on without the answer. */
  skipQuestion?: boolean;
}

const MOD_KEY = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent) ? '⌘' : 'Ctrl';

const TOKEN = /(^|[\s(（])@([\p{L}\p{N}_-]*)$/u;

export function Composer({
  sources,
  followUpChoice,
  selectedName,
  onChooseFollowUp,
  autoFocus,
  agents,
  running,
  commandRunning = false,
  held = false,
  canContinue,
  locked = false,
  reviewing = false,
  steering = false,
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
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [notice, setNotice] = useState('');
  const { addFiles, removeFile, onPaste, dragging, dropZone } = useMessageFiles(files, setFiles, setNotice);
  const [preparing, setPreparing] = useState(false);
  // A ref, not just state: a quick double Enter / click arrives before React re-renders.
  const sendingRef = useRef(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const textRef = useRef(text);
  textRef.current = text;

  const explicitMention =
    (followUpChoice || sources.length) &&
    addressedFollowUp(
      text,
      agents.map((a) => a.name),
    );
  const inferred = !explicitMention && !followUpChoice && !files.length ? inferFollowUp(text, sources) : undefined;
  const recipient = explicitMention ? undefined : (followUpChoice?.id ?? inferred?.id);
  const recipientName = followUpChoice ? selectedName : inferred?.agent.name;
  useEffect(() => {
    if (followUpChoice) ref.current?.focus();
  }, [followUpChoice]);

  // A withdrawn message (or a lead review's next step) comes in, ahead of anything typed since.
  useEffect(() => {
    if (!restore) return;
    setText((cur) => restoredText(cur, restore));
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
  // A dropped folder still being read is sent once it is: Send waits for it.
  const canSend = (text.trim().length > 0 || files.length > 0) && !preparing && !files.some((f) => f.reading) && !held;

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
        attachments = await readUploads(files, t.composer.readFailed);
      } catch {
        setNotice(t.composer.readFailed);
        return;
      }
      const ok = await onSend(trimmed, attachments, interrupt && running && !locked, explicitMention ? undefined : followUpChoice?.id);
      if (ok) {
        setText('');
        setCaret(0);
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
    ? locked
      ? c.hintConfirmTouch
      : reviewing
        ? c.hintReviewTouch
        : running
          ? steering
            ? c.hintSteerTouch
            : c.hintBusyTouch
          : c.hintTouch
    : locked
      ? c.hintConfirm
      : reviewing
        ? c.hintReview
        : running
          ? steering
            ? c.hintSteer(MOD_KEY)
            : c.hintBusy(MOD_KEY)
          : c.hint;

  return (
    <div className="composer-wrap" {...dropZone}>
      {recipient && (
        <div className="follow-up-route">
          <span role="status">{recipient === 'team' ? t.composer.teamRoute : t.composer.memberRoute(recipientName ?? '?')}</span>
          <button type="button" className="ghost small-button" onClick={() => onChooseFollowUp(recipient === 'team' ? undefined : 'team')}>
            {recipient === 'team' ? t.composer.autoRoute : t.composer.askTeam}
          </button>
        </div>
      )}
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
        <AttachmentTray files={files} removeFile={removeFile} />
        <div className="composer-row">
          <AttachmentPicker addFiles={addFiles} onNotice={setNotice} />
          <textarea
            autoFocus={autoFocus}
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
            {running || commandRunning ? (
              <button className="stop" onClick={onStop} aria-label={t.composer.stopLabel}>
                {t.composer.stop}
              </button>
            ) : (
              canContinue &&
              !locked &&
              !held && (
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
              // While the team replies it adds to the discussion; during a review it sends now (stopping it).
              aria-label={running && !locked && !reviewing ? t.composer.queueLabel : t.composer.sendLabel}
              title={running && !locked && !reviewing ? t.composer.queueLabel : undefined}
            >
              ↑
            </button>
          </div>
        </div>
      </div>
      {/* Held: why nothing can be sent stays in sight once something is typed (the placeholder is gone then), also on a phone. */}
      <p className={`composer-hint muted small${held ? ' held' : ''}`}>{held ? placeholder : hint}</p>
    </div>
  );
}
