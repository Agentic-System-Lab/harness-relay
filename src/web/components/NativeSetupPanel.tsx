import { useEffect, useRef, useState } from 'react';
import type { FilePreview, NativeSetup, Provider } from '../../shared/types';
import { api } from '../api';
import { isMarkdown, lineCount } from '../files';
import { useT } from '../i18n';
import { formatBytes, relativeTime } from '../util';
import { TextContent } from './FileBrowser';
import { GrokTrustNote } from './GrokTrust';
import { useDialog } from './useDialog';

type Tab = 'skills' | 'mcp' | 'memory';

/**
 * What a CLI loads by itself (its own skills, MCP servers and memory files), asked from the CLI when
 * the section is first opened: asking starts the CLI briefly.
 */
export function NativeSetupPanel({ provider }: { provider: Provider }) {
  const t = useT();
  const [setup, setSetup] = useState<NativeSetup | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<Tab>('skills');
  const [query, setQuery] = useState('');
  /** The reported file being read. */
  const [viewing, setViewing] = useState<string | null>(null);

  const load = async (refresh = false) => {
    setLoading(true);
    setError('');
    try {
      setSetup(await api.nativeSetup(provider, refresh));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const q = query.trim().toLowerCase();
  const match = (...texts: (string | undefined)[]) => !q || texts.some((s) => s?.toLowerCase().includes(q));
  const counts = setup ? { skills: setup.skills.length, mcp: setup.mcpServers.length, memory: setup.memory.length } : null;

  return (
    <details className="sub native-setup" onToggle={(e) => e.currentTarget.open && !setup && !loading && load()}>
      <summary>
        {t.native.title}
        {counts && ` (${t.native.summary(counts.skills, counts.mcp, counts.memory)})`}
      </summary>
      <div className="sub-body">
        <p className="muted small">{t.native.hint}</p>
        <div className="button-row">
          {setup && <span className="muted small">{t.native.checked(setup.cwd, relativeTime(setup.checkedAt, t))}</span>}
          <button className="ghost small-button" onClick={() => load(true)} disabled={loading}>
            {loading ? t.native.loading : setup ? t.native.reload : t.native.load}
          </button>
        </div>
        {error && <p className="error-line">{error}</p>}
        {setup && provider === 'grok' && setup.folderTrusted !== undefined && (
          <GrokTrustNote cwd={setup.cwd} trusted={setup.folderTrusted} onTrusted={() => load(true)} />
        )}
        {setup?.errors.map((e, i) => (
          <p key={i} className="warn-line small">
            {e}
          </p>
        ))}
        {setup && counts && (
          <>
            <div className="segmented native-tabs" role="tablist">
              {(['skills', 'mcp', 'memory'] as const).map((k) => (
                <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
                  {t.native.tabs[k]} ({counts[k]})
                </button>
              ))}
            </div>
            {tab !== 'memory' && (
              <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t.native.filter} aria-label={t.native.filter} />
            )}
            {tab === 'skills' && (
              <>
                {provider === 'claude' && <p className="muted small">{t.native.claudeSkills}</p>}
                <ul className="native-list">
                  {setup.skills
                    .filter((s) => match(s.name, s.description))
                    .map((s, i) => (
                      <li key={`${s.name}-${i}`} title={s.path}>
                        <span className="native-name">
                          {s.path ? (
                            <button type="button" className="link-button" onClick={() => setViewing(s.path!)}>
                              {s.name}
                            </button>
                          ) : (
                            s.name
                          )}
                          {s.source && <span className="badge">{s.source}</span>}
                          {s.enabled === false && <span className="badge">{t.native.off}</span>}
                        </span>
                        {s.description && <span className="native-description">{s.description}</span>}
                      </li>
                    ))}
                </ul>
                {!setup.skills.length && <p className="muted small">{t.native.none}</p>}
              </>
            )}
            {tab === 'mcp' && (
              <>
                <ul className="native-list">
                  {setup.mcpServers
                    .filter((s) => match(s.name, s.source))
                    .map((s, i) => (
                      <li key={`${s.name}-${i}`}>
                        <span className="native-name">
                          {s.name}
                          {s.transport && <span className="badge">{s.transport}</span>}
                          {s.status && <span className={`badge ${s.status === 'connected' ? 'ok' : ''}`}>{s.status}</span>}
                        </span>
                        <span className="native-description">
                          {[s.source && t.native.source(s.source), s.tools !== undefined && t.native.tools(s.tools)].filter(Boolean).join(' · ')}
                        </span>
                      </li>
                    ))}
                </ul>
                {!setup.mcpServers.length && <p className="muted small">{t.native.none}</p>}
              </>
            )}
            {tab === 'memory' && (
              <>
                <p className="muted small">{setup.memoryFromFiles ? t.native.fromFiles : t.native.fromCli}</p>
                {provider === 'grok' && <p className="muted small">{t.native.grokMemory}</p>}
                <ul className="native-list">
                  {setup.memory.map((m) => (
                    <li key={m.path}>
                      <span className="native-name">
                        <button type="button" className="link-button native-file" onClick={() => setViewing(m.path)} title={t.native.preview}>
                          <code>{m.path}</code>
                        </button>
                        <span className="badge">{m.kind === 'memory' ? t.native.memoryFile : t.native.instructions}</span>
                      </span>
                    </li>
                  ))}
                </ul>
                {!setup.memory.length && <p className="muted small">{t.native.none}</p>}
              </>
            )}
          </>
        )}
      </div>
      {viewing && <ReportedFile provider={provider} path={viewing} onClose={() => setViewing(null)} />}
    </details>
  );
}

/** One of the files the CLI reported, read in a dialog. */
function ReportedFile({ provider, path, onClose }: { provider: Provider; path: string; onClose: () => void }) {
  const t = useT();
  const dialog = useRef<HTMLDivElement>(null);
  useDialog(dialog, onClose);
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [error, setError] = useState('');
  const [source, setSource] = useState(false);
  const name = path.split(/[\\/]/).pop() || path;

  useEffect(() => {
    api.nativeFile(provider, path).then(setPreview, (e: Error) => setError(e.message));
  }, [provider, path]);

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div
        ref={dialog}
        className="modal reported-file"
        role="dialog"
        aria-modal="true"
        aria-label={name}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="drawer-head">
          <div className="preview-title">
            <h2>{name}</h2>
            <span className="muted small">
              <code>{path}</code>
              {preview?.kind === 'text' && ` · ${formatBytes(preview.size)} · ${t.files.lines(lineCount(preview.text ?? ''))}`}
            </span>
          </div>
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
          <button className="icon-button" onClick={onClose} aria-label={t.common.close}>
            ×
          </button>
        </header>
        {error ? (
          <p className="error-line">{error}</p>
        ) : !preview ? (
          <p className="muted small">{t.common.loading}</p>
        ) : (
          <TextContent name={name} preview={preview} source={source} />
        )}
      </div>
    </div>
  );
}
