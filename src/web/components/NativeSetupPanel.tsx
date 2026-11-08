import { useState } from 'react';
import type { NativeSetup, Provider } from '../../shared/types';
import { api } from '../api';
import { useT } from '../i18n';
import { relativeTime } from '../util';

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
                          {s.name}
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
                        <code>{m.path}</code>
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
    </details>
  );
}
