import { useEffect, useRef, useState } from 'react';
import type { FilePreview, NativeSetup, Provider, ProviderSettingsView, SettingsView } from '../../shared/types';
import { api } from '../api';
import { isMarkdown, lineCount } from '../files';
import { useT } from '../i18n';
import { nativeLeftOutCount, nativeTabs, sameNativeParts, type NativeTab } from '../native';
import { formatBytes, relativeTime } from '../util';
import { TextContent } from './FileBrowser';
import { GrokTrustNote } from './GrokTrust';
import { NativeOffSwitches } from './NativeOffSwitches';
import { useDialog } from './useDialog';

/** The badges an item gets: turned off by the CLI itself, or left out of Harness Relay's runs. */
function StateBadges({ item }: { item: { enabled?: boolean; leftOut?: boolean } }) {
  const t = useT();
  return (
    <>
      {item.enabled === false && <span className="badge">{t.native.off}</span>}
      {item.leftOut && (
        <span className="badge warn" title={t.native.leftOutTitle}>
          {t.native.leftOut}
        </span>
      )}
    </>
  );
}

/**
 * What a CLI loads by itself (its own skills, MCP servers, hooks, subagents, plugins and memory
 * files), and the switches that leave them out of Harness Relay's runs. The CLI is asked only when
 * the user clicks Ask: asking starts it briefly (Claude Code runs SessionStart hooks and connects
 * MCP servers), and someone may open this section to turn off an MCP server precisely because
 * starting it does harm. With something left out, the server asks the CLI again the way Harness
 * Relay starts it and marks what is then left out.
 */
export function NativeSetupPanel({
  provider,
  settings,
  onSettings,
}: {
  provider: Provider;
  settings?: ProviderSettingsView;
  onSettings: (s: SettingsView) => void;
}) {
  const t = useT();
  const [setup, setSetup] = useState<NativeSetup | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<NativeTab>('skills');
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
  const tabs = setup ? nativeTabs(setup) : [];
  const counts = setup ? { skills: setup.skills.length, mcp: setup.mcpServers.length, memory: setup.memory.length } : null;
  // The switches changed since this answer, so its marks may no longer hold.
  const stale = Boolean(setup && settings && !sameNativeParts(setup.nativeOff, settings.nativeOff));
  const shown = tabs.some((x) => x.tab === tab) ? tab : 'skills';

  return (
    <details className="sub native-setup">
      <summary>
        {t.native.title}
        {counts && ` (${t.native.summary(counts.skills, counts.mcp, counts.memory)})`}
        {settings?.nativeOff.length ? <span className="badge">{t.native.offCount(settings.nativeOff.length)}</span> : null}
      </summary>
      <div className="sub-body">
        <NativeOffSwitches provider={provider} settings={settings} onSettings={onSettings} />
        <p className="muted small">{t.native.hint}</p>
        <div className="button-row">
          {setup && <span className="muted small">{t.native.checked(setup.cwd, relativeTime(setup.checkedAt, t))}</span>}
          {/* The first Ask may get an answer kept from the last minute; Ask again always asks the CLI. */}
          <button className="ghost small-button" onClick={() => load(Boolean(setup))} disabled={loading}>
            {loading ? t.native.loading : setup ? t.native.reload : t.native.load}
          </button>
        </div>
        {error && <p className="error-line">{error}</p>}
        {setup && provider === 'grok' && setup.folderTrusted !== undefined && (
          <GrokTrustNote
            cwd={setup.cwd}
            folder={setup.trustFolder}
            above={setup.trustFolderAbove}
            trusted={setup.folderTrusted}
            onTrusted={() => load(true)}
          />
        )}
        {setup?.errors.map((e, i) => (
          <p key={i} className="warn-line small">
            {e}
          </p>
        ))}
        {stale ? (
          <p className="warn-line small">{t.native.asRunStale}</p>
        ) : (
          setup?.asRun && <p className="muted small">{t.native.asRun(nativeLeftOutCount(setup))}</p>
        )}
        {setup && counts && (
          <>
            <div className="segmented native-tabs" role="tablist">
              {tabs.map(({ tab: k, count }) => (
                <button key={k} role="tab" aria-selected={shown === k} className={shown === k ? 'on' : ''} onClick={() => setTab(k)}>
                  {t.native.tabs[k]} ({count})
                </button>
              ))}
            </div>
            {shown !== 'memory' && (
              <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t.native.filter} aria-label={t.native.filter} />
            )}
            {shown === 'skills' && (
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
                          <StateBadges item={s} />
                        </span>
                        {s.description && <span className="native-description">{s.description}</span>}
                      </li>
                    ))}
                </ul>
                {!setup.skills.length && <p className="muted small">{t.native.none}</p>}
              </>
            )}
            {shown === 'mcp' && (
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
                          <StateBadges item={s} />
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
            {shown === 'hooks' && setup.hooks && (
              <>
                <p className="muted small">{t.native.hooksNote}</p>
                <ul className="native-list">
                  {setup.hooks
                    .filter((h) => match(h.event, h.matcher, h.source, h.file))
                    .map((h, i) => (
                      <li key={`${h.event}-${i}`}>
                        <span className="native-name">
                          {h.event}
                          {h.matcher && <code>{h.matcher}</code>}
                          {h.source && <span className="badge">{h.source}</span>}
                          <StateBadges item={h} />
                        </span>
                        {h.file && (
                          <span className="native-description">
                            <code>{h.file}</code>
                          </span>
                        )}
                      </li>
                    ))}
                </ul>
                {!setup.hooks.length && <p className="muted small">{t.native.none}</p>}
              </>
            )}
            {shown === 'agents' && setup.agents && (
              <>
                {provider === 'claude' && <p className="muted small">{t.native.claudeAgents}</p>}
                <ul className="native-list">
                  {setup.agents
                    .filter((a) => match(a.name, a.description, a.source))
                    .map((a, i) => (
                      <li key={`${a.name}-${i}`}>
                        <span className="native-name">
                          {a.name}
                          {a.source && <span className="badge">{a.source}</span>}
                          <StateBadges item={a} />
                        </span>
                        {a.description && <span className="native-description">{a.description}</span>}
                      </li>
                    ))}
                </ul>
                {!setup.agents.length && <p className="muted small">{t.native.none}</p>}
              </>
            )}
            {shown === 'plugins' && setup.plugins && (
              <>
                <ul className="native-list">
                  {setup.plugins
                    .filter((p) => match(p.name, p.source))
                    .map((p, i) => (
                      <li key={`${p.name}-${i}`}>
                        <span className="native-name">
                          {p.name}
                          {p.source && <span className="badge">{p.source}</span>}
                          <StateBadges item={p} />
                        </span>
                      </li>
                    ))}
                </ul>
                {!setup.plugins.length && <p className="muted small">{t.native.none}</p>}
              </>
            )}
            {shown === 'memory' && (
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
                        <StateBadges item={m} />
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
