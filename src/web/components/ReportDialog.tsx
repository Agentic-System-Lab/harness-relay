import { useEffect, useMemo, useReducer, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { createPortal } from 'react-dom';
import { REPORT_SCREENSHOT_EXTENSIONS, REPORT_SCREENSHOT_LIMITS, type AboutInfo, type ProviderStatus } from '../../shared/types';
import { ApiError, api } from '../api';
import { copyText } from '../copy';
import { useI18n } from '../i18n';
import {
  EMPTY_REPORT,
  GMAIL_MAX,
  MAILTO_MAX,
  REPORT_DESCRIPTION_MAX,
  REPORT_EMAIL,
  REPORT_KINDS,
  REPORT_SUBJECT_MAX,
  fitLink,
  gmailUrl,
  infoLines,
  mailtoUrl,
  reportBody,
  reportReady,
  reportState,
  reportSubject,
  reportText,
  countsAsSent,
  screenshotProblem,
  ShotUploads,
  type MailLink,
  type ReportDraft,
  type Sent,
} from '../report';
import { isAppWindow } from '../update';
import { formatBytes, toBase64 } from '../util';
import { CopyButton } from './CopyButton';
import { CopyIcon, MailIcon } from './icons';
import { useDialog } from './useDialog';

/** A screenshot added to the report: the image, and its preview. */
interface Shot {
  id: string;
  file: File;
  url: string;
}

/**
 * What was typed and added, kept while the page is open, so closing the dialog by mistake loses
 * nothing; and the screenshots' upload, which goes on when the dialog closes (src/web/report.ts).
 * Forgotten once the report was sent and the dialog closed (an upload stays on GitHub: the mail links
 * to it).
 */
let kept: ReportDraft = EMPTY_REPORT;
let keptShots: Shot[] = [];
const uploads = new ShotUploads({
  upload: (images) => api.uploadScreenshots(images),
  remove: (id) => api.removeScreenshots(id),
  // Not known to the server (it restarted): its message says to delete the gist on GitHub.
  gone: (err) => err instanceof ApiError && err.status === 404,
});

function forget() {
  keptShots.forEach((s) => URL.revokeObjectURL(s.url));
  kept = EMPTY_REPORT;
  keptShots = [];
  uploads.forget();
}


interface Props {
  /** Each CLI's status, as the sidebar has it: their versions go along with the report. */
  providers: ProviderStatus[];
  onClose: () => void;
}

/**
 * Report a problem or an idea by email: the user's mail app (or Gmail) opens with the mail filled in,
 * for them to send. Screenshots, which a mail link cannot carry, go up to GitHub as a secret gist when
 * the user uploads them, and the mail links to it. Rendered on the page's body, as the sidebar it is
 * opened from is moved on a phone (a transform), which would carry a fixed dialog with it.
 */
export function ReportDialog({ providers, onClose }: Props) {
  const { t, lang } = useI18n();
  const r = t.report;
  const dialog = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(kept);
  const [shots, setShots] = useState(keptShots);
  // The upload, and what goes on (uploading, removing), as `uploads` has them.
  const [, uploadsChanged] = useReducer((n: number) => n + 1, 0);
  useEffect(() => uploads.subscribe(uploadsChanged), []);
  const upload = uploads.done;
  const busy = uploads.busy;
  /** Why images could not be added. */
  const [notice, setNotice] = useState('');
  /** Why the upload, or removing it, failed. */
  const [failure, setFailure] = useState('');
  /** undefined while it loads; null when it could not be loaded (the report goes without it). */
  const [about, setAbout] = useState<AboutInfo | null>();
  const [sent, setSent] = useState<Sent>();

  const close = () => {
    if (countsAsSent(sent)) forget();
    onClose();
  };
  /** Whether the dialog is still open, for what an upload says once it is done (set on each mount: StrictMode mounts twice). */
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  useDialog(dialog, close);
  useEffect(() => {
    kept = draft;
    keptShots = shots;
  }, [draft, shots]);
  useEffect(() => {
    let live = true;
    api.about().then(
      (a) => live && setAbout(a),
      () => live && setAbout(null),
    );
    return () => {
      live = false;
    };
  }, []);

  const update = (patch: Partial<ReportDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const info = useMemo(
    () => infoLines({ about, providers, userAgent: navigator.userAgent, lang }, t),
    [about, providers, lang, t],
  );
  const { editable, waiting, ready } = reportState({ draft, shots: shots.length, uploaded: !!upload, busy: !!busy, aboutKnown: about !== undefined });
  const subject = reportSubject(draft, t);
  const body = reportBody(draft, info, t, upload?.url);
  const whole = () => reportText(REPORT_EMAIL, subject, body, t);

  const addShots = (files: File[]) => {
    if (!editable || !files.length) return;
    let problem = '';
    const added: Shot[] = [];
    for (const file of files) {
      const why = screenshotProblem(file, shots.length + added.length);
      if (why === 'tooMany') {
        problem = r.shots.tooMany(REPORT_SCREENSHOT_LIMITS.maxFiles);
        break;
      }
      if (why === 'notImage') problem = r.shots.notImage(file.name);
      else if (why === 'tooLarge') problem = r.shots.tooLarge(file.name, formatBytes(REPORT_SCREENSHOT_LIMITS.maxBytes));
      else added.push({ id: crypto.randomUUID(), file, url: URL.createObjectURL(file) });
    }
    setNotice(problem);
    setFailure('');
    setShots((prev) => [...prev, ...added]);
  };

  const removeShot = (id: string) => {
    const gone = shots.find((s) => s.id === id);
    if (gone) URL.revokeObjectURL(gone.url);
    setShots((prev) => prev.filter((s) => s.id !== id));
    setNotice('');
    setFailure('');
  };

  /** Says why it failed while the dialog is open. */
  const failed = (err: unknown) => {
    if (live.current) setFailure((err as Error).message);
  };
  // Opened again while the screenshots go up: says how that upload went.
  useEffect(() => {
    uploads.pending?.catch(failed);
  }, []);

  const uploadShots = () => {
    setNotice('');
    setFailure('');
    uploads.upload(() => Promise.all(shots.map((s) => toBase64(s.file)))).catch(failed);
  };

  const removeUpload = () => {
    setFailure('');
    uploads.remove().catch(failed);
  };

  // Images pasted anywhere in the dialog, or dropped on it, become screenshots.
  const onPaste = (e: ClipboardEvent) => {
    const images = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'));
    if (!images.length) return;
    if (!e.clipboardData.getData('text/plain')) e.preventDefault();
    addShots(images);
  };
  const onDragOver = (e: DragEvent) => {
    if (e.dataTransfer.types.includes('Files')) e.preventDefault();
  };
  const onDrop = (e: DragEvent) => {
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    addShots([...e.dataTransfer.files]);
  };

  /**
   * Opens `link`; a report too long for it goes on the clipboard, for the user to paste (started first,
   * and the link opened at once after, both while the click still counts as the user's). In the desktop
   * app's window, a mail link goes through its window handler (to the mail app); a page cannot move to it.
   */
  const open = async (link: MailLink, how: 'mail' | 'gmail') => {
    const copied = link.cut ? copyText(whole()) : undefined;
    if (how === 'gmail' || isAppWindow(navigator.userAgent)) window.open(link.url, '_blank', 'noopener,noreferrer');
    else window.location.href = link.url;
    const went: Sent = copied ? ((await copied) ? 'cut' : 'cutCopyFailed') : how;
    // The mail links to the upload done now, if any (it stays on GitHub): not when it holds no report.
    if (countsAsSent(went)) uploads.sent();
    setSent(went);
  };
  const sendMail = () => open(fitLink((s, b) => mailtoUrl(REPORT_EMAIL, s, b), subject, body, r.mail.pasteHere, MAILTO_MAX), 'mail');
  const sendGmail = () => open(fitLink((s, b) => gmailUrl(REPORT_EMAIL, s, b), subject, body, r.mail.pasteHere, GMAIL_MAX), 'gmail');

  return createPortal(
    <div className="modal-scrim" onClick={close}>
      <div
        ref={dialog}
        className="modal report-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={r.title}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onPaste={onPaste}
        onDragOver={onDragOver}
        onDrop={onDrop}
      >
        <header className="drawer-head">
          <h2>{r.title}</h2>
          <button type="button" className="icon-button" onClick={close} aria-label={t.common.close}>
            ×
          </button>
        </header>
        <p className="muted small">{r.intro}</p>

        <div className="field">
          <span>{r.kind}</span>
          <div className="segmented" role="group" aria-label={r.kind}>
            {REPORT_KINDS.map((k) => (
              <button key={k} type="button" className={draft.kind === k ? 'on' : ''} aria-pressed={draft.kind === k} onClick={() => update({ kind: k })}>
                {r.kinds[k]}
              </button>
            ))}
          </div>
        </div>
        <label className="field">
          <span>{r.subject}</span>
          <input
            value={draft.subject}
            maxLength={REPORT_SUBJECT_MAX}
            placeholder={r.subjectPlaceholder}
            onChange={(e) => update({ subject: e.target.value })}
          />
        </label>
        <label className="field">
          <span>{r.description}</span>
          <textarea
            value={draft.description}
            rows={7}
            maxLength={REPORT_DESCRIPTION_MAX}
            placeholder={r.placeholder[draft.kind]}
            onChange={(e) => update({ description: e.target.value })}
          />
        </label>

        <div className="field report-shots">
          <span>{r.shots.label}</span>
          {shots.length > 0 && (
            <ul className="attach-tray" aria-label={r.shots.label}>
              {shots.map((s, i) => (
                <li key={s.id} className="attach-thumb" title={s.file.name}>
                  <img src={s.url} alt={r.shots.alt(i + 1)} />
                  {editable && (
                    <button type="button" className="attach-remove" onClick={() => removeShot(s.id)} aria-label={r.shots.remove(i + 1)}>
                      ×
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          <p className="muted small">{r.shots.hint(REPORT_SCREENSHOT_LIMITS.maxFiles)}</p>
          <div className="report-shots-actions">
            {editable && shots.length < REPORT_SCREENSHOT_LIMITS.maxFiles && (
              <button type="button" className="ghost small-button" onClick={() => picker.current?.click()}>
                {r.shots.add}
              </button>
            )}
            {waiting && (
              <button type="button" className="ghost small-button" disabled={!!busy} onClick={uploadShots}>
                {busy === 'upload' ? r.shots.uploading : r.shots.upload}
              </button>
            )}
            {upload && (
              <>
                <span className="small report-sent">{r.shots.uploaded}</span>
                <a className="small" href={upload.url} target="_blank" rel="noopener noreferrer">
                  {r.shots.view}
                </a>
                <button type="button" className="ghost small-button" disabled={!!busy} onClick={removeUpload}>
                  {busy === 'remove' ? r.shots.removing : r.shots.removeUpload}
                </button>
              </>
            )}
          </div>
          <input
            ref={picker}
            type="file"
            // Endings only: image/jpeg would have the system list .jfif, .jpe and the like too.
            accept={REPORT_SCREENSHOT_EXTENSIONS.join(',')}
            multiple
            hidden
            onChange={(e) => {
              addShots([...(e.target.files ?? [])]);
              e.target.value = '';
            }}
          />
          {notice && (
            <p className="small warn-text" role="status">
              {notice}
            </p>
          )}
          {failure && (
            <p className="small warn-text" role="alert">
              {failure} {waiting && r.shots.fallback}
            </p>
          )}
        </div>

        <details className="report-info">
          <summary className="muted small">{r.infoSummary}</summary>
          <p className="muted small">{r.infoHint}</p>
          <pre className="report-info-lines">{about === undefined ? `${r.infoLoading}\n${info.join('\n')}` : info.join('\n')}</pre>
        </details>

        <p className="muted small">{r.hint}</p>
        {waiting && reportReady(draft) && <p className="small warn-text">{r.shots.uploadFirst}</p>}
        {sent && (
          <p className={sent === 'cutCopyFailed' ? 'small warn-text' : 'small report-sent'} role="status">
            {upload && (sent === 'mail' || sent === 'gmail' || sent === 'copied') ? r.sentLinked[sent] : r.sent[sent]}
          </p>
        )}

        <footer className="report-foot">
          <div className="report-alt">
            <span className="muted small">{r.noMailApp}</span>
            <button type="button" className="ghost small-button" disabled={!ready} onClick={sendGmail}>
              {r.gmail}
            </button>
            <CopyButton
              className="ghost small-button report-copy"
              label={r.copy}
              icon={<CopyIcon size={14} />}
              text={whole}
              // Copied to send by hand, it counts as sent: the mail links to the upload done now, which then
              // stays on GitHub, and the report is forgotten once the dialog closes. Not when copying failed.
              onDone={(copied) => {
                if (!copied) return;
                uploads.sent();
                setSent('copied');
              }}
              disabled={!ready}
            />
          </div>
          <button type="button" className="primary report-send" disabled={!ready} onClick={sendMail}>
            <MailIcon size={16} />
            <span>{r.send}</span>
          </button>
        </footer>
        <p className="muted small report-to">
          {r.sendTo}
          <span className="report-address">{REPORT_EMAIL}</span>
        </p>
      </div>
    </div>,
    document.body,
  );
}
