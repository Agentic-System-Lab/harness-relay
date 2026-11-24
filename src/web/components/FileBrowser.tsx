import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FILE_LIMITS,
  TEAM_WORKTREE,
  cwdsOf,
  type Conversation,
  type FileEntry,
  type FileListing,
  type FilePreview,
} from '../../shared/types';
import { filePreviewTarget, type PreviewSelection } from '../appPreview';
import { api } from '../api';
import { useT } from '../i18n';
import { canEdit } from '../fileEdit';
import { codeLanguage, crumbs, filterEntries, isMarkdown, joinPath, lineCount, parentPath, zipChoice } from '../files';
import { highlightHtml } from '../highlight';
import { formatBytes, relativeTime } from '../util';
import { CopyButton } from './CopyButton';
import { FileEditor, useFolderWrites } from './FileEditing';
import { ChevronIcon, CopyIcon, DownloadIcon, FolderIcon, PencilIcon, TrashIcon } from './icons';
import { Markdown } from './Markdown';
import { useDialog } from './useDialog';

/** Highlighting a very long file would hold up the page; past this it is shown as plain text. */
const HIGHLIGHT_MAX_CHARS = 200_000;

/** Where each conversation's browser was last, so reopening it comes back there. */
const lastPlace = new Map<string, { root: string; dir: string; file?: string }>();

/** A dialog to browse the conversation's working directory (or an agent's worktree) and preview files. */
export function FileBrowser({
  conv,
  onClose,
  onPreview,
}: {
  conv: Conversation;
  onClose: () => void;
  onPreview: (target: PreviewSelection) => void;
}) {
  const t = useT();
  const dialog = useRef<HTMLDivElement>(null);
  /** A file being edited holds changes not saved: leaving it asks first. */
  const unsaved = useRef(false);
  /** Runs `go` unless there are unsaved changes the user would rather keep. */
  const leaving = (go: () => void) => {
    if (unsaved.current && !confirm(t.filesEdit.discard)) return;
    unsaved.current = false;
    go();
  };
  useDialog(dialog, () => leaving(onClose));
  const start = lastPlace.get(conv.id) ?? { root: 'cwd', dir: '' };
  const [root, setRoot] = useState(start.root);
  const [dir, setDir] = useState(start.dir);
  const [file, setFile] = useState<string | undefined>(start.file);
  const [listing, setListing] = useState<FileListing | null>(null);
  const [listError, setListError] = useState('');
  const [query, setQuery] = useState('');
  const [reload, setReload] = useState(0);
  /** The folder being zipped (its name), and why the last one could not be. */
  const [zipping, setZipping] = useState<string | null>(null);
  const [zipError, setZipError] = useState('');
  /** A file just made, which opens for editing (once: not when it is opened again later). */
  const [editOnOpen, setEditOnOpen] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (editOnOpen !== undefined && file !== editOnOpen) setEditOnOpen(undefined);
  }, [file, editOnOpen]);

  useEffect(() => {
    lastPlace.set(conv.id, { root, dir, file });
  }, [conv.id, root, dir, file]);

  useEffect(() => {
    let live = true;
    setListError('');
    api.listFiles(conv.id, root, dir).then(
      (l) => live && setListing(l),
      (e: Error) => {
        if (!live) return;
        // The folder is gone (or the root): fall back to the working directory's top.
        if (dir || root !== 'cwd') {
          setRoot('cwd');
          setDir('');
          setFile(undefined);
        } else setListError(e.message);
      },
    );
    return () => {
      live = false;
    };
  }, [conv.id, root, dir, reload]);

  const open = (e: FileEntry) => {
    const path = joinPath(dir, e.name);
    if (e.kind === 'dir') {
      setDir(path);
      setQuery('');
    } else if (path !== file) leaving(() => setFile(path));
  };

  /** A folder's name in the list: with several working directories, each also by its folder's name. */
  const rootName = (id: string) => {
    const r = roots.find((x) => x.id === id);
    const cwds = cwdsOf(conv.settings);
    const dir = cwds.length > 1 ? cwds[r?.cwd ?? 0] : undefined;
    const folder = dir ? ` · ${dir.split(/[\\/]/).filter(Boolean).pop() ?? dir}` : '';
    if (!r?.agentId) return `${t.files.workingDir}${folder}`;
    if (r.agentId === TEAM_WORKTREE) return `${t.files.teamWorktree}${folder}`;
    const agent = conv.agents.find((a) => a.id === r.agentId);
    return `${t.files.worktree(agent?.name ?? r.agentId)}${folder}`;
  };

  /**
   * Download a folder (the root too) as a ZIP file. Asked first how much it holds: one that is too large
   * is offered without what git ignores (node_modules and the like), or said to be too large.
   */
  const downloadZip = async (path: string) => {
    const name = path.split('/').pop() || rootName(root);
    setZipping(name);
    setZipError('');
    try {
      const check = await api.checkZip(conv.id, root, path);
      const choice = zipChoice(check);
      if (choice === 'tooBig') {
        setZipError(t.files.zipTooBig(name, FILE_LIMITS.zipItems, FILE_LIMITS.zipBytes / 1024 ** 3));
        return;
      }
      const unignored = choice === 'unignored';
      if (unignored && !confirm(t.files.zipUnignored(name, check.unignored!.files, formatBytes(check.unignored!.bytes)))) return;
      const link = document.createElement('a');
      link.href = api.zipUrl(conv.id, root, path, unignored);
      link.setAttribute('download', ''); // the server names it (after the folder, or for a worktree, the agent)
      link.click();
    } catch (e) {
      setZipError((e as Error).message);
    } finally {
      setZipping(null);
    }
  };
  const roots = listing?.roots ?? [{ id: 'cwd', path: conv.settings.cwd }];
  const rootPath = roots.find((r) => r.id === root)?.path ?? conv.settings.cwd;
  const entries = useMemo(() => filterEntries(listing?.path === dir ? listing.entries : [], query), [listing, dir, query]);
  const previewApp = (target: NonNullable<ReturnType<typeof filePreviewTarget>>) => {
    if (!listing || listing.root !== root) return;
    const base = listing.canonicalRoot;
    const separator = base.includes('\\') ? '\\' : '/';
    onPreview({
      request: { ...target, root },
      label: rootName(root),
      folder: target.folder ? base.replace(/[\\/]+$/, '') + separator + target.folder.split('/').join(separator) : base,
    });
  };
  const loading = !listing || listing.path !== dir || listing.root !== root;
  const folderName = dir.split('/').pop() || rootName(root);
  const writes = useFolderWrites({
    convId: conv.id,
    root,
    dir,
    folderName,
    entries: !loading ? listing.entries : [],
    writable: !loading && Boolean(listing.writable),
    readOnly: loading ? undefined : listing.readOnly,
    onWritten: () => setReload((n) => n + 1),
    onCreated: (path) => {
      setEditOnOpen(path);
      setFile(path);
    },
    onDeleted: (path) => {
      if (file !== undefined && (file === path || file.startsWith(`${path}/`))) {
        // Its unsaved changes went with it: the user agreed to delete it.
        unsaved.current = false;
        setFile(undefined);
      }
    },
  });
  const writable = !loading && Boolean(listing.writable);

  return (
    <div className="modal-scrim" onClick={() => leaving(onClose)}>
      <div
        ref={dialog}
        className={`modal file-browser ${file ? 'has-file' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={t.files.title}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="drawer-head file-browser-head">
          <h2>
            <FolderIcon size={18} /> {t.files.title}
          </h2>
          {roots.length > 1 && (
            <select
              className="file-root"
              aria-label={t.files.rootLabel}
              value={root}
              onChange={(e) => {
                const next = e.target.value;
                leaving(() => {
                  setRoot(next);
                  setDir('');
                  setFile(undefined);
                });
              }}
            >
              {roots.map((r) => (
                <option key={r.id} value={r.id}>
                  {rootName(r.id)}
                </option>
              ))}
            </select>
          )}
          <button className="icon-button" onClick={() => leaving(onClose)} aria-label={t.common.close}>
            ×
          </button>
        </header>
        {/* Right-to-left so a long path is cut at its start; the path itself still reads left to right. */}
        <p className="muted small file-root-path" title={rootPath}>
          <span dir="ltr">{rootPath}</span>
        </p>

        <div className="file-browser-body">
          <section
            className={`file-pane ${writes.dropping ? 'dropping' : ''}`}
            aria-label={t.files.title}
            data-drop={t.filesEdit.dropHere(folderName)}
            {...writes.dropProps}
          >
            <nav className="file-crumbs" aria-label={t.files.rootLabel}>
              {crumbs(dir).map((c, i, all) => (
                <span key={c.path}>
                  {i > 0 && <span className="crumb-sep">/</span>}
                  {i === all.length - 1 ? (
                    <span className="crumb current">{c.name || rootName(root)}</span>
                  ) : (
                    <button className="link-button crumb" onClick={() => setDir(c.path)}>
                      {c.name || rootName(root)}
                    </button>
                  )}
                </span>
              ))}
            </nav>
            <div className="file-tools">
              <button
                className="icon-button"
                disabled={!dir}
                onClick={() => setDir(parentPath(dir))}
                aria-label={t.files.up}
                title={t.files.up}
              >
                ↑
              </button>
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t.files.filter}
                aria-label={t.files.filter}
              />
              <button className="icon-button" onClick={() => setReload((n) => n + 1)} aria-label={t.files.refresh} title={t.files.refresh}>
                ↻
              </button>
              {/* This folder, as it is listed here (the root too). */}
              <button
                className="icon-button"
                disabled={zipping !== null}
                onClick={() => downloadZip(dir)}
                aria-label={t.files.downloadFolder(dir.split('/').pop() || rootName(root))}
                title={t.files.downloadFolder(dir.split('/').pop() || rootName(root))}
              >
                <DownloadIcon size={15} />
              </button>
            </div>
            {!loading && !listError && (
              <div className="file-actions">
                <button
                  className="ghost small-button folder-preview-button"
                  title={t.appPreview.openFolder}
                  onClick={() => previewApp({ folder: dir, mode: 'static' })}
                >
                  {t.appPreview.openFolder}
                </button>
                {writes.buttons}
              </div>
            )}
            {!loading && !listError && writes.panel}
            {zipping ? (
              <p className="muted small" role="status">
                {t.files.zipPreparing(zipping)}
              </p>
            ) : (
              zipError && <p className="error-line small">{zipError}</p>
            )}
            {listError ? (
              <p className="error-line">{listError}</p>
            ) : loading ? (
              <p className="muted small">{t.common.loading}</p>
            ) : (
              <>
                <ul className="file-list">
                  {entries.map((e) => {
                    const path = joinPath(dir, e.name);
                    return (
                      <li key={e.name} className="file-row">
                        <button
                          className={`file-item ${e.kind} ${file === path ? 'selected' : ''}`}
                          onClick={() => open(e)}
                          title={e.link ? `${e.name} (${t.files.linkHint})` : e.name}
                        >
                          <span className="file-icon" aria-hidden="true">
                            {e.kind === 'dir' ? <FolderIcon size={16} /> : <FileGlyph />}
                          </span>
                          <span className="file-name">
                            {e.name}
                            {e.link && <span className="muted"> ↗</span>}
                          </span>
                          <span className="file-meta">{e.kind === 'dir' ? <ChevronIcon size={14} /> : formatBytes(e.size)}</span>
                        </button>
                        {e.kind === 'dir' && (
                          <button
                            className="icon-button file-row-zip"
                            disabled={zipping !== null}
                            onClick={() => downloadZip(path)}
                            aria-label={t.files.downloadFolder(e.name)}
                            title={t.files.downloadFolder(e.name)}
                          >
                            <DownloadIcon size={14} />
                          </button>
                        )}
                        {writable && (
                          <button
                            className="icon-button file-row-zip file-row-delete"
                            disabled={writes.busy}
                            onClick={() => writes.remove(e)}
                            aria-label={t.filesEdit.deleteHint(e.name)}
                            title={t.filesEdit.deleteHint(e.name)}
                          >
                            <TrashIcon size={14} />
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
                {entries.length === 0 && <p className="muted small">{query ? t.files.noMatch : t.files.empty}</p>}
                {listing.truncated && <p className="muted small">{t.files.truncated(listing.entries.length)}</p>}
              </>
            )}
          </section>

          <section className="preview-pane">
            {file ? (
              <Preview
                key={`${root}:${file}`}
                conv={conv}
                root={root}
                rootPath={rootPath}
                path={file}
                writable={!loading && Boolean(listing.writable)}
                startEditing={editOnOpen === file}
                onPreview={previewApp}
                onBack={() => leaving(() => setFile(undefined))}
                onDirty={(dirty) => {
                  unsaved.current = dirty;
                }}
                onSaved={() => setReload((n) => n + 1)}
              />
            ) : (
              <p className="muted preview-empty">{t.files.pick}</p>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function FileGlyph() {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
    </svg>
  );
}

function Preview({
  conv,
  root,
  rootPath,
  path,
  writable,
  startEditing,
  onBack,
  onPreview,
  onDirty,
  onSaved,
}: {
  conv: Conversation;
  root: string;
  rootPath: string;
  path: string;
  /** The Files panel may write in this root (`FileListing.writable`). */
  writable: boolean;
  /** Open in the editor once loaded (a file just made). */
  startEditing: boolean;
  onBack: () => void;
  onPreview: (target: NonNullable<ReturnType<typeof filePreviewTarget>>) => void;
  onDirty: (dirty: boolean) => void;
  /** The file was saved: the list shows its new size. */
  onSaved: () => void;
}) {
  const t = useT();
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [error, setError] = useState('');
  const [source, setSource] = useState(false);
  const [editing, setEditing] = useState(false);
  const name = path.split('/').pop() ?? path;

  const load = useCallback(() => {
    setError('');
    api.previewFile(conv.id, root, path).then(setPreview, (e: Error) => {
      setError(e.message);
      setEditing(false); // gone, say: nothing to edit
    });
  }, [conv.id, root, path]);
  useEffect(load, [load]);
  const editable = canEdit({ writable }, preview);
  /** Editing, while the file can still be edited (not once a reload found it too large or gone). */
  const inEditor = editing && editable;
  // A file just made opens in the editor, once.
  const started = useRef(false);
  useEffect(() => {
    if (!startEditing || started.current || !editable) return;
    started.current = true;
    setEditing(true);
  }, [startEditing, editable]);

  const raw = api.rawFileUrl(conv.id, root, path);
  const app = filePreviewTarget(path);
  const fullPath = `${rootPath.replace(/[\\/]+$/, '')}/${path}`;

  return (
    <div className="preview">
      <div className="preview-head">
        <button className="ghost small-button preview-back" onClick={onBack}>
          ← {t.files.back}
        </button>
        <div className="preview-title">
          <strong title={path}>{name}</strong>
          {preview && (
            <span className="muted small">
              {formatBytes(preview.size)}
              {preview.kind === 'text' && preview.text ? ` · ${t.files.lines(lineCount(preview.text))}` : ''} ·{' '}
              {relativeTime(preview.mtime, t)}
            </span>
          )}
        </div>
        <div className="preview-actions">
          {editable && !inEditor && (
            <button className="ghost small-button file-edit-button" onClick={() => setEditing(true)} title={t.filesEdit.editHint(name)}>
              <PencilIcon size={14} />
              {t.filesEdit.edit}
            </button>
          )}
          {app && preview && (
            <button className="ghost small-button" onClick={() => onPreview(app)}>
              {t.appPreview.open}
            </button>
          )}
          {!inEditor && preview?.kind === 'text' && isMarkdown(name) && (
            <div className="segmented" role="radiogroup">
              <button role="radio" aria-checked={!source} className={!source ? 'on' : ''} onClick={() => setSource(false)}>
                {t.files.rendered}
              </button>
              <button role="radio" aria-checked={source} className={source ? 'on' : ''} onClick={() => setSource(true)}>
                {t.files.source}
              </button>
            </div>
          )}
          {(preview?.kind === 'image' || preview?.kind === 'video') && (
            <a className="ghost small-button button-link" href={raw} target="_blank" rel="noreferrer">
              {t.files.openRaw}
            </a>
          )}
          {preview && (
            <a
              className="ghost small-button button-link"
              href={api.downloadFileUrl(conv.id, root, path)}
              download={name}
              title={t.files.downloadHint(name)}
            >
              <DownloadIcon size={14} />
              {t.files.download}
            </a>
          )}
          <CopyButton className="ghost small-button" label={t.files.copyPath} icon={<CopyIcon size={14} />} text={() => fullPath} />
          {/* Not while editing: what was typed would go. */}
          {!inEditor && (
            <button className="icon-button" onClick={load} aria-label={t.files.refresh} title={t.files.refresh}>
              ↻
            </button>
          )}
        </div>
      </div>
      {error ? (
        <p className="error-line">{error}</p>
      ) : inEditor && preview ? (
        <FileEditor
          key={preview.version}
          convId={conv.id}
          root={root}
          path={path}
          preview={preview}
          onDirty={onDirty}
          onReload={load}
          onDone={(saved) => {
            setEditing(false);
            if (!saved) return;
            load();
            onSaved();
          }}
        />
      ) : !preview ? (
        <p className="muted small">{t.common.loading}</p>
      ) : preview.kind === 'image' ? (
        <div className="preview-media">
          <img src={raw} alt={name} />
        </div>
      ) : preview.kind === 'video' ? (
        <div className="preview-media">
          <video src={raw} controls preload="metadata" />
        </div>
      ) : (
        <TextContent name={name} preview={preview} source={source} />
      )}
    </div>
  );
}

/** A text file's content: Markdown rendered (unless `source`), anything else as code; or why it is not shown. */
export function TextContent({ name, preview, source }: { name: string; preview: FilePreview; source: boolean }) {
  const t = useT();
  if (preview.kind !== 'text') return <p className="muted preview-empty">{t.files.binary}</p>;
  if (!preview.text) return <p className="muted preview-empty">{t.files.emptyFile}</p>;
  return (
    <>
      {preview.truncated && <p className="warn-line small">{t.files.truncatedText(formatBytes(FILE_LIMITS.maxPreviewBytes))}</p>}
      {isMarkdown(name) && !source ? (
        <div className="preview-markdown">
          <Markdown text={preview.text} />
        </div>
      ) : (
        <CodeView text={preview.text} name={name} />
      )}
    </>
  );
}

/** Text with line numbers, highlighted when the language is known and the file is not too long. */
function CodeView({ text, name }: { text: string; name: string }) {
  const html = useMemo(() => {
    const lang = codeLanguage(name);
    if (!lang || text.length > HIGHLIGHT_MAX_CHARS) return null;
    try {
      // Escaped text in <span class="hljs-…"> elements only (highlightHtml).
      return highlightHtml(text, lang);
    } catch {
      return null;
    }
  }, [text, name]);
  const numbers = useMemo(() => Array.from({ length: Math.max(1, lineCount(text)) }, (_, i) => i + 1).join('\n'), [text]);
  return (
    <div className="code-view">
      <pre className="code-lines" aria-hidden="true">
        {numbers}
      </pre>
      {html !== null ? (
        <pre className="code-text hljs" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre className="code-text">{text}</pre>
      )}
    </div>
  );
}
