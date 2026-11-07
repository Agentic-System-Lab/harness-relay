import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { PROVIDER_LABEL, type AgentConfig } from '../../shared/types';
import { useT } from '../i18n';
import { PROVIDER_COLOR, initials } from '../util';

interface Props {
  agents: AgentConfig[];
  running: boolean;
  canContinue: boolean;
  placeholder: string;
  onSend: (text: string) => Promise<boolean>;
  onStop: () => void;
  onContinue: () => void;
}

const TOKEN = /(^|[\s(（])@([\p{L}\p{N}_-]*)$/u;

export function Composer({ agents, running, canContinue, placeholder, onSend, onStop, onContinue }: Props) {
  const t = useT();
  const [text, setText] = useState('');
  const [caret, setCaret] = useState(0);
  const [pick, setPick] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  // Auto-grow the textarea.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 260)}px`;
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

  const submit = async () => {
    const trimmed = text.trim();
    if (!trimmed || running) return;
    if (await onSend(trimmed)) {
      setText('');
      setCaret(0);
    }
  };

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
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <div className="composer-wrap">
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
      <div className="composer">
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
        />
        <div className="composer-actions">
          {running ? (
            <button className="stop" onClick={onStop} aria-label={t.composer.stopLabel}>
              {t.composer.stop}
            </button>
          ) : (
            <>
              {canContinue && (
                <button className="ghost" onClick={onContinue} title={t.composer.continueTitle}>
                  {t.composer.continue}
                </button>
              )}
              <button className="send" onClick={submit} disabled={!text.trim()} aria-label={t.composer.sendLabel}>
                ↑
              </button>
            </>
          )}
        </div>
      </div>
      <p className="composer-hint muted small">{t.composer.hint}</p>
    </div>
  );
}
