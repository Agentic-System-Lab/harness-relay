import { useEffect, useRef, useState } from 'react';
import {
  OAUTH_PROVIDERS,
  MAIL_CALENDAR_USES,
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
import { accountActions, calendarName, redirectAddresses, sayPopupBlocked, toggleUse, waiting } from '../oauth';
import { isAppWindow } from '../update';

/**
 * Settings → Tool library → Mail and calendar → Accounts you sign in to: Microsoft 365, Outlook.com and
 * Google (Gmail, Google Calendar), which sign in with OAuth instead of an app password, for the calendar
 * tools, the mail tools, or both. The server runs each sign-in; this only starts it (the provider's
 * page in a new tab, or a code for another device), follows it, and takes a pasted address when the
 * provider's page cannot come back here. No token ever comes here. `connectors`: the mail accounts and
 * calendars, to know which account's mail account is there. `refresh`: read the accounts again when it
 * changes (a calendar or mail account of one was tested, which may have found that its sign-in no
 * longer works).
 */
export function OAuthAccounts({
  view,
  setView,
  connectors,
  onConnectors,
  refresh = 0,
}: {
  view: OAuthView | null;
  setView: (v: OAuthView) => void;
  connectors: ConnectorsView;
  onConnectors: (v: ConnectorsView) => void;
  refresh?: number;
}) {
  const t = useT();
  const o = t.connectors.oauth;

  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [signIn, setSignIn] = useState<OAuthSignInView>();
  const [settingUp, setSettingUp] = useState<OAuthProviderId>();
  const [calendarsOf, setCalendarsOf] = useState<string>();
  /** What a new sign-in is for. */
  const [forUses, setForUses] = useState<OAuthUse[]>(['calendar']);

  useEffect(() => {
    if (refresh) api.oauth().then(setView, (e: Error) => setError(e.message));
  }, [refresh, setView]);

  // Follow a sign-in while it waits; once done, the account (and its calendar) are shown.
  useFollowSignIn(signIn, setSignIn, setError);
  const ended = signIn && !waiting(signIn) ? signIn : undefined;
  const shown = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!ended || shown.current === ended.id) return;
    shown.current = ended.id;
    if (ended.status === 'done') {
      setInfo(o.done(ended.account?.email ?? ''));
      api.oauth().then(setView, () => undefined);
      api.connectors().then(onConnectors, () => undefined);
    } else setError(ended.error ?? '');
    setSignIn(undefined);
  }, [ended, o, onConnectors]);

  /** A sign-in for these uses; `account`: the account it signs in again, or for another use. */
  const start = async (provider: OAuthProviderId, uses: OAuthUse[], device = false, account?: string) => {
    setError('');
    setInfo('');
    try {
      const v = await api.startOAuthSignIn(provider, uses, device, account);
      setSignIn(v);
      if (v.authorizeUrl && !openSignInPage(v.authorizeUrl)) setError(o.popupBlocked);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  // The accounts read again: a calendar list that failed may have found a sign-in no longer works, which its account then says.
  const reread = () => void api.oauth().then(setView, () => undefined);

  /** Adds the mail account of an account signed in for mail. */
  const addMail = async (a: OAuthAccountView) => {
    setError('');
    setInfo('');
    try {
      onConnectors(await api.addOAuthMail(a.id));
      setInfo(o.mailAdded(a.email));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const remove = async (a: OAuthAccountView) => {
    if (!confirm(o.confirmRemove(a.email))) return;
    try {
      const r = await api.removeOAuthAccount(a.id);
      setView(r);
      onConnectors(r.connectors);
      setInfo(r.permissionsPages?.length ? o.removedMicrosoft(r.permissionsPages.join(t.common.listSeparator)) : '');
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (!view) return error ? <p className="error-line">{error}</p> : null;
  const label = (p: OAuthProviderId) => o.providers[p];
  return (
    <div className="oauth-accounts">
      <h5>{o.title}</h5>
      <p className="muted small">{o.hint(t.settings.keyStorageName[view.secretStorage])}</p>
      {error && <p className="error-line">{error}</p>}
      {info && <p className="small ok-text">{info}</p>}

      <ul className="lib-list">
        {view.accounts.map((a) => {
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
                    disabled={waiting(signIn)}
                    onClick={() => start(a.provider, can.signInAgain!, false, a.id)}
                  >
                    {o.signInAgain}
                  </button>
                )}
                {can.calendars && (
                  <button
                    type="button"
                    className="ghost small-button"
                    aria-expanded={calendarsOf === a.id}
                    onClick={() => setCalendarsOf((x) => (x === a.id ? undefined : a.id))}
                  >
                    {o.calendars}
                  </button>
                )}
                {/* A use not granted yet: a sign-in for it with those it has (incremental consent), which updates this account. */}
                {can.signInFor.map(({ use, uses }) => (
                  <button
                    key={use}
                    type="button"
                    className="ghost small-button"
                    disabled={waiting(signIn)}
                    onClick={() => start(a.provider, uses, false, a.id)}
                  >
                    {o.useFor[use]}
                  </button>
                ))}
                {can.addMail && (
                  <button type="button" className="ghost small-button" onClick={() => addMail(a)}>
                    {o.useFor.mail}
                  </button>
                )}
                <button type="button" className="icon-button danger" aria-label={`${o.remove} ${a.email}`} onClick={() => remove(a)}>
                  ×
                </button>
              </div>
              {calendarsOf === a.id && <AccountCalendars account={a} onConnectors={onConnectors} onFailed={reread} />}
            </li>
          );
        })}
      </ul>

      {signIn && waiting(signIn) && signIn.provider !== 'mcp' && (
        <SignInWaiting signIn={signIn} label={label(signIn.provider)} onChange={setSignIn} onError={setError} />
      )}

      {/* What a new sign-in is for: the calendar tools, the mail tools, or both. */}
      <fieldset className="oauth-uses">
        <legend className="small">{o.signInFor}</legend>
        {MAIL_CALENDAR_USES.map((u) => (
          <label key={u} className="check-row">
            <input type="checkbox" checked={forUses.includes(u)} onChange={(e) => setForUses((x) => toggleUse(x, u, e.target.checked))} />
            {o.uses[u]}
          </label>
        ))}
      </fieldset>
      <div className="oauth-providers">
        {OAUTH_PROVIDERS.map((p) => {
          const client = view.clients.find((c) => c.provider === p)!;
          const none = waiting(signIn) || !forUses.length;
          return (
            <div key={p} className="oauth-provider">
              {client.clientId ? (
                <div className="form-actions">
                  <button type="button" className="ghost small-button" disabled={none} onClick={() => start(p, forUses)}>
                    {o.signIn(label(p))}
                  </button>
                  {client.device && (
                    <button type="button" className="ghost small-button" disabled={none} onClick={() => start(p, forUses, true)}>
                      {o.onAnotherDevice}
                    </button>
                  )}
                  <button type="button" className="link-button" onClick={() => setSettingUp((x) => (x === p ? undefined : p))}>
                    {o.app}
                  </button>
                </div>
              ) : (
                <p className="small muted">
                  {o.needsApp(label(p))}{' '}
                  <button type="button" className="link-button" onClick={() => setSettingUp((x) => (x === p ? undefined : p))}>
                    {o.setUp}
                  </button>
                </p>
              )}
              {settingUp === p && (
                <ClientForm
                  client={client}
                  label={label(p)}
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
  onSaved,
  onCancel,
}: {
  client: OAuthClientView;
  label: string;
  onSaved: (v: OAuthView) => void | Promise<void>;
  onCancel: () => void;
}) {
  const t = useT();
  const o = t.connectors.oauth;
  const [clientId, setClientId] = useState(client.builtIn ? '' : client.clientId);
  const [tenant, setTenant] = useState(client.tenant ?? '');
  const [secret, setSecret] = useState('');
  const [error, setError] = useState('');
  const redirects = redirectAddresses(client.provider, location.origin);
  const save = async () => {
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
      <p className="muted small">{client.provider === 'microsoft' ? o.microsoftApp : o.googleApp}</p>
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
      {error && <p className="error-line">{error}</p>}
      <div className="form-actions">
        <button type="button" className="ghost" onClick={onCancel}>
          {t.common.cancel}
        </button>
        <button type="submit" className="primary">
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
