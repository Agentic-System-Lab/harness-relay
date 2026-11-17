**English** | [繁體中文](oauth.zh-TW.md)

# Accounts that sign in with OAuth

> **Status: the core and its first uses built: Microsoft 365 and Outlook.com calendars over Microsoft Graph, and Google Calendar over its CalDAV with the account's token (not yet tried against Google itself). Mail over OAuth, remote MCP servers' own sign-in and Harness Relay's own registered apps are still a proposal.** See [Proposals](README.md). From [#90](https://github.com/Agentic-System-Lab/harness-relay/issues/90).

## Why

The mail and calendar tools sign in with app passwords, so there is no OAuth client to register and nothing to get verified. That leaves out:

- **Google Calendar.** Its CalDAV endpoint accepts only OAuth 2.0.
- **Microsoft 365 and Outlook.com calendars.** They have no CalDAV at all, only Microsoft Graph.
- **Microsoft 365 mail.** Exchange Online no longer takes Basic authentication for IMAP, and is retiring it for SMTP AUTH.
- **Remote MCP servers that sign in with OAuth** (MCP's authorization spec). The tool library only takes their token as a header typed in by hand.

App passwords stay: OAuth comes beside them, chosen per account. Every provider the connectors support has some OAuth route, but each needs that provider to register or approve the app first, and an arbitrary IMAP or CalDAV server has none (an IETF draft would add one, with dynamic client registration and PKCE).

## One interface

It is one interface for OAuth itself, and each API stays with the tool group that uses it. What differs between providers is mostly data, so a provider is a description, not a class:

- **Provider** (`src/server/oauth/providers.ts`): its endpoints (authorize, token, and revoke and device code where it has them), the app's client id (and Google's client secret), the flows it allows (`loopback`, `device`), the scopes each use asks for, the only hosts its access token is sent to, extra sign-in parameters (Google's `access_type=offline` and `prompt=consent`), who signed in (`whoami`), its calendars and the one a new sign-in adds, and, for Microsoft, the pages where the user takes the app's access away.
- **Account** (`store.ts`): its provider, who it is (its id at the provider, which never changes, its address and name), what uses it, the scopes granted, and whether it is connected or needs signing in again. Its refresh token goes to the credential store (`oauth-<id>`), as a mail password does; the access token is kept in memory only. The UI sees "connected as …", never a token, and no CLI ever gets one.
- **Token broker** (`broker.ts`): `accessToken()` refreshes a token two minutes before it expires, one refresh at a time per account; it keeps the new refresh token when the provider rotates it (Microsoft does), and on `invalid_grant` marks the account as needing a new sign-in, which Settings and the calendar tools' `unavailable()` both show. `fetch()` sends the token only to the provider's hosts (https, or plain http to this computer for a stand-in), never follows a redirect with it, and refreshes once when the provider answers 401.
- **Sign-in** (`signin.ts`): see below.
- **Connectors take an auth source.** `caldav.ts` signs its requests with a password (Basic) or through an account's fetch (Bearer); `graph.ts` is the new Graph client; `calendar.ts` gives the calendar tools one backend whichever it is, and agents see no difference.

Adding a provider is a description and a test; adding a use is a connector that asks the broker for a fetch.

## The sign-in

The server runs the sign-in; the page only starts it and shows how it went.

- **The main flow** is an authorization code with PKCE (S256) and a loopback redirect (RFC 8252) to the web app's own page, `/oauth/callback`, on the origin the page that started it is on when that is this computer (`http://127.0.0.1:8787`, `http://localhost:5173`). Microsoft and Google both take any loopback port for a desktop app. The provider's page opens in a new tab (in the desktop app, in the system browser).
- **A browser on another computer** (a codespace, Tailscale) never reaches this computer's loopback: the redirect then goes to `http://localhost:<port>/oauth/callback`, the page says it cannot be reached, and the user pastes its address into Settings, which only the browser that started the sign-in can do.
- **On another device**, where the provider allows it for the scopes: Microsoft's device code flow (a code typed at Microsoft's address, while the server asks Microsoft until it is done). Google's device flow takes a short list of scopes, without Calendar's, so Google has the loopback flow only.

## Answers to the open questions

- **Whose OAuth client?** Both, and the user's own first. Settings → Tool library takes a client id (with Microsoft's tenant, and Google's client secret, which for a desktop app is not one but is required). `BUILT_IN_CLIENTS` would hold Harness Relay's own apps, registered once and shipped in the code; none is registered yet. On Microsoft Entra that would be one public client for work, school and personal accounts. Google wants the app verified for Calendar's sensitive scope (and a security assessment for Gmail's restricted one); a user's own Google app still in Testing gets refresh tokens that expire after 7 days. A work or school tenant may need its admin to consent either way.
- **The callback route.** Neither option as #90 wrote them, because the redirect is a top-level navigation from the provider's site: the session cookie is `SameSite=Strict`, so it does not come with it (option B, `BROWSER_LOADS`, cannot work), and in the desktop app it opens in the system browser, which was never signed in (option A, a page posting with the key, cannot either). Built: `/oauth/callback` is a page of the web app (outside `/api/`, as every page is), which posts the code and state as JSON to `POST /api/oauth/callback`. That route keeps the Host, Origin and JSON checks and takes the state as its proof, the way the webhook takes its token: 256 random bits that only the provider and the browser see, compared by hash in constant time, for one sign-in, working once, within 10 minutes; the code is worth nothing without the PKCE verifier, which never leaves the server. Twenty callbacks naming no sign-in within 10 minutes and the route refuses them for a while (429). The page posts once (also for React's StrictMode), then takes the code and state off its address.
- **One sign-in for several groups?** One account per sign-in, with what uses it (`uses`, only `calendar` so far). A later use asks for its scopes at a sign-in of its own (incremental consent), which updates the same account, found by its id at the provider. Mail accounts and calendars stay apart (`ConnectorStore`); a calendar reached through an account names it (`CalendarAccountView.oauth`), and a new sign-in for calendars adds the account's own calendar. The others it has are listed and added from Settings.
- **Removing an account.** Its refresh token and its calendars go. Google's token is revoked; Microsoft has no revoke for one token, so Settings names the pages where the user takes the app's access away (`myapps.microsoft.com` for work and school accounts, `account.live.com/consent/Manage` for personal ones).

## Settings and the environment

- **Settings → Tool library → Mail and calendar → Accounts you sign in to:** the app for each provider (with the redirect addresses Microsoft's must allow), **Sign in with …**, **Sign in on another device** (Microsoft), the accounts with their state, their calendars to add, and Remove.
- **`RELAY_MICROSOFT_LOGIN_URL` and `RELAY_MICROSOFT_GRAPH_URL`** point Microsoft's sign-in and Graph at another cloud than the global one (a national one, such as `https://login.microsoftonline.us` and `https://graph.microsoft.us`), or at a stand-in on this computer in the end-to-end tests: https, or plain http to this computer only.

## HTTP API

| Method and path | Purpose |
| --- | --- |
| `GET /api/oauth` | the providers' apps (masked) and the accounts |
| `PUT /api/oauth/clients/:provider` | a provider's app: client id, tenant, secret |
| `POST /api/oauth/signins` | start a sign-in (`provider`, the page's `origin`, `device`) |
| `GET /api/oauth/signins/:id` | how it goes, for the browser that started it |
| `POST /api/oauth/signins/:id/address` | the address the provider's page ended at, pasted |
| `DELETE /api/oauth/signins/:id` | cancel it |
| `POST /api/oauth/callback` | the callback page's code and state: no sign-in, the state is the proof |
| `GET /api/oauth/accounts/:id/calendars` | an account's calendars |
| `POST /api/oauth/accounts/:id/calendars` | add one to the calendar tools (an address on its provider's hosts only) |
| `DELETE /api/oauth/accounts/:id` | remove it, its tokens and its calendars |

## Not built yet

In this order, each a pull request of its own:

1. **Mail over OAuth.** Microsoft 365 and Gmail through the same IMAP and SMTP clients with SASL XOAUTH2, or through Graph and the Gmail API. Microsoft's IMAP and SMTP tokens are for another resource (`outlook.office.com`) than Graph's, so the broker would keep a token per resource. Once that is there, an OAuth account's mail can start an automation too ([triggers](triggers.md)).
2. **Remote MCP servers' own sign-in** in the tool library: OAuth 2.1, protected resource metadata and dynamic client registration, so the provider is discovered for each server instead of being built in; it may share only the broker and the sign-in. A token that expires within the hour would be given to the CLI again each turn, or the server's tools passed through the gateway so the token never leaves the server.
3. **Harness Relay's own apps** (`BUILT_IN_CLIENTS`), once someone owns the registrations and Google's verification.
4. **Whatever else fits**, such as Google Drive or OneDrive files and tasks, each with a tool group and tiers of its own.

The CLIs' own sign-ins (`login.ts`) stay out of scope; each CLI keeps its own.

## Alternatives considered

- **A class per provider.** Rejected: the differences are data, and a description is easier to test against a stand-in.
- **A sign-in window inside the desktop app.** Rejected: RFC 8252 says to use the system browser, where the user's own sign-ins and password manager are and Harness Relay never sees the password; the desktop app already sends every page that is not its own there.
- **Keeping access tokens in the database.** Rejected: they last an hour and are refreshed when needed; only the refresh token is kept, in the credential store.

## Tests

Everything runs offline:

- `test/fake-oauth-server.ts`: a stand-in for Microsoft's sign-in and Graph (authorize, the code exchanged with its verifier, refresh with rotation, `invalid_grant`, the device code, `/me`, `/me/calendars`, `calendarView` in pages, `POST …/events`).
- `test/oauth.test.ts`: the sign-in (PKCE, the redirect address, the state once and for its own sign-in only, a refusal, expiry, a pasted address, the device code), the broker (refreshing early and once, rotation, `invalid_grant`, the host rule, no redirect, a refused token refreshed once), the calendar tools over Graph, and the HTTP API with sign-in on (only the callback answers without it).
- `test/oauth-web.test.ts`: the page's own logic (the redirect addresses, what the callback got).
- `e2e/specs/oauth.spec.ts`: a sign-in in a new tab against a stand-in Microsoft page, back to `/oauth/callback`, its calendars added and the account removed.
