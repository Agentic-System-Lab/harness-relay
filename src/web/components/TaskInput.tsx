import { useEffect, useId, useRef, useState } from 'react';
import { DRAFT_APPS } from '../../shared/apps';
import { draftAppName, requestedApps, type DraftAppSelection } from '../draftApps';
import { useT } from '../i18n';
import { settingsHref } from '../route';
import { insertTranscript } from '../voice';
import { AttachmentPicker, AttachmentTray, useMessageFiles, type PendingFile, type SavedFiles } from './MessageFiles';
import { AppsIcon } from './icons';
import { VoiceButton } from './VoiceInput';

interface Props {
  id: string;
  text: string;
  onText: (text: string) => void;
  files: PendingFile[];
  onFiles: (files: PendingFile[]) => void;
  saved?: SavedFiles;
  disabled?: boolean;
  creation?: boolean;
  apps?: DraftAppSelection;
  placeholder?: string;
  maxLength?: number;
}

/** The required question for a new chat or the message an automation will send. */
export function TaskInput({ id, text, onText, files, onFiles, saved, disabled, creation, apps, ...textarea }: Props) {
  const t = useT();
  const choicesId = useId();
  const choices = useRef<HTMLFieldSetElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const [choosingApps, setChoosingApps] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const [notice, setNotice] = useState('');
  const { addFiles, removeFile, onPaste, dragging, dropZone } = useMessageFiles(files, onFiles, setNotice, saved?.files.length);
  const insertVoice = (piece: string) => {
    const field = ref.current;
    if (!field || disabled) return;
    const next = insertTranscript(field.value, field.selectionStart, field.selectionEnd, piece);
    onText(next.text);
    setNotice('');
    const previousFocus = document.activeElement;
    requestAnimationFrame(() => {
      // A user who moved on to the next field while the transcript was rendering keeps that field.
      if (
        document.activeElement === previousFocus &&
        (previousFocus === field || previousFocus === document.body || previousFocus?.closest('.mic-button'))
      )
        field.focus();
      field.setSelectionRange(next.caret, next.caret);
    });
  };
  const checkingApps = apps && DRAFT_APPS.some((app) => !apps.states[app] && !apps.failed.includes(app));
  const focusChoices = () => {
    const group = choices.current;
    const destination =
      group?.querySelector<HTMLElement>('input:enabled') ??
      (group?.dataset.checking !== 'true' ? group?.querySelector<HTMLElement>('button:enabled, a') : group);
    destination?.focus();
  };
  useEffect(() => {
    if (choosingApps && choices.current === document.activeElement) {
      const group = choices.current;
      const target =
        group?.querySelector<HTMLElement>('input:enabled') ??
        (!checkingApps ? group?.querySelector<HTMLElement>('button:enabled, a') : null);
      target?.focus();
    }
  }, [choosingApps, apps?.states, checkingApps]);
  const tray = <AttachmentTray files={files} removeFile={removeFile} saved={saved} />;
  return (
    <fieldset disabled={disabled} className={dragging ? 'first-input dragging' : 'first-input'} {...(disabled ? {} : dropZone)}>
      <textarea
        {...textarea}
        className={creation ? 'task-input' : undefined}
        id={id}
        ref={ref}
        required
        rows={4}
        value={text}
        onChange={(e) => onText(e.target.value)}
        onPaste={onPaste}
      />
      {!creation && tray}
      <div className="first-input-tools">
        <AttachmentPicker addFiles={addFiles} />
        {apps && (
          <button
            type="button"
            ref={toggle}
            className="ghost small-button draft-app-toggle"
            aria-expanded={choosingApps}
            aria-controls={choicesId}
            onClick={(event) => {
              if (!choosingApps) apps.open();
              setChoosingApps(!choosingApps);
              if (!choosingApps && event.detail === 0) {
                requestAnimationFrame(focusChoices);
              }
            }}
          >
            <AppsIcon size={15} />
            {t.apps.title}
            {apps.selected.length > 0 && <span>({apps.selected.length})</span>}
          </button>
        )}
        <VoiceButton fixedButton={creation} onError={setNotice} onText={insertVoice} />
      </div>
      {apps && (
        <>
          <fieldset
            className="draft-app-choices"
            id={choicesId}
            hidden={!choosingApps}
            aria-label={t.apps.title}
            data-checking={Boolean(checkingApps)}
            ref={choices}
            tabIndex={-1}
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return;
              event.stopPropagation();
              setChoosingApps(false);
              toggle.current?.focus();
            }}
          >
            <p className="small muted">{t.apps.draftHint}</p>
            <div className="draft-app-list">
              {DRAFT_APPS.map((app) => {
                const state = apps.states[app];
                const name = draftAppName(app, t);
                const reason = apps.failed.includes(app)
                  ? t.apps.draftUnknown
                  : state && state !== 'ready'
                    ? t.apps.draftStates[state]
                    : undefined;
                return (
                  <div key={app}>
                    <label>
                      <input
                        type="checkbox"
                        disabled={state !== 'ready'}
                        id={choicesId + '-choice-' + app}
                        aria-label={name}
                        aria-describedby={reason ? choicesId + '-' + app : undefined}
                        checked={apps.selected.includes(app)}
                        onChange={(e) => {
                          if (state === 'ready')
                            apps.onChange(e.target.checked ? [...apps.selected, app] : apps.selected.filter((item) => item !== app));
                        }}
                      />
                      <span>
                        {name}
                        {reason && <small id={choicesId + '-' + app}>{reason}</small>}
                      </span>
                    </label>
                    {app === 'slack' && state === 'needs-verification' && (
                      <div className="draft-slack-verify">
                        <small id={choicesId + '-slack-check'}>{t.apps.draftSlackProfile}</small>
                        <button
                          type="button"
                          className="link-button"
                          aria-describedby={choicesId + '-slack-check'}
                          onClick={async (event) => {
                            const keyboard = event.detail === 0;
                            if (!(await apps.verifySlack()) || !keyboard) return;
                            requestAnimationFrame(() => {
                              if (document.activeElement === document.body && choices.current && !choices.current.hidden) {
                                document.getElementById(choicesId + '-choice-slack')?.focus();
                              }
                            });
                          }}
                        >
                          {t.apps.draftVerifySlack}
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <a href={settingsHref('apps')}>{t.apps.manageConnections}</a>
          </fieldset>
          {(choosingApps || apps.selected.length > 0) && (checkingApps || apps.failed.length > 0) && (
            <div className="draft-app-status">
              <span className="small muted" role="status">
                {apps.failed.length ? t.apps.draftCheckFailed : t.apps.draftChecking}
              </span>
              {apps.failed.length > 0 && (
                <button type="button" className="ghost small-button" onClick={apps.retry}>
                  {t.apps.draftRetry}
                </button>
              )}
              {apps.failed.length > 0 && apps.selected.length > 0 && (
                <button type="button" className="ghost small-button" onClick={() => apps.onChange([])}>
                  {t.apps.clearDraftApps}
                </button>
              )}
            </div>
          )}
          {apps.removed.length > 0 && (
            <p className="small warn-text" role="status">
              {t.apps.draftRemoved(apps.removed.map((app) => draftAppName(app, t)))}
            </p>
          )}
          {apps.selected.length > 0 && <p className="small draft-app-selection">{requestedApps(apps.selected, t)}</p>}
        </>
      )}
      {creation && tray}
      {notice && (
        <p role="alert" className="error-line">
          {notice}
        </p>
      )}
    </fieldset>
  );
}
