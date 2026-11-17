**English** | [繁體中文](oauth.zh-TW.md)

# Accounts that sign in with OAuth

> **Status: the core and its uses built: Microsoft 365 and Outlook.com calendars over Microsoft Graph, Google Calendar over its CalDAV with the account's token, and Microsoft 365, Outlook.com and Gmail mail over their own IMAP and SMTP with SASL XOAUTH2, for the mail tools, the mail trigger and its IMAP IDLE (Microsoft's sign-in, Graph and mail servers, and Google's sign-in, CalDAV and Gmail, tried against stand-ins only, not against the real services). Remote MCP servers' own sign-in and Harness Relay's own registered apps are still a proposal.** See [Proposals](README.md). From [#90](https://github.com/Agentic-System-Lab/harness-relay/issues/90).

## Why

The mail and calendar tools sign in with app passwords, so there is no OAuth client to register and nothing to get verified. That leaves out:

- **Google Calendar.** Its CalDAV endpoint accepts only OAuth 2.0.
- **Microsoft 365 and Outlook.com calendars.** They have no CalDAV at all, only Microsoft Graph.
- **Microsoft 365 mail.** Exchange Online no longer takes Basic authentication for IMAP, and is retiring it for SMTP AUTH.
- **Remote MCP servers that sign in with OAuth** (MCP's authorization spec). The tool library only takes their token as a header typed in by hand.

App passwords stay: OAuth comes beside them, chosen per account. Every provider the connectors support has some OAuth route, but each needs that provider to register or approve the app first, and an arbitrary IMAP or CalDAV server has none (an IETF draft would add one, with dynamic client registration and PKCE).

## One interface

It is one interface for OAuth itself, and each API stays with the tool group that uses it. What differs between providers is mostly data, so a provider is a description, not a class:

- **Provider** (`src/server/oauth/providers.ts`): its endpoints (authorize, token, and revoke and device code where it has them), the app's client id (and Google's client secret), the flows it allows (`loopback`, `device`), the scopes each use asks for, the only hosts its access token is sent to, its own mail servers (the only ones a token for mail goes to: Microsoft's `outlook.office365.com:993` and `smtp.office365.com:587`, Gmail's `imap.gmail.com:993` and `smtp.gmail.com:465`), extra sign-in parameters (Google's `access_type=offline`, `prompt=consent` and `include_granted_scopes=true`), who signed in (`whoami`), its calendars and the one a new sign-in adds, and, for Microsoft, the pages where the user takes the app's access away. Microsoft's tokens are each for one resource, so it says too which scopes each use's own token is asked for (`tokenScopes`: Graph's for the calendar, Exchange Online's for mail) and what the code exchange asks for (`signInToken`: Graph's, to ask who signed in).
- **Account** (`store.ts`): its provider, who it is (its id at the provider, which never changes, its address and name), what uses it, the scopes granted, and whether it is connected or needs signing in again. Its refresh token goes to the credential store (`oauth-<id>`), as a mail password does; the access token is kept in memory only. The UI sees "connected as …", never a token, and no CLI ever gets one.
- **Token broker** (`broker.ts`): `accessToken(account, use)` refreshes a token two minutes before it expires, one refresh at a time per account; it keeps a token per account and use where the provider's tokens are each for one resource (Microsoft: Graph's for the calendar, `outlook.office.com`'s for IMAP and SMTP), each refreshed with that use's own scopes from the one refresh token, and one for every use otherwise (Google's covers each scope granted). It keeps the new refresh token when the provider rotates it (Microsoft does), so the next refresh, for whichever use, sends it; on `invalid_grant` it marks the account as needing a new sign-in, which Settings and the tools' `unavailable()` show. It never asks for a use the account was not signed in for (a refusal of that would mark the whole account). `fetch()` sends the token only to the provider's hosts (https, or plain http to this computer for a stand-in), never follows a redirect with it, and refreshes once when the provider answers 401.
- **Sign-in** (`signin.ts`): see below.
- **Connectors take an auth source.** `caldav.ts` signs its requests with a password (Basic) or through an account's fetch (Bearer); `graph.ts` is the new Graph client; `calendar.ts` gives the calendar tools one backend whichever it is. The IMAP and SMTP clients sign in with a password or with a token (SASL XOAUTH2: IMAP's `AUTHENTICATE XOAUTH2`, SMTP's `AUTH XOAUTH2`; a refusal's reason, which Gmail sends first in a continuation, answered with an empty line), and `mailLogin.ts` is the one place that gives a mail account's servers and sign-in to the mail tools, Test, the mail trigger and IDLE: its own servers and password, or its provider's servers and a fresh token for mail; a token the server refuses is renewed once and tried again, and an account that needs a new sign-in says so before any server is asked. Agents see no difference.

Adding a provider is a description and a test; adding a use is a connector that asks the broker for a fetch.

## The sign-in

The server runs the sign-in; the page only starts it and shows how it went.

- **The main flow** is an authorization code with PKCE (S256) and a loopback redirect (RFC 8252) to the web app's own page, `/oauth/callback`, on the origin the page that started it is on when that is this computer (`http://127.0.0.1:8787`, `http://localhost:5173`). Microsoft and Google both take any loopback port for a desktop app. The provider's page opens in a new tab (in the desktop app, in the system browser).
- **A browser on another computer** (a codespace, Tailscale) never reaches this computer's loopback: the redirect then goes to `http://localhost:<port>/oauth/callback`, the page says it cannot be reached, and the user pastes its address into Settings, which only the browser that started the sign-in can do.
- **On another device**, where the provider allows it for the scopes: Microsoft's device code flow (a code typed at Microsoft's address, while the server asks Microsoft until it is done). Google's device flow takes a short list of scopes, without Calendar's or Gmail's, so Google has the loopback flow only.
- **What was granted** is checked for each use of the sign-in where the provider's answer says: a sign-in without its use's own scopes would look connected, and fail at its first request (Google lets the user untick Calendar or Gmail on its page). Microsoft's code exchange asks for Graph's token; a sign-in for mail then asks at once, with the refresh token, for Exchange Online's token, and fails when that is refused or does not carry IMAP's and SMTP's scopes.

## Answers to the open questions

- **Whose OAuth client?** Both, and the user's own first. Settings → Tool library takes a client id (with Microsoft's tenant, and Google's client secret, which for a desktop app is not one but is required). `BUILT_IN_CLIENTS` would hold Harness Relay's own apps, registered once and shipped in the code; none is registered yet. On Microsoft Entra that would be one public client for work, school and personal accounts. Google wants the app verified for Calendar's sensitive scope (and a security assessment for Gmail's restricted one); a user's own Google app still in Testing gets refresh tokens that expire after 7 days. A work or school tenant may need its admin to consent either way.
- **The callback route.** Neither option as #90 wrote them, because the redirect is a top-level navigation from the provider's site: the session cookie is `SameSite=Strict`, so it does not come with it (option B, `BROWSER_LOADS`, cannot work), and in the desktop app it opens in the system browser, which was never signed in (option A, a page posting with the key, cannot either). Built: `/oauth/callback` is a page of the web app (outside `/api/`, as every page is), which posts the code and state as JSON to `POST /api/oauth/callback`. That route keeps the Host, Origin and JSON checks and takes the state as its proof, the way the webhook takes its token: 256 random bits that only the provider and the browser see, compared by hash in constant time, for one sign-in, working once, within 10 minutes; the code is worth nothing without the PKCE verifier, which never leaves the server. Twenty callbacks naming no sign-in within 10 minutes and the route refuses those that name none for a while (429); one with a sign-in's own state always goes through. The page posts once (also for React's StrictMode), then takes the code and state off its address once a sign-in here answered; when none here has them (another computer's Harness Relay started it), it shows the address to paste there.
- **One sign-in for several groups?** One account per sign-in, with what uses it (`uses`: `calendar`, `mail`). A later use asks for its scopes at a sign-in of its own (incremental consent), which updates the same account, found by its id at the provider; the uses kept become both. Microsoft keeps what was consented, so a sign-in for mail keeps the calendar's; Google's is asked with `include_granted_scopes=true`, so its answer lists every scope granted, which is checked against the account's uses before and now together: a sign-in for mail that would leave the calendar without its access (taken away at Google meanwhile) is refused, and the account stays as it was. Mail accounts and calendars stay apart (`ConnectorStore`); one reached through an account names it (`oauth`), a new sign-in for calendars adds the account's own calendar (the others it has are listed and added from Settings), and one for mail adds its mail account, at its provider's own servers, with its address as the sender and user name. Those servers and that sign-in are fixed (saving it with a password or other servers is a 409); it is removed, and added again from its account.
- **Removing an account.** Its refresh token, its calendars and its mail accounts go. Google's token is revoked; Microsoft has no revoke for one token, so Settings names the pages where the user takes the app's access away (`myapps.microsoft.com` for work and school accounts, `account.live.com/consent/Manage` for personal ones).

## Settings and the environment

- **Settings → Tool library → Mail and calendar → Accounts you sign in to:** the app for each provider (with the redirect addresses Microsoft's must allow), what a new sign-in is for (**Calendars**, **Mail**, or both), **Sign in with …**, **Sign in on another device** (Microsoft), the accounts with their state and what they are used for, their calendars to add, **Use for calendars** and **Use for mail** (a sign-in for that use when it is not granted yet, asking for the account's other uses too, with its address as `login_hint`; once mail is granted, it adds the mail account itself), **Sign in again** alone while an account needs a new sign-in, and Remove. A sign-in adds an account's calendar or mail account by itself only at its first sign-in for that use.
- **`RELAY_MICROSOFT_LOGIN_URL` and `RELAY_MICROSOFT_GRAPH_URL`** point Microsoft's sign-in and Graph at another cloud than the global one (a national one, such as `https://login.microsoftonline.us` and `https://graph.microsoft.us`), or at a stand-in on this computer in the end-to-end tests: https, or plain http to this computer only.
- **`RELAY_MICROSOFT_IMAP` and `RELAY_MICROSOFT_SMTP`** (`host:port`) point Microsoft accounts' mail at stand-ins on this computer in the end-to-end tests, instead of `outlook.office365.com:993` and `smtp.office365.com:587`: TLS, or STARTTLS on IMAP's port 143 and SMTP's 587 and 25; plain TCP to this computer only. They are not for a national cloud: its mail is not supported yet, since Exchange Online's scopes stay the global cloud's (`https://outlook.office.com/…`).

## HTTP API

| Method and path | Purpose |
| --- | --- |
| `GET /api/oauth` | the providers' apps (masked) and the accounts |
| `PUT /api/oauth/clients/:provider` | a provider's app: client id, tenant, secret |
| `POST /api/oauth/signins` | start a sign-in (`provider`, its `uses`: `calendar`, `mail` or both, the calendar when none; the page's `origin`, `device`) |
| `GET /api/oauth/signins/:id` | how it goes, for the browser that started it |
| `POST /api/oauth/signins/:id/address` | the address the provider's page ended at, pasted |
| `DELETE /api/oauth/signins/:id` | cancel it |
| `POST /api/oauth/callback` | the callback page's code and state: no sign-in, the state is the proof |
| `GET /api/oauth/accounts/:id/calendars` | an account's calendars |
| `POST /api/oauth/accounts/:id/calendars` | add one to the calendar tools (an address on its provider's hosts only; an account signed in for calendars only) |
| `POST /api/oauth/accounts/:id/mail` | add its mail account to the mail tools, once (an account signed in for mail only) |
| `DELETE /api/oauth/accounts/:id` | remove it, its tokens, its calendars and its mail accounts |

A mail account reached through an account is tested as any other (`POST /api/connectors/mail/:id/test`, over XOAUTH2), and refuses `PUT /api/connectors/mail/:id` (409).

## Not built yet

In this order, each a pull request of its own:

1. **Remote MCP servers' own sign-in** in the tool library: OAuth 2.1, protected resource metadata and dynamic client registration, so the provider is discovered for each server instead of being built in; it may share only the broker and the sign-in. A token that expires within the hour would be given to the CLI again each turn, or the server's tools passed through the gateway so the token never leaves the server.
2. **Harness Relay's own apps** (`BUILT_IN_CLIENTS`), once someone owns the registrations and Google's verification (Gmail's scope is a restricted one, which needs a security assessment besides).
3. **Whatever else fits**, such as Google Drive or OneDrive files and tasks, each with a tool group and tiers of its own.

Mail over OAuth went through the IMAP and SMTP clients the mail tools already had, with SASL XOAUTH2, rather than through Graph and the Gmail API: the tools, the mail trigger and IDLE stay one code path for every provider. What stays open there: Microsoft's national clouds' mail, not supported yet (Exchange Online's scopes are the global cloud's; each cloud's resource would have to be named by a setting), and Microsoft 365 tenants that turned SMTP AUTH off for the mailbox (Send is then refused; Graph's `sendMail` would not be).

The CLIs' own sign-ins (`login.ts`) stay out of scope; each CLI keeps its own.

## Alternatives considered

- **A class per provider.** Rejected: the differences are data, and a description is easier to test against a stand-in.
- **A sign-in window inside the desktop app.** Rejected: RFC 8252 says to use the system browser, where the user's own sign-ins and password manager are and Harness Relay never sees the password; the desktop app already sends every page that is not its own there.
- **Keeping access tokens in the database.** Rejected: they last an hour and are refreshed when needed; only the refresh token is kept, in the credential store.

## Tests

Everything runs offline:

- `test/fake-oauth-server.ts`: a stand-in for Microsoft's sign-in and Graph (authorize, the code exchanged with its verifier, refresh with rotation, `invalid_grant` and the other refusals, the granted scopes, a token for one resource as the request's scope says, a request naming two refused and a refresh for scopes never consented to as well, the device code with its slow-downs and errors, `/me`, `/me/calendars`, `calendarView` in pages, `POST …/events`), and for Google's (its token endpoint checking the client secret, the scopes granted before with `include_granted_scopes`, revoke, userinfo, and a CalDAV that takes a Bearer token only); it can hold an answer, or drop a request, to stand for a slow or failing network.
- `test/fake-mail-servers.ts`: the IMAP and SMTP stand-ins take XOAUTH2 with the tokens a test says, and refuse another as Gmail does (its reason in a continuation, then NO or 535) or as Microsoft does.
- `test/oauth.test.ts`: the sign-in (PKCE, the redirect address, the state once and for its own sign-in only, a refusal, expiry, a pasted address, the device code and its retries, the scopes granted, a sign-in ended when its app changes or cancelled at any step), the broker (refreshing early and once, rotation, the refusals that need a new sign-in and the errors that do not, an account removed or signed in again during a refresh, the host and https rule, no redirect, a refused token refreshed once), the calendar tools over Graph and over Google's CalDAV with a token, Google's revoke, and the HTTP API with sign-in on (only the callback answers without it; its 429; the limits and refusals of each route).
- `test/oauth-mail.test.ts`: mail over OAuth: XOAUTH2 in both clients and the servers' refusals, Microsoft's token for each use from one refresh token (rotation shared, one refresh at a time), a sign-in for mail and its scopes (Microsoft's mail token at once, Gmail unticked, Google's incremental consent keeping the calendar's, or refused when it lost it; Microsoft's other uses' tokens asked for with the new refresh token), no token for a use not signed in for, the mail account added at the first sign-in for mail only, the mail tools, the mail trigger and IDLE with a token (a refused one renewed once; an account that needs a new sign-in an error, and IDLE's login backoff until it is signed in again), the token never in the clear but to this computer, the fixed servers, and the HTTP API.
- `test/oauth-web.test.ts`: the page's own logic (the redirect addresses, what the callback got and when it clears its address, the popup message in the desktop app, what each account offers for calendars and mail).
- `e2e/specs/oauth.spec.ts`: a sign-in in a new tab against a stand-in Microsoft page, back to `/oauth/callback`, its calendars added, a refresh refused (Needs a new sign-in, Sign in again), and the account removed; a sign-in for mail alone, its mail account added and tested over XOAUTH2 against stand-in IMAP and SMTP servers on this computer, removed and added again, and removed with its account.
