import hljs from 'highlight.js/lib/common';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FILE_LIMITS, type Conversation, type FileEntry, type FileListing, type FilePreview } from '../../shared/types';
import { api } from '../api';
import { useT } from '../i18n';
import { codeLanguage, crumbs, filterEntries, isMarkdown, joinPath, lineCount, parentPath } from '../files';
import { formatBytes, relativeTime } from '../util';
import { CopyButton } from './CopyButton';
import { ChevronIcon, CopyIcon, FolderIcon } from './icons';
import { Markdown } from './Markdown';
import { useDialog } from './useDialog';

/** Highlighting a very long file would hold up the page; past this it is shown as plain text. */
const HIGHLIGHT_MAX_CHARS = 200_000;

/** Where each conversation's browser was last, so reopening it comes back there. */
const lastPlace = new Map<string, { root: string; dir: string; file?: string }>();

/** A dialog to browse the conversation's working directory (or an agent's worktree) and preview files. */
export function FileBrowser({ conv, onClose }: { conv: Conversation; onClose: () => void }) {
  const t = useT();
  const dialog = useRef<HTMLDivElement>(null);
  useDialog(dialog, onClose);
  const start = lastPlace.get(conv.id) ?? { root: 'cwd', dir: '' };
  const [root, setRoot] = useState(start.root);
  const [dir, setDir] = useState(start.dir);
  const [file, setFile] = useState<string | undefined>(start.file);
  const [listing, setListing] = useState<FileListing | null>(null);
  const [listError, setListError] = useState('');
  const [query, setQuery] = useState('');
  const [reload, setReload] = useState(0);

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
    } else setFile(path);
  };

  const rootName = (id: string) => {
    if (id === 'cwd') return t.files.workingDir;
    const agent = conv.agents.find((a) => a.id === id);
    return t.files.worktree(agent?.name ?? id);
  };
  const roots = listing?.roots ?? [{ id: 'cwd', path: conv.settings.cwd }];
  const rootPath = roots.find((r) => r.id === root)?.path ?? conv.settings.cwd;
  const entries = useMemo(() => filterEntries(listing?.path === dir ? listing.entries : [], query), [listing, dir, query]);
  const loading = !listing || listing.path !== dir || listing.root !== root;

  return (
    <div className="modal-scrim" onClick={onClose}>
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
                setRoot(e.target.value);
                setDir('');
                setFile(undefined);
              }}
            >
              {roots.map((r) => (
                <option key={r.id} value={r.id}>
                  {rootName(r.id)}
                </option>
              ))}
            </select>
          )}
          <button className="icon-button" onClick={onClose} aria-label={t.common.close}>
            ×
          </button>
        </header>
        {/* Right-to-left so a long path is cut at its start; the path itself still reads left to right. */}
        <p className="muted small file-root-path" title={rootPath}>
          <span dir="ltr">{rootPath}</span>
        </p>

        <div className="file-browser-body">
          <section className="file-pane" aria-label={t.files.title}>
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
              <button className="icon-button" disabled={!dir} onClick={() => setDir(parentPath(dir))} aria-label={t.files.up} title={t.files.up}>
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
            </div>
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
                      <li key={e.name}>
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
              <Preview key={`${root}:${file}`} conv={conv} root={root} rootPath={rootPath} path={file} onBack={() => setFile(undefined)} />
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
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
  onBack,
}: {
  conv: Conversation;
  root: string;
  rootPath: string;
  path: string;
  onBack: () => void;
}) {
  const t = useT();
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [error, setError] = useState('');
  const [source, setSource] = useState(false);
  const name = path.split('/').pop() ?? path;

  const load = useCallback(() => {
    setError('');
    api.previewFile(conv.id, root, path).then(setPreview, (e: Error) => setError(e.message));
  }, [conv.id, root, path]);
  useEffect(load, [load]);

  const raw = api.rawFileUrl(conv.id, root, path);
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
              {preview.kind === 'text' && preview.text ? ` · ${t.files.lines(lineCount(preview.text))}` : ''} · {relativeTime(preview.mtime, t)}
            </span>
          )}
        </div>
        <div className="preview-actions">
          {preview?.kind === 'text' && isMarkdown(name) && (
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
          <CopyButton className="ghost small-button" label={t.files.copyPath} icon={<CopyIcon size={14} />} text={() => fullPath} />
          <button className="icon-button" onClick={load} aria-label={t.files.refresh} title={t.files.refresh}>
            ↻
          </button>
        </div>
      </div>
      {error ? (
        <p className="error-line">{error}</p>
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
    if (!lang || text.length > HIGHLIGHT_MAX_CHARS || !hljs.getLanguage(lang)) return null;
    try {
      // highlight.js escapes the text; its output is only <span class="hljs-…"> elements.
      return hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
    } catch {
      return null;
    }
  }, [text, name]);
  const numbers = useMemo(
    () => Array.from({ length: Math.max(1, lineCount(text)) }, (_, i) => i + 1).join('\n'),
    [text],
  );
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
