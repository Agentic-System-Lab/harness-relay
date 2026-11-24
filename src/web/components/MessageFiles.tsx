import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import { FOLDER_MIME_TYPE, isFolderAttachment, isInlineImage, type ConversationSchedule } from '../../shared/types';
import type { AttachmentUpload } from '../api';
import {
  acceptAttachments,
  foldersOfPicked,
  isFolder,
  readDroppedFolder,
  type DroppedEntry,
  type Picked,
  type PendingFolder,
} from '../attachments';
import { isTouchScreen } from '../chat';
import { useT } from '../i18n';
import { formatBytes, toBase64 } from '../util';
import { FolderIcon, PaperclipIcon } from './icons';

let nextFileId = 0;

/** A file or a folder waiting to be sent. */
export type PendingFile = { id: number; file: File; folder?: undefined } | { id: number; folder: PendingFolder; file?: undefined };

/** Its size: a folder's, all its files'. */
const sizeOf = (p: PendingFile) => (p.folder ? p.folder.size : p.file.size);

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
    files.map(async (p): Promise<AttachmentUpload> => {
      if (p.folder) {
        const files: { path: string; data: string }[] = [];
        // One file at a time: a folder can hold a thousand.
        for (const f of p.folder.files) files.push({ path: f.path, data: await toBase64(f.file) });
        return { name: p.folder.name, mimeType: FOLDER_MIME_TYPE, files };
      }
      return { name: p.file.name, mimeType: p.file.type || 'application/octet-stream', data: await toBase64(p.file) };
    }),
  ).catch(() => {
    throw new Error(readFailed);
  });
}

/**
 * The files and folders a message (or an automation) is to send: what was picked, pasted or dropped
 * goes in as far as the limits allow (`acceptAttachments`). `saved`: an automation's files already
 * saved, which count too.
 */
export function useMessageFiles(
  files: PendingFile[],
  onFiles: (files: PendingFile[]) => void,
  onNotice: (notice: string) => void,
  saved: readonly { size: number }[] = [],
) {
  const t = useT();
  const [dragging, setDragging] = useState(false);
  const addFiles = (list: Picked[]) => {
    if (!list.length) return;
    const attached = {
      count: saved.length + files.length,
      bytes: saved.reduce((n, f) => n + f.size, 0) + files.reduce((n, f) => n + sizeOf(f), 0),
    };
    const { accepted, notice } = acceptAttachments(list, attached, t.composer, formatBytes);
    onNotice(notice);
    const added = accepted.map((item): PendingFile => {
      if (isFolder(item)) return { id: ++nextFileId, folder: item };
      const named = item.name && item.name !== 'image.png' ? item : new File([item], pastedName(item), { type: item.type });
      return { id: ++nextFileId, file: named };
    });
    if (added.length) onFiles([...files, ...added]);
  };
  // A dropped folder is read after the drop: what it holds is added to the files there are by then.
  const latest = useRef(addFiles);
  latest.current = addFiles;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

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
    e.currentTarget.querySelector('textarea')?.focus();
    // Each dropped item's entry, taken now: the drop's items are gone once it is handled.
    const items = [...e.dataTransfer.items].filter((i) => i.kind === 'file');
    const entries = items.map((i) => (i.webkitGetAsEntry?.() ?? null) as DroppedEntry | null);
    if (!entries.some((entry) => entry?.isDirectory)) {
      addFiles([...e.dataTransfer.files]);
      return;
    }
    const dropped = items.map((item, i) => {
      const entry = entries[i];
      return entry?.isDirectory ? readDroppedFolder(entry) : Promise.resolve(item.getAsFile());
    });
    void Promise.all(dropped).then(
      (list) => {
        if (mounted.current) latest.current(list.filter((p): p is Picked => p !== null));
      },
      () => {
        if (mounted.current) onNotice(t.composer.readFailed);
      },
    );
  };

  const onDragLeave = (e: DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
  };

  return { addFiles, removeFile, onPaste, dragging, dropZone: { onDragOver, onDragLeave, onDrop } };
}

/** Whether this browser can pick a folder: not on a phone or tablet, whose pickers take files only. */
function canPickFolders(): boolean {
  return typeof document !== 'undefined' && 'webkitdirectory' in document.createElement('input') && !isTouchScreen();
}

/**
 * The paperclip: files, or (where the browser can pick one) a folder, from a menu. Each pick of a
 * folder takes one; several are attached one after another, or dropped together.
 */
export function AttachmentPicker({ addFiles }: { addFiles: (items: Picked[]) => void }) {
  const t = useT();
  const filePicker = useRef<HTMLInputElement>(null);
  const folderPicker = useRef<HTMLInputElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [folders] = useState(canPickFolders);
  const [open, setOpen] = useState(false);

  // Open, the menu takes the focus, and a press anywhere else closes it.
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const away = (e: PointerEvent) => {
      if (!menu.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);

  const pick = (input: HTMLInputElement | null) => {
    setOpen(false);
    button.current?.focus();
    input?.click();
  };

  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      button.current?.focus();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      items[(at + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      items[e.key === 'Home' ? 0 : items.length - 1]?.focus();
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  };

  return (
    <span className="attach-picker">
      <button
        ref={button}
        type="button"
        className="icon-button attach-button"
        onClick={() => (folders ? setOpen(!open) : filePicker.current?.click())}
        aria-label={folders ? t.composer.attachFilesOrFolder : t.composer.attach}
        title={folders ? t.composer.attachFilesOrFolder : t.composer.attach}
        {...(folders ? { 'aria-haspopup': 'menu' as const, 'aria-expanded': open } : {})}
      >
        <PaperclipIcon />
      </button>
      {open && (
        <div ref={menu} className="attach-menu" role="menu" aria-label={t.composer.attachFilesOrFolder} onKeyDown={onMenuKey}>
          <button type="button" role="menuitem" tabIndex={-1} onClick={() => pick(filePicker.current)}>
            <PaperclipIcon size={16} />
            {t.composer.attachFiles}
          </button>
          <button type="button" role="menuitem" tabIndex={-1} onClick={() => pick(folderPicker.current)}>
            <FolderIcon size={16} />
            {t.composer.attachFolder}
          </button>
        </div>
      )}
      <input
        ref={filePicker}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          addFiles([...(e.target.files ?? [])]);
          e.target.value = '';
        }}
      />
      {folders && (
        <input
          ref={(el) => {
            folderPicker.current = el;
            // A folder picker (as `webkitdirectory` in markup: React does not know the attribute).
            el?.setAttribute('webkitdirectory', '');
          }}
          type="file"
          hidden
          onChange={(e) => {
            addFiles(foldersOfPicked(e.target.files ?? []));
            e.target.value = '';
          }}
        />
      )}
    </span>
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
    ...(saved?.files ?? []).map((f) => ({
      id: f.id,
      name: f.name,
      size: f.size,
      count: isFolderAttachment(f) ? (f.files ?? 0) : undefined,
      leftOut: [] as string[],
      image: undefined,
      remove: () => saved!.remove(f.id),
    })),
    ...files.map((p) => ({
      id: p.id,
      name: p.folder ? p.folder.name : p.file.name,
      size: sizeOf(p),
      count: p.folder?.files.length,
      leftOut: p.folder?.leftOut ?? [],
      image: p.file && isInlineImage(p.file.type) ? p.file : undefined,
      remove: () => removeFile(p.id),
    })),
  ];
  if (!entries.length) return null;
  return (
    <ul className="attach-tray" aria-label={t.composer.attachments}>
      {entries.map((f) => (
        <li
          key={f.id}
          className={f.image ? 'attach-thumb' : f.count === undefined ? 'attach-chip' : 'attach-chip attach-folder'}
          title={
            f.leftOut.length
              ? `${f.name}/\n${t.composer.folderLeftOut(f.leftOut.join(', '))}`
              : f.count === undefined
                ? f.name
                : `${f.name}/`
          }
        >
          {f.image ? (
            <FilePreview file={f.image} />
          ) : f.count === undefined ? (
            <>
              <PaperclipIcon size={14} />
              <span className="ellipsis">{f.name}</span>
              <span className="muted">{formatBytes(f.size)}</span>
            </>
          ) : (
            <>
              <FolderIcon size={14} />
              <span className="ellipsis">{f.name}</span>
              <span className="muted">{t.composer.folderSize(f.count, formatBytes(f.size))}</span>
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
