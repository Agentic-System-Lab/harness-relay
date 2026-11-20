import { useState } from 'react';
import type { OAuthClientView } from '../../shared/types';
import { api } from '../api';
import { useT } from '../i18n';
import { AppSignIn } from './McpSignIn';
import { ClientForm } from './OAuthAccounts';

export function GoogleProjectConnection({ client, onDone }: { client?: OAuthClientView; onDone: () => Promise<void> }) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  return (
    <details className="app-secondary">
      <summary>{t.apps.googleAdvanced}</summary>
      <p className="muted small">{t.apps.ownGoogleProject}</p>
      {client ? (
        <>
          {client.clientId && client.secret && !client.builtIn && !editing && (
            <AppSignIn
              name="Google Drive"
              startRequest={() => api.startOAuthSignIn('google', ['drive'])}
              onDone={onDone}
              button={t.apps.connectDirect}
            />
          )}
          {editing ? (
            <ClientForm
              client={client}
              label="Google"
              onSaved={async () => {
                await onDone();
                setEditing(false);
              }}
              onCancel={() => setEditing(false)}
            />
          ) : (
            <button type="button" className="link-button" onClick={() => setEditing(true)}>
              {t.apps.configureGoogle}
            </button>
          )}
        </>
      ) : (
        t.common.loading
      )}
    </details>
  );
}
