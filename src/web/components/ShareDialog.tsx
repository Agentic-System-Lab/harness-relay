import { useEffect, useRef, useState } from 'react';
import {
  SHARE_FILES_MAX,
  SHARE_FILES_MAX_BYTES,
  SHARE_FILE_MAX_BYTES,
  SHARE_FILE_REFUSED,
  type Conversation,
  type GH_MISSING,
  type GH_SIGNED_OUT,
  type ShareFileInfo,
  type ShareFileRef,
  type SharedPage,
} from '../../shared/types';
import { ApiError, api } from '../api';
import { conversationMarkdown, speaker } from '../copy';
import { useI18n } from '../i18n';
import { settingsHref } from '../route';
import { shareSize } from '../../shared/share';
import { chosenFileRefs, fileSelection, ghProblem, looksSecret, messagesUpTo, nextFileSelection, stillStreaming } from '../share';
import { ShareTooLargeError, linkedFiles, sharePage } from '../sharePage';
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

/** The same links, in the same order. */
const sameRefs = (a: ShareFileRef[], b: ShareFileRef[]) =>
  a.length === b.length && a.every((r, i) => r.messageId === b[i]!.messageId && r.path === b[i]!.path);

/**
 * The files the shared messages link to, as the server found them (`refs`: the links asked about), and
 * which are chosen. `checking`: they are being checked again (the list stays until the answer comes).
 */
interface LinkedFiles {
  refs: ShareFileRef[];
  list: ShareFileInfo[];
  chosen: boolean[];
  /** They could not be checked: none goes along. */
  error?: string;
  checking?: boolean;
}

const NO_FILES: LinkedFiles = { refs: [], list: [], chosen: [] };

/**
 * Share the conversation, or the part of it up to one reply, without tool calls and thinking: copy it
 * as Markdown, or put it on the web as a page that looks like the chat (a secret gist, on gistpreview).
 * The text files its replies link to can go along, in a second secret gist, for anyone with the link to download.
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

  // The files the shared replies link to, checked again when those replies change (or after a share
  // was refused for one), the user's choices kept: null until they are first checked.
  const [files, setFiles] = useState<LinkedFiles | null>(() => {
    // Nothing to check when no reply links a file: say nothing about files, not even for a moment.
    const el = chat();
    return el && range && linkedFiles({ chat: el, messages: conv.messages, upTo, convId: conv.id }).length ? null : NO_FILES;
  });
  const [recheck, setRecheck] = useState(0);
  /** The links last asked about (and for which recheck), and the latest request: only its answer counts. */
  const asked = useRef<{ refs: ShareFileRef[]; recheck: number } | undefined>(undefined);
  const request = useRef(0);
  const last = range?.[range.length - 1];
  useEffect(() => {
    if (!range || streaming) return;
    const el = chat();
    const refs = el ? linkedFiles({ chat: el, messages: conv.messages, upTo, convId: conv.id }) : [];
    // The same links as before: what the user chose stays.
    if (asked.current && asked.current.recheck === recheck && sameRefs(asked.current.refs, refs)) return;
    asked.current = { refs, recheck };
    const n = ++request.current;
    if (!refs.length) {
      setFiles(NO_FILES);
      return;
    }
    setFiles((f) => f && { ...f, checking: true });
    api.shareFiles(conv.id, refs, upTo).then(
      (r) => {
        if (n !== request.current) return;
        // A file seen before keeps what the user chose for it.
        setFiles((f) => ({ refs, list: r.files, chosen: nextFileSelection(r.files, f && !f.error ? f : undefined) }));
      },
      (e: Error) => {
        if (n !== request.current) return;
        setFiles({ ...NO_FILES, error: e.message });
      },
    );
    // The replies it holds, as they are now: a new or rewritten one (or a finished stream) may link others.
  }, [conv.id, upTo, range?.length, last?.id, last?.status, streaming, recheck]);
  const selection = files ? fileSelection(files.list, files.chosen) : { count: 0, bytes: 0 };
  const toggle = (i: number) => setFiles((f) => f && { ...f, chosen: f.chosen.map((v, j) => (j === i ? !v : v)) });

  // One at a time: a click, and the gh sign-in's own retry (`GhHelp`), may come together.
  const creating = useRef(false);
  const canCreate = phase === 'idle' && Boolean(range) && !streaming && Boolean(files) && !files?.checking && selection.over === undefined;
  const create = async () => {
    const el = chat();
    if (!el || creating.current) return;
    creating.current = true;
    setError('');
    setGh(undefined);
    setNotes([]);
    setPhase('preparing');
    try {
      const take = files && !files.error ? chosenFileRefs(files.refs, files.list, files.chosen) : [];
      const page = await sharePage({ chat: el, messages: conv.messages, title: conv.title, upTo, t, lang, convId: conv.id, files: take });
      const said: string[] = [];
      if (page.shrunk) said.push(t.share.shrunk);
      if (page.dropped > 0) said.push(t.share.dropped(page.dropped));
      setNotes(said);
      setPhase('uploading');
      const shared = await api.share(conv.id, page.html, upTo, take);
      if (shared.files) setNotes([...said, t.share.files.included(shared.files)]);
      setLink(shared);
      setPhase('done');
    } catch (e) {
      const problem = ghProblem(e);
      if (problem) setGh(problem);
      else setError(e instanceof ShareTooLargeError ? t.share.tooLarge((e.bytes / 1_000_000).toFixed(1)) : (e as Error).message);
      // A file changed since it was checked: check them all again.
      if (e instanceof ApiError && e.code === SHARE_FILE_REFUSED) setRecheck((n) => n + 1);
      setPhase('idle');
    } finally {
      creating.current = false;
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
              disabled={!canCreate}
              onClick={create}
            >
              <ShareIcon size={15} />
              <span>{phase === 'preparing' ? t.share.preparing : phase === 'uploading' ? t.share.uploading : t.share.create}</span>
            </button>
          )}
        </section>

        {(files === null ? range && !streaming : files.error || files.list.length > 0 || files.checking) && (
          <section className="share-files" aria-label={t.share.files.heading}>
            <strong>{t.share.files.heading}</strong>
            {files === null || (files.checking && !files.list.length) ? (
              <p className="muted small">{t.share.files.checking}</p>
            ) : files.error ? (
              <p className="error-line">{t.share.files.checkFailed(files.error)}</p>
            ) : (
              <>
                <p className="small share-files-warning">{t.share.files.warning}</p>
                <p className="muted small">
                  {t.share.files.hint(shareSize(SHARE_FILE_MAX_BYTES), shareSize(SHARE_FILES_MAX_BYTES), SHARE_FILES_MAX)}
                </p>
                <ul className="share-file-list">
                  {files.list.map((f, i) => (
                    <li key={`${f.path}\n${f.refs[0]}`} className={`share-file ${f.problem ? 'blocked' : ''}`}>
                      <label className="check-row">
                        <input
                          type="checkbox"
                          checked={!f.problem && Boolean(files.chosen[i])}
                          disabled={Boolean(f.problem) || phase !== 'idle' || Boolean(link) || files.checking}
                          onChange={() => toggle(i)}
                        />
                        <span className="share-file-text">
                          <span className="share-file-name">{f.name}</span>
                          {f.path !== f.name && <span className="muted small share-file-path">{f.path}</span>}
                          {!f.problem && looksSecret(f.name) && <span className="small warn-text">{t.share.files.secret}</span>}
                        </span>
                        <span className={`small share-file-size ${f.problem ? 'warn-text' : 'muted'}`}>
                          {f.problem === 'too-large'
                            ? t.share.files.tooLarge(shareSize(SHARE_FILE_MAX_BYTES))
                            : f.problem
                              ? t.share.files.problem[f.problem]
                              : shareSize(f.size ?? 0)}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
                <p className={selection.over ? 'error-line' : 'muted small'}>
                  {files.checking
                    ? t.share.files.checking
                    : selection.over === 'count'
                    ? t.share.files.overCount(SHARE_FILES_MAX)
                      : selection.over === 'bytes'
                        ? t.share.files.overBytes(shareSize(SHARE_FILES_MAX_BYTES))
                        : selection.count
                          ? t.share.files.chosen(selection.count, shareSize(selection.bytes))
                          : t.share.files.none}
                </p>
              </>
            )}
          </section>
        )}

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
        {gh && <GhHelp problem={gh} retry={t.share.gh.retryLink} onSignedIn={() => canCreate && void create()} />}
        {error && (
          <p className="error-line" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
