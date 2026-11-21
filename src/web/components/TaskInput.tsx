import { useId, useRef, useState } from 'react';
import { DRAFT_APPS, draftAppName, requestedApps, type DraftAppSelection } from '../draftApps';
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
    requestAnimationFrame(() => {
      field.focus();
      field.setSelectionRange(next.caret, next.caret);
    });
  };
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
              setChoosingApps(!choosingApps);
              if (!choosingApps && event.detail === 0) {
                requestAnimationFrame(() => choices.current?.querySelector('input')?.focus());
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
            ref={choices}
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return;
              event.stopPropagation();
              setChoosingApps(false);
              toggle.current?.focus();
            }}
          >
            <p className="small muted">{t.apps.draftHint}</p>
            <div className="draft-app-list">
              {DRAFT_APPS.map((app) => (
                <label key={app}>
                  <input
                    type="checkbox"
                    checked={apps.selected.includes(app)}
                    onChange={(e) =>
                      apps.onChange(e.target.checked ? [...apps.selected, app] : apps.selected.filter((item) => item !== app))
                    }
                  />
                  {draftAppName(app, t)}
                </label>
              ))}
            </div>
            <a href={settingsHref('apps')}>{t.apps.manageConnections}</a>
          </fieldset>
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
