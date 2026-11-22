import { useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent, type ReactNode } from 'react';
import { FILE_CHANGED, FILE_EDIT_LIMITS, FILE_EXISTS, FOLDER_BUSY, type FileEntry, type FilePreview } from '../../shared/types';
import { ApiError, api } from '../api';
import { editorText, isDirty, isSaveKey, newFileProblem, uploadPlan, type PickedFile, type UploadRefusal } from '../fileEdit';
import { isMarkdown, joinPath } from '../files';
import { useT } from '../i18n';
import type { Messages } from '../locales/zh-TW';
import { toBase64 } from '../util';
import { CopyButton } from './CopyButton';
import { CopyIcon, PlusIcon } from './icons';
import '../filesEdit.css';

/**
 * A text file being edited in the Files panel: a text box with the file as it was loaded, Save (also
 * Ctrl+S or ⌘S) and Cancel. A save names the version it was loaded at: when the file changed since,
 * the server refuses it and this offers to reload (after copying what was typed); while a run writes in
 * the folder, it says so and keeps the text.
 */
export function FileEditor({
  convId,
  root,
  path,
  preview,
  onDone,
  onReload,
  onDirty,
}: {
  convId: string;
  root: string;
  path: string;
  preview: FilePreview;
  /** Editing ends: `saved` once the file is written. */
  onDone: (saved: boolean) => void;
  /** The file is loaded again (what was typed is dropped). */
  onReload: () => void;
  onDirty: (dirty: boolean) => void;
}) {
  const t = useT();
  const name = path.split('/').pop() ?? path;
  const original = useMemo(() => editorText(preview.text ?? ''), [preview.text]);
  const [draft, setDraft] = useState(original);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<{ changed: boolean; message: string } | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const dirty = isDirty(original, draft);
  const report = useRef(onDirty);
  report.current = onDirty;

  useEffect(() => {
    report.current(dirty);
  }, [dirty]);
  useEffect(() => {
    area.current?.focus();
    return () => report.current(false);
  }, []);
  // Leaving the page (closing the tab, reloading it) asks first while there is something unsaved.
  useEffect(() => {
    if (!dirty) return;
    const ask = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', ask);
    return () => window.removeEventListener('beforeunload', ask);
  }, [dirty]);

  const save = async () => {
    if (saving || !dirty) return;
    setSaving(true);
    setProblem(null);
    try {
      await api.saveFile(convId, { root, path, text: draft, version: preview.version ?? null });
      report.current(false);
      onDone(true);
    } catch (e) {
      const err = e as Error;
      setProblem({ changed: err instanceof ApiError && err.code === FILE_CHANGED, message: err.message });
    } finally {
      setSaving(false);
    }
  };
  const cancel = () => {
    if (dirty && !confirm(t.filesEdit.discard)) return;
    report.current(false);
    onDone(false);
  };

  return (
    <div className="file-editor">
      <div className="file-editor-bar">
        <span className={`small ${dirty ? 'warn-text' : 'muted'}`} aria-live="polite">
          {dirty ? t.filesEdit.unsaved : t.filesEdit.saveKey}
        </span>
        <button type="button" className="ghost small-button" onClick={cancel} disabled={saving}>
          {t.common.cancel}
        </button>
        <button type="button" className="primary small-button" onClick={() => void save()} disabled={saving || !dirty}>
          {saving ? t.filesEdit.saving : t.common.save}
        </button>
      </div>
      {problem &&
        (problem.changed ? (
          <div className="warn-line file-editor-problem" role="alert">
            <span>{t.filesEdit.changed(name)}</span>
            <span className="file-editor-problem-actions">
              <CopyButton className="ghost small-button" label={t.filesEdit.copyMine} icon={<CopyIcon size={14} />} text={() => draft} />
              <button type="button" className="ghost small-button" onClick={onReload}>
                {t.common.reload}
              </button>
              <button type="button" className="ghost small-button" onClick={() => setProblem(null)}>
                {t.filesEdit.keepEditing}
              </button>
            </span>
          </div>
        ) : (
          <p className="error-line small" role="alert">
            {problem.message}
          </p>
        ))}
      <textarea
        ref={area}
        className="file-editor-text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (!isSaveKey(e)) return;
          e.preventDefault();
          void save();
        }}
        aria-label={t.filesEdit.editorLabel(name)}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        // Prose wraps; code and tables (a CSV's rows) keep a line to a line.
        wrap={isMarkdown(name) || /\.txt$/i.test(name) ? 'soft' : 'off'}
      />
    </div>
  );
}

/** An arrow up out of a tray: send a file. */
function UploadIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 15V4M7 9l5-5 5 5" />
      <path d="M5 20h14" />
    </svg>
  );
}

/** Why a picked file was not sent, for the user. */
function refusalText(t: Messages, r: UploadRefusal): string {
  switch (r.why) {
    case 'name':
      return `${t.filesEdit.badName(r.name)} ${t.filesEdit.nameProblem[r.problem]}`;
    case 'size':
      return t.filesEdit.refusedSize(r.name, FILE_EDIT_LIMITS.maxUploadBytes / 1024 / 1024);
    case 'folder':
      return t.filesEdit.refusedFolder(r.name);
    case 'duplicate':
      return t.filesEdit.refusedDuplicate(r.name);
    case 'isFolder':
      return t.filesEdit.refusedIsFolder(r.name);
    case 'tooMany':
      return t.filesEdit.refusedTooMany(FILE_EDIT_LIMITS.maxUploadFiles);
  }
}

/** The files a drop holds, a dropped folder marked (it cannot go up as such). */
function droppedFiles(e: DragEvent): { picked: PickedFile[]; files: (File | null)[] } {
  const items = [...e.dataTransfer.items].filter((i) => i.kind === 'file');
  if (!items.length) {
    const files = [...e.dataTransfer.files];
    return { picked: files.map((f) => ({ name: f.name, size: f.size })), files };
  }
  const files = items.map((i) => i.getAsFile());
  const picked = items.map((i, n) => ({
    name: files[n]?.name ?? '',
    size: files[n]?.size ?? 0,
    ...(i.webkitGetAsEntry?.()?.isDirectory ? { folder: true } : {}),
  }));
  return { picked, files };
}

/**
 * New file and upload for the folder on screen: their buttons (`buttons`, for the row of the folder's
 * actions), the new file's name and what they say (`panel`, below it), and the handlers that take files
 * dropped on the list (`dropProps`, `dropping` while files are over it). In a root the panel may not
 * write in (`readOnly`), there are no buttons and the panel says why.
 */
export function useFolderWrites({
  convId,
  root,
  dir,
  folderName,
  entries,
  writable,
  readOnly,
  onWritten,
  onCreated,
}: {
  convId: string;
  root: string;
  dir: string;
  folderName: string;
  entries: FileEntry[];
  writable: boolean;
  readOnly?: string;
  /** Files were written into the folder: list it again. */
  onWritten: () => void;
  /** A new file was made, to open for editing. */
  onCreated: (path: string) => void;
}): { buttons: ReactNode; panel: ReactNode; dropProps: Record<string, (e: DragEvent) => void>; dropping: boolean } {
  const t = useT();
  const picker = useRef<HTMLInputElement>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [dropping, setDropping] = useState(false);

  // Another folder, another root: what was said was about the last one.
  useEffect(() => {
    setStatus('');
    setErrors([]);
    setCreating(false);
  }, [root, dir]);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    const name = newName.trim();
    const problem = newFileProblem(name, entries);
    if (problem) {
      setErrors([problem === 'exists' ? t.filesEdit.exists(name) : `${t.filesEdit.badName(name)} ${t.filesEdit.nameProblem[problem]}`]);
      return;
    }
    setBusy(true);
    setErrors([]);
    try {
      const path = joinPath(dir, name);
      await api.saveFile(convId, { root, path, text: '', version: null });
      setCreating(false);
      setNewName('');
      onWritten();
      onCreated(path);
    } catch (err) {
      setErrors([(err as Error).message]);
    } finally {
      setBusy(false);
    }
  };

  /** Sends `files` into the folder one at a time, a file there replaced only once the user agreed. */
  const upload = async (picked: PickedFile[], files: (File | null)[]) => {
    if (busy) return;
    if (!writable) {
      setErrors(readOnly ? [readOnly] : []);
      return;
    }
    const plan = uploadPlan(picked, entries);
    const problems = plan.refused.filter((r, i, all) => r.why !== 'tooMany' || all.findIndex((x) => x.why === 'tooMany') === i);
    const said = problems.map((r) => refusalText(t, r));
    const replace = plan.replaces.length > 0 && confirm(t.filesEdit.replaceConfirm(plan.replaces));
    const send = plan.send.filter((s) => !s.replace || replace);
    setErrors(said);
    if (!send.length) return;
    setBusy(true);
    let done = 0;
    try {
      for (const [n, item] of send.entries()) {
        const file = files[item.index];
        setStatus(t.filesEdit.uploading(n + 1, send.length, item.name));
        try {
          if (!file) throw new Error(t.filesEdit.refusedFolder(item.name));
          const data = await toBase64(file);
          const request = { root, dir, name: item.name, data };
          try {
            await api.uploadFile(convId, { ...request, replace: item.replace });
          } catch (err) {
            // A file of that name the list did not show (another letter case, or new since).
            if (!(err instanceof ApiError && err.code === FILE_EXISTS) || item.replace || !confirm(t.filesEdit.replaceOne(item.name)))
              throw err;
            await api.uploadFile(convId, { ...request, replace: true });
          }
          done++;
        } catch (err) {
          said.push(`${item.name}: ${(err as Error).message}`);
          setErrors([...said]);
          // A run writes in the folder: the others would be refused too.
          if (err instanceof ApiError && err.code === FOLDER_BUSY) break;
        }
      }
    } finally {
      setBusy(false);
      setStatus(done ? t.filesEdit.uploaded(done) : '');
      if (done) onWritten();
    }
  };

  const hasFiles = (e: DragEvent) => [...e.dataTransfer.types].includes('Files');
  const dropProps = {
    onDragEnter: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (writable) setDropping(true);
    },
    onDragOver: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = writable ? 'copy' : 'none';
    },
    onDragLeave: (e: DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false);
    },
    // Taken here also where the panel may not write, so that the browser does not open the file instead.
    onDrop: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDropping(false);
      const { picked, files } = droppedFiles(e);
      void upload(picked, files);
    },
  };

  const closeForm = () => {
    setCreating(false);
    setErrors([]);
  };
  const buttons = writable && (
    <>
      <button
        type="button"
        className="ghost small-button"
        disabled={busy}
        onClick={() => {
          setCreating((c) => !c);
          setErrors([]);
        }}
        aria-expanded={creating}
      >
        <PlusIcon size={14} /> {t.filesEdit.newFile}
      </button>
      <button
        type="button"
        className="ghost small-button"
        disabled={busy}
        onClick={() => picker.current?.click()}
        title={t.filesEdit.uploadHint(folderName)}
      >
        <UploadIcon /> {t.filesEdit.upload}
      </button>
      <input
        ref={picker}
        type="file"
        multiple
        hidden
        aria-label={t.filesEdit.uploadHint(folderName)}
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = '';
          void upload(
            files.map((f) => ({ name: f.name, size: f.size })),
            files,
          );
        }}
      />
    </>
  );
  const panel = (
    <>
      {!writable && readOnly && <p className="muted small">{readOnly}</p>}
      {creating && (
        <form className="file-new" onSubmit={(e) => void create(e)}>
          <input
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder={t.filesEdit.newFilePlaceholder}
            aria-label={t.filesEdit.newFileName}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            onKeyDown={(e) => {
              // Escape closes this form, not the dialog.
              if (e.key !== 'Escape' || e.nativeEvent.isComposing) return;
              e.preventDefault();
              e.stopPropagation();
              e.nativeEvent.stopImmediatePropagation();
              closeForm();
            }}
          />
          <button type="submit" className="primary small-button" disabled={busy || !newName.trim()}>
            {t.filesEdit.create}
          </button>
          <button type="button" className="ghost small-button" onClick={closeForm}>
            {t.common.cancel}
          </button>
        </form>
      )}
      {status && (
        <p className="muted small" role="status">
          {status}
        </p>
      )}
      {errors.length > 0 && (
        <ul className="file-write-errors error-line small" role="alert">
          {errors.map((m, i) => (
            <li key={i}>{m}</li>
          ))}
        </ul>
      )}
    </>
  );
  return { buttons, panel, dropProps, dropping };
}
