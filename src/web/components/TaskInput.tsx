import { useRef, useState } from 'react';
import { insertTranscript } from '../voice';
import { AttachmentPicker, AttachmentTray, useMessageFiles, type PendingFile, type SavedFiles } from './MessageFiles';
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
  placeholder?: string;
  maxLength?: number;
}

/** The required question for a new chat or the message an automation will send. */
export function TaskInput({ id, text, onText, files, onFiles, saved, disabled, creation, ...textarea }: Props) {
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
        <VoiceButton fixedButton={creation} onError={setNotice} onText={insertVoice} />
      </div>
      {creation && tray}
      {notice && (
        <p role="alert" className="error-line">
          {notice}
        </p>
      )}
    </fieldset>
  );
}
