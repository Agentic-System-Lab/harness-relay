import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  OAUTH_PROVIDERS,
  type ConnectorsView,
  type OAuthAccountView,
  type OAuthCalendar,
  type OAuthClientView,
  type OAuthProviderId,
  type OAuthSignInView,
  type OAuthUse,
  type OAuthView,
} from '../../shared/types';
import { ApiError, api } from '../api';
import { useT } from '../i18n';
import { accountActions, calendarName, redirectAddresses, sayPopupBlocked, waiting } from '../oauth';
import { isAppWindow } from '../update';

type AccountUse = 'mail' | 'calendar';

const AccountSignInContext = createContext<{
  owner?: AccountUse;
  begin: (kind: AccountUse) => boolean;
  finish: () => void;
} | null>(null);

/** Only one Mail or Calendar sign-in can start, including while the first start request is in flight. */
export function AccountSignInProvider({ children }: { children: ReactNode }) {
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
  return <AccountSignInContext.Provider value={{ owner, begin, finish }}>{children}</AccountSignInContext.Provider>;
}

/**
 * Common apps → Mail or Calendar → Accounts you sign in to: Microsoft 365, Outlook.com and
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
  setView,
  connectors,
  onConnectors,
  refresh = 0,
}: {
  kind: AccountUse;
  view: OAuthView | null;
  setView: (v: OAuthView) => void;
  connectors: ConnectorsView;
  onConnectors: (v: ConnectorsView) => void;
  refresh?: number;
}) {
  const t = useT();
  const o = t.connectors.oauth;

  const [error, setError] = useState('');
  const [info, setInfo] = useState<{ text: string; account?: string }>();
  const [signIn, setSignIn] = useState<OAuthSignInView>();
  const [settingUp, setSettingUp] = useState<OAuthProviderId>();
  const [calendarsOf, setCalendarsOf] = useState<string>();
  const shared = useContext(AccountSignInContext)!;
  const busy = Boolean(shared.owner);
  const updateSignIn = (v: OAuthSignInView | undefined) => {
    setSignIn(v);
    if (!v) shared.finish();
  };

  useEffect(() => {
    if (refresh) api.oauth().then(setView, (e: Error) => setError(e.message));
  }, [refresh, setView]);

  // Follow a sign-in while it waits; once done, the account (and its calendar) are shown.
  useFollowSignIn(signIn, updateSignIn, setError);
  const ended = signIn && !waiting(signIn) ? signIn : undefined;
  const shown = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!ended || shown.current === ended.id) return;
    shown.current = ended.id;
    if (ended.status === 'done') {
      setInfo({ text: o.done(ended.account?.email ?? ''), account: ended.account?.id });
      void Promise.allSettled([api.oauth().then(setView), api.connectors().then(onConnectors)]).then((responses) => {
        const failed = responses.find((result) => result.status === 'rejected');
        if (failed) setError((failed.reason as Error).message);
        updateSignIn(undefined);
      });
    } else {
      setError(ended.error ?? '');
      updateSignIn(undefined);
    }
  }, [ended, o, onConnectors]);

  /** A sign-in for these uses; `account`: the account it signs in again, or for another use. */
  const start = async (provider: OAuthProviderId, uses: OAuthUse[], device = false, account?: string) => {
    if (!shared.begin(kind)) return;
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
  const reread = () => void api.oauth().then(setView, () => undefined);

  /** Adds the mail account of an account signed in for mail. */
  const addMail = async (a: OAuthAccountView) => {
    setError('');
    setInfo(undefined);
    try {
      onConnectors(await api.addOAuthMail(a.id));
      setInfo({ text: o.mailAdded(a.email), account: a.id });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const remove = async (a: OAuthAccountView) => {
    if (!confirm(o.confirmRemove(a.email, a.uses.map((u) => o.uses[u]).join(t.common.listSeparator)))) return;
    try {
      const r = await api.removeOAuthAccount(a.id);
      setView(r);
      onConnectors(r.connectors);
      setInfo(r.permissionsPages?.length ? { text: o.removedMicrosoft(r.permissionsPages.join(t.common.listSeparator)) } : undefined);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (!view) return error ? <p className="error-line">{error}</p> : null;
  const label = (p: OAuthProviderId) => o.providers[p];
  // Incremental consent names the existing account so the server preserves its current grants.
  const otherAccounts = view.accounts.filter((a) => !a.uses.includes(kind));
  return (
    <div className="oauth-accounts">
      <h5>{o.title}</h5>
      <p className="muted small">{o.hint[kind]}</p>
      {error && <p className="error-line">{error}</p>}
      {info && (!info.account || view.accounts.some((a) => a.id === info.account)) && <p className="small ok-text">{info.text}</p>}

      <ul className="lib-list">
        {view.accounts
          .filter((a) => a.uses.includes(kind))
          .map((a) => {
            const can = accountActions(
              a,
              connectors.mail.some((m) => m.oauth === a.id),
            );
            return (
              <li key={a.id} className="lib-row relay-group">
                <div className="lib-row-main">
                  <span className="lib-name">{label(a.provider)}</span>
                  <code className="lib-detail">{a.email}</code>
                  <span className={`badge ${a.status === 'reauth' ? 'warn' : ''}`}>{a.status === 'reauth' ? o.reauth : o.connected}</span>
                </div>
                <p className="small muted">{o.usedFor(a.uses.map((u) => o.uses[u]).join(t.common.listSeparator))}</p>
                {a.status === 'reauth' && a.error && <p className="small warn-text">{a.error}</p>}
                <div className="lib-row-actions">
                  {can.signInAgain && (
                    <button
                      type="button"
                      className="ghost small-button"
                      disabled={busy}
                      onClick={() => start(a.provider, can.signInAgain!, false, a.id)}
                    >
                      {o.signInAgain}
                    </button>
                  )}
                  {kind === 'calendar' && can.calendars && (
                    <button
                      type="button"
                      className="ghost small-button"
                      aria-expanded={calendarsOf === a.id}
                      onClick={() => setCalendarsOf((x) => (x === a.id ? undefined : a.id))}
                    >
                      {o.calendars}
                    </button>
                  )}
                  {kind === 'mail' && can.addMail && (
                    <button type="button" className="ghost small-button" onClick={() => addMail(a)}>
                      {o.useFor.mail}
                    </button>
                  )}
                  <button
                    type="button"
                    className="icon-button danger"
                    aria-label={`${o.remove} ${a.email}`}
                    disabled={busy}
                    onClick={() => remove(a)}
                  >
                    ×
                  </button>
                </div>
                {calendarsOf === a.id && <AccountCalendars account={a} onConnectors={onConnectors} onFailed={reread} />}
              </li>
            );
          })}
      </ul>

      {signIn && waiting(signIn) && signIn.provider !== 'mcp' && (
        <SignInWaiting signIn={signIn} label={label(signIn.provider)} onChange={updateSignIn} onError={setError} />
      )}

      {otherAccounts.length > 0 && (
        <details className="sub">
          <summary>{o.existing}</summary>
          <ul className="lib-list">
            {otherAccounts.map((a) => (
              <li key={a.id} className="lib-row relay-group">
                <strong>{a.email}</strong>
                <span className="small muted">{o.usedFor(a.uses.map((u) => o.uses[u]).join(t.common.listSeparator))}</span>
                <button type="button" className="ghost small-button" disabled={busy} onClick={() => start(a.provider, [kind], false, a.id)}>
                  {o.useFor[kind]}
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
      {shared.owner && shared.owner !== kind && (
        <p className="small muted" role="status">
          {o.finishIn[shared.owner]}
        </p>
      )}
      <div className="oauth-providers">
        {OAUTH_PROVIDERS.map((p) => {
          const client = view.clients.find((c) => c.provider === p)!;
          return (
            <div key={p} className="oauth-provider">
              {client.clientId ? (
                <div className="form-actions">
                  <button type="button" className="ghost small-button" disabled={busy} onClick={() => start(p, [kind])}>
                    {o.signIn(label(p))}
                  </button>
                  {client.device && (
                    <button type="button" className="ghost small-button" disabled={busy} onClick={() => start(p, [kind], true)}>
                      {o.onAnotherDevice}
                    </button>
                  )}
                  <button
                    type="button"
                    className="link-button"
                    disabled={busy}
                    onClick={() => setSettingUp((x) => (x === p ? undefined : p))}
                  >
                    {o.app}
                  </button>
                </div>
              ) : (
                <p className="small muted">
                  {label(p)}{' '}
                  <button
                    type="button"
                    className="link-button"
                    disabled={busy}
                    onClick={() => setSettingUp((x) => (x === p ? undefined : p))}
                  >
                    {o.setUp}
                  </button>
                </p>
              )}
              {settingUp === p && (
                <ClientForm
                  client={client}
                  label={label(p)}
                  kind={kind}
                  disabled={busy}
                  onSaved={(v) => {
                    setView(v);
                    setSettingUp(undefined);
                  }}
                  onCancel={() => setSettingUp(undefined)}
                />
              )}
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
export function ClientForm({
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
  onSaved: (v: OAuthView) => void | Promise<void>;
  onCancel: () => void;
}) {
  const t = useT();
  const o = t.connectors.oauth;
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
    if (replaced || disabled) return;
    setError('');
    try {
      await onSaved(
        await api.saveOAuthClient(client.provider, {
          clientId: clientId.trim(),
          ...(client.provider === 'microsoft' && tenant.trim() ? { tenant: tenant.trim() } : {}),
          ...(secret ? { secret } : {}),
        }),
      );
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <form
      className="mcp-form connector-form"
      aria-label={`${o.app} · ${label}`}
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
  onConnectors,
  onFailed,
}: {
  account: OAuthAccountView;
  onConnectors: (v: ConnectorsView) => void;
  onFailed: () => void;
}) {
  const o = useT().connectors.oauth;
  const [list, setList] = useState<OAuthCalendar[]>();
  const [error, setError] = useState('');
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
    try {
      onConnectors(await api.addOAuthCalendar(account.id, { name: calendarName(account, c.name), url: c.url }));
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  if (error) return <p className="error-line">{error}</p>;
  if (!list) return <p className="small muted">{o.loadingCalendars}</p>;
  return (
    <ul className="oauth-calendars" aria-label={`${o.calendars} · ${account.email}`}>
      {list.map((c) => (
        <li key={c.url}>
          <span>{c.name}</span>
          {c.addedAs ? (
            <span className="small muted">{o.added}</span>
          ) : (
            <button type="button" className="ghost small-button" onClick={() => add(c)}>
              {o.add}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
