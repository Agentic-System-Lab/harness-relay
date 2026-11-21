import { type ReactNode, useId } from 'react';
import type { OAuthAccountView, OAuthClientView } from '../../shared/types';
import { api } from '../api';
import { useT } from '../i18n';
import { oauthClientStatus } from '../oauth';
import { AppRow } from './AppRow';
import { AppSignIn } from './McpSignIn';
import { OAuthSetupHint } from './OAuthAccounts';
import { ChevronIcon } from './icons';

export function GoogleProjectConnection({
  client,
  accounts,
  onDone,
  onDisconnect,
  access,
}: {
  client?: OAuthClientView;
  accounts: OAuthAccountView[];
  onDone: () => Promise<void>;
  onDisconnect: (account: OAuthAccountView) => Promise<void>;
  access: ReactNode;
}) {
  const t = useT();
  const a = t.apps;
  const o = t.connectors.oauth;
  const descriptionId = useId();
  const state = oauthClientStatus(client);
  const configured = state === 'ready';
  const linked = accounts.filter((account) => account.uses.includes('drive') || account.uses.includes('documents'));
  const quick = !linked.length && configured;
  const capabilities = (account: OAuthAccountView) =>
    [account.uses.includes('drive') && a.driveReading, account.uses.includes('documents') && a.docsEnabled].filter(Boolean).join(' · ');
  const status = (account: OAuthAccountView) =>
    account.email + ' · ' + (!configured ? o.clientState[state] : account.status === 'reauth' ? o.reauth : capabilities(account));
  const quickLabel = (label: string) => (
    <span className="app-row-action">
      {label}
      <ChevronIcon size={14} />
    </span>
  );
  return (
    <AppRow
      name="Google Drive"
      description={a.details.drive}
      label={quick ? undefined : linked.length ? a.manage : a.connect}
      status={linked.map(status).join(t.common.listSeparator)}
    >
      <AppSignIn
        disabled={!configured}
        describedBy={!configured && client ? descriptionId : undefined}
        name="Google Drive"
        rowDescription={quick ? a.details.drive : undefined}
        buttonLabel={a.connectApp('Google Drive')}
        button={quick ? quickLabel(a.connect) : a.connectApp('Google Drive')}
        startRequest={() => api.startOAuthSignIn('google', ['drive'])}
        onDone={onDone}
      />
      {!configured && client && <OAuthSetupHint id={descriptionId} client={client} />}
      <div className="app-row-body">
        {linked.map((account) => (
          <div className="app-row-body" role="group" aria-label={account.email} key={account.id}>
            <strong>{account.email}</strong>
            <span className="small muted">
              {!configured ? o.clientState[state] : account.status === 'reauth' ? o.reauth : capabilities(account)}
            </span>
            <AppSignIn
              disabled={!configured}
              name="Google Drive"
              startRequest={() => api.startOAuthSignIn('google', account.uses, false, account.id)}
              onDone={onDone}
              button={o.signInAgain}
            />
            <button type="button" className="link-button" onClick={() => void onDisconnect(account)}>
              {a.disconnect}
            </button>
          </div>
        ))}
        {accounts
          .filter((account) => !account.uses.includes('drive'))
          .map((account) => (
            <AppSignIn
              disabled={!configured}
              key={account.id}
              name="Google Drive"
              startRequest={() => api.startOAuthSignIn('google', ['drive'], false, account.id)}
              onDone={onDone}
              button={a.enableDriveFor(account.email)}
            />
          ))}
        <details className="app-secondary drive-editing">
          <summary>{a.driveEditHelp}</summary>
          <div className="app-row-body">
            <p className="muted small">{a.driveEditHint}</p>
            {accounts
              .filter((account) => !account.uses.includes('documents'))
              .map((account) => (
                <AppSignIn
                  disabled={!configured}
                  key={account.id}
                  name="Google Docs"
                  startRequest={() => api.startOAuthSignIn('google', ['documents'], false, account.id)}
                  onDone={onDone}
                  button={a.enableDocsFor(account.email)}
                />
              ))}
            <AppSignIn
              name="Google Docs"
              disabled={!configured}
              startRequest={() => api.startOAuthSignIn('google', ['documents'])}
              onDone={onDone}
              button={accounts.length ? a.anotherDocsAccount : a.enableDocs}
            />
            {!configured && client && <OAuthSetupHint client={client} />}
          </div>
        </details>
      </div>
      {!!linked.length && access}
    </AppRow>
  );
}
