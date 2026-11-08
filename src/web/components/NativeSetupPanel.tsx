import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  PROVIDER_LABEL,
  sameNativeItems,
  type FilePreview,
  type NativeItemKind,
  type NativeMcpServer,
  type NativeSetup,
  type Provider,
  type ProviderSettingsUpdate,
  type ProviderSettingsView,
  type SettingsView,
} from '../../shared/types';
import { api } from '../api';
import { isMarkdown, lineCount } from '../files';
import { useT } from '../i18n';
import {
  TAB_PART,
  canLeaveOutAll,
  canPick,
  canPickIn,
  isPicked,
  nativeLeftOutCount,
  nativeOffTotal,
  nativeTabs,
  sameNativeParts,
  tabPicked,
  unlistedPicks,
  withItem,
  withoutPicks,
  withoutTab,
  type NativeTab,
} from '../native';
import { formatBytes, relativeTime } from '../util';
import { TextContent } from './FileBrowser';
import { GrokTrustNote } from './GrokTrust';
import { useDialog } from './useDialog';

type ItemState = { enabled?: boolean; leftOut?: boolean; stillLoaded?: boolean };

/**
 * The badges an item gets: turned off by the CLI itself, left out of Harness Relay's runs, or
 * ticked to be left out while the CLI, asked again, still loads it.
 */
function StateBadges({ item, still }: { item: ItemState; still?: boolean }) {
  const t = useT();
  return (
    <>
      {item.enabled === false && <span className="badge">{t.native.off}</span>}
      {item.leftOut && (
        <span className="badge warn" title={t.native.leftOutTitle}>
          {t.native.leftOut}
        </span>
      )}
      {still && (
        <span className="badge warn" title={t.native.stillLoadedTitle}>
          {t.native.stillLoaded}
        </span>
      )}
    </>
  );
}

/**
 * What a CLI loads by itself (its own skills, MCP servers and their tools, built-in tools, hooks,
 * subagents, plugins, instruction and memory files), in a tab each, and what of it Harness Relay's
 * runs leave out: each tab has a switch that leaves all of its kind out, and a box on each item the
 * CLI can leave out alone. Saved as soon as one is changed; the CLI's own settings stay. The CLI is
 * asked only when the user clicks Ask: asking starts it briefly (Claude Code runs SessionStart
 * hooks; it and Codex start MCP servers), and someone may open this section to turn off an MCP
 * server precisely because starting it does harm. With something left out, the server asks the CLI
 * again the way Harness Relay starts it and marks what is then left out.
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
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [tab, setTab] = useState<NativeTab>('skills');
  const [query, setQuery] = useState('');
  /** The reported file being read. */
  const [viewing, setViewing] = useState<string | null>(null);
  /** MCP servers whose tool list the user opened or closed (by name); the rest open while one of their tools is ticked. */
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

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

  // What is being saved shows at once; it goes back if saving fails.
  const [saving, setSaving] = useState<Pick<ProviderSettingsUpdate, 'nativeOff' | 'nativeItems'> | null>(null);
  const off = saving?.nativeOff ?? settings?.nativeOff ?? [];
  const items = saving?.nativeItems ?? settings?.nativeItems ?? {};
  const save = async (update: Pick<ProviderSettingsUpdate, 'nativeOff' | 'nativeItems'>) => {
    setBusy(true);
    setSaveError('');
    setSaving(update);
    try {
      onSettings(await api.updateProvider(provider, update));
    } catch (e) {
      setSaveError((e as Error).message);
    } finally {
      setSaving(null);
      setBusy(false);
    }
  };

  const q = query.trim().toLowerCase();
  const match = (...texts: (string | undefined)[]) => !q || texts.some((s) => s?.toLowerCase().includes(q));
  const tabs = nativeTabs(provider, setup);
  const shown = tabs.some((x) => x.tab === tab) ? tab : 'skills';
  const part = TAB_PART[shown];
  const partOff = off.includes(part);
  const picked = tabPicked(items, shown);
  // Whether this answer was given with what is left out now; if not, its marks may no longer hold.
  const current = Boolean(setup && settings && sameNativeParts(setup.nativeOff, off) && sameNativeItems(setup.nativeItems ?? {}, items));
  const stale = Boolean(setup && settings && !current);
  const counts = setup ? { skills: setup.skills.length, mcp: setup.mcpServers.length, memory: setup.memory.length } : null;
  const total = nativeOffTotal(off, items);

  /** The box that leaves one item out, when the CLI can leave it out alone. */
  const box = (kind: NativeItemKind, id: string | undefined, name: string, locked = partOff) =>
    canPick(provider, kind) && id ? (
      <input
        type="checkbox"
        className="native-pick"
        checked={isPicked(items, kind, id)}
        disabled={busy || !settings || locked}
        onChange={(e) => void save({ nativeItems: withItem(items, kind, id, e.target.checked) })}
        aria-label={t.native.pick(name)}
        title={t.native.pick(name)}
      />
    ) : null;
  // Marked by the server, for the lists it asked about again; only while that answer is current.
  const still = (item: ItemState) => current && Boolean(item.stillLoaded);
  const unlisted = setup && current ? unlistedPicks(setup, items, shown) : [];
  const row = (key: string, pick: ReactNode, body: ReactNode, title?: string) => (
    <li key={key} className={pick ? 'pickable' : undefined} title={title}>
      {pick}
      <div className="native-item">{body}</div>
    </li>
  );

  return (
    <details className="sub native-setup">
      <summary>
        {t.native.title}
        {counts && ` (${t.native.summary(counts.skills, counts.mcp, counts.memory)})`}
        {total ? <span className="badge">{t.native.offCount(total)}</span> : null}
      </summary>
      <div className="sub-body">
        <p className="muted small">{t.native.offHint}</p>
        {provider === 'codex' && <p className="muted small">{t.native.offCodexThreads}</p>}
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
        <div className="segmented native-tabs" role="tablist">
          {tabs.map(({ tab: k, count }) => {
            const n = tabPicked(items, k);
            const tabOff = off.includes(TAB_PART[k]);
            return (
              <button key={k} role="tab" aria-selected={shown === k} className={shown === k ? 'on' : ''} onClick={() => setTab(k)}>
                {t.native.tabs[k]}
                {count !== undefined && ` (${count})`}
                {(tabOff || n > 0) && <span className="native-tab-off">{tabOff ? t.native.tabOff : t.native.tabPicked(n)}</span>}
              </button>
            );
          })}
        </div>
        <div className="native-part">
          {canLeaveOutAll(provider, shown) && (
            <label className="check-row">
              <input
                type="checkbox"
                checked={partOff}
                disabled={busy || !settings}
                onChange={(e) => void save({ nativeOff: e.target.checked ? [...off, part] : off.filter((p) => p !== part) })}
              />
              <span>{t.native.offAll}</span>
            </label>
          )}
          <span className="muted small">{t.native.offNotes[provider][part]}</span>
        </div>
        {canLeaveOutAll(provider, shown) && !canPickIn(provider, shown) && (
          <p className="muted small">{provider === 'claude' && shown === 'hooks' ? t.native.claudeHooks : t.native.cannotPick(PROVIDER_LABEL[provider])}</p>
        )}
        {picked > 0 &&
          (partOff ? (
            <p className="muted small">{t.native.offAllOn}</p>
          ) : (
            <p className="muted small">
              {t.native.picked(picked)}{' '}
              <button type="button" className="link-button" onClick={() => void save({ nativeItems: withoutTab(items, shown) })} disabled={busy || !settings}>
                {t.native.clearPicked}
              </button>
            </p>
          ))}
        {unlisted.length > 0 && (
          <p className="muted small">
            {t.native.unlisted(unlisted.length)}{' '}
            <button type="button" className="link-button" onClick={() => void save({ nativeItems: withoutPicks(items, unlisted) })} disabled={busy || !settings}>
              {t.native.clearUnlisted}
            </button>
          </p>
        )}
        {saveError && <p className="error-line">{saveError}</p>}
        {shown === 'mcp' && provider === 'claude' && <p className="muted small">{t.native.claudeMcp}</p>}
        {shown === 'mcp' && provider === 'codex' && <p className="muted small">{t.native.codexMcp}</p>}
        {shown === 'tools' && <p className="muted small">{t.native.claudeTools}</p>}
        {shown === 'skills' && provider === 'claude' && <p className="muted small">{t.native.claudeSkills}</p>}
        {shown === 'agents' && provider === 'claude' && <p className="muted small">{t.native.claudeAgents}</p>}
        {shown === 'hooks' && <p className="muted small">{t.native.hooksNote}</p>}
        {(shown === 'instructions' || shown === 'memory') && setup && (
          <p className="muted small">{setup.memoryFromFiles ? t.native.fromFiles : t.native.fromCli}</p>
        )}
        {shown === 'memory' && provider === 'grok' && <p className="muted small">{t.native.grokMemory}</p>}
        {!setup ? (
          <p className="muted small">{t.native.askFirst}</p>
        ) : (
          <>
            {shown !== 'memory' && shown !== 'instructions' && (
              <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t.native.filter} aria-label={t.native.filter} />
            )}
            {shown === 'skills' && (
              <List empty={!setup.skills.length}>
                {setup.skills
                  .filter((s) => match(s.name, s.description))
                  .map((s, i) =>
                    row(
                      `${s.name}-${i}`,
                      box('skills', s.id, s.name),
                      <>
                        <span className="native-name">
                          {s.path ? (
                            <button type="button" className="link-button" onClick={() => setViewing(s.path!)}>
                              {s.name}
                            </button>
                          ) : (
                            s.name
                          )}
                          {s.source && <span className="badge">{s.source}</span>}
                          <StateBadges item={s} still={still(s)} />
                        </span>
                        {s.description && <span className="native-description">{s.description}</span>}
                      </>,
                      s.path,
                    ),
                  )}
              </List>
            )}
            {shown === 'mcp' && (
              <List empty={!setup.mcpServers.length}>
                {setup.mcpServers
                  .filter((s) => match(s.name, s.source) || (s.tools ?? []).some((x) => match(x.name)))
                  .map((s, i) => row(`${s.name}-${i}`, box('mcp', s.id, s.name), mcpServer(s)))}
              </List>
            )}
            {shown === 'tools' &&
              (setup.builtinTools ? (
                <List empty={!setup.builtinTools.length}>
                  {setup.builtinTools
                    .filter((x) => match(x.name))
                    .map((x) =>
                      row(
                        x.name,
                        box('tools', x.id, x.name),
                        <span className="native-name">
                          <code>{x.name}</code>
                          <StateBadges item={x} still={still(x)} />
                        </span>,
                      ),
                    )}
                </List>
              ) : (
                <p className="muted small">{t.native.notListed}</p>
              ))}
            {shown === 'hooks' &&
              (setup.hooks ? (
                <List empty={!setup.hooks.length}>
                  {setup.hooks
                    .filter((h) => match(h.event, h.matcher, h.source, h.file))
                    .map((h, i) =>
                      row(
                        `${h.event}-${i}`,
                        box('hooks', h.id, h.event),
                        <>
                          <span className="native-name">
                            {h.event}
                            {h.matcher && <code>{h.matcher}</code>}
                            {h.source && <span className="badge">{h.source}</span>}
                            <StateBadges item={h} still={still(h)} />
                          </span>
                          {h.file && (
                            <span className="native-description">
                              <code>{h.file}</code>
                            </span>
                          )}
                        </>,
                      ),
                    )}
                </List>
              ) : (
                <p className="muted small">{t.native.notListed}</p>
              ))}
            {shown === 'agents' &&
              (setup.agents ? (
                <List empty={!setup.agents.length}>
                  {setup.agents
                    .filter((a) => match(a.name, a.description, a.source))
                    .map((a, i) =>
                      row(
                        `${a.name}-${i}`,
                        // "Leave all out" keeps the built-in ones, which can still be ticked.
                        box('agents', a.id, a.name, partOff && a.source !== 'built-in'),
                        <>
                          <span className="native-name">
                            {a.name}
                            {a.source && <span className="badge">{a.source}</span>}
                            <StateBadges item={a} still={still(a)} />
                          </span>
                          {a.description && <span className="native-description">{a.description}</span>}
                        </>,
                      ),
                    )}
                </List>
              ) : (
                <p className="muted small">{t.native.notListed}</p>
              ))}
            {shown === 'plugins' &&
              (setup.plugins ? (
                <List empty={!setup.plugins.length}>
                  {setup.plugins
                    .filter((p) => match(p.name, p.source))
                    .map((p, i) =>
                      row(
                        `${p.name}-${i}`,
                        box('plugins', p.id, p.name),
                        <span className="native-name">
                          {p.name}
                          {p.source && <span className="badge">{p.source}</span>}
                          <StateBadges item={p} still={still(p)} />
                        </span>,
                      ),
                    )}
                </List>
              ) : (
                <p className="muted small">{t.native.notListed}</p>
              ))}
            {(shown === 'instructions' || shown === 'memory') && (
              <List empty={!setup.memory.some((m) => m.kind === shown)}>
                {setup.memory
                  .filter((m) => m.kind === shown)
                  .map((m) =>
                    row(
                      m.path,
                      box('instructions', m.id, m.path),
                      <span className="native-name">
                        <button type="button" className="link-button native-file" onClick={() => setViewing(m.path)} title={t.native.preview}>
                          <code>{m.path}</code>
                        </button>
                        <StateBadges item={m} still={still(m)} />
                      </span>,
                    ),
                  )}
              </List>
            )}
          </>
        )}
      </div>
      {viewing && <ReportedFile provider={provider} path={viewing} onClose={() => setViewing(null)} />}
    </details>
  );

  /** An MCP server: its name and state, and its tools, each with its own box (rendered in place, not as a component, so its list stays open). */
  function mcpServer(s: NativeMcpServer) {
    const serverPicked = isPicked(items, 'mcp', s.id);
    const tools = (s.tools ?? []).filter((x) => match(s.name, s.source) || match(x.name));
    const someTicked = (s.tools ?? []).some((x) => isPicked(items, 'mcpTools', x.id));
    // Open while filtering; else as the user left it, at first open when one of its tools is ticked.
    const open = Boolean(q) || (expanded[s.name] ?? someTicked);
    return (
      <>
        <span className="native-name">
          {s.name}
          {s.transport && <span className="badge">{s.transport}</span>}
          {s.status && <span className={`badge ${s.status === 'connected' ? 'ok' : ''}`}>{s.status}</span>}
          <StateBadges item={s} still={still(s)} />
        </span>
        <span className="native-description">{[s.source && t.native.source(s.source), s.tools && t.native.tools(s.tools.length)].filter(Boolean).join(' · ')}</span>
        {tools.length > 0 && (
          <details
            className="native-server-tools"
            open={open}
            onToggle={(e) => {
              const now = e.currentTarget.open;
              // What the user did, and how it first opened (so unticking its last tool does not close it);
              // not the filter opening it.
              if (!q && (now !== open || expanded[s.name] === undefined)) setExpanded((x) => ({ ...x, [s.name]: now }));
            }}
          >
            <summary className="muted small">{t.native.tools(s.tools!.length)}</summary>
            <ul>
              {tools.map((x) => (
                <li key={x.name} className={canPick(provider, 'mcpTools') && x.id ? 'pickable' : undefined}>
                  {/* A server left out (or ticked) takes all its tools with it. */}
                  {box('mcpTools', x.id, `${s.name} · ${x.name}`, partOff || serverPicked || Boolean(s.leftOut))}
                  <span className="native-name">
                    <code>{x.name}</code>
                    <StateBadges item={x} still={still(x)} />
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </>
    );
  }
}

/** A list of reported items, or "None." when there are none. */
function List({ empty, children }: { empty: boolean; children: ReactNode }) {
  const t = useT();
  return empty ? <p className="muted small">{t.native.none}</p> : <ul className="native-list">{children}</ul>;
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
