**English** | [繁體中文](oauth.zh-TW.md)

# Accounts that sign in with OAuth

> **Status: the core and its first uses built: Microsoft 365 and Outlook.com calendars over Microsoft Graph, Google Calendar over its CalDAV with the account's token, and remote MCP servers' own sign-in in the tool library (Microsoft's sign-in and Graph, Google's sign-in and CalDAV, and MCP's authorization, each tried against stand-ins only, not against real services). Mail over OAuth, an MCP server's tools passed through the gateway, and Harness Relay's own registered apps are still a proposal.** See [Proposals](README.md). From [#90](https://github.com/Agentic-System-Lab/harness-relay/issues/90).

## Why

The mail and calendar tools sign in with app passwords, so there is no OAuth client to register and nothing to get verified. That leaves out:

- **Google Calendar.** Its CalDAV endpoint accepts only OAuth 2.0.
- **Microsoft 365 and Outlook.com calendars.** They have no CalDAV at all, only Microsoft Graph.
- **Microsoft 365 mail.** Exchange Online no longer takes Basic authentication for IMAP, and is retiring it for SMTP AUTH.
- **Remote MCP servers that sign in with OAuth** (MCP's authorization spec). The tool library only takes their token as a header typed in by hand.

App passwords stay: OAuth comes beside them, chosen per account. Every provider the connectors support has some OAuth route, but each needs that provider to register or approve the app first, and an arbitrary IMAP or CalDAV server has none (an IETF draft would add one, with dynamic client registration and PKCE).

## One interface

It is one interface for OAuth itself, and each API stays with the tool group that uses it. What differs between providers is mostly data, so a provider is a description, not a class:

- **Provider** (`src/server/oauth/providers.ts`): a description the sign-ins and the broker take (`OAuthProvider`), with what an account's provider adds (`AccountProvider`): its endpoints (authorize, token, and revoke and device code where it has them), the app's client id (and Google's client secret), the flows it allows (`loopback`, `device`), the scopes each use asks for, the only hosts its access token is sent to, extra sign-in parameters (Google's `access_type=offline` and `prompt=consent`), who signed in (`whoami`), its calendars and the one a new sign-in adds, and, for Microsoft, the pages where the user takes the app's access away.
- **Account** (`store.ts`): its provider, who it is (its id at the provider, which never changes, its address and name), what uses it, the scopes granted, and whether it is connected or needs signing in again. Its refresh token goes to the credential store (`oauth-<id>`), as a mail password does; the access token is kept in memory only. The UI sees "connected as …", never a token, and no CLI ever gets one.
- **Token broker** (`broker.ts`): over the sign-ins it is given (`TokenGrants`: the accounts, or the tool library's MCP servers, one broker each), `accessToken()` refreshes a token two minutes before it expires (a turn's MCP server: when less than half its lifetime, or ten, whichever is less, is left), one refresh at a time per sign-in; it keeps the new refresh token when the provider rotates it (Microsoft does), and on `invalid_grant` marks the account as needing a new sign-in, which Settings and the calendar tools' `unavailable()` both show. `fetch()` sends the token only to the provider's hosts (https, or plain http to this computer for a stand-in), never follows a redirect with it, and refreshes once when the provider answers 401.
- **Sign-in** (`signin.ts`): see below.
- **Connectors take an auth source.** `caldav.ts` signs its requests with a password (Basic) or through an account's fetch (Bearer); `graph.ts` is the new Graph client; `calendar.ts` gives the calendar tools one backend whichever it is, and agents see no difference.

Adding a provider is a description and a test; adding a use is a connector that asks the broker for a fetch. An MCP server's provider is a description too, built from what it publishes (below).

## The sign-in

The server runs the sign-in; the page only starts it and shows how it went.

- **The main flow** is an authorization code with PKCE (S256) and a loopback redirect (RFC 8252) to the web app's own page, `/oauth/callback`, on the origin the page that started it is on when that is this computer (`http://127.0.0.1:8787`, `http://localhost:5173`). Microsoft and Google both take any loopback port for a desktop app. The provider's page opens in a new tab (in the desktop app, in the system browser).
- **A browser on another computer** (a codespace, Tailscale) never reaches this computer's loopback: the redirect then goes to `http://localhost:<port>/oauth/callback`, the page says it cannot be reached, and the user pastes its address into Settings, which only the browser that started the sign-in can do.
- **On another device**, where the provider allows it for the scopes: Microsoft's device code flow (a code typed at Microsoft's address, while the server asks Microsoft until it is done). Google's device flow takes a short list of scopes, without Calendar's, so Google has the loopback flow only.

## Remote MCP servers' own sign-in

An HTTP server in the tool library that signs in with OAuth (MCP's authorization spec, 2025-06-18) signs in from its row in Settings → Tool library, rather than with a token typed into its headers (`src/server/oauth/mcp.ts`). Its provider is discovered for each server, and its sign-in goes through the same sign-ins, callback page and checks as an account's.

- **Discovery.** The server is sent an `initialize` without a token. It answers 401 with `WWW-Authenticate: Bearer resource_metadata="…"` (RFC 9728), or else its protected resource metadata is at `/.well-known/oauth-protected-resource` with the server's path, then without it. Metadata for another resource than the server (not the server's canonical URL: another origin or path, one above it included) is refused. It names the authorization servers; the first one's metadata is at `/.well-known/oauth-authorization-server` (RFC 8414, the well-known part inserted before an issuer's path), else OpenID's `/.well-known/openid-configuration` (inserted, then appended), and must name that issuer exactly. No PKCE with S256 in `code_challenge_methods_supported`: no sign-in. No `registration_endpoint`: the server needs a client registered by hand, which is not taken yet, and the page says so. A server that answers without a 401 and publishes no metadata asks for no sign-in, which the page says too. Every address is https, or plain http to this computer only for a server that is itself on this computer (a stand-in); for a server elsewhere, every request of its sign-in goes only to addresses on the internet, looked up, checked and pinned (never this computer or the local network); no redirect is followed; each request has 15 seconds and reads 256 KB at most, every field of an answer capped.
- **Registration** (RFC 7591): a public client named Harness Relay (`token_endpoint_auth_method: none`, grant types `authorization_code` and `refresh_token`, the scopes asked for), with the exact redirect address the sign-in uses (`/oauth/callback` on the page's own origin, as for an account). It is kept with the server, and registered again, with the addresses kept, when a sign-in needs one it lacks; a client a refresh found refused (`invalid_client`, `unauthorized_client`) is registered again at the next sign-in, which the server then needs. A client secret the authorization server gives all the same goes to the credential store, and is sent as it says (Basic, or in the form).
- **The sign-in** asks for the scopes the 401's challenge names, else those the resource metadata lists (`scopes_supported`), else none, and names the resource (RFC 8707: the metadata's `resource` as it names it, which is the server's own URL; without one, the server's canonical URL) in the authorization request and in every token request, the refreshes too. An authorization server that gives no refresh token is taken: the sign-in then lasts as long as its access token. Against a mix-up (a hostile server's metadata naming another authorization server's page, to have the code sent to its own token endpoint), the redirect's `iss` must be the sign-in's issuer (RFC 9207; required when the metadata says it is always there), and when the page or the token endpoint is not on the issuer's origin, the row first says where the user will sign in, and opens the page only on **Continue**. A sign-in again revokes the refresh token it replaces.
- **Kept with the server** (`ToolLibrary`): the authorization server's issuer and endpoints, the client and its redirect addresses, the resource, the scopes, the host its token goes to, and its state (signed in since when, or needing a new sign-in and why). Its refresh token and client secret are one entry in the credential store, `mcp-oauth.<server id>` (a dot, which no server's name has, so it is never another server's `mcp-<id>`); its access token is in memory only. The UI sees **Signed in** (and when) or **Needs a new sign-in**, never a token.
- **Each turn**, before the CLI starts, an agent given the server gets an access token with at least half its lifetime, or ten minutes, whichever is less, left (renewed when it has less), in the server's `Authorization` header, in place of one typed by hand. It goes only to the host the server signed in at, over https (plain http to this computer only). It reaches the CLI as the library's headers do, so the CLI holds a short-lived token for the turn. A server whose token cannot be had (its refresh refused, `invalid_grant`, or not renewed now) is left out of the turn: the reply shows a note to the user, the agent's briefing says so in English, and Settings shows the server needing a new sign-in; the note is shown on a reply whose agent passed, too. A member whose CLI takes no HTTP server (Antigravity) gets no token, refresh or note.
- **Removing the server, changing its URL (another server: not only a slash), or Sign out** deletes its tokens, ends its sign-ins under way, and revokes its refresh token (else its access token) at the authorization server's `revocation_endpoint` when the metadata has one (RFC 7009). Renaming it, or changing its headers or CLIs, keeps its sign-in.

## Answers to the open questions

- **Whose OAuth client?** Both, and the user's own first. Settings → Tool library takes a client id (with Microsoft's tenant, and Google's client secret, which for a desktop app is not one but is required). `BUILT_IN_CLIENTS` would hold Harness Relay's own apps, registered once and shipped in the code; none is registered yet. On Microsoft Entra that would be one public client for work, school and personal accounts. Google wants the app verified for Calendar's sensitive scope (and a security assessment for Gmail's restricted one); a user's own Google app still in Testing gets refresh tokens that expire after 7 days. A work or school tenant may need its admin to consent either way.
- **The callback route.** Neither option as #90 wrote them, because the redirect is a top-level navigation from the provider's site: the session cookie is `SameSite=Strict`, so it does not come with it (option B, `BROWSER_LOADS`, cannot work), and in the desktop app it opens in the system browser, which was never signed in (option A, a page posting with the key, cannot either). Built: `/oauth/callback` is a page of the web app (outside `/api/`, as every page is), which posts the code and state as JSON to `POST /api/oauth/callback`. That route keeps the Host, Origin and JSON checks and takes the state as its proof, the way the webhook takes its token: 256 random bits that only the provider and the browser see, compared by hash in constant time, for one sign-in, working once, within 10 minutes; the code is worth nothing without the PKCE verifier, which never leaves the server. Twenty callbacks naming no sign-in within 10 minutes and the route refuses those that name none for a while (429); one with a sign-in's own state always goes through. The page posts once (also for React's StrictMode), then takes the code and state off its address once a sign-in here answered; when none here has them (another computer's Harness Relay started it), it shows the address to paste there.
- **One sign-in for several groups?** One account per sign-in, with what uses it (`uses`, only `calendar` so far). A later use asks for its scopes at a sign-in of its own (incremental consent), which updates the same account, found by its id at the provider. Mail accounts and calendars stay apart (`ConnectorStore`); a calendar reached through an account names it (`CalendarAccountView.oauth`), and a new sign-in for calendars adds the account's own calendar. The others it has are listed and added from Settings.
- **Removing an account.** Its refresh token and its calendars go. Google's token is revoked; Microsoft has no revoke for one token, so Settings names the pages where the user takes the app's access away (`myapps.microsoft.com` for work and school accounts, `account.live.com/consent/Manage` for personal ones).

## Settings and the environment

- **Settings → Tool library → Mail and calendar → Accounts you sign in to:** the app for each provider (with the redirect addresses Microsoft's must allow), **Sign in with …**, **Sign in on another device** (Microsoft), the accounts with their state, their calendars to add, and Remove.
- **Settings → Tool library → MCP servers:** each HTTP server has **Sign in** (which finds out first whether it asks for one), then its state with **Sign in again** and **Sign out**; a sign-in under way takes a pasted address as an account's does.
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
| `POST /api/tools/mcp/:name/signin` | start an HTTP MCP server's own sign-in (the page's `origin`): discovery, a registration when needed, then followed, pasted and cancelled at `/api/oauth/signins/:id` and finished at the callback as above; 409 (`mcp-no-sign-in`) for a server that asks for none, 502 for one that cannot be signed in to |
| `DELETE /api/tools/mcp/:name/signin` | sign it out: its tokens deleted, and revoked when its authorization server can |

`GET /api/tools` says each HTTP server's sign-in state (`McpServerView.oauth`).

## Not built yet

In this order, each a pull request of its own:

1. **Mail over OAuth.** Microsoft 365 and Gmail through the same IMAP and SMTP clients with SASL XOAUTH2, or through Graph and the Gmail API. Microsoft's IMAP and SMTP tokens are for another resource (`outlook.office.com`) than Graph's, so the broker would keep a token per resource. Once that is there, an OAuth account's mail can start an automation too ([triggers](triggers.md)).
2. **A signed-in MCP server's tools passed through the gateway**, so that its token never leaves the server: today each turn gives the CLI a short-lived one in the server's headers. Beside it, for MCP servers: a client registered by hand (a client id typed in Settings) for an authorization server without dynamic registration, the 2025-03-26 spec's servers that publish no protected resource metadata (their own origin taken as the authorization server), and a sign-in on another device.
3. **Harness Relay's own apps** (`BUILT_IN_CLIENTS`), once someone owns the registrations and Google's verification.
4. **Whatever else fits**, such as Google Drive or OneDrive files and tasks, each with a tool group and tiers of its own.

The CLIs' own sign-ins (`login.ts`) stay out of scope; each CLI keeps its own.

## Alternatives considered

- **A class per provider.** Rejected: the differences are data, and a description is easier to test against a stand-in.
- **A sign-in window inside the desktop app.** Rejected: RFC 8252 says to use the system browser, where the user's own sign-ins and password manager are and Harness Relay never sees the password; the desktop app already sends every page that is not its own there.
- **Keeping access tokens in the database.** Rejected: they last an hour and are refreshed when needed; only the refresh token is kept, in the credential store.
- **An MCP server's tokens kept as an account** (`OAuthStore`). Rejected: they belong to the server (its URL, its client), so they go with it when it is removed or changed; they share the sign-ins and the broker only.

## Tests

Everything runs offline:

- `test/fake-oauth-server.ts`: a stand-in for Microsoft's sign-in and Graph (authorize, the code exchanged with its verifier, refresh with rotation, `invalid_grant` and the other refusals, the granted scopes, the device code with its slow-downs and errors, `/me`, `/me/calendars`, `calendarView` in pages, `POST …/events`), and for Google's (its token endpoint checking the client secret, revoke, userinfo, and a CalDAV that takes a Bearer token only); it can hold an answer, or drop a request, to stand for a slow or failing network.
- `test/oauth.test.ts`: the sign-in (PKCE, the redirect address, the state once and for its own sign-in only, a refusal, expiry, a pasted address, the device code and its retries, the scopes granted, a sign-in ended when its app changes or cancelled at any step), the broker (refreshing early and once, rotation, the refusals that need a new sign-in and the errors that do not, an account removed or signed in again during a refresh, the host and https rule, no redirect, a refused token refreshed once), the calendar tools over Graph and over Google's CalDAV with a token, Google's revoke, and the HTTP API with sign-in on (only the callback answers without it; its 429; the limits and refusals of each route).
- `test/oauth-web.test.ts`: the page's own logic (the redirect addresses, what the callback got and when it clears its address, an MCP server's sign-in there, the popup message in the desktop app, what an MCP server's row says of its sign-in).
- `test/fake-mcp-auth-server.ts`: a stand-in MCP server that answers 401 and serves its protected resource metadata (where its header says, or at a well-known address with or without its path), and its authorization server, whose issuer has a path (RFC 8414's and OpenID's metadata, without PKCE S256 or registration when asked, registration, authorize, the token endpoint checking PKCE, the redirect address and `resource`, refresh with rotation, `invalid_grant` and other answers, no refresh token, revocation).
- `test/mcp-oauth.test.ts`: discovery (the header, both well-known addresses, the OpenID fallbacks, no S256 or no registration refused, another resource refused, a server that asks for none, plain http elsewhere refused), registration (again for a new redirect address only; a client secret sent as given), the sign-in end to end, the token in a turn's server headers (in place of one typed by hand), refresh (with the resource, rotation, early for a turn), `invalid_grant` and a failing refresh leaving the server out with a note, no refresh token, sign out, removal and a changed URL deleting and revoking the tokens (a rename keeping them), the host rule, a restart without a credential store, and the HTTP API with sign-in on.
- `test/orchestrator-mcp-oauth.test.ts`: a member's run getting the server with its token, and once its refresh is refused, the server left out with a note in the reply and the briefing.
- `e2e/specs/oauth.spec.ts`: a sign-in in a new tab against a stand-in Microsoft page, back to `/oauth/callback`, its calendars added, a refresh refused (Needs a new sign-in, Sign in again), and the account removed.
- `e2e/specs/mcp-oauth.spec.ts`: a library MCP server's Sign in in a new tab against a stand-in authorization server, back to `/oauth/callback`, signed in, a fake Claude Code's turn given its token in the server's `Authorization` header; revoked, the next reply's note and Needs a new sign-in; Sign in again; Sign out.
