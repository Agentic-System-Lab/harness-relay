import { type ReactNode, useId, useState } from 'react';
import type { OAuthAccountView, OAuthClientView } from '../../shared/types';
import { api } from '../api';
import { useT } from '../i18n';
import { oauthClientStatus } from '../oauth';
import { AppRow } from './AppRow';
import { AppSignIn } from './McpSignIn';
import { OAuthSetupHint } from './OAuthAccounts';

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
  const summary = linked.length
    ? !configured
      ? o.clientState[state]
      : linked.some((account) => account.status === 'reauth')
        ? o.reauth
        : a.driveAccounts(linked.length)
    : undefined;
  return (
    <AppRow name="Google Drive" description={a.details.drive} label={linked.length ? a.manage : a.connect} status={summary}>
      {linked.length ? (
        <>
          {linked.map((account) => {
            const reads = account.uses.includes('drive');
            const edits = account.uses.includes('documents');
            const permissions = edits ? (reads ? a.driveReadWrite : a.docsEnabled) : a.driveReading;
            return (
              <div key={account.id} className="drive-account" role="group" aria-label={account.email}>
                <div className="drive-account-identity">
                  <strong>{account.email}</strong>
                  <span className="small muted">
                    {account.status === 'reauth' && <>{o.reauth} · </>}
                    {permissions}
                  </span>
                </div>
                <div className="form-actions">
                  {account.status === 'reauth' ? (
                    <AppSignIn
                      name="Google Drive"
                      disabled={!configured}
                      onDone={onDone}
                      button={o.signInAgain}
                      startRequest={() => api.startOAuthSignIn('google', account.uses, false, account.id)}
                    />
                  ) : (
                    (!reads || !edits) && (
                      <AppSignIn
                        name={reads ? 'Google Docs' : 'Google Drive'}
                        disabled={!configured}
                        onDone={onDone}
                        button={reads ? a.enableDocs : a.enableDriveReading}
                        startRequest={() => api.startOAuthSignIn('google', [reads ? 'documents' : 'drive'], false, account.id)}
                      />
                    )
                  )}
                  <button type="button" className="link-button" onClick={() => void onDisconnect(account)}>
                    {a.disconnect}
                  </button>
                </div>
              </div>
            );
          })}
          <DriveAccountSignIn key="another" additional disabled={!configured} onDone={onDone} />
          {!configured && client && <OAuthSetupHint id={descriptionId} client={client} />}
          {access}
        </>
      ) : (
        <>
          <DriveAccountSignIn key="first" disabled={!configured} describedBy={!configured ? descriptionId : undefined} onDone={onDone} />
          {!configured && client && <OAuthSetupHint id={descriptionId} client={client} />}
        </>
      )}
    </AppRow>
  );
}

/** A single sign-in requests only the capabilities chosen for this account. */
function DriveAccountSignIn({
  additional = false,
  disabled,
  describedBy,
  onDone,
}: {
  additional?: boolean;
  disabled: boolean;
  describedBy?: string;
  onDone: () => Promise<void>;
}) {
  const t = useT();
  const a = t.apps;
  const [open, setOpen] = useState(!additional);
  const [permission, setPermission] = useState('read');
  const [authorizing, setAuthorizing] = useState(false);
  const group = useId();
  return (
    <div className="drive-account">
      {additional && (
        <button
          type="button"
          className="link-button"
          disabled={disabled || authorizing}
          aria-expanded={open}
          aria-controls={group}
          onClick={() => setOpen(!open)}
        >
          {a.addDriveAccount}
        </button>
      )}
      <div id={group} className="drive-permission-form" hidden={!open}>
        <label className="field">
          <span>{a.drivePermission}</span>
          <select value={permission} disabled={disabled || authorizing} onChange={(e) => setPermission(e.target.value)}>
            <option value="read">{a.driveOptions.read}</option>
            <option value="both">{a.driveOptions.both}</option>
            <option value="documents">{a.driveOptions.documents}</option>
          </select>
        </label>
        {permission !== 'read' && <p className="small muted">{a.driveWritePreview}</p>}
        <AppSignIn
          name="Google Drive"
          disabled={disabled}
          describedBy={describedBy}
          onPendingChange={setAuthorizing}
          button={t.connectors.oauth.signIn('Google')}
          startRequest={() =>
            api.startOAuthSignIn('google', permission === 'both' ? ['drive', 'documents'] : [permission === 'read' ? 'drive' : 'documents'])
          }
          onDone={async () => {
            await onDone();
            if (additional) {
              setOpen(false);
              setPermission('read');
            }
          }}
        />
      </div>
    </div>
  );
}
