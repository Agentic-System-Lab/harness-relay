import { useRef, useState } from 'react';
import type { OAuthAccountView, OAuthClientView } from '../../shared/types';
import { api } from '../api';
import { useT } from '../i18n';
import { AppSignIn } from './McpSignIn';
import { ClientForm } from './OAuthAccounts';

export function GoogleProjectConnection({
  client,
  accounts,
  onDone,
}: {
  client?: OAuthClientView;
  accounts: OAuthAccountView[];
  onDone: () => Promise<void>;
}) {
  const t = useT();
  const a = t.apps;
  const [editing, setEditing] = useState(false);
  const project = useRef<HTMLDetailsElement>(null);
  const [projectOpen, setProjectOpen] = useState(false);
  const configured = client?.clientId && client.secret && !client.builtIn;
  const enable = (account?: OAuthAccountView) => (
    <AppSignIn
      name="Google Docs"
      startRequest={() => api.startOAuthSignIn('google', ['documents'], false, account?.id)}
      onDone={onDone}
      button={account ? a.enableDocsFor(account.email) : accounts.length ? a.anotherDocsAccount : a.enableDocs}
    />
  );
  return (
    <>
      <details className="app-secondary">
        <summary>{a.driveEditHelp}</summary>
        <div className="app-row-body">
          <p className="muted small">{a.driveEditHint}</p>
          {configured ? (
            <>
              {accounts.map((item) =>
                item.uses.includes('documents') ? (
                  <p key={item.id} className="small">
                    {item.email} · {item.status === 'reauth' ? t.connectors.oauth.reauth : a.docsEnabled}
                  </p>
                ) : (
                  <div key={item.id}>{enable(item)}</div>
                ),
              )}
              {enable()}
            </>
          ) : client ? (
            !projectOpen && (
              <button
                className="ghost small-button"
                onClick={() => {
                  if (project.current) project.current.open = true;
                  setEditing(true);
                  requestAnimationFrame(() => project.current?.querySelector<HTMLInputElement>('input')?.focus());
                }}
              >
                {a.configureGoogle}
              </button>
            )
          ) : (
            t.common.loading
          )}
        </div>
      </details>
      <details className="app-secondary" ref={project} onToggle={(e) => setProjectOpen(e.currentTarget.open)}>
        <summary>{a.googleAdvanced}</summary>
        <div className="app-row-body">
          <p className="muted small">{a.ownGoogleProject}</p>
          {client ? (
            <>
              {configured && !editing && (
                <AppSignIn
                  name="Google Drive"
                  startRequest={() => api.startOAuthSignIn('google', ['drive'])}
                  onDone={onDone}
                  button={a.connectDirect}
                />
              )}
              {editing ? (
                <ClientForm client={client} label="Google" onSaved={onDone} onCancel={() => setEditing(false)} />
              ) : (
                <button type="button" className="ghost small-button" onClick={() => setEditing(true)}>
                  {a.configureGoogle}
                </button>
              )}
            </>
          ) : (
            t.common.loading
          )}
        </div>
      </details>
    </>
  );
}
