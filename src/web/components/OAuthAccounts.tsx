import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import {
  type CalendarAccountView,
  type ConnectorsView,
  type MailAccountView,
  type OAuthAccountView,
  type OAuthCalendar,
  type OAuthClientView,
  type OAuthProviderId,
  type OAuthSignInView,
  type OAuthUse,
  type OAuthView,
} from '../../shared/types';
import { ApiError, api } from '../api';
import { useI18n, useT } from '../i18n';
import { accountActions, accountServices, calendarName, oauthClientStatus, redirectAddresses, sayPopupBlocked, waiting } from '../oauth';
import { isAppWindow } from '../update';

type AccountUse = 'mail' | 'calendar';

const AccountSignInContext = createContext<{
  owner?: AccountUse;
  setupPanel: React.RefObject<HTMLDetailsElement | null>;
  editor?: { provider: OAuthProviderId; kind?: AccountUse };
  configure: (provider: OAuthProviderId, kind?: AccountUse) => void;
  closeEditor: () => void;
  begin: (kind: AccountUse) => boolean;
  finish: () => void;
} | null>(null);

/** Only one Mail or Calendar sign-in can start, including while the first start request is in flight. */
export function AccountSignInProvider({ children }: { children: ReactNode }) {
  const setupPanel = useRef<HTMLDetailsElement>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const originGroup = useRef<Element | null>(null);
  const [editor, setEditor] = useState<{ provider: OAuthProviderId; kind?: AccountUse }>();
  const configure = (provider: OAuthProviderId, kind?: AccountUse) => {
    trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    originGroup.current = trigger.current?.closest('.oauth-provider, .drive-editing, .app-row') ?? null;
    if (setupPanel.current) setupPanel.current.open = true;
    setEditor({ provider, kind });
  };
  const closeEditor = () => {
    setEditor(undefined);
    const panel = setupPanel.current;
    if (!panel) return;
    const opener = trigger.current;
    if (opener && !panel.contains(opener)) panel.open = false;
    requestAnimationFrame(() => {
      if (opener?.isConnected && opener.getClientRects().length) opener.focus();
      else (originGroup.current?.querySelector<HTMLElement>('button:not(:disabled)') ?? panel.querySelector('summary'))?.focus();
    });
  };
  const active = useRef(false);
  const [owner, setOwner] = useState<AccountUse>();
  const begin = (kind: AccountUse) => {
    if (active.current) return false;
    active.current = true;
    setOwner(kind);
    return true;
  };
  const finish = () => {
    active.current = false;
    setOwner(undefined);
  };
  return (
    <AccountSignInContext.Provider value={{ owner, begin, finish, editor, configure, closeEditor, setupPanel }}>
      {children}
    </AccountSignInContext.Provider>
  );
}

function useConfigureOAuth() {
  return useContext(AccountSignInContext)!.configure;
}

function OAuthGuideLink({ provider }: { provider: OAuthProviderId }) {
  const { lang, t } = useI18n();
  const path = `/help/oauth/${lang}/${provider}.html`;
  return (
    <a href={path} target="_blank" rel="noreferrer">
      {t.connectors.oauth.setupGuide[provider]}
    </a>
  );
}

/** Keep the explanation and the two ways to continue available beside disabled service actions. */
export function OAuthSetupHint({ client, kind, id }: { client: OAuthClientView; kind?: AccountUse; id?: string }) {
  const o = useT().connectors.oauth;
  const configure = useConfigureOAuth();
  const { provider, disabled } = client;
  const name = provider === 'microsoft' ? 'Microsoft' : 'Google';
  return (
    <div className="oauth-setup-hint">
      <p className="muted small" id={id}>
        {disabled ? o.disabledSetup(name) : o.missingSetup(name)}
      </p>
      <div className="form-actions small">
        <button type="button" className="link-button" aria-controls="oauth-client-settings" onClick={() => configure(provider, kind)}>
          {disabled ? o.settingsFor[provider] : o.configure[provider]}
        </button>
        <OAuthGuideLink provider={provider} />
      </div>
    </div>
  );
}

export function OAuthClientSettings({ view, onSaved }: { view: OAuthView | null; onSaved: () => Promise<void> }) {
  const { editor, configure, closeEditor, setupPanel, owner } = useContext(AccountSignInContext)!;
  const t = useT();
  const o = t.connectors.oauth;
  const [notice, setNotice] = useState('');
  const [changing, setChanging] = useState(false);
  const [error, setError] = useState('');
  const toggle = async (entry: OAuthClientView) => {
    if (!entry.disabled && !window.confirm(o.confirmTurnOff[entry.provider])) return;
    setChanging(true);
    setError('');
    setNotice('');
    try {
      await api.setOAuthClientDisabled(entry.provider, !entry.disabled);
      await onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setChanging(false);
    }
  };
  const disconnect = async (account: OAuthAccountView) => {
    const services = accountServices(account, t);
    const hasConnectors = account.uses.includes('mail') || account.uses.includes('calendar');
    if (!window.confirm(o.confirmRemove(o.providers[account.provider], account.email, services, hasConnectors))) return;
    setChanging(true);
    setError('');
    setNotice('');
    try {
      const result = await api.removeOAuthAccount(account.id);
      if (result.permissionsPages?.length) setNotice(o.removedMicrosoft(result.permissionsPages.join(t.common.listSeparator)));
      await onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setChanging(false);
    }
  };
  const client = view?.clients.find((item) => item.provider === editor?.provider);
  const form = useRef<HTMLDivElement>(null);
  const enableButton = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (editor) (enableButton.current ?? form.current?.querySelector('input'))?.focus();
  }, [editor, client?.provider]);
  return (
    <details ref={setupPanel} className="library-category oauth-settings" id="oauth-client-settings">
      <summary>
        <h4>{o.settingsTitle}</h4>
      </summary>
      <div className="library-category-body oauth-settings-body">
        <p className="small muted">{o.settingsHint}</p>
        <div className="oauth-client-list">
          {(['google', 'microsoft'] as const).map((p) => {
            const entry = view?.clients.find((c) => c.provider === p);
            const name = p === 'google' ? 'Google' : 'Microsoft';
            const state = oauthClientStatus(entry);
            const accounts = view?.accounts.filter((account) => account.provider === p) ?? [];
            return (
              <div key={p} role="group" aria-label={name}>
                <div className="oauth-client-row">
                  <button
                    type="button"
                    className="ghost"
                    aria-pressed={editor?.provider === p}
                    aria-label={o.settingsFor[p]}
                    disabled={!!owner || !view || changing}
                    onClick={() => configure(p)}
                  >
                    {name}
                  </button>
                  {entry && <span className="small muted">{o.clientState[state]}</span>}
                  {entry && state !== 'missing' && (
                    <button
                      type="button"
                      className="link-button"
                      ref={editor?.provider === p && entry.disabled ? enableButton : undefined}
                      disabled={changing}
                      onClick={() => toggle(entry)}
                    >
                      {entry.disabled ? o.turnOn : o.turnOff}
                    </button>
                  )}
                </div>
                {accounts.length > 0 && (
                  <ul className="lib-list oauth-client-accounts">
                    {accounts.map((account) => (
                      <li key={account.id}>
                        <div className="lib-row" role="group" aria-label={account.email}>
                          <div className="lib-row-main">
                            <strong className="lib-name">{account.email}</strong>
                            <span className="small muted">{accountServices(account, t) || o.noAccountServices}</span>
                          </div>
                          <button
                            type="button"
                            className="ghost small-button danger"
                            disabled={!!owner || changing}
                            onClick={() => disconnect(account)}
                          >
                            {o.disconnectAccount}
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
        {error && (
          <p role="alert" className="error-line">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="small muted">
            {notice}
          </p>
        )}
        {client && (
          <div ref={form}>
            <ClientForm
              key={client.provider}
              client={client}
              label={o.providers[client.provider]}
              kind={editor?.kind}
              disabled={!!owner || changing}
              onSaved={onSaved}
              onCancel={closeEditor}
            />
          </div>
        )}
        <div className="form-actions small">
          {(['google', 'microsoft'] as const)
            .filter((p) => !editor || editor.provider === p)
            .map((p) => (
              <OAuthGuideLink key={p} provider={p} />
            ))}
        </div>
      </div>
    </details>
  );
}

/**
 * Common apps → Mail or Calendar: Microsoft 365, Outlook.com and
 * Google (Gmail, Google Calendar), which sign in with OAuth instead of an app password, for the calendar
 * tools, the mail tools, or both. The server runs each sign-in; this only starts it (the provider's
 * page in a new tab, or a code for another device), follows it, and takes a pasted address when the
 * provider's page cannot come back here. No token ever comes here. `connectors`: the mail accounts and
 * calendars, to know which account's mail account is there. `refresh`: read the accounts again when it
 * changes (a calendar or mail account of one was tested, which may have found that its sign-in no
 * longer works).
 */
export function OAuthAccounts({
  kind,
  view,
  reloadOAuth,
  connectors,
  renderResource,
  reloadConnectors,
  refresh = 0,
  servicePicker,
  provider,
}: {
  kind: AccountUse;
  view: OAuthView | null;
  reloadOAuth: () => Promise<void>;
  connectors: ConnectorsView;
  renderResource: (resource: MailAccountView | CalendarAccountView, account?: OAuthAccountView) => ReactNode;
  reloadConnectors: () => Promise<void>;
  refresh?: number;
  servicePicker: ReactNode;
  provider?: OAuthProviderId;
}) {
  const t = useT();
  const o = t.connectors.oauth;

  const [error, setError] = useState('');
  const [info, setInfo] = useState<{ text: string; account?: string }>();
  const [signIn, setSignIn] = useState<OAuthSignInView>();
  const [calendarsOf, setCalendarsOf] = useState<string>();
  const shared = useContext(AccountSignInContext)!;
  const reasonId = useId();
  const busy = Boolean(shared.owner);
  const updateSignIn = (v: OAuthSignInView | undefined) => {
    setSignIn(v);
    if (!v) shared.finish();
  };

  useEffect(() => {
    if (refresh) reloadOAuth().catch((e: Error) => setError(e.message));
  }, [refresh, reloadOAuth]);

  // Follow a sign-in while it waits; once done, the account (and its calendar) are shown.
  useFollowSignIn(signIn, updateSignIn, setError);
  const ended = signIn && !waiting(signIn) ? signIn : undefined;
  const shown = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!ended || shown.current === ended.id) return;
    shown.current = ended.id;
    if (ended.status === 'done') {
      setInfo({ text: o.done(ended.account?.email ?? ''), account: ended.account?.id });
      void Promise.allSettled([reloadOAuth(), reloadConnectors()]).then((responses) => {
        const failed = responses.find((result) => result.status === 'rejected');
        if (failed) setError((failed.reason as Error).message);
        updateSignIn(undefined);
      });
    } else {
      setError(ended.error ?? '');
      updateSignIn(undefined);
    }
  }, [ended, o, reloadConnectors, reloadOAuth]);

  /** A sign-in for these uses; `account`: the account it signs in again, or for another use. */
  const start = async (provider: OAuthProviderId, uses: OAuthUse[], device = false, account?: string) => {
    if (!shared.begin(kind)) return;
    if (account) setCalendarsOf(undefined);
    setError('');
    setInfo(undefined);
    const tab = device ? null : openPendingTab();
    try {
      const v = await api.startOAuthSignIn(provider, uses, device, account);
      setSignIn(v);
      if (v.authorizeUrl && !showSignInPage(tab, v.authorizeUrl)) setError(o.popupBlocked);
      if (!v.authorizeUrl) tab?.close();
    } catch (e) {
      tab?.close();
      shared.finish();
      setError((e as Error).message);
    }
  };

  // The accounts read again: a calendar list that failed may have found a sign-in no longer works, which its account then says.
  const reread = () => void reloadOAuth().catch(() => undefined);

  /** Adds the mail account of an account signed in for mail. */
  const addMail = async (a: OAuthAccountView) => {
    setError('');
    setInfo(undefined);
    try {
      await api.addOAuthMail(a.id);
      await reloadConnectors();
      setInfo({ text: o.mailAdded(a.email), account: a.id });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const available = (p: OAuthProviderId) => oauthClientStatus(view?.clients.find((client) => client.provider === p)) === 'ready';
  const accounts = view?.accounts ?? [];
  const label = (p: OAuthProviderId) => o.providers[p];
  const resources = connectors[kind];
  const groups = accounts.filter((a) => a.uses.includes(kind) || resources.some((r) => r.oauth === a.id));
  const standalone = resources.filter((resource) => !groups.some((account) => account.id === resource.oauth));
  return (
    <div className="oauth-accounts">
      {error && (
        <p className="error-line" role="alert">
          {error}
        </p>
      )}
      {info && (!info.account || accounts.some((a) => a.id === info.account)) && <p className="small ok-text">{info.text}</p>}
      {(standalone.length > 0 || groups.length > 0) && (
        <>
          <h5>{kind === 'mail' ? t.apps.linkedMail : t.apps.linkedCalendars}</h5>
          <ul className="lib-list" aria-label={kind === 'mail' ? t.connectors.mailAccounts : t.connectors.calendar}>
            {standalone.map((r) => renderResource(r))}
            {groups.map((account) => {
              const linked = resources.filter((r) => r.oauth === account.id);
              const can = accountActions(account, kind === 'mail' && linked.length > 0);
              const state = oauthClientStatus(view?.clients.find((c) => c.provider === account.provider));
              const ready = state === 'ready';
              return (
                <li key={`oauth:${account.id}`} className="lib-row relay-group">
                  <div className="connector-account" role="group" aria-label={account.email}>
                    <div className="lib-row-main">
                      <strong className="lib-name">{account.email}</strong>
                      <span className="small muted">{label(account.provider)}</span>
                      <span className={`badge ${account.status === 'reauth' ? 'warn' : ''}`}>
                        {!ready ? o.clientState[state] : account.status === 'reauth' ? o.reauth : o.connected}
                      </span>
                    </div>
                    {account.status === 'reauth' && account.error && <p className="small warn-text">{account.error}</p>}
                    {linked.length > 0 ? (
                      <ul className="connector-resources">{linked.map((r) => renderResource(r, account))}</ul>
                    ) : (
                      <p className="small muted">{o.emptyResources[kind]}</p>
                    )}
                    <div className="lib-row-actions">
                      {can.signInAgain && (
                        <button
                          type="button"
                          className="ghost small-button"
                          disabled={busy || !ready}
                          onClick={() => start(account.provider, account.uses, false, account.id)}
                        >
                          {o.signInAgain}
                        </button>
                      )}
                      {kind === 'calendar' && can.calendars && !can.signInAgain && (
                        <button
                          type="button"
                          className="ghost small-button"
                          disabled={!ready}
                          aria-expanded={calendarsOf === account.id}
                          onClick={() => setCalendarsOf((id) => (id === account.id ? undefined : account.id))}
                        >
                          {linked.length ? o.manageCalendars : o.chooseCalendars}
                        </button>
                      )}
                      {kind === 'mail' && can.addMail && (
                        <button type="button" className="ghost small-button" disabled={!ready} onClick={() => addMail(account)}>
                          {o.restoreMail}
                        </button>
                      )}
                    </div>
                    {ready && calendarsOf === account.id && !can.signInAgain && (
                      <AccountCalendars
                        account={account}
                        connected={connectors.calendar}
                        reloadConnectors={reloadConnectors}
                        onFailed={reread}
                      />
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
      {signIn && waiting(signIn) && signIn.provider !== 'mcp' && (
        <SignInWaiting signIn={signIn} label={label(signIn.provider)} onChange={updateSignIn} onError={setError} />
      )}

      {shared.owner && shared.owner !== kind && (
        <p className="small muted" role="status">
          {o.finishIn[shared.owner]}
        </p>
      )}
      {servicePicker}
      <div className="oauth-providers">
        {view?.clients
          .filter((client) => client.provider === provider)
          .map((client) => {
            const p = client.provider;
            return (
              <div key={p} className="oauth-provider">
                <div className="form-actions">
                  <button
                    type="button"
                    className="ghost small-button"
                    disabled={busy || !available(p)}
                    aria-describedby={available(p) ? undefined : reasonId}
                    onClick={() => start(p, [kind])}
                  >
                    {o.signIn(label(p))}
                  </button>
                  {client.device && (
                    <button
                      type="button"
                      className="ghost small-button"
                      disabled={busy || !available(p)}
                      aria-describedby={available(p) ? undefined : reasonId}
                      onClick={() => start(p, [kind], true)}
                    >
                      {o.onAnotherDevice}
                    </button>
                  )}
                </div>
                {!available(p) && <OAuthSetupHint id={reasonId} client={client} kind={kind} />}
              </div>
            );
          })}
      </div>
    </div>
  );
}

/**
 * Opens a sign-in's page in a new tab (in the desktop app, the system browser); false when the browser
 * blocked it, to say so.
 */
export function openSignInPage(url: string): boolean {
  // `noopener` would make open() answer null whether or not the tab opened: the opener is dropped by hand.
  // The desktop app's window opens it in the system browser, and answers null too.
  const tab = window.open(url, '_blank');
  if (tab) tab.opener = null;
  return !sayPopupBlocked(Boolean(tab), isAppWindow(navigator.userAgent));
}

/**
 * A blank tab opened on the click itself, for a sign-in page whose address comes only once the server
 * answered (an MCP server's discovery and registration can outlast a browser's user activation, after
 * which Safari blocks the tab): null in the desktop app's window, which opens the page in the system
 * browser once it is known (`showSignInPage()`), and when the browser blocked it.
 */
export function openPendingTab(): Window | null {
  if (isAppWindow(navigator.userAgent)) return null;
  const tab = window.open('', '_blank');
  if (tab) tab.opener = null;
  return tab;
}

/**
 * Shows a sign-in's page in the tab opened for it (`openPendingTab()`), or in the desktop app in the
 * system browser; false when the browser blocked it, to say so.
 */
export function showSignInPage(tab: Window | null, url: string): boolean {
  // No tab (blocked on the click, or closed since): one more try, which a browser may still allow.
  if (isAppWindow(navigator.userAgent) || !tab || tab.closed) return openSignInPage(url);
  tab.location.href = url;
  return true;
}

/**
 * Follows a sign-in while it waits, asking the server how it goes every moment and handing each answer
 * to `onChange`; one the server no longer has (it restarted, or it ended long ago) is over (`undefined`).
 */
export function useFollowSignIn(
  signIn: OAuthSignInView | undefined,
  onChange: (v: OAuthSignInView | undefined) => void,
  onError: (e: string) => void,
): void {
  const following = signIn && waiting(signIn) ? signIn.id : undefined;
  const handlers = useRef({ onChange, onError });
  handlers.current = { onChange, onError };
  useEffect(() => {
    if (!following) return;
    let live = true;
    const timer = setInterval(async () => {
      try {
        const v = await api.oauthSignIn(following);
        if (!live) return;
        handlers.current.onChange(v);
      } catch (e) {
        if (!live) return;
        handlers.current.onError((e as Error).message);
        // Gone (the server restarted, or it ended long ago): nothing more to follow. Anything else may pass.
        if (e instanceof ApiError && e.status === 404) handlers.current.onChange(undefined);
      }
    }, 1500);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [following]);
}

/**
 * A sign-in under way: the page to open again, the code for another device, or the address to paste.
 * Also a tool library MCP server's own sign-in (`McpSignIn`), `label` then naming the server.
 */
export function SignInWaiting({
  signIn,
  label,
  onChange,
  onError,
}: {
  signIn: OAuthSignInView;
  label: string;
  onChange: (v: OAuthSignInView | undefined) => void;
  onError: (e: string) => void;
}) {
  const o = useT().connectors.oauth;
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState(false);
  const paste = async () => {
    setBusy(true);
    try {
      onChange(await api.pasteOAuthAddress(signIn.id, address));
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    await api.cancelOAuthSignIn(signIn.id).catch(() => undefined);
    onChange(undefined);
  };
  return (
    <div className="oauth-waiting" role="status">
      {signIn.device ? (
        <p className="small">{o.device(signIn.device.verificationUri, signIn.device.userCode)}</p>
      ) : (
        <>
          <p className="small">
            {o.waiting(label)}{' '}
            <a className="link-button" href={signIn.authorizeUrl} target="_blank" rel="noopener noreferrer">
              {o.openAgain}
            </a>
          </p>
          <label className="field">
            <span className="small muted">{o.pasteHint}</span>
            <input value={address} placeholder={o.pastePlaceholder} onChange={(e) => setAddress(e.target.value)} />
          </label>
        </>
      )}
      <div className="form-actions">
        <button type="button" className="ghost small-button" onClick={cancel}>
          {o.cancel}
        </button>
        {!signIn.device && (
          <button type="button" className="primary small-button" disabled={busy || !address.trim()} onClick={paste}>
            {o.finish}
          </button>
        )}
      </div>
    </div>
  );
}

/** A provider's app: the user's own client id (Microsoft's tenant, Google's secret), and the redirect addresses it must allow. */
function ClientForm({
  client,
  label,
  kind,
  disabled = false,
  onSaved,
  onCancel,
}: {
  client: OAuthClientView;
  label: string;
  kind?: AccountUse;
  disabled?: boolean;
  onSaved: () => Promise<void>;
  onCancel: () => void;
}) {
  const t = useT();
  const o = t.connectors.oauth;
  const mounted = useRef(false);
  const submitting = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const initial = useRef(client).current;
  const replaced = initial.clientId !== client.clientId || initial.tenant !== client.tenant || initial.secret !== client.secret;
  const [clientId, setClientId] = useState(client.builtIn ? '' : client.clientId);
  const [tenant, setTenant] = useState(client.tenant ?? '');
  const [secret, setSecret] = useState('');
  const [error, setError] = useState('');
  // A different client or tenant invalidates every account signed in through the old registration.
  const registrationChanges = Boolean(
    client.clientId &&
    (clientId.trim() !== (client.builtIn ? '' : client.clientId) ||
      (tenant.trim().toLowerCase() || 'common') !== (client.tenant?.trim().toLowerCase() || 'common')),
  );
  const redirects = redirectAddresses(client.provider, location.origin);
  const save = async () => {
    if (replaced || disabled || submitting.current) return;
    submitting.current = true;
    setError('');
    try {
      await api.saveOAuthClient(client.provider, {
        clientId: clientId.trim(),
        ...(client.provider === 'microsoft' && tenant.trim() ? { tenant: tenant.trim() } : {}),
        ...(secret ? { secret } : {}),
      });
      await onSaved();
      if (mounted.current) onCancel();
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    } finally {
      submitting.current = false;
    }
  };
  return (
    <form
      className="mcp-form connector-form"
      aria-label={o.settingsFor[client.provider]}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <p className="muted small">
        {kind ? o.clientHelp[client.provider][kind] : client.provider === 'microsoft' ? o.microsoftApp : o.googleApp}
      </p>
      <label className="field">
        <span>{o.clientId}</span>
        <input value={clientId} autoComplete="off" onChange={(e) => setClientId(e.target.value)} />
      </label>
      {client.provider === 'microsoft' && (
        <label className="field">
          <span>{o.tenant}</span>
          <input value={tenant} placeholder="common" autoComplete="off" onChange={(e) => setTenant(e.target.value)} />
          <span className="small muted">{o.tenantHint}</span>
        </label>
      )}
      {client.provider === 'google' && (
        <label className="field">
          <span>{o.secret}</span>
          <input
            type="password"
            value={secret}
            autoComplete="new-password"
            placeholder={client.secret ? t.tools.keepValue(client.secret) : ''}
            onChange={(e) => setSecret(e.target.value)}
          />
          <span className="small muted">{o.secretHint}</span>
        </label>
      )}
      {redirects.length > 0 && (
        <div className="field">
          <span className="small">{o.redirects}</span>
          {redirects.map((r) => (
            <code key={r} className="small">
              {r}
            </code>
          ))}
        </div>
      )}
      <p className="muted small">{o.sharedClient[client.provider]}</p>
      {replaced ? (
        <p className="warn-line small" role="alert">
          {o.clientUpdated}
        </p>
      ) : (
        registrationChanges && <p className="warn-line small">{o.clientChanged(label)}</p>
      )}
      {error && <p className="error-line">{error}</p>}
      <div className="form-actions">
        <button type="button" className="ghost" onClick={onCancel}>
          {t.common.cancel}
        </button>
        <button type="submit" disabled={disabled || replaced} className="primary">
          {t.common.save}
        </button>
      </div>
    </form>
  );
}

/** An account's calendars, each to add to the calendar tools. `onFailed`: they could not be listed. */
function AccountCalendars({
  account,
  connected,
  reloadConnectors,
  onFailed,
}: {
  account: OAuthAccountView;
  connected: CalendarAccountView[];
  reloadConnectors: () => Promise<void>;
  onFailed: () => void;
}) {
  const t = useT().connectors;
  const o = t.oauth;
  const [list, setList] = useState<OAuthCalendar[]>();
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const load = () =>
    api.oauthCalendars(account.id).then(setList, (e: Error) => {
      setError(e.message);
      onFailed();
    });
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account.id]);
  const add = async (c: OAuthCalendar) => {
    if (adding) return;
    setAdding(true);
    try {
      await api.addOAuthCalendar(account.id, { name: calendarName(account, c.name), url: c.url });
      await reloadConnectors();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setAdding(false);
    }
  };
  if (error) return <p className="error-line">{error}</p>;
  if (!list) return <p className="small muted">{o.loadingCalendars}</p>;
  if (!list.length) return <p className="small muted">{t.noneFound}</p>;
  return (
    <ul className="oauth-calendars" aria-label={`${o.calendars} · ${account.email}`}>
      {list.map((c) => (
        <li key={c.url}>
          <span>{c.name}</span>
          {connected.some((r) => r.oauth === account.id && r.url === c.url) ? (
            <span className="small muted">{o.added}</span>
          ) : (
            <button type="button" className="ghost small-button" disabled={adding} onClick={() => add(c)}>
              {o.add}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
