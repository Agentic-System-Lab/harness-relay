import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import {
  type ConnectorsView,
  type OAuthView,
  type ObsidianVault,
  type RelayToolGroup,
  type TeamsConnection,
  type SlackPostingConnection,
  type ToolLibraryView,
} from '../../shared/types';
import { api } from '../api';
import { useT } from '../i18n';
import { AppSignIn } from './McpSignIn';
import { HostedAppLinks } from './HostedAppLinks';
import { ChevronIcon } from './icons';
import { AppRow } from './AppRow';
import { GoogleProjectConnection } from './GoogleProjectConnection';
import { SlackPostingSettings } from './SlackPostingSettings';
import { APP_SERVERS } from '../../shared/apps';
import { TeamsSignIn } from './TeamsSignIn';
import { GithubConnectionRow } from './GithubConnectionRow';

const accounts = { drive: 'Google Drive', teams: 'Microsoft Teams' } as const;
const remote = { notion: 'Notion', heptabase: 'Heptabase' } as const;
type Change = (call: () => Promise<ToolLibraryView>, report?: (error: string) => void) => Promise<boolean>;

export function CommonApps({
  lib,
  oauth,
  change,
  refreshAccounts,
  accountSettings,
  connectors,
  relayAccess,
  browserSettings,
}: {
  lib: ToolLibraryView;
  oauth: OAuthView | null;
  change: Change;
  refreshAccounts: () => Promise<void>;
  accountSettings: (kind: 'mail' | 'calendar') => ReactNode;
  connectors: ConnectorsView | null;
  relayAccess: (group: RelayToolGroup) => ReactNode;
  browserSettings: ReactNode;
}) {
  const t = useT();
  const a = t.apps;
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [teams, setTeams] = useState<TeamsConnection>();
  const [slack, setSlack] = useState<SlackPostingConnection>();
  const slackServers = lib.mcpServers.filter((s) => s.app === 'slack' || (s.transport === 'http' && s.url === APP_SERVERS.slack));
  const savedSlack = slackServers.filter((s) => s.oauth);
  const connectedAccountRow = (use: keyof typeof accounts) => {
    const provider = use === 'teams' ? 'microsoft' : 'google';
    const linked =
      oauth?.accounts.filter(
        (x) => x.provider === provider && (x.uses.includes(use) || (use === 'drive' && x.uses.includes('documents'))),
      ) ?? [];
    const nativeTeams = use === 'teams' ? teams : undefined;
    const pending =
      nativeTeams?.status === 'signing-in' ||
      nativeTeams?.status === 'installing' ||
      (nativeTeams?.status === 'connected' && nativeTeams.posting?.status === 'signing-in');
    const account = nativeTeams?.status === 'connected' ? nativeTeams.account : linked[0]?.email;
    const status = linked.some((x) => x.status === 'reauth')
      ? t.connectors.oauth.reauth
      : pending
        ? a.inProgress
        : account
          ? (use === 'drive' && !linked[0]?.uses.includes('documents') ? a.driveReadOnly : a.directConnection) +
            ' · ' +
            account +
            ' · ' +
            t.connectors.oauth.connected
          : undefined;
    return (
      <AppRow
        name={accounts[use]}
        key={use}
        description={a.details[use]}
        label={status ? a.manage : a.options}
        status={status}
        reveal={pending}
      >
        <HostedAppLinks app={use} />
        {linked.map((x) => (
          <div key={x.id}>
            <span>
              {use === 'drive' && (x.uses.includes('documents') ? a.docsEnabled : a.driveReadOnly) + ' · '}
              {x.email} · {x.status === 'reauth' ? t.connectors.oauth.reauth : t.connectors.oauth.connected}
            </span>
            {x.status === 'reauth' && (
              <AppSignIn
                name={accounts[use]}
                startRequest={() => api.startOAuthSignIn(provider, x.uses, false, x.id)}
                onDone={refreshAccounts}
                button={t.connectors.oauth.signInAgain}
              />
            )}
            <button
              className="link-button"
              onClick={async () => {
                if (!confirm(a.confirmAccount(x.email, x.uses.map((u) => t.connectors.oauth.uses[u]).join(t.common.listSeparator)))) return;
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
        ))}
        {use === 'teams' ? (
          <TeamsSignIn view={teams} setView={setTeams} />
        ) : (
          <GoogleProjectConnection
            accounts={oauth?.accounts.filter((x) => x.provider === 'google') ?? []}
            client={oauth?.clients.find((c) => c.provider === 'google')}
            onDone={refreshAccounts}
          />
        )}
        {relayAccess(use)}
      </AppRow>
    );
  };
  return (
    <>
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
      <div className="common-apps">
        <AppGroup name={a.categories.schedule}>
          {(['mail', 'calendar'] as const).map((kind) => {
            const count = connectors?.[kind].length ?? 0;
            const grants = oauth?.accounts.filter((account) => account.uses.includes(kind)) ?? [];
            const status = grants.some((account) => account.status === 'reauth')
              ? t.connectors.oauth.reauth
              : count
                ? a.added[kind](count)
                : grants.length
                  ? a.signedInFor[kind]
                  : undefined;
            return (
              <AppRow
                key={kind}
                name={t.tools.relay.groups[kind]}
                description={a.details[kind]}
                label={status ? a.manage : a.options}
                status={status}
              >
                {accountSettings(kind)}
                {relayAccess(kind)}
              </AppRow>
            );
          })}
        </AppGroup>
        <AppGroup name={a.categories.team}>
          {connectedAccountRow('teams')}
          <AppRow
            name="Slack"
            description={a.details.slack}
            label={savedSlack.length || slack?.status === 'connected' ? a.manage : a.options}
            status={
              slack?.status === 'connected'
                ? slack.sender + ' · ' + slack.workspace + ' · ' + a.postingEnabled
                : savedSlack.length
                  ? savedSlack.some((s) => s.oauth?.status === 'reauth')
                    ? t.connectors.oauth.reauth
                    : a.savedSlack
                  : undefined
            }
          >
            <HostedAppLinks app="slack" />
            <SlackPostingSettings view={slack} setView={setSlack} />
            {relayAccess('slack')}
            {slackServers.map((server) => (
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
          </AppRow>
        </AppGroup>
        <AppGroup name={a.categories.notes}>
          {connectedAccountRow('drive')}
          {(Object.keys(remote) as (keyof typeof remote)[]).map((key) => {
            const server = lib.mcpServers.find((s) => s.app === key);
            const signIn = (
              <AppSignIn
                name={remote[key]}
                oauth={server?.oauth}
                button={
                  server?.oauth ? undefined : (
                    <span className="app-row-action">
                      {a.connect}
                      <ChevronIcon size={14} />
                    </span>
                  )
                }
                buttonLabel={server?.oauth ? undefined : a.connectApp(remote[key])}
                rowDescription={server?.oauth ? undefined : a.details[key]}
                startRequest={() => api.startAppSignIn(key)}
                onDone={() => change(() => api.tools())}
                onSignOut={() => (server ? change(() => api.signOutMcp(server.name)) : Promise.resolve(false))}
              />
            );
            return (
              <AppRow
                key={key}
                name={remote[key]}
                description={a.details[key]}
                label={server?.oauth ? a.manage : undefined}
                status={
                  server?.oauth ? (server.oauth.status === 'reauth' ? t.connectors.oauth.reauth : t.connectors.oauth.connected) : undefined
                }
              >
                {signIn}
              </AppRow>
            );
          })}
          <VaultConnection vaults={lib.obsidianVaults ?? []} change={change} access={relayAccess('obsidian')} />
        </AppGroup>
        <AppGroup name={a.categories.dev}>
          <GithubConnectionRow access={relayAccess('github')} />
          <AppRow name={t.tools.relay.groups.browser} description={a.details.browser} label={a.manage}>
            {relayAccess('browser')}
            {browserSettings}
          </AppRow>
        </AppGroup>
      </div>
    </>
  );
}

function AppGroup({ name, children }: { name: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className="app-group" aria-labelledby={id}>
      <h4 id={id}>{name}</h4>
      <ul className="lib-list">{children}</ul>
    </section>
  );
}

function VaultConnection({ vaults, change, access }: { vaults: ObsidianVault[]; change: Change; access: React.ReactNode }) {
  const t = useT();
  const a = t.apps;
  const [pick, setPick] = useState<boolean>();
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const chooseButton = useRef<HTMLButtonElement>(null);
  const restoreChooserFocus = useRef(false);
  useLayoutEffect(() => {
    if (busy || !restoreChooserFocus.current) return;
    restoreChooserFocus.current = false;
    if (document.activeElement === document.body) {
      const button = chooseButton.current;
      if (button?.disabled) button.closest('details')?.querySelector<HTMLElement>('summary')?.focus();
      else button?.focus();
    }
  }, [busy]);
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
    restoreChooserFocus.current = document.activeElement === chooseButton.current;
    setBusy(true);
    try {
      const folders = pick
        ? (await api.pickCwd(vaults.at(-1)?.path ?? '', ctl.signal)).paths
        : typed
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean);
      if (ctl.signal.aborted) return;
      if (folders.length && (await change(() => api.addObsidianVaults(folders), setError))) setTyped('');
    } catch (e) {
      if (!ctl.signal.aborted) setError((e as Error).message);
    } finally {
      request.current = null;
      if (!ctl.signal.aborted) setBusy(false);
    }
  };
  const disconnect = async (id: string, button: HTMLButtonElement) => {
    restoreChooserFocus.current = document.activeElement === button;
    setBusy(true);
    try {
      await change(() => api.removeObsidianVault(id), setError);
    } finally {
      setBusy(false);
    }
  };
  const name = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
  const choose = (
    <button
      type="button"
      className="ghost small-button"
      ref={chooseButton}
      disabled={busy || pick === undefined || (!pick && !typed.trim())}
      onClick={() => void connect()}
    >
      {vaults.length ? a.addVaults : a.vault}
    </button>
  );
  return (
    <AppRow
      name="Obsidian"
      description={a.details.obsidian}
      status={
        vaults.length === 1
          ? name(vaults[0]!.path) + ' · ' + t.connectors.oauth.connected
          : vaults.length
            ? a.connectedVaults(vaults.length)
            : undefined
      }
      label={vaults.length ? a.manage : a.options}
    >
      {vaults.length > 0 && (
        <ul className="lib-list vault-list" aria-label={a.vaultList}>
          {vaults.map((vault) => (
            <li key={vault.id}>
              <div>
                <strong>{name(vault.path)}</strong>
                <span className="small muted">{vault.path}</span>
              </div>
              <button
                type="button"
                className="ghost small-button"
                disabled={busy}
                aria-label={a.disconnectVault(vault.path)}
                onClick={(e) => void disconnect(vault.id, e.currentTarget)}
              >
                {a.disconnect}
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="small muted">{a.vaultHint}</p>
      {pick === false && (
        <label className="field">
          <span>{a.path}</span>
          <textarea rows={2} value={typed} onChange={(e) => setTyped(e.target.value)} />
        </label>
      )}
      {choose}
      {access}
      {error && (
        <p role="alert" className="error-line">
          {error}
        </p>
      )}
    </AppRow>
  );
}
