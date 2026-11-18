import {
  OAUTH_USES,
  type ConnectorsView,
  type OAuthAccountView,
  type OAuthCalendar,
  type OAuthClientUpdate,
  type OAuthProviderId,
  type OAuthSignInView,
  type OAuthUse,
  type OAuthView,
} from '../../shared/types';
import type { ConnectorStore } from '../connectors/accounts';
import type { CalendarOAuth } from '../connectors/calendar';
import type { MailOAuth } from '../connectors/mailLogin';
import { HttpError } from '../errors';
import { t } from '../i18n';
import { TokenBroker } from './broker';
import { missingUse, oauthProvider, tokenHost, type OAuthClient, type OAuthProvider } from './providers';
import { noAccess, SignIns, signInFetch, type SignedIn } from './signin';
import type { OAuthStore } from './store';

/*
 * Accounts that sign in with OAuth, and what they serve (`src/server/oauth/`): the providers
 * (`providers.ts`), the accounts and their apps (`store.ts`), the token broker (`broker.ts`) and the
 * sign-ins (`signin.ts`). They serve the calendar tools and the mail tools: a sign-in for calendars
 * adds the account's own calendar (and others it has can be added), one for mail adds its mail
 * account, at its provider's own IMAP and SMTP servers. They are reached through the account
 * (`CalendarOAuth`, `MailOAuth`), with its token, which never leaves the server.
 */
export class OAuthService implements CalendarOAuth, MailOAuth {
  readonly broker: TokenBroker;
  readonly signIns: SignIns;

  constructor(
    readonly store: OAuthStore,
    private connectors: ConnectorStore,
    private opts: {
      /** A provider's description (stand-ins in tests). */
      provider?: (id: OAuthProviderId, client: OAuthClient) => OAuthProvider;
      now?: () => number;
      pollMs?: (interval: number) => number;
    } = {},
  ) {
    const now = opts.now ?? Date.now;
    this.broker = new TokenBroker(store, (id) => this.providerOfAccount(id), now);
    this.signIns = new SignIns((s) => this.keep(s), now, opts.pollMs);
  }

  /** A provider, with the app Settings has for it; none set up is a 400 that says so. */
  provider(id: OAuthProviderId): OAuthProvider {
    const client = this.store.client(id);
    if (!client) throw new HttpError(400, t().oauthNoClient(id === 'microsoft' ? 'Microsoft' : 'Google'));
    return (this.opts.provider ?? oauthProvider)(id, client);
  }

  private providerOfAccount(accountId: string): OAuthProvider {
    const a = this.store.account(accountId);
    if (!a) throw new Error(t().oauthAccountGone);
    return this.provider(a.provider);
  }

  view(): OAuthView {
    return {
      clients: this.store.clientsView((p) => {
        try {
          return this.provider(p).flows.includes('device');
        } catch {
          return p === 'microsoft';
        }
      }),
      accounts: this.store.accounts(),
      secretStorage: this.store.storage,
    };
  }

  saveClient(provider: OAuthProviderId, u: OAuthClientUpdate): OAuthView {
    // Another app: its accounts' tokens were given to the one before, which this one cannot refresh.
    // They need a new sign-in, and say so, rather than look connected until their next request fails.
    // The sign-ins still waiting would finish with the app before: they end.
    if (this.store.saveClient(provider, u)) {
      this.signIns.cancelProvider(provider);
      for (const a of this.store.accounts())
        if (a.provider === provider) {
          this.broker.forget(a.id);
          this.store.needsSignIn(a.id, t().oauthAppChanged);
        }
    }
    return this.view();
  }

  /**
   * A sign-in for these uses. Another use than the account has asks for its scopes at a sign-in of its
   * own (incremental consent), which updates the same account, found by its id at the provider.
   * `account`: the account signing in again, or for another use: its own uses are asked for too (a
   * sign-in for one of them alone would leave the others without their grant), and its address is
   * the provider's page's `login_hint`.
   */
  async startSignIn(o: {
    provider: OAuthProviderId;
    uses: OAuthUse[];
    account?: string;
    session?: string;
    origin?: string;
    port: number;
    device?: boolean;
  }): Promise<OAuthSignInView> {
    const provider = this.provider(o.provider);
    const { account: accountId, ...rest } = o;
    if (!accountId) return this.signIns.start({ ...rest, provider });
    const a = this.account(accountId);
    if (a.provider !== o.provider) throw new HttpError(400, t().invalidField('account'));
    const uses = OAUTH_USES.filter((u) => o.uses.includes(u) || a.uses.includes(u));
    return this.signIns.start({ ...rest, provider, uses, loginHint: a.email, forAccount: { id: a.id, subject: a.subject } });
  }

  /**
   * Keeps a sign-in that worked: who it is, its refresh token, its access tokens, and, at its first
   * sign-in for the calendar tools, its own calendar, at its first for the mail tools, its mail account
   * (one the user removed since is not added again: a sign-in again or for another use adds nothing).
   */
  private async keep(s: SignedIn): Promise<OAuthAccountView> {
    const who = await s.whoami(signInFetch(s));
    // Cancelled, or its app changed, while who signed in was asked: nothing is kept.
    if (!s.live()) throw new Error(t().oauthSignInCancelled);
    // Started for one account (Sign in again, Use for …): another one picked on the provider's page, or
    // this one removed meanwhile, changes nothing (its uses would go to another account, or bring it back).
    if (s.forAccount) {
      const meant = this.store.account(s.forAccount.id);
      if (!meant) throw new Error(t().oauthAccountRemoved);
      if (who.subject !== s.forAccount.subject) throw new Error(t().oauthOtherAccount(who.email, meant.email));
    }
    // The account signed in before, for other uses: each of them must still work with the new refresh
    // token, or it would fail at its next request, and mark the whole account as needing a new sign-in.
    // Where a token is for one resource (Microsoft), each earlier use not named gets its own token now,
    // its access checked (consent taken away, another app); where one token covers every scope granted
    // (Google, with include_granted_scopes), that token must still have theirs. Else nothing is kept:
    // the account stays as it was.
    const before = this.store.bySubject(s.provider, who.subject);
    const provider = this.provider(s.provider);
    if (before && provider.tokenScopes) {
      for (const use of before.uses) if (!s.uses.includes(use)) await s.tokenFor(use);
      if (!s.live()) throw new Error(t().oauthSignInCancelled);
    } else if (before && s.granted !== undefined) {
      const lost = missingUse(provider, before.uses, s.granted);
      if (lost) throw new Error(noAccess(provider.label, lost));
    }
    // The uses it had (the store updates the same account), for its first sign-in for one: what that use reaches is added by itself.
    const had = new Set(before?.uses ?? []);
    const first = (use: OAuthUse) => s.uses.includes(use) && !had.has(use);
    // Removed while the earlier uses' tokens were asked for: not brought back.
    if (s.forAccount && !this.store.account(s.forAccount.id)) throw new Error(t().oauthAccountRemoved);
    const account = this.store.signedIn(s.provider, who, s.uses, s.scopes, s.refreshToken, (this.opts.now ?? Date.now)());
    this.broker.signedIn(account.id, s.access);
    if (first('mail') && !this.connectors.oauthMail(account.id).length) {
      try {
        this.addMail(account.id);
      } catch (err) {
        // Kept all the same: its mail account can be added from Settings.
        console.warn('[oauth] could not add the mail account of a new sign-in:', (err as Error).message);
      }
    }
    if (first('calendar') && !this.connectors.oauthCalendars(account.id).length) {
      const own = this.provider(s.provider).defaultCalendar(who.email);
      try {
        this.addCalendar(account.id, {
          name: `${s.provider === 'microsoft' ? 'Outlook' : 'Google'} · ${who.email}`.slice(0, 60),
          url: own.url,
        });
      } catch (err) {
        // Kept all the same: its calendars can be added from Settings.
        console.warn('[oauth] could not add the calendar of a new sign-in:', (err as Error).message);
      }
    }
    return this.store.accounts().find((a) => a.id === account.id) ?? account;
  }

  /**
   * The account's calendars, each with the calendar it was added as, when it was. An account that needs
   * a new sign-in says so (a 409), rather than list what its provider can no longer be asked about; so
   * does one found so now, its refresh refused while they were asked for.
   */
  async calendars(accountId: string): Promise<OAuthCalendar[]> {
    const a = this.account(accountId);
    const problem = this.problem(accountId);
    if (problem) throw new HttpError(409, problem);
    if (!a.uses.includes('calendar')) throw new HttpError(409, t().oauthNotFor(a.email, 'calendar'));
    const added = this.connectors.oauthCalendars(accountId);
    let found: { name: string; url: string }[];
    try {
      found = await this.provider(a.provider).calendars(this.broker.fetch(accountId, 'calendar'), a.email);
    } catch (err) {
      const refused = this.problem(accountId);
      if (refused) throw new HttpError(409, refused);
      throw err;
    }
    return found.map((c) => {
      const as = added.find((x) => x.url === c.url);
      return { ...c, ...(as ? { addedAs: as.id } : {}) };
    });
  }

  /**
   * Adds one of the account's calendars to the calendar tools: an address on its provider's hosts only
   * (its token goes nowhere else), under a name not taken.
   */
  addCalendar(accountId: string, c: { name: string; url: string }) {
    const a = this.account(accountId);
    // Its token would be asked for calendar scopes it was never granted.
    if (!a.uses.includes('calendar')) throw new HttpError(409, t().oauthNotFor(a.email, 'calendar'));
    let host: string;
    try {
      host = tokenHost(c.url);
    } catch {
      throw new HttpError(400, t().connectorBadUrl);
    }
    if (!this.provider(a.provider).hosts.includes(host)) throw new HttpError(400, t().oauthHostRefused(host));
    const same = this.connectors.oauthCalendars(accountId).find((x) => x.url === c.url);
    const taken = this.connectors.calendarIds();
    let id = same?.id ?? accountId;
    for (let n = 2; !same && taken.includes(id); n++) id = `${accountId.slice(0, 36)}-${n}`;
    return this.connectors.saveOAuthCalendar(id, { name: c.name, url: c.url, oauth: accountId, email: a.email });
  }

  /**
   * Adds the account's mail account to the mail tools (once: it is there already, it stays): its
   * provider's own IMAP and SMTP servers, its address as the sender and user name, under an id and a
   * name not taken. Only for an account signed in for mail.
   */
  addMail(accountId: string): ConnectorsView {
    const a = this.account(accountId);
    if (!a.uses.includes('mail')) throw new HttpError(409, t().oauthNotFor(a.email, 'mail'));
    const same = this.connectors.oauthMail(accountId)[0];
    if (same) return this.connectors.view();
    const { mail } = this.provider(a.provider);
    const taken = this.connectors.mailIds();
    let id = accountId;
    for (let n = 2; taken.includes(id); n++) id = `${accountId.slice(0, 36)}-${n}`;
    const names = new Set(this.connectors.mailAccounts().map((m) => m.name.toLowerCase()));
    const base = `${a.provider === 'microsoft' ? 'Outlook' : 'Gmail'} · ${a.email}`;
    let name = base.slice(0, 60);
    for (let n = 2; names.has(name.toLowerCase()); n++) name = `${base.slice(0, 60 - ` (${n})`.length)} (${n})`;
    return this.connectors.saveOAuthMail(id, { name, oauth: accountId, email: a.email, imap: mail.imap, smtp: mail.smtp });
  }

  /**
   * Removes the account, its tokens and the calendars and mail accounts reached through it: at once,
   * so that a refresh under way writes nothing back (`TokenBroker.forget()`). Google's token is revoked
   * then too; Microsoft has no revoke for one token, so its pages where the app's access is taken away
   * are returned for the user.
   */
  async removeAccount(accountId: string): Promise<{ permissionsPages?: string[] }> {
    const a = this.account(accountId);
    let provider: OAuthProvider | undefined;
    try {
      provider = this.provider(a.provider);
    } catch {
      provider = undefined;
    }
    const refresh = this.store.refreshToken(accountId);
    this.broker.forget(accountId);
    this.store.delete(accountId);
    this.connectors.removeOAuth(accountId);
    if (provider?.endpoints.revoke && refresh) {
      await fetch(provider.endpoints.revoke, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: refresh }).toString(),
        redirect: 'manual',
        signal: AbortSignal.timeout(15_000),
      }).catch(() => undefined);
    }
    return provider?.permissionsPages ? { permissionsPages: provider.permissionsPages } : {};
  }

  private account(id: string) {
    const a = this.store.account(id);
    if (!a) throw new HttpError(404, t().connectorNotFound(id));
    return a;
  }

  // CalendarOAuth: how the calendar tools reach a calendar of an account.

  via(oauthAccount: string) {
    const a = this.store.account(oauthAccount);
    if (!a) throw new Error(t().oauthAccountGone);
    return {
      api: a.provider === 'microsoft' ? ('graph' as const) : ('caldav' as const),
      fetch: this.broker.fetch(oauthAccount, 'calendar'),
    };
  }

  // MailOAuth: how the mail tools, the mail trigger and IDLE reach a mail account of an account.

  /** Its provider's own mail servers as they are now (never those saved with the mail account), and its address. */
  mailVia(oauthAccount: string) {
    const a = this.store.account(oauthAccount);
    if (!a) throw new Error(t().oauthAccountGone);
    const { mail } = this.provider(a.provider);
    return { imap: mail.imap, smtp: mail.smtp, username: a.email };
  }

  mailToken(oauthAccount: string, fresh = false): Promise<string> {
    return this.broker.accessToken(oauthAccount, 'mail', fresh);
  }

  signInState(oauthAccount: string): string {
    const a = this.store.account(oauthAccount);
    return a ? `${a.status} ${a.connectedAt}` : 'gone';
  }

  problem(oauthAccount: string): string | undefined {
    const a = this.store.account(oauthAccount);
    if (!a) return t().oauthAccountGone;
    if (a.status === 'reauth') return t().oauthSignInAgain(a.email, a.error ?? '');
    return undefined;
  }

  /** How a sign-in goes, for the page that started it. */
  signIn(id: string, session?: string): OAuthSignInView {
    return this.signIns.get(id, session);
  }
}
