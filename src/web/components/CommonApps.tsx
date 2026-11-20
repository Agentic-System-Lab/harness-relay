import { useEffect, useRef, useState } from 'react';
import {
  PROVIDERS,
  type ConnectorsView,
  type GithubConnection,
  type OAuthUse,
  type OAuthView,
  type RelayToolGroup,
  type ToolLibraryView,
} from '../../shared/types';
import { APP_SERVERS } from '../../shared/apps';
import { api } from '../api';
import { useT } from '../i18n';
import { settingsHref } from '../route';
import { AppSignIn } from './McpSignIn';
import { ClaudeConnectorLink } from './ClaudeConnectorLink';
import { GoogleProjectConnection } from './GoogleProjectConnection';
import { TeamsSignIn } from './TeamsSignIn';
import { GhSignIn } from './GhHelp';

const accounts = { mail: 'Gmail', drive: 'Google Drive', calendar: 'Google Calendar', teams: 'Microsoft Teams' } as const;
// Official “Add to Claude” destinations for Google's Drive and Calendar connectors.
const googleInClaude = {
  drive: 'https://claude.ai/directory/b89f7865-a755-4f86-8062-c3bd651740ce',
  calendar: 'https://claude.ai/directory/2a838eaa-f7b4-4bc2-bd47-c326f3c813c5',
} as const;
const remote = { notion: 'Notion', heptabase: 'Heptabase' } as const;
// “Add to Claude” on Claude's official Slack connector listing.
const SLACK_IN_CLAUDE = 'https://claude.ai/directory/597f662f-36de-437e-836e-5a81013cbfbe';
type Change = (call: () => Promise<ToolLibraryView>) => Promise<boolean>;

export function CommonApps({
  lib,
  oauth,
  connectors,
  change,
  refreshAccounts,
}: {
  lib: ToolLibraryView;
  oauth: OAuthView | null;
  connectors: ConnectorsView | null;
  change: Change;
  refreshAccounts: () => Promise<void>;
}) {
  const t = useT();
  const a = t.apps;
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [gh, setGh] = useState<GithubConnection>();
  const [ghError, setGhError] = useState('');
  const refreshGh = async () => {
    setGhError('');
    try {
      setGh(await api.githubStatus());
    } catch (e) {
      setGhError((e as Error).message);
    }
  };
  useEffect(() => {
    void refreshGh();
  }, []);
  const enable = (group: RelayToolGroup) => {
    const providers = lib.relayTools.find((g) => g.group === group)?.providers ?? [];
    return providers.length ? (
      <div className="form-actions">
        <span className="muted small">{a.enabled}</span>
        <button className="link-button" onClick={() => void change(() => api.updateTools({ relayTools: { [group]: [] } }))}>
          {a.disable}
        </button>
      </div>
    ) : (
      <button
        className="ghost small-button"
        onClick={() => void change(() => api.updateTools({ relayTools: { [group]: [...PROVIDERS] } }))}
      >
        {a.enable}
      </button>
    );
  };
  return (
    <>
      <p className="muted small">{a.hint}</p>
      {error && (
        <p role="alert" className="error-line">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="muted small">
          {notice}
        </p>
      )}
      <ul className="lib-list common-apps">
        {(Object.keys(accounts) as OAuthUse[]).map((use) => {
          const provider = use === 'teams' ? 'microsoft' : 'google';
          const linked = oauth?.accounts.filter((x) => x.provider === provider && x.uses.includes(use)) ?? [];
          const configured = oauth?.clients.some((x) => x.provider === provider && x.clientId && (provider !== 'google' || x.secret));
          return (
            <li className="lib-row" key={use} aria-label={accounts[use]}>
              <strong>{accounts[use]}</strong>
              <p className="muted small">{a.details[use]}</p>
              {(use === 'drive' || use === 'calendar') && <ClaudeConnectorLink app={accounts[use]} href={googleInClaude[use]} />}
              {linked.map((x) => {
                const missing = (use === 'mail' || use === 'calendar') && !connectors?.[use].some((c) => c.oauth === x.id);
                return (
                  <div key={x.id}>
                    <span>
                      {(use === 'drive' || use === 'calendar') && t.apps.directConnection + ' · '}
                      {x.email} ·{' '}
                      {x.status === 'reauth' ? t.connectors.oauth.reauth : missing ? a.needsSelection : t.connectors.oauth.connected}
                    </span>
                    {x.status === 'reauth' ? (
                      <AppSignIn
                        name={accounts[use]}
                        startRequest={() => api.startOAuthSignIn(provider, [use], false, x.id)}
                        onDone={refreshAccounts}
                        button={t.connectors.oauth.signInAgain}
                      />
                    ) : missing ? (
                      <a href={settingsHref('tools')}>{a.accounts}</a>
                    ) : (
                      enable(use)
                    )}
                    <button
                      className="link-button"
                      onClick={async () => {
                        if (!confirm(a.confirmAccount(x.email, x.uses.map((u) => t.connectors.oauth.uses[u]).join(t.common.listSeparator))))
                          return;
                        try {
                          const removed = await api.removeOAuthAccount(x.id);
                          setNotice(
                            removed.permissionsPages?.length
                              ? t.connectors.oauth.removedMicrosoft(removed.permissionsPages.join(t.common.listSeparator))
                              : '',
                          );
                          await refreshAccounts();
                        } catch (e) {
                          setError((e as Error).message);
                        }
                      }}
                    >
                      {a.disconnect}
                    </button>
                  </div>
                );
              })}
              {use === 'teams' ? (
                <TeamsSignIn>{!linked.some((x) => x.status !== 'reauth') && enable('teams')}</TeamsSignIn>
              ) : use === 'drive' || use === 'calendar' ? (
                <GoogleProjectConnection
                  use={use}
                  name={accounts[use]}
                  client={oauth?.clients.find((c) => c.provider === 'google')}
                  onDone={refreshAccounts}
                />
              ) : !oauth ? (
                t.common.loading
              ) : configured ? (
                <AppSignIn
                  name={accounts[use]}
                  startRequest={() => api.startOAuthSignIn(provider, [use])}
                  onDone={refreshAccounts}
                  button={linked.length ? a.addAccount : a.connect}
                />
              ) : (
                <p className="muted small">{a.unavailable}</p>
              )}
            </li>
          );
        })}
        {(Object.keys(remote) as (keyof typeof remote)[]).map((key) => {
          const server = lib.mcpServers.find((s) => s.app === key);
          return (
            <li className="lib-row" key={key} aria-label={remote[key]}>
              <strong>{remote[key]}</strong>
              <p className="muted small">{a.details[key]}</p>
              <AppSignIn
                name={remote[key]}
                oauth={server?.oauth}
                button={server?.oauth ? undefined : a.connect}
                startRequest={() => api.startAppSignIn(key)}
                onDone={() => change(() => api.tools())}
                onSignOut={() => (server ? change(() => api.signOutMcp(server.name)) : Promise.resolve(false))}
              />
            </li>
          );
        })}
        <li className="lib-row" aria-label="Slack">
          <strong>Slack</strong>
          <p className="muted small">{a.details.slack}</p>
          <ClaudeConnectorLink app="Slack" href={SLACK_IN_CLAUDE} />
          {lib.mcpServers
            .filter((s) => s.app === 'slack' || (s.transport === 'http' && s.url === APP_SERVERS.slack))
            .map((server) => (
              <div key={server.id}>
                {server.oauth && <p className="small">{a.slackExisting(server.name)}</p>}
                <AppSignIn
                  name="Slack"
                  oauth={server.oauth}
                  startRequest={server.oauth ? () => api.startMcpSignIn(server.name) : undefined}
                  onDone={() => change(() => api.tools())}
                  onSignOut={() => change(() => api.signOutMcp(server.name))}
                />
              </div>
            ))}
        </li>
        <li className="lib-row" aria-label="GitHub">
          <strong>GitHub</strong>
          <p className="muted small">{a.details.github}</p>
          {gh?.status === 'connected' ? (
            <>
              {gh.login} · {t.connectors.oauth.connected} {enable('github')}
            </>
          ) : gh?.status === 'missing' ? (
            <a href="https://cli.github.com/" target="_blank" rel="noreferrer">
              {a.installGh}
            </a>
          ) : gh?.status === 'signed-out' ? (
            <GhSignIn onSignedIn={() => void refreshGh()} />
          ) : (
            !ghError && t.common.loading
          )}
          {ghError && <p role="alert">{ghError}</p>}
          {(gh?.status === 'missing' || ghError) && (
            <button className="ghost small-button" onClick={() => void refreshGh()}>
              {a.checkAgain}
            </button>
          )}
        </li>
        <li className="lib-row" aria-label="Obsidian">
          <strong>Obsidian</strong>
          <p className="muted small">{a.details.obsidian}</p>
          <VaultConnection path={lib.obsidianVault} change={change} />
          {lib.obsidianVault && enable('obsidian')}
        </li>
      </ul>
    </>
  );
}

function VaultConnection({ path, change }: { path?: string; change: Change }) {
  const t = useT();
  const a = t.apps;
  const [pick, setPick] = useState<boolean>();
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.cwds().then(
      (v) => setPick(Boolean(v.pick)),
      () => setPick(false),
    );
  }, []);
  const connect = async () => {
    setError('');
    if (request.current) return;
    const ctl = new AbortController();
    request.current = ctl;
    setBusy(true);
    try {
      const folders = pick ? (await api.pickCwd(path ?? '', ctl.signal)).paths : [typed.trim()];
      if (ctl.signal.aborted) return;
      if (folders.length > 1) {
        setError(a.oneVault);
        return;
      }
      const folder = folders[0];
      if (folder && (await change(() => api.setObsidianVault(folder)))) setTyped('');
    } catch (e) {
      if (!ctl.signal.aborted) setError((e as Error).message);
    } finally {
      request.current = null;
      if (!ctl.signal.aborted) setBusy(false);
    }
  };
  return (
    <div>
      {path && (
        <div>
          {path} · {t.connectors.oauth.connected}
        </div>
      )}
      {pick === false && <input aria-label={a.path} value={typed} placeholder={a.path} onChange={(e) => setTyped(e.target.value)} />}
      <button
        type="button"
        className="ghost small-button"
        disabled={busy || pick === undefined || (!pick && !typed.trim())}
        onClick={() => void connect()}
      >
        {a.vault}
      </button>
      {path && (
        <button type="button" className="link-button" disabled={busy} onClick={() => void change(() => api.setObsidianVault(''))}>
          {a.disconnect}
        </button>
      )}
      {error && (
        <p role="alert" className="error-line">
          {error}
        </p>
      )}
    </div>
  );
}
