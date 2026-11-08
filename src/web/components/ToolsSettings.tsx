import { useEffect, useRef, useState } from 'react';
import {
  MEMORY_SCOPES,
  PROVIDERS,
  PROVIDER_LABEL,
  TOOL_LIMITS,
  type McpServerView,
  type McpTransport,
  type MemoryScope,
  type Provider,
  type SkillCandidate,
  type ToolLibraryView,
} from '../../shared/types';
import { api } from '../api';
import { useT, type Messages } from '../i18n';
import { PROVIDER_COLOR } from '../util';
import { sectionId } from '../route';
import { SectionTitle } from './SectionTitle';
import { useDialog } from './useDialog';

/** Settings → Tool library: MCP servers, skills and the shared memory every agent can be given. */
export function ToolsCard() {
  const t = useT();
  const [lib, setLib] = useState<ToolLibraryView | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.tools().then(setLib, (e: Error) => setError(e.message));
  }, []);

  /** Runs a change and shows the library it returns, or the error. */
  const change = async (call: () => Promise<ToolLibraryView>): Promise<boolean> => {
    setError('');
    try {
      setLib(await call());
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  };

  return (
    <section className="card tools-card" id={sectionId('tools')}>
      <SectionTitle section="tools">{t.tools.title}</SectionTitle>
      <p className="muted small">{t.tools.hint}</p>
      {error && <p className="error-line">{error}</p>}
      {!lib ? (
        !error && <p className="muted small">{t.common.loading}</p>
      ) : (
        <>
          <McpSection lib={lib} change={change} />
          <SkillsSection lib={lib} change={change} />
          <MemorySection lib={lib} change={change} />
        </>
      )}
    </section>
  );
}

type Change = (call: () => Promise<ToolLibraryView>) => Promise<boolean>;

/** Who gets an item by default, in a few words. */
function givenTo(providers: Provider[], t: Messages): string {
  if (providers.length === PROVIDERS.length) return t.tools.allMembers;
  if (!providers.length) return t.tools.offByDefault;
  return t.tools.onlyFor(providers.map((p) => PROVIDER_LABEL[p]).join(t.common.listSeparator));
}

/** One toggle per CLI: the CLIs whose agents get an item by default. */
function ProviderPicks({ value, onChange, label }: { value: Provider[]; onChange: (v: Provider[]) => void; label: string }) {
  return (
    <div className="provider-picks" role="group" aria-label={label}>
      {PROVIDERS.map((p) => {
        const on = value.includes(p);
        return (
          <button
            key={p}
            type="button"
            aria-pressed={on}
            className={on ? 'on' : ''}
            style={{ ['--accent' as string]: PROVIDER_COLOR[p] }}
            onClick={() => onChange(on ? value.filter((x) => x !== p) : PROVIDERS.filter((x) => x === p || value.includes(x)))}
          >
            {PROVIDER_LABEL[p]}
          </button>
        );
      })}
    </div>
  );
}

function McpSection({ lib, change }: { lib: ToolLibraryView; change: Change }) {
  const t = useT();
  /** The server being edited ('' = a new one), or null. */
  const [editing, setEditing] = useState<string | null>(null);

  return (
    <div className="tools-section">
      <h4>{t.tools.mcp}</h4>
      <p className="muted small">
        {t.tools.mcpHint} {t.tools.secretsIn(t.settings.keyStorageName[lib.secretStorage])}
      </p>
      {lib.mcpServers.length === 0 && editing === null && <p className="muted small">{t.tools.noMcp}</p>}
      <ul className="tool-list">
        {lib.mcpServers.map((s) =>
          editing === s.name ? (
            <li key={s.name}>
              <McpForm server={s} change={change} onDone={() => setEditing(null)} />
            </li>
          ) : (
            <li key={s.name} className="tool-row">
              <div className="tool-row-main">
                <span className="tool-name">{s.name}</span>
                <code className="tool-detail">{s.transport === 'http' ? s.url : [s.command, ...s.args].join(' ')}</code>
                <span className={`tool-scope ${s.providers.length ? '' : 'off'}`}>{givenTo(s.providers, t)}</span>
              </div>
              <div className="tool-row-actions">
                <button className="ghost small-button" onClick={() => setEditing(s.name)}>
                  {t.tools.edit}
                </button>
                <button
                  className="icon-button danger"
                  aria-label={t.common.remove}
                  onClick={() => confirm(t.tools.confirmRemove(s.name)) && change(() => api.deleteMcpServer(s.name))}
                >
                  ×
                </button>
              </div>
            </li>
          ),
        )}
      </ul>
      {editing === '' ? (
        <McpForm change={change} onDone={() => setEditing(null)} />
      ) : (
        lib.mcpServers.length < TOOL_LIMITS.maxMcpServers && (
          <div className="button-row">
            <button className="ghost" onClick={() => setEditing('')}>
              + {t.tools.addMcp}
            </button>
          </div>
        )
      )}
    </div>
  );
}

interface VarRow {
  name: string;
  value: string;
  /** The stored value, masked, and the name it is stored under; kept while `value` is empty and the name unchanged. */
  masked?: string;
  stored?: string;
}

function McpForm({ server, change, onDone }: { server?: McpServerView; change: Change; onDone: () => void }) {
  const t = useT();
  const [name, setName] = useState(server?.name ?? '');
  const [transport, setTransport] = useState<McpTransport>(server?.transport ?? 'stdio');
  const [command, setCommand] = useState(server?.command ?? '');
  const [args, setArgs] = useState((server?.args ?? []).join('\n'));
  const [url, setUrl] = useState(server?.url ?? '');
  const [env, setEnv] = useState<VarRow[]>((server?.env ?? []).map((v) => ({ name: v.name, value: '', masked: v.masked, stored: v.name })));
  const [headers, setHeaders] = useState<VarRow[]>(
    (server?.headers ?? []).map((v) => ({ name: v.name, value: '', masked: v.masked, stored: v.name })),
  );
  const [providers, setProviders] = useState<Provider[]>(server?.providers ?? [...PROVIDERS]);
  const [saving, setSaving] = useState(false);

  const http = transport === 'http';
  const rows = http ? headers : env;
  const setRows = http ? setHeaders : setEnv;
  /** A stored value is kept only for a row whose name is unchanged; a renamed row needs its value again. */
  const keeps = (r: VarRow) => r.masked !== undefined && r.name.trim() === r.stored;
  const vars = (list: VarRow[]) =>
    list
      .filter((r) => r.name.trim())
      .map((r) => (r.value || !keeps(r) ? { name: r.name.trim(), value: r.value } : { name: r.name.trim() }));

  // A stored value cannot follow a new name: the row needs its value typed again.
  const renamed = rows.filter((r) => r.masked !== undefined && r.name.trim() && r.name.trim() !== r.stored && !r.value);

  const save = async () => {
    setSaving(true);
    const ok = await change(() =>
      api.saveMcpServer(name.trim(), {
        transport,
        ...(http
          ? { url: url.trim(), headers: vars(headers) }
          : { command: command.trim(), args: args.split('\n').map((a) => a.trim()).filter(Boolean), env: vars(env) }),
        providers,
        ...(server ? { previousName: server.name } : {}),
      }),
    );
    setSaving(false);
    if (ok) onDone();
  };

  return (
    <div className="mcp-form">
      <div className="mcp-form-grid">
        <label className="field">
          <span>{t.tools.name}</span>
          <input value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} maxLength={40} placeholder="github" />
        </label>
        <div className="field">
          <span>{t.tools.transport}</span>
          <div className="segmented" role="radiogroup" aria-label={t.tools.transport}>
            {(['stdio', 'http'] as const).map((tr) => (
              <button key={tr} role="radio" aria-checked={transport === tr} className={transport === tr ? 'on' : ''} onClick={() => setTransport(tr)}>
                {t.tools[tr]}
              </button>
            ))}
          </div>
        </div>
      </div>
      {http ? (
        <label className="field">
          <span>{t.tools.url}</span>
          <input value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false} placeholder="https://example.com/mcp" />
        </label>
      ) : (
        <>
          <label className="field">
            <span>{t.tools.command}</span>
            <input value={command} onChange={(e) => setCommand(e.target.value)} spellCheck={false} placeholder="npx" />
          </label>
          <label className="field">
            <span>{t.tools.args}</span>
            <textarea
              value={args}
              rows={3}
              onChange={(e) => setArgs(e.target.value)}
              spellCheck={false}
              placeholder={'-y\n@modelcontextprotocol/server-github'}
            />
          </label>
        </>
      )}
      <div className="field">
        <span>{http ? t.tools.headers : t.tools.env}</span>
        <span className="muted small">{t.tools.tokenHint}</span>
        {rows.map((r, i) => (
          <div key={i} className="var-row">
            <input
              value={r.name}
              aria-label={t.tools.varName}
              placeholder={t.tools.varName}
              spellCheck={false}
              onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
            />
            <input
              value={r.value}
              type="password"
              autoComplete="off"
              aria-label={t.tools.varValue}
              placeholder={keeps(r) ? t.tools.keepValue(r.masked!) : t.tools.varValue}
              onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
            />
            <button className="icon-button danger" aria-label={t.common.remove} onClick={() => setRows(rows.filter((_, j) => j !== i))}>
              ×
            </button>
          </div>
        ))}
        {rows.length < TOOL_LIMITS.maxVars && (
          <div>
            <button className="link-button" onClick={() => setRows([...rows, { name: '', value: '' }])}>
              + {t.tools.addVar}
            </button>
          </div>
        )}
      </div>
      <div className="field">
        <span>{t.tools.givenTo}</span>
        <ProviderPicks value={providers} onChange={setProviders} label={t.tools.givenTo} />
        <span className="muted small">{givenTo(providers, t)}</span>
      </div>
      <div className="button-row">
        <button className="ghost" onClick={onDone}>
          {t.common.cancel}
        </button>
        {renamed.length > 0 && <span className="warn-line small">{t.tools.renamedNeedsValue(renamed.map((r) => r.name.trim()).join(t.common.listSeparator))}</span>}
        <button className="primary" disabled={saving || !name.trim() || renamed.length > 0} onClick={save}>
          {t.common.save}
        </button>
      </div>
    </div>
  );
}

function SkillsSection({ lib, change }: { lib: ToolLibraryView; change: Change }) {
  const t = useT();
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [picking, setPicking] = useState<{ path: string; skills: SkillCandidate[] } | null>(null);
  const list = lib.skills.map((s) => ({ path: s.path, providers: s.providers }));

  const addPaths = async (paths: string[]) =>
    change(() => api.updateTools({ skills: [...list, ...paths.map((p) => ({ path: p, providers: [...PROVIDERS] }))] }));

  // Look first: one new skill is added right away; several are offered to pick from.
  const add = async () => {
    setBusy(true);
    setNote('');
    try {
      const found = await api.scanSkills(path.trim());
      const fresh = found.skills.filter((s) => !s.added);
      if (!found.skills.length) setNote(t.tools.noSkillsFound(found.path));
      else if (found.skills.length === 1 && fresh.length === 1) {
        if (await addPaths([fresh[0]!.path])) setPath('');
      } else setPicking(found);
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="tools-section">
      <h4>{t.tools.skills}</h4>
      <p className="muted small">{t.tools.skillsHint}</p>
      {lib.skills.length === 0 && <p className="muted small">{t.tools.noSkills}</p>}
      <ul className="tool-list">
        {lib.skills.map((s, i) => (
          <li key={s.path} className="tool-row">
            <div className="tool-row-main">
              <span className="tool-name">{s.name}</span>
              {s.description && <span className="tool-description">{s.description}</span>}
              <code className="tool-detail" title={s.path}>
                {s.path}
              </code>
              {s.problem && <span className="warn-line">{s.problem}</span>}
              <div className="tool-scope-row">
                <span className="muted small">{t.tools.givenTo}</span>
                <ProviderPicks
                  value={s.providers}
                  label={`${s.name}: ${t.tools.givenTo}`}
                  onChange={(providers) => change(() => api.updateTools({ skills: list.map((x, j) => (j === i ? { ...x, providers } : x)) }))}
                />
              </div>
            </div>
            <div className="tool-row-actions">
              <button
                className="icon-button danger"
                aria-label={t.common.remove}
                onClick={() => change(() => api.updateTools({ skills: list.filter((_, j) => j !== i) }))}
              >
                ×
              </button>
            </div>
          </li>
        ))}
      </ul>
      <div className="input-row">
        <input
          value={path}
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && path.trim() && !busy && add()}
          placeholder="~/.claude/skills"
          aria-label={t.tools.skillPath}
          spellCheck={false}
        />
        <button className="primary" disabled={!path.trim() || busy} onClick={add}>
          {busy ? t.tools.scanning : t.tools.addSkill}
        </button>
      </div>
      {note && <p className="warn-line small">{note}</p>}
      {picking && (
        <SkillPicker
          found={picking}
          onClose={() => setPicking(null)}
          onAdd={async (paths) => {
            if (await addPaths(paths)) {
              setPicking(null);
              setPath('');
            }
          }}
        />
      )}
    </div>
  );
}

/** The skills found under a folder, to tick the ones to add. */
function SkillPicker({
  found,
  onClose,
  onAdd,
}: {
  found: { path: string; skills: SkillCandidate[] };
  onClose: () => void;
  onAdd: (paths: string[]) => Promise<void>;
}) {
  const t = useT();
  const dialog = useRef<HTMLDivElement>(null);
  useDialog(dialog, onClose);
  // Nothing ticked at first: a folder such as ~/.claude/skills can hold dozens of skills.
  const [chosen, setChosen] = useState<Set<string>>(() => new Set());
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const q = query.trim().toLowerCase();
  const shown = found.skills.filter((s) => !q || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q));
  const selectable = shown.filter((s) => !s.added);
  const rel = (p: string) => (p === found.path ? '.' : p.startsWith(found.path) ? p.slice(found.path.length).replace(/^[\\/]/, '') : p);
  const toggle = (p: string, on: boolean) => {
    const next = new Set(chosen);
    if (on) next.add(p);
    else next.delete(p);
    setChosen(next);
  };

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div
        ref={dialog}
        className="modal skill-picker"
        role="dialog"
        aria-modal="true"
        aria-label={t.tools.pickTitle}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="drawer-head">
          <h2>{t.tools.pickTitle}</h2>
          <button className="icon-button" onClick={onClose} aria-label={t.common.close}>
            ×
          </button>
        </header>
        <p className="muted small">{t.tools.pickHint(found.skills.length, found.path)}</p>
        <div className="skill-picker-tools">
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t.tools.filterSkills} aria-label={t.tools.filterSkills} />
          <button className="link-button" onClick={() => setChosen(new Set([...chosen, ...selectable.map((s) => s.path)]))}>
            {t.tools.selectAll}
          </button>
          <button className="link-button" onClick={() => setChosen(new Set([...chosen].filter((p) => !selectable.some((s) => s.path === p))))}>
            {t.tools.selectNone}
          </button>
        </div>
        <ul className="skill-picker-list">
          {shown.map((s) => (
            <li key={s.path}>
              <label className={`skill-option ${s.added ? 'added' : ''}`}>
                <input type="checkbox" disabled={s.added} checked={s.added || chosen.has(s.path)} onChange={(e) => toggle(s.path, e.target.checked)} />
                <span className="skill-option-text">
                  <span className="skill-option-head">
                    <strong>{s.name}</strong>
                    <code>{rel(s.path)}</code>
                    {s.added && <span className="badge">{t.tools.alreadyAdded}</span>}
                  </span>
                  {s.description && <span className="skill-option-description">{s.description}</span>}
                </span>
              </label>
            </li>
          ))}
        </ul>
        <footer className="button-row end">
          <button className="ghost" onClick={onClose}>
            {t.common.cancel}
          </button>
          <button
            className="primary"
            disabled={!chosen.size || saving}
            onClick={async () => {
              setSaving(true);
              await onAdd(found.skills.filter((s) => chosen.has(s.path)).map((s) => s.path));
              setSaving(false);
            }}
          >
            {t.tools.addSelected(chosen.size)}
          </button>
        </footer>
      </div>
    </div>
  );
}

function MemorySection({ lib, change }: { lib: ToolLibraryView; change: Change }) {
  const t = useT();
  const [memory, setMemory] = useState<Record<MemoryScope, string>>(lib.memory);
  const [scope, setScope] = useState<MemoryScope>('all');
  const [saved, setSaved] = useState(false);
  const max = TOOL_LIMITS.maxMemoryChars;
  const scopeName = (s: MemoryScope) => (s === 'all' ? t.tools.allMembers : PROVIDER_LABEL[s]);
  const changed = MEMORY_SCOPES.filter((s) => memory[s] !== lib.memory[s]);

  return (
    <div className="tools-section">
      <h4>{t.tools.memory}</h4>
      <p className="muted small">{t.tools.memoryHint}</p>
      <div className="segmented memory-scopes" role="tablist" aria-label={t.tools.memory}>
        {MEMORY_SCOPES.map((s) => (
          <button
            key={s}
            role="tab"
            aria-selected={scope === s}
            className={scope === s ? 'on' : ''}
            style={s === 'all' ? undefined : { ['--accent' as string]: PROVIDER_COLOR[s] }}
            onClick={() => setScope(s)}
          >
            {scopeName(s)}
            {memory[s].trim() && <span className="scope-dot" aria-hidden="true" />}
          </button>
        ))}
      </div>
      <textarea
        className="memory-input"
        value={memory[scope]}
        rows={6}
        maxLength={max}
        aria-label={t.tools.memoryFor(scopeName(scope))}
        placeholder={t.tools.memoryPlaceholder}
        onChange={(e) => {
          setMemory({ ...memory, [scope]: e.target.value });
          setSaved(false);
        }}
      />
      <div className="button-row">
        <span className="muted small">{saved && !changed.length ? t.tools.saved : t.tools.chars(memory[scope].length, max)}</span>
        <button
          className="primary"
          disabled={!changed.length}
          onClick={async () =>
            setSaved(await change(() => api.updateTools({ memory: Object.fromEntries(changed.map((s) => [s, memory[s]])) })))
          }
        >
          {t.common.save}
        </button>
      </div>
    </div>
  );
}
