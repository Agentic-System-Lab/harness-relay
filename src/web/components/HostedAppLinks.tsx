import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { HOSTED_APPS } from '../../shared/apps';
import type { HostedApp as App, HostedProvider as Provider, HostedAppStatus as Status, ProviderAccountView } from '../../shared/types';
import { api } from '../api';
import { useT } from '../i18n';
import { AppRow } from './AppRow';

const services: Record<App, string> = { teams: 'Microsoft Teams', slack: 'Slack' };
const names = { claude: 'Claude', codex: 'Codex' } as const;
export type HostedAccounts = Record<Provider, ProviderAccountView[]>;

function useConnection(app: App, provider: Provider, accounts: ProviderAccountView[], active: boolean) {
  const t = useT();
  const [selected, select] = useState('');
  const account = accounts.some((x) => x.id === selected) ? selected : '';
  const label = accounts.find((x) => x.id === account)?.label || (account ? t.accounts.unnamed(account) : t.accounts.default);
  const [result, setResult] = useState<{ account: string; status: Status }>();
  const [checking, setChecking] = useState(true);
  const [disconnectHelp, setHelp] = useState(false);
  const generation = useRef(0);
  const pending = useRef<{ account: string; request: ReturnType<typeof api.hostedAppStatus> } | null>(null);
  const returning = useRef(false);
  const check = useCallback(
    (fresh = false) => {
      const id = ++generation.current;
      setChecking(true);
      const request =
        !fresh && pending.current?.account === account ? pending.current.request : api.hostedAppStatus(app, provider, account, fresh);
      pending.current = { account, request };
      void request
        .catch(() => ({ status: 'unknown' as const }))
        .then(({ status }) => {
          if (id !== generation.current) return;
          pending.current = null;
          setResult({ account, status });
          setChecking(false);
          if (status === 'not-found' || status === 'needs-auth') setHelp(false);
        });
    },
    [app, provider, account],
  );
  useEffect(() => {
    returning.current = false;
    setHelp(false);
    if (!active) return;
    check();
    const onReturn = () => {
      if (document.visibilityState !== 'visible' || !returning.current) return;
      returning.current = false;
      check(true);
    };
    window.addEventListener('focus', onReturn);
    document.addEventListener('visibilitychange', onReturn);
    return () => {
      ++generation.current;
      document.removeEventListener('visibilitychange', onReturn);
      window.removeEventListener('focus', onReturn);
    };
  }, [check, active]);
  const open = (disconnect: boolean) => {
    returning.current = true;
    setHelp(disconnect);
  };
  return {
    provider,
    accounts,
    account,
    label,
    select,
    status: result?.account === account ? result.status : undefined,
    checking,
    check,
    open,
    disconnectHelp,
  };
}

function Connection({ app, connection }: { app: App; connection: ReturnType<typeof useConnection> }) {
  const t = useT();
  const a = t.apps;
  const { provider, accounts, account, label, status, checking } = connection;
  const platform = names[provider];
  const service = services[app];
  const { claudeDirectory: claudeId, codexPlugin: codexId } = HOSTED_APPS[app];
  const connect = provider === 'claude' ? 'https://claude.ai/directory/' + claudeId : 'https://chatgpt.com/plugins/' + codexId;
  const manage = provider === 'claude' ? 'https://claude.ai/customize/connectors' : connect;
  const connected = status === 'connected';
  const available = status === 'available';
  const open = (disconnect: boolean) => ({
    onClick: () => connection.open(disconnect),
    onAuxClick: (e: React.MouseEvent) => {
      if (e.button === 1) connection.open(disconnect);
    },
    target: '_blank',
    rel: 'noreferrer',
  });
  const action = connected
    ? a.disconnectHosted(service, platform)
    : available
      ? a.manageAppIn(service, platform)
      : provider === 'claude'
        ? a.connectInClaude(service)
        : a.connectInCodex(service);
  return (
    <div className="hosted-connection" role="group" aria-label={platform}>
      <div className="hosted-identity">
        <strong>{platform}</strong>
        <span className="muted small" role="status">
          {checking || !status ? a.checkingHosted : a.hostedStatus[status](platform, service) + ' · ' + label}
        </span>
      </div>
      {accounts.length > 1 && (
        <label className="field hosted-account">
          <span>{a.hostedAccount(platform)}</span>
          <select value={account} onChange={(e) => connection.select(e.target.value)}>
            {accounts.map((x) => (
              <option key={x.id} value={x.id}>
                {x.label || (x.id ? t.accounts.unnamed(x.id) : t.accounts.default)}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="form-actions hosted-actions">
        <a className="ghost small-button" href={connected ? manage : connect} {...open(connected)}>
          {action}
        </a>
        {available && (
          <a href={manage} {...open(true)}>
            {a.disconnectHosted(service, platform)}
          </a>
        )}
        {!connected && (status === 'unknown' || status === 'disabled') && (
          <a href={manage} {...open(true)}>
            {a.manageHosted}
          </a>
        )}
      </div>
      {available && !connection.disconnectHelp && <p className="muted small hosted-help">{a.codexAccountsHint}</p>}
      {(connected || connection.disconnectHelp) && app === 'teams' && provider === 'claude' && (
        <p className="muted small hosted-help">{a.sharedMicrosoft}</p>
      )}
      {connection.disconnectHelp && (
        <p className="muted small hosted-help">
          {a.disconnectHostedHelp(platform, app === 'teams' && provider === 'claude' ? 'Microsoft 365' : service)}
        </p>
      )}
    </div>
  );
}

export function HostedAppRow({
  app,
  accounts,
  active,
  directStatus,
  reveal,
  children,
}: {
  app: App;
  accounts: HostedAccounts;
  active: boolean;
  directStatus?: string;
  reveal?: boolean;
  children: ReactNode;
}) {
  const a = useT().apps;
  const [opened, setOpened] = useState(false);
  const claude = useConnection(app, 'claude', accounts.claude, active || opened);
  const codex = useConnection(app, 'codex', accounts.codex, active || opened);
  const lines = [claude, codex].flatMap((p) =>
    p.status === 'connected' || p.status === 'available' ? [a.hostedStatus[p.status](names[p.provider], services[app])] : [],
  );
  if (directStatus) lines.push(directStatus);
  const busy = claude.checking || codex.checking;
  return (
    <AppRow
      onOpen={() => setOpened(true)}
      name={services[app]}
      description={a.details[app]}
      label={lines.length ? a.manage : a.options}
      status={lines.join(' · ')}
      reveal={reveal}
    >
      <p className="muted small">{app === 'teams' ? a.hostedTeamsNote : a.hostedSlackHint}</p>
      <div className="hosted-connections">
        <Connection app={app} connection={claude} />
        <Connection app={app} connection={codex} />
      </div>
      <p className="muted small">{a.verifyHostedHint}</p>
      <button
        type="button"
        className="ghost small-button"
        aria-disabled={busy}
        onClick={() => {
          if (!busy) {
            claude.check(true);
            codex.check(true);
          }
        }}
      >
        {a.checkHosted}
      </button>
      {children}
    </AppRow>
  );
}
