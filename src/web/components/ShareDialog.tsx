import { useRef, useState } from 'react';
import type { Conversation, GH_MISSING, GH_SIGNED_OUT, SharedPage } from '../../shared/types';
import { api } from '../api';
import { conversationMarkdown, speaker } from '../copy';
import { useI18n } from '../i18n';
import { settingsHref } from '../route';
import { ghProblem, messagesUpTo, stillStreaming } from '../share';
import { ShareTooLargeError, sharePage } from '../sharePage';
import { CopyButton } from './CopyButton';
import { GhHelp } from './GhHelp';
import { CopyIcon, ShareIcon } from './icons';
import { useDialog } from './useDialog';

interface Props {
  conv: Conversation;
  /** Up to and including this agent reply; the whole conversation without it. */
  upTo?: string;
  /** ChatView's root element: the page is made from the chat on screen. */
  chat: () => HTMLElement | null;
  onClose: () => void;
}

type Phase = 'idle' | 'preparing' | 'uploading' | 'done';

/**
 * Share the conversation, or the part of it up to one reply, without tool calls and thinking: copy it
 * as Markdown, or put it on the web as a page that looks like the chat (a secret gist, on gistpreview).
 */
export function ShareDialog({ conv, upTo, chat, onClose }: Props) {
  const { t, lang } = useI18n();
  const dialog = useRef<HTMLDivElement>(null);
  useDialog(dialog, onClose);
  const [phase, setPhase] = useState<Phase>('idle');
  const [link, setLink] = useState<SharedPage>();
  const [notes, setNotes] = useState<string[]>([]);
  const [error, setError] = useState('');
  /** The GitHub CLI is missing or not signed in: what to do about it is shown instead of the error. */
  const [gh, setGh] = useState<typeof GH_MISSING | typeof GH_SIGNED_OUT>();

  // Who wrote the reply it is up to, as when the dialog opened: still named once that reply is gone.
  const [name] = useState(() => {
    const reply = upTo ? conv.messages.find((m) => m.id === upTo) : undefined;
    return reply ? speaker(reply, conv.agents).name : undefined;
  });
  const title = name ? t.share.titleUpTo(name) : t.share.title;
  // Undefined once the reply it is up to is gone (retried or edited away).
  const range = messagesUpTo(conv.messages, upTo);
  const streaming = range !== undefined && stillStreaming(range);
  const markdown = () => (range ? conversationMarkdown({ ...conv, messages: range }, t) : '');

  const create = async () => {
    const el = chat();
    if (!el) return;
    setError('');
    setGh(undefined);
    setNotes([]);
    setPhase('preparing');
    try {
      const page = await sharePage({ chat: el, messages: conv.messages, title: conv.title, upTo, t, lang });
      const said: string[] = [];
      if (page.shrunk) said.push(t.share.shrunk);
      if (page.dropped > 0) said.push(t.share.dropped(page.dropped));
      setNotes(said);
      setPhase('uploading');
      setLink(await api.share(conv.id, page.html, upTo));
      setPhase('done');
    } catch (e) {
      const problem = ghProblem(e);
      if (problem) setGh(problem);
      else setError(e instanceof ShareTooLargeError ? t.share.tooLarge((e.bytes / 1_000_000).toFixed(1)) : (e as Error).message);
      setPhase('idle');
    }
  };

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div
        ref={dialog}
        className="modal share-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="drawer-head">
          <h2>{title}</h2>
          <button className="icon-button" onClick={onClose} aria-label={t.common.close}>
            ×
          </button>
        </header>
        {range && <p className="muted small share-scope">{name ? t.share.scopeUpTo(name) : t.share.scopeAll}</p>}

        <section className="share-option">
          <div className="share-option-text">
            <strong>{t.share.copyHeading}</strong>
            <span className="muted small">{t.share.copyHint}</span>
          </div>
          <CopyButton
            className="ghost small-button share-action"
            label={t.share.copy}
            icon={<CopyIcon size={15} />}
            text={markdown}
            disabled={!range}
          />
        </section>

        <section className="share-option">
          <div className="share-option-text">
            <strong>{t.share.linkHeading}</strong>
            <span className="muted small">{t.share.linkHint}</span>
          </div>
          {phase !== 'done' && (
            <button
              type="button"
              className="primary small-button share-action"
              disabled={phase !== 'idle' || !range || streaming}
              onClick={create}
            >
              <ShareIcon size={15} />
              <span>{phase === 'preparing' ? t.share.preparing : phase === 'uploading' ? t.share.uploading : t.share.create}</span>
            </button>
          )}
        </section>

        {link && (
          <div className="share-result">
            <div className="share-link-row">
              <input readOnly value={link.url} aria-label={t.share.linkHeading} onFocus={(e) => e.currentTarget.select()} />
              <CopyButton className="ghost small-button share-action" label={t.share.copyLink} icon={<CopyIcon size={15} />} text={() => link.url} />
              <a className="ghost small-button share-action" href={link.url} target="_blank" rel="noreferrer">
                {t.share.open}
              </a>
            </div>
            <p className="muted small">
              <a href={link.gistUrl} target="_blank" rel="noreferrer">
                {t.share.viewGist}
              </a>
              {' · '}
              <a href={settingsHref('shares')}>{t.share.manage}</a>
            </p>
          </div>
        )}
        {notes.map((n) => (
          <p key={n} className="muted small">
            {n}
          </p>
        ))}
        {!range && (
          <p className="error-line" role="alert">
            {t.share.gone}
          </p>
        )}
        {streaming && phase === 'idle' && !link && <p className="muted small">{t.share.streaming}</p>}
        {gh && <GhHelp problem={gh} retry={t.share.gh.retryLink} />}
        {error && (
          <p className="error-line" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
