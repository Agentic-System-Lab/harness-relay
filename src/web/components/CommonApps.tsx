import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import {
  type ConnectorsView,
  type OAuthView,
  type ObsidianVault,
  type RelayToolGroup,
  type TeamsConnection,
  type ToolLibraryView,
} from '../../shared/types';
import { api } from '../api';
import { useT } from '../i18n';
import { oauthClientStatus } from '../oauth';
import { AppSignIn } from './McpSignIn';
import { type HostedAccounts } from './HostedAppLinks';
import { ChevronIcon } from './icons';
import { OAuthClientSettings, OAuthSetupHint } from './OAuthAccounts';
import { AppRow } from './AppRow';
import { GoogleProjectConnection } from './GoogleProjectConnection';
import { SlackAppRow } from './SlackAppRow';
import { TeamsSignIn } from './TeamsSignIn';
import { GithubConnectionRow } from './GithubConnectionRow';

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
  hostedAccounts,
  activeApps,
}: {
  lib: ToolLibraryView;
  oauth: OAuthView | null;
  change: Change;
  refreshAccounts: () => Promise<void>;
  accountSettings: (kind: 'mail' | 'calendar') => ReactNode;
  connectors: ConnectorsView | null;
  relayAccess: (group: RelayToolGroup) => ReactNode;
  browserSettings: ReactNode;
  hostedAccounts: HostedAccounts;
  activeApps: boolean;
}) {
  const t = useT();
  const a = t.apps;
  const [teams, setTeams] = useState<TeamsConnection>();
  const linkedTeams = oauth?.accounts.filter((x) => x.provider === 'microsoft' && x.uses.includes('teams')) ?? [];
  const microsoftClient = oauth?.clients.find((client) => client.provider === 'microsoft');
  const microsoftState = oauthClientStatus(microsoftClient);
  const pendingTeams =
    teams?.status === 'signing-in' ||
    teams?.status === 'installing' ||
    (teams?.status === 'connected' && teams.posting?.status === 'signing-in');
  const teamsAccount = teams?.status === 'connected' ? teams.account : linkedTeams[0]?.email;
  const teamsStatus =
    teams?.status === 'connected'
      ? [teams.account, t.connectors.oauth.connected].join(' · ')
      : pendingTeams
        ? a.inProgress
        : linkedTeams.length && microsoftState !== 'ready'
          ? t.connectors.oauth.clientState[microsoftState]
          : linkedTeams.some((account) => account.status === 'reauth')
            ? t.connectors.oauth.reauth
            : teamsAccount
              ? [teamsAccount, t.connectors.oauth.connected].join(' · ')
              : undefined;
  return (
    <div className="common-apps">
      <OAuthClientSettings view={oauth} onSaved={refreshAccounts} />
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
        <AppRow
          name="Microsoft Teams"
          description={a.details.teams}
          label={teamsAccount ? a.manage : a.connect}
          status={teamsStatus}
          reveal={pendingTeams}
        >
          {linkedTeams.map((account) => (
            <div key={account.id}>
              <span>
                {account.email} ·{' '}
                {microsoftState !== 'ready'
                  ? t.connectors.oauth.clientState[microsoftState]
                  : account.status === 'reauth'
                    ? t.connectors.oauth.reauth
                    : t.connectors.oauth.connected}
              </span>
              {account.status === 'reauth' && (
                <AppSignIn
                  disabled={microsoftState !== 'ready'}
                  name="Microsoft Teams"
                  startRequest={() => api.startOAuthSignIn('microsoft', account.uses, false, account.id)}
                  onDone={refreshAccounts}
                  button={t.connectors.oauth.signInAgain}
                />
              )}
            </div>
          ))}
          {linkedTeams.length > 0 && microsoftClient && microsoftState !== 'ready' && <OAuthSetupHint client={microsoftClient} />}
          <TeamsSignIn view={teams} setView={setTeams} />
          {(linkedTeams.length > 0 || teams?.status === 'connected') && relayAccess('teams')}
        </AppRow>
        <SlackAppRow active={activeApps} lib={lib} accounts={hostedAccounts} access={relayAccess('slack')} change={change} />
      </AppGroup>
      <AppGroup name={a.categories.notes}>
        <GoogleProjectConnection
          accounts={oauth?.accounts.filter((x) => x.provider === 'google') ?? []}
          client={oauth?.clients.find((c) => c.provider === 'google')}
          onDone={refreshAccounts}
          access={relayAccess('drive')}
        />
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
