import { type ReactNode, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import '../toolLibrary.css';
import {
  type CheckList,
  type OAuthView,
  type ConnectorsView,
  MEMORY_SCOPES,
  PROVIDERS,
  PROVIDER_LABEL,
  TOOL_LIMITS,
  type McpServerView,
  type McpTransport,
  type MemoryScope,
  type Provider,
  type SettingsView,
  type RelayToolGroup,
  type SkillCandidate,
  type ToolLibraryView,
} from '../../shared/types';
import { api } from '../api';
import { checkProblems, hooksFromRows, sameChecks } from '../checks';
import { useT, type Messages } from '../i18n';
import { sameServerUrl } from '../oauth';
import { PROVIDER_COLOR } from '../util';
import { itemId, sectionId, settingsHref, type LibraryItem } from '../route';
import { ChecksEditor, HooksEditor, useChecksEnvironment } from './ChecksEditor';
import { AppDependencyInstall } from './AppDependencyInstall';
import { CommonApps } from './CommonApps';
import { AccountSignInProvider } from './OAuthAccounts';
import { ConnectorsSettings } from './ConnectorsSettings';
import { McpSignIn } from './McpSignIn';
import { SectionTitle } from './SectionTitle';
import { useDialog } from './useDialog';

/** Settings → Tool library: MCP servers, skills and the shared memory every agent can be given. */
export function ToolsCard({
  settings,
  tab,
  activeApps,
  draftLink,
}: {
  activeApps: boolean;
  settings: SettingsView | null;
  tab: 'apps' | 'tools';
  draftLink?: ReactNode;
}) {
  const env = useChecksEnvironment();
  const t = useT();
  const [lib, setLib] = useState<ToolLibraryView | null>(null);
  const [error, setError] = useState('');

  const tabs = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    // Back and Forward can switch tabs while focus is still on the previous tab.
    if (tabs.current?.contains(document.activeElement)) {
      tabs.current.querySelector<HTMLElement>('[aria-selected="true"]')?.focus({ preventScroll: true });
    }
  }, [tab]);
  const [appError, setAppError] = useState('');
  const [oauth, setOauth] = useState<OAuthView | null>(null);
  const [connectors, setConnectors] = useState<ConnectorsView | null>(null);
  const [oauthError, setOauthError] = useState('');
  const [connectorError, setConnectorError] = useState('');
  const oauthRead = useRef(0);
  const reloadOAuth = useCallback(async () => {
    const id = ++oauthRead.current;
    const current = await api.oauth();
    if (id === oauthRead.current) setOauth(current);
  }, []);
  // A connector mutation returns a snapshot of both services. An older response can arrive
  // after a newer mutation, so read current state after each write and apply only the latest read.
  const connectorRead = useRef(0);
  const reloadConnectors = useCallback(async () => {
    const id = ++connectorRead.current;
    const latest = await api.connectors();
    if (id === connectorRead.current) setConnectors(latest);
  }, []);
  const refreshAccounts = async () => {
    setOauthError('');
    setConnectorError('');
    await Promise.all([
      reloadOAuth().catch((e: Error) => setOauthError(e.message)),
      reloadConnectors().catch((e: Error) => setConnectorError(e.message)),
    ]);
  };

  useEffect(() => {
    void refreshAccounts();
    api.tools().then(setLib, (e: Error) => setError(e.message));
  }, []);

  // The endpoint returns a whole-library snapshot. Apply concurrent edits in the order requested.
  const pendingChange = useRef(Promise.resolve());
  /** Runs a change and shows the library it returns, or the error. */
  const change = async (call: () => Promise<ToolLibraryView>, report: (error: string) => void = setError): Promise<boolean> => {
    report('');
    try {
      const result = pendingChange.current.then(call);
      pendingChange.current = result.then(
        () => undefined,
        () => undefined,
      );
      setLib(await result);
      return true;
    } catch (e) {
      report((e as Error).message);
      return false;
    }
  };

  return (
    <section className="card tools-card" id={sectionId('apps')} aria-label={t.settings.nav.apps}>
      <SectionTitle section={tab}>{t.settings.nav.apps}</SectionTitle>
      {draftLink}
      <div ref={tabs} className="segmented apps-tools-tabs" role="tablist" aria-label={t.settings.nav.apps}>
        {(['apps', 'tools'] as const).map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            id={'tab-' + key}
            aria-selected={tab === key}
            aria-controls={key === 'apps' ? 'common-apps-panel' : 'settings-tools'}
            tabIndex={tab === key ? 0 : -1}
            className={tab === key ? 'on' : undefined}
            onClick={() => {
              location.hash = settingsHref(key);
            }}
            onKeyDown={(e) => {
              let next: 'apps' | 'tools';
              if (e.key === 'Home') next = 'apps';
              else if (e.key === 'End') next = 'tools';
              else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') next = key === 'apps' ? 'tools' : 'apps';
              else return;
              e.preventDefault();
              document.getElementById('tab-' + next)?.focus();
              location.hash = settingsHref(next);
            }}
          >
            {key === 'apps' ? t.apps.title : t.tools.title}
          </button>
        ))}
      </div>
      <div role="tabpanel" id="common-apps-panel" aria-labelledby="tab-apps" className="apps-tools-panel" hidden={tab !== 'apps'}>
        {(appError || oauthError || connectorError) && (
          <p className="error-line" role="alert">
            {[appError, oauthError, connectorError].filter(Boolean).join(' ')}
          </p>
        )}
        {lib ? (
          <AccountSignInProvider>
            <CommonApps
              activeApps={activeApps}
              lib={lib}
              oauth={oauth}
              hostedAccounts={{
                claude: settings?.providers.find((p) => p.provider === 'claude')?.accounts ?? [],
                codex: settings?.providers.find((p) => p.provider === 'codex')?.accounts ?? [],
              }}
              connectors={connectors}
              accountSettings={(kind) => (
                <ConnectorsSettings
                  kind={kind}
                  view={connectors}
                  reloadConnectors={reloadConnectors}
                  oauth={oauth}
                  reloadOAuth={reloadOAuth}
                />
              )}
              relayAccess={(group) => <RelayAccess group={group} lib={lib} change={(call) => change(call, setAppError)} />}
              browserSettings={<BrowserPath lib={lib} change={(call) => change(call, setAppError)} />}
              change={(call, report = setAppError) => change(call, report)}
              refreshAccounts={refreshAccounts}
            />
          </AccountSignInProvider>
        ) : (
          <p>{error || t.common.loading}</p>
        )}
      </div>
      <div role="tabpanel" id="settings-tools" aria-labelledby="tab-tools" className="apps-tools-panel" hidden={tab !== 'tools'}>
        <p className="muted small">
          {t.tools.hint} <a href={settingsHref('agents')}>{t.tools.agentSettings}</a>
        </p>
        {error && <p className="error-line">{error}</p>}
        {!lib ? (
          !error && <p className="muted small">{t.common.loading}</p>
        ) : (
          <div className="library-categories">
            <McpSection lib={lib} change={change} />
            <SkillsSection lib={lib} change={change} />
            <MemorySection lib={lib} change={change} />
            {settings && (
              <>
                <ChecksDefaultSection part="hooks" defaults={settings.checksDefault} env={env} />
                <ChecksDefaultSection part="checks" defaults={settings.checksDefault} env={env} />
              </>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

type Change = (call: () => Promise<ToolLibraryView>) => Promise<boolean>;

/**
 * A native disclosure keeps its editors and any unsaved changes mounted when folded. `item`: which part of
 * the library it is, for its own link (#/settings/tools/<item>), which opens it.
 */
function LibraryCategory({ item, title, hint, children }: { item: LibraryItem; title: string; hint: string; children: ReactNode }) {
  const hintId = useId();
  return (
    <details id={itemId(item)} className="library-category" aria-label={title}>
      <summary aria-label={title} aria-describedby={hintId}>
        <h4 aria-label={title}>
          {title}
          <span className="library-category-hint" id={hintId}>
            {hint}
          </span>
        </h4>
      </summary>
      <div className="tools-section library-category-body">{children}</div>
    </details>
  );
}

/** Who gets an item by default, in a few words (`all`: the CLIs that can get it). */
function givenTo(providers: Provider[], t: Messages, all: readonly Provider[] = PROVIDERS): string {
  if (providers.length === all.length) return t.tools.allMembers;
  if (!providers.length) return t.tools.offByDefault;
  return t.tools.onlyFor(providers.map((p) => PROVIDER_LABEL[p]).join(t.common.listSeparator));
}

/** One toggle per CLI: the CLIs whose agents get an item by default (of `choices`, every CLI unless given). */
function ProviderPicks({
  value,
  onChange,
  label,
  choices = PROVIDERS,
}: {
  value: Provider[];
  onChange: (v: Provider[]) => void;
  label: string;
  choices?: readonly Provider[];
}) {
  return (
    <div className="provider-picks" role="group" aria-label={label}>
      {choices.map((p) => {
        const on = value.includes(p);
        return (
          <button
            key={p}
            type="button"
            aria-pressed={on}
            className={on ? 'on' : ''}
            style={{ ['--accent' as string]: PROVIDER_COLOR[p] }}
            onClick={() => onChange(on ? value.filter((x) => x !== p) : choices.filter((x) => x === p || value.includes(x)))}
          >
            {PROVIDER_LABEL[p]}
          </button>
        );
      })}
    </div>
  );
}

/** Harness Relay's own tool groups (through the gateway), and which CLIs' members get each. */
function RelayAccess({ group, lib, change }: { group: RelayToolGroup; lib: ToolLibraryView; change: Change }) {
  const t = useT();
  const providers = lib.relayTools.find((g) => g.group === group)?.providers ?? [];
  const [saving, setSaving] = useState(false);
  const setAccess = async (next: Provider[]) => {
    setSaving(true);
    try {
      await change(() => api.updateTools({ relayTools: { [group]: next } }));
    } finally {
      setSaving(false);
    }
  };
  return (
    <details className="sub app-chat-access">
      <summary>{group === 'slack' ? t.apps.postingAssistants(providers.length) : t.apps.chatAccess(providers.length)}</summary>
      <fieldset className="sub-body app-access-controls" disabled={saving} aria-label={t.tools.givenTo}>
        <p className="small muted">
          {group === 'browser' || group === 'computer' || group === 'obsidian' ? t.apps.deviceGrant : t.apps.grantHint}
        </p>
        {(!lib.gateway.available || lib.gateway.reason) && (
          <p className="warn-line small">{t.tools.relay.unavailable[lib.gateway.reason ?? 'not-started']}</p>
        )}
        <ProviderPicks value={providers} label={`${t.tools.relay.groups[group]} · ${t.tools.givenTo}`} onChange={setAccess} />
        <button type="button" className="link-button" onClick={() => void setAccess(providers.length ? [] : [...PROVIDERS])}>
          {providers.length ? t.apps.disable : t.apps.enable}
        </button>
      </fieldset>
    </details>
  );
}

/**
 * Which browser the browser tools start: a path of the user's (`browser` in the library), else
 * RELAY_BROWSER's, else the first found; and the one in use now, or none found.
 */
function BrowserPath({ lib, change }: { lib: ToolLibraryView; change: Change }) {
  const t = useT();
  const saved = lib.browser.path ?? '';
  const [path, setPath] = useState(saved);
  const [busy, setBusy] = useState(false);
  const [installed, setInstalled] = useState(false);
  useEffect(() => setPath(saved), [saved]);
  const save = async () => {
    setBusy(true);
    await change(() => api.updateTools({ browser: path.trim() }));
    setBusy(false);
  };
  const dirty = path.trim() !== saved;
  return (
    <details className="sub browser-path" open={Boolean(saved) || !lib.browser.using || installed}>
      <summary>
        {t.tools.relay.browserPath}
        {saved && ` (${saved})`}
      </summary>
      <div className="sub-body">
        <p className="muted small">{t.tools.relay.browserPathHint(lib.browser.env ?? '')}</p>
        <div className="input-row">
          <input
            value={path}
            placeholder={lib.browser.using ?? ''}
            aria-label={t.tools.relay.browserPath}
            onChange={(e) => setPath(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !busy && dirty && void save()}
            spellCheck={false}
          />
          <button className="ghost" onClick={() => void save()} disabled={busy || !dirty}>
            {t.common.save}
          </button>
        </div>
        <p role={installed ? 'status' : undefined} className={`small ${lib.browser.using ? 'muted' : 'warn-text'}`}>
          {lib.browser.using ? t.tools.relay.browserUsing(lib.browser.using) : t.tools.relay.browserNone}
        </p>
        {!lib.browser.using && (
          <AppDependencyInstall
            name="browser"
            onReady={async () => {
              setInstalled(true);
              await change(api.tools);
            }}
          />
        )}
      </div>
    </details>
  );
}

function McpSection({ lib, change }: { lib: ToolLibraryView; change: Change }) {
  const t = useT();
  /** The server being edited ('' = a new one), or null. */
  const [editing, setEditing] = useState<string | null>(null);

  return (
    <LibraryCategory item="mcp" title={t.tools.mcp} hint={t.tools.categories.mcp}>
      <p className="muted small">
        {t.tools.mcpHint} {t.tools.secretsIn(t.settings.keyStorageName[lib.secretStorage])}
      </p>
      <p className="muted small">{t.tools.signIn.hint}</p>
      {lib.mcpServers.length === 0 && editing === null && <p className="muted small">{t.tools.noMcp}</p>}
      <ul className="lib-list">
        {lib.mcpServers.map((s) =>
          editing === s.name ? (
            <li key={s.name}>
              <McpForm server={s} change={change} onDone={() => setEditing(null)} />
            </li>
          ) : (
            <li key={s.name} className={`lib-row ${s.transport === 'http' ? 'mcp-http' : ''}`}>
              <div className="lib-row-main">
                <span className="lib-name">{s.name}</span>
                <code className="lib-detail">{s.transport === 'http' ? s.url : [s.command, ...s.args].join(' ')}</code>
                <span className={`tool-scope ${s.providers.length ? '' : 'off'}`}>{givenTo(s.providers, t)}</span>
                {s.oauth && (
                  <span className={`badge ${s.oauth.status === 'reauth' ? 'warn' : ''}`}>
                    {s.oauth.status === 'reauth' ? t.tools.signIn.reauth : t.tools.signIn.signedIn}
                  </span>
                )}
              </div>
              <div className="lib-row-actions">
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
              {s.transport === 'http' && <McpSignIn server={s} change={change} />}
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
    </LibraryCategory>
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
  // A server signed in: another URL or transport is another server, and signs it out (said, louder once changed).
  const signsOut = Boolean(server?.oauth && (transport !== server.transport || !sameServerUrl(url, server.url)));

  const save = async () => {
    setSaving(true);
    const ok = await change(() =>
      api.saveMcpServer(name.trim(), {
        transport,
        ...(http
          ? { url: url.trim(), headers: vars(headers) }
          : {
              command: command.trim(),
              args: args
                .split('\n')
                .map((a) => a.trim())
                .filter(Boolean),
              env: vars(env),
            }),
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
              <button
                key={tr}
                role="radio"
                aria-checked={transport === tr}
                className={transport === tr ? 'on' : ''}
                onClick={() => setTransport(tr)}
              >
                {t.tools[tr]}
              </button>
            ))}
          </div>
        </div>
      </div>
      {server?.oauth && (
        <p className={`small ${signsOut ? 'warn-text' : 'muted'}`} role={signsOut ? 'alert' : undefined}>
          {t.tools.signIn.changeSignsOut}
        </p>
      )}
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
            <label className="field">
              <span>{t.tools.varName}</span>
              <input
                value={r.name}
                spellCheck={false}
                onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
              />
            </label>
            <label className="field">
              <span>{t.tools.varValue}</span>
              <input
                value={r.value}
                type="password"
                autoComplete="off"
                placeholder={keeps(r) ? t.tools.keepValue(r.masked!) : undefined}
                onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
              />
            </label>
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
      <details className="sub library-access">
        <summary>
          {t.tools.givenTo} · {t.tools.defaultAccess(providers.length, PROVIDERS.length)}
        </summary>
        <div className="field">
          <ProviderPicks value={providers} onChange={setProviders} label={t.tools.givenTo} />
          <span className="muted small">{givenTo(providers, t)}</span>
        </div>
      </details>
      <div className="button-row">
        <button className="ghost" onClick={onDone}>
          {t.common.cancel}
        </button>
        {renamed.length > 0 && (
          <span className="warn-line small">
            {t.tools.renamedNeedsValue(renamed.map((r) => r.name.trim()).join(t.common.listSeparator))}
          </span>
        )}
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
    <LibraryCategory item="skills" title={t.tools.skills} hint={t.tools.categories.skills}>
      <p className="muted small">{t.tools.skillsHint}</p>
      {lib.skills.length === 0 && <p className="muted small">{t.tools.noSkills}</p>}
      <ul className="lib-list">
        {lib.skills.map((s, i) => (
          <li key={s.path} className="lib-row">
            <div className="lib-row-main">
              <span className="lib-name">{s.name}</span>
              {s.description && <span className="lib-description">{s.description}</span>}
              <code className="lib-detail" title={s.path}>
                {s.path}
              </code>
              {s.problem && <span className="warn-line">{s.problem}</span>}
              <details className="sub library-access">
                <summary>
                  {t.tools.givenTo} · {t.tools.defaultAccess(s.providers.length, PROVIDERS.length)}
                </summary>
                <ProviderPicks
                  value={s.providers}
                  label={`${s.name}: ${t.tools.givenTo}`}
                  onChange={(providers) =>
                    change(() => api.updateTools({ skills: list.map((x, j) => (j === i ? { ...x, providers } : x)) }))
                  }
                />
              </details>
            </div>
            <div className="lib-row-actions">
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
    </LibraryCategory>
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
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t.tools.filterSkills}
            aria-label={t.tools.filterSkills}
          />
          <button className="link-button" onClick={() => setChosen(new Set([...chosen, ...selectable.map((s) => s.path)]))}>
            {t.tools.selectAll}
          </button>
          <button
            className="link-button"
            onClick={() => setChosen(new Set([...chosen].filter((p) => !selectable.some((s) => s.path === p))))}
          >
            {t.tools.selectNone}
          </button>
        </div>
        <ul className="skill-picker-list">
          {shown.map((s) => (
            <li key={s.path}>
              <label className={`skill-option ${s.added ? 'added' : ''}`}>
                <input
                  type="checkbox"
                  disabled={s.added}
                  checked={s.added || chosen.has(s.path)}
                  onChange={(e) => toggle(s.path, e.target.checked)}
                />
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
    <LibraryCategory item="memory" title={t.tools.memory} hint={t.tools.categories.memory}>
      <p className="muted small">{t.tools.memoryHint}</p>
      <div className="segmented cli-picker memory-scopes" role="tablist" aria-label={t.tools.memory}>
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
    </LibraryCategory>
  );
}

/** One independently saved section of the defaults copied into new chats and automations. */
function ChecksDefaultSection({
  part,
  defaults,
  env,
}: {
  part: 'hooks' | 'checks';
  defaults?: CheckList;
  env: ReturnType<typeof useChecksEnvironment>;
}) {
  const t = useT();
  const hooksOnly = part === 'hooks';
  const sectionOf = (list: CheckList = {}): CheckList => {
    const { hooks, ...checks } = list;
    return hooksOnly ? { hooks } : checks;
  };
  const [saved, setSaved] = useState(() => sectionOf(defaults));
  const [draft, setDraft] = useState<CheckList | undefined>(saved);
  const [opened, setOpened] = useState(0);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const changed = !sameChecks(draft, saved);
  const problem = checkProblems(draft, t.checks)[0];
  const edit = (next: CheckList | undefined) => {
    setDraft(next);
    setDone(false);
    setError('');
  };
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const patch = hooksOnly
        ? { hooks: draft?.hooks ?? [] }
        : {
            protectedPaths: draft?.protectedPaths ?? [],
            commitPattern: draft?.commitPattern ?? '',
            commands: draft?.commands ?? [],
            previewApp: Boolean(draft?.previewApp),
            autoFix: Boolean(draft?.autoFix),
          };
      const kept = sectionOf(await api.updateCheckDefaults(patch));
      setSaved(kept);
      setDraft(kept);
      setOpened((n) => n + 1);
      setDone(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const title = hooksOnly ? t.checks.hooks : t.tools.checksDefault;
  return (
    <LibraryCategory item={part} title={title} hint={t.tools.categories[part]}>
      <p className="muted small">{hooksOnly ? t.tools.hooksDefaultHint : t.tools.checksDefaultHint}</p>
      <fieldset className="team-fieldset" disabled={busy} aria-label={title}>
        {hooksOnly ? (
          <HooksEditor key={opened} value={saved.hooks} env={env} onChange={(hooks) => edit({ hooks: hooksFromRows(hooks) })} />
        ) : (
          <ChecksEditor key={opened} value={draft} onChange={edit} env={env} variant="defaults" />
        )}
      </fieldset>
      {(problem || error) && <p className="error-line">{problem || error}</p>}
      <div className="button-row">
        <span className="muted small" role="status">
          {done && !changed ? t.tools.saved : ''}
        </span>
        <button className="primary" disabled={busy || !changed || Boolean(problem)} onClick={() => void save()}>
          {t.common.save}
        </button>
      </div>
    </LibraryCategory>
  );
}
