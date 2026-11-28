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
  access,
}: {
  client?: OAuthClientView;
  accounts: OAuthAccountView[];
  onDone: () => Promise<void>;
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
    <AppRow item="drive" name="Google Drive" description={a.details.drive} label={linked.length ? a.manage : a.connect} status={summary}>
      {linked.length ? (
        <>
          <ul className="lib-list drive-accounts">
            {linked.map((account) => (
              <li key={account.id} className="lib-row relay-group">
                <DriveAccountCard account={account} configured={configured} onDone={onDone} />
              </li>
            ))}
          </ul>
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

function DriveAccountCard({
  account,
  configured,
  onDone,
}: {
  account: OAuthAccountView;
  configured: boolean;
  onDone: () => Promise<void>;
}) {
  const t = useT();
  const a = t.apps;
  const reads = account.uses.includes('drive');
  const edits = account.uses.includes('documents');
  const permissions = edits ? (reads ? a.driveReadWrite : a.docsEnabled) : a.driveReading;
  const renew = account.status === 'reauth';
  const upgradeHint = reads && !edits && !renew;
  const hintId = useId();
  const [removing, setRemoving] = useState(false);
  const [authorizing, setAuthorizing] = useState(false);
  const [error, setError] = useState('');
  const remove = async (button: HTMLButtonElement) => {
    if (!window.confirm(a.confirmRemoveDrive(account.email, reads, edits))) return;
    setRemoving(true);
    setError('');
    try {
      await api.removeOAuthDrive(account.id);
      if (document.activeElement === button || document.activeElement === document.body) {
        button.closest('details')?.querySelector('summary')?.focus();
      }
      await onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRemoving(false);
    }
  };
  return (
    <div className="drive-account" role="group" aria-label={account.email}>
      <div className="drive-account-identity">
        <strong className="lib-name">{account.email}</strong>
        <span className="small muted">{permissions}</span>
        {renew && <span className="small warn-text">{t.connectors.oauth.reauth}</span>}
      </div>
      {upgradeHint && (
        <p id={hintId} className="small muted">
          {a.driveUpgradeHint}
        </p>
      )}
      <div className="form-actions">
        {(renew || !reads || !edits) && (
          <AppSignIn
            name={renew || !reads ? 'Google Drive' : 'Google Docs'}
            disabled={!configured || removing}
            describedBy={upgradeHint ? hintId : undefined}
            onPendingChange={setAuthorizing}
            onDone={onDone}
            button={renew ? t.connectors.oauth.signInAgain : reads ? a.enableDocs : a.enableDriveReading}
            startRequest={() => api.startOAuthSignIn('google', renew ? account.uses : [reads ? 'documents' : 'drive'], false, account.id)}
          />
        )}
        <button
          type="button"
          className="ghost small-button danger"
          disabled={removing || authorizing}
          onClick={(e) => void remove(e.currentTarget)}
        >
          {a.removeDrive}
        </button>
      </div>
      {error && (
        <p role="alert" className="error-line">
          {error}
        </p>
      )}
    </div>
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
    <div className="drive-account-signin">
      {additional && (
        <button
          type="button"
          className="ghost small-button"
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
