import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { ATTACHMENT_LIMITS, isInlineImage, type ConversationSchedule } from '../../shared/types';
import type { AttachmentUpload } from '../api';
import { useT } from '../i18n';
import { formatBytes, toBase64 } from '../util';
import { PaperclipIcon } from './icons';

let nextFileId = 0;

export interface PendingFile {
  id: number;
  file: File;
}

/** Pasted screenshots are all called "image.png"; give them a time-stamped name. */
function pastedName(file: File): string {
  if (file.name && file.name !== 'image.png') return file.name;
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const ext = file.type.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
  return `pasted-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.${ext}`;
}

export async function readUploads(files: PendingFile[], readFailed: string): Promise<AttachmentUpload[]> {
  return Promise.all(
    files.map(async ({ file }) => ({
      name: file.name,
      mimeType: file.type || 'application/octet-stream',
      data: await toBase64(file),
    })),
  ).catch(() => {
    throw new Error(readFailed);
  });
}

export function useMessageFiles(
  files: PendingFile[],
  onFiles: (files: PendingFile[]) => void,
  onNotice: (notice: string) => void,
  savedCount = 0,
) {
  const t = useT();
  const [dragging, setDragging] = useState(false);
  const addFiles = (list: File[]) => {
    if (!list.length) return;
    onNotice('');
    const accepted: PendingFile[] = [];
    for (const file of list) {
      if (savedCount + files.length + accepted.length >= ATTACHMENT_LIMITS.maxFiles) {
        onNotice(t.composer.tooManyFiles(ATTACHMENT_LIMITS.maxFiles));
        break;
      }
      if (file.size > ATTACHMENT_LIMITS.maxBytes) {
        onNotice(t.composer.fileTooLarge(file.name, formatBytes(ATTACHMENT_LIMITS.maxBytes)));
        continue;
      }
      const named = file.name && file.name !== 'image.png' ? file : new File([file], pastedName(file), { type: file.type });
      accepted.push({ id: ++nextFileId, file: named });
    }
    onFiles([...files, ...accepted]);
  };

  const removeFile = (id: number) => {
    onFiles(files.filter((f) => f.id !== id));
    onNotice('');
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
    e.currentTarget.querySelector('textarea')?.focus();
  };

  const onDragLeave = (e: DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
  };

  return { addFiles, removeFile, onPaste, dragging, dropZone: { onDragOver, onDragLeave, onDrop } };
}

export function AttachmentPicker({ addFiles }: { addFiles: (files: File[]) => void }) {
  const t = useT();
  const picker = useRef<HTMLInputElement>(null);
  return (
    <>
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
    </>
  );
}

/** The draft owns the file. Each mounted thumbnail owns its preview URL. */
function FilePreview({ file }: { file: File }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    const preview = URL.createObjectURL(file);
    setUrl(preview);
    return () => URL.revokeObjectURL(preview);
  }, [file]);
  return <img src={url} alt={file.name} />;
}

export interface SavedFiles {
  files: NonNullable<ConversationSchedule['attachments']>;
  remove: (id: string) => void;
}

export function AttachmentTray({
  files,
  removeFile,
  saved,
}: {
  files: PendingFile[];
  removeFile: (id: number) => void;
  saved?: SavedFiles;
}) {
  const t = useT();
  const entries = [
    ...(saved?.files ?? []).map((f) => ({ ...f, image: undefined, remove: () => saved!.remove(f.id) })),
    ...files.map(({ id, file }) => ({
      id,
      name: file.name,
      size: file.size,
      image: isInlineImage(file.type) ? file : undefined,
      remove: () => removeFile(id),
    })),
  ];
  if (!entries.length) return null;
  return (
    <ul className="attach-tray" aria-label={t.composer.attachments}>
      {entries.map((f) => (
        <li key={f.id} className={f.image ? 'attach-thumb' : 'attach-chip'} title={f.name}>
          {f.image ? (
            <FilePreview file={f.image} />
          ) : (
            <>
              <PaperclipIcon size={14} />
              <span className="ellipsis">{f.name}</span>
              <span className="muted">{formatBytes(f.size)}</span>
            </>
          )}
          <button type="button" className="attach-remove" onClick={f.remove} aria-label={t.composer.removeFile(f.name)}>
            ×
          </button>
        </li>
      ))}
    </ul>
  );
}
