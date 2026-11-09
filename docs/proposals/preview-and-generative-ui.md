**English** | [繁體中文](preview-and-generative-ui.zh-TW.md)

# Website previews and generative UI

> **Status: proposal, not implemented.** See [Proposals](README.md).

Two things a reply cannot do today:

1. **Try what an agent built.** When the team makes a website, the user opens it in a panel next to the chat and uses it there, on this computer or on a phone, and sends what went wrong back to an agent with one click.
2. **Reply with UI.** An agent puts choices, a form, a chart or a small interactive page in its reply, and the user answers by clicking instead of typing.

Both run code or markup an agent wrote in the user's browser, so they share one security design: agent code never runs in the app's origin, and by default it cannot contact other sites.

## What exists today

- **A link to a local file is a download.** `[Report](out/report.pdf)` becomes a download from `GET /api/conversations/:id/messages/:messageId/download`, always as `application/octet-stream` with `Content-Disposition: attachment`, `nosniff` and a sandboxing `Content-Security-Policy`, "so an HTML page or SVG an agent wrote can never run in the app's origin" ([Security](../architecture.md#security)). An `.html` file an agent made can only be downloaded and opened by hand.
- **The Files browser** shows an `.html` file as highlighted text ([Browsing files](../architecture.md#browsing-files)).
- **What a reply can draw**: Markdown, images and videos on this computer (`![chart](out/chart.png)`, through the media endpoint), and ```` ```mermaid ```` diagrams, rendered as an `<img>` in which nothing runs. Nothing in a reply is interactive.
- **Asking the user**: an agent ends its reply with `[ASK_USER]` (`src/shared/ask.ts`); the team waits (`conversation.pause`) and the agent that asked answers first once the user replies. The briefing tells agents to ask "with options when that helps", but the options are plain text the user reads and types back.
- **The API's defences**: the middleware in `src/server/app.ts` checks `Host` and `Origin` and requires `application/json` on every write. The server sets no CORS headers anywhere, so a page on another origin cannot read an answer, and its JSON writes fail at the browser's preflight. The `Origin` check accepts localhost on any port.
- **Processes**: each turn runs one CLI process ([CLI adapters](../architecture.md#cli-adapters)). A dev server an agent starts from its shell is not tracked by Harness Relay. The server signals a turn's process group only when the turn is stopped or times out, and on shutdown (`killTree()` in `src/server/process.ts`). After a normal turn the server is either stopped by the CLI or left running on a port the user is never shown, with nothing in the app to stop it.
- **Phone access**: `tailscale serve` shares port 8787; a second port can be shared the same way, as [Use it from your phone → AgentsView](../remote-access.md#5-browse-agentsview-too-optional) already does.

## What is missing

- No way to see or use a site an agent made without downloading its files or running its dev server in a terminal, and nothing at all on a phone.
- No feedback loop: an error the user sees in the browser reaches the agent only if the user copies it.
- Questions with options must be answered by typing, tables are static, and an agent cannot show anything interactive (a calculator, an adjustable chart, a small game).

## Goals

- Open a site an agent made (static files, or a dev server) in a panel next to the chat, with the same experience on a phone.
- Send the page's errors to an agent with one click.
- Agents can put interactive UI in a reply, and the user answers by using it. It works the same for Claude Code, Codex and Grok, also in read-only conversations.
- Code an agent wrote never runs in the app's origin, cannot call the API, and by default loads nothing from other sites.

## Not goals

- Deploying, hosting or sharing previews with other people.
- Developer tools in the panel beyond a list of errors, and screenshots of a preview for agents (see [Open questions](#open-questions)).
- Agents driving the preview themselves (clicking, filling in forms).
- Hosting MCP Apps or speaking AG-UI (see [Alternatives considered](#alternatives-considered)).

## Design

### 1. The preview origin

If an agent's page ran in the app's origin, its scripts could call `/api/` like the UI does and start agents with full access. A page planted through a prompt injection, for example text copied from a website, could do the same. It could also read the files around it and send them away. So previews get an origin of their own.

- **A second listener**, started in `src/server/index.ts` next to the API: `127.0.0.1:8788` (`RELAY_PREVIEW_PORT`; `off` turns previews off), with its own small Hono app in `src/server/preview.ts`. Another port is another origin. The browser then stops a preview from reading the app's pages or storage, and from calling the API: the API sends no CORS headers, and its JSON writes need a preflight. As defence in depth, the API middleware also refuses requests whose `Origin` is the preview port.
- **The same `Host` check** as the API (localhost names and `RELAY_ALLOWED_HOSTS`), against DNS rebinding.
- **Every response** carries `Cache-Control: no-store` (agents rewrite files), `X-Content-Type-Options: nosniff`, no CORS headers, and a `Content-Security-Policy` whose `frame-ancestors` lists only the app's own hosts, so no other site can frame a preview. See [Network](#3-network-and-the-bridge) for the rest of the policy.
- **One preview at a time, at the root of the preview origin.** Absolute paths such as `/assets/app.js`, module scripts, `localStorage` and a dev server's hot reload then work as on a normal local server. Opening another preview replaces it. A panel still showing the old one says so and offers to switch back. With no preview open, the origin answers every path with a small page that says so.
- **The iframe**: `sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-downloads"`. Here `allow-same-origin` means the preview's own origin, which is not the app's. Without `allow-top-navigation`, the page cannot navigate the app away.
- **Its address**: `GET /api/preview` tells the UI the port, and the UI uses its own scheme and host name. That is `http://localhost:8788/` on this computer, or `https://my-computer.tail1234.ts.net:8788/` once `tailscale serve --bg --https=8788 8788` shares the port. [Use it from your phone](../remote-access.md) gets that step, like the one for AgentsView.

### 2. What can be previewed

| Kind | What | Served by |
| --- | --- | --- |
| **Files** | A folder in the working directory or an agent's worktree (`site/`, `dist/`, the root) and its entry page (`index.html` unless a file is named) | The preview server reads the files |
| **Command** | A dev server: `npm run dev`, `vite`, `python -m http.server`… | Harness Relay starts it and passes requests through |

A preview's target is `{ conversationId, root: 'cwd' | <agentId>, folder, entry? | command? }`.

**Files.**

- Paths are resolved inside the folder with the Files browser's rules (`resolveInRoot()` in `src/server/files.ts`): after following symlinks, nothing outside the folder and nothing in `.git`. Files and folders whose names start with a dot (`.env`, `.claude/`) are left out too.
- `/` serves the entry page, and a folder serves its `index.html`. A missing file is a 404, using the folder's `404.html` when it has one.
- Media types come from a fixed table: HTML, CSS, JavaScript, JSON, source maps, SVG and images, fonts, WebAssembly, audio, video and text. Anything else is `application/octet-stream`. Video supports byte ranges, like the media endpoint.

**Command.**

- **Only the user starts a command, never an agent.** A card shows the command and the folder it runs in, with **Start**. For a folder with a `package.json`, the card offers its `dev`, `start` and `preview` scripts, run with the package manager that its lockfile names.
- **A tracked, long-running process**: a new helper in `src/server/process.ts` (`startService()`) spawns it in its own process group. Its group is killed on **Stop**, when another preview replaces it, when the conversation is deleted, after 30 minutes without a request, and on shutdown (`killAll()`).
- **Environment**: the server's own, without Claude Code's nesting variables and without the stored API keys, which belong to the CLIs. On top of it come `PORT` (a free port), `HOST=127.0.0.1` and `BROWSER=none`.
- **Finding its address**: the first `http://localhost:N`, `127.0.0.1:N`, `0.0.0.0:N` or `[::1]:N` that it prints, without ANSI codes. Otherwise the `PORT` it was given, once it accepts connections. After 60 seconds without one, the preview fails and shows the end of the output. Finding the address is a pure function over output lines, tested with recorded output from common dev servers.
- **Passing requests through**: HTTP and WebSocket upgrades (hot reload) go to `127.0.0.1:<port>`. `Host` and `Origin` are rewritten to the dev server's own, so its host checks pass (Vite's `server.allowedHosts`, for example). HTML is asked for with `Accept-Encoding: identity`, so the bridge can be added to it. The last 64 KB of output are kept for the panel's **Output** tab.
- **Parallel mode**: the command runs in the agent's worktree. Ignored files such as `node_modules/` are missing there ([Known limitations](../architecture.md#known-limitations)), so a failed start shows the output, which usually says to install dependencies.
- **Trust**: a command runs project code with the user's rights, outside any agent's sandbox, also in a read-only conversation. It is what the user would do in a terminal, which is why only the user's click starts it. The card says so.

### 3. Network and the bridge

**Network is off by default.** Every HTML response gets a policy:

```
default-src 'self' data: blob: 'unsafe-inline' 'unsafe-eval';
connect-src 'self' ws://<host>:<port> wss://<host>:<port>;
form-action 'self';
frame-ancestors <the app's hosts>
```

- A preview can therefore load its own files, but no scripts, styles, fonts or images from other sites, and it cannot `fetch` them. The panel counts what was blocked and offers **Allow internet for this preview**, which relaxes the sources to `*` for that target until the server restarts. This keeps today's rule that an agent's reply cannot make the browser contact another site without the user choosing to.
- **What it cannot stop**: a page that navigates itself to another site, with data in the address. No policy covers a frame's own navigation. The bridge reports such a navigation, and the panel says the page left the preview. "Off" means the page loads nothing from other sites. It does not guarantee anything against a page written to do harm, and the files a preview can reach are only those in its folder.

**The bridge** is a small script at `/__relay/bridge.js`, a path the preview origin reserves. It is added as the first script in every HTML response, including those passed through from a dev server. It posts to its parent frame. Since `frame-ancestors` lets only the app frame a preview, that parent is the app, and the panel accepts a message only when `event.source` is its own iframe. It reports:

- uncaught errors and rejected promises, `console.error` and `console.warn` (the first 200, each cut to 2 KB), resources that failed to load, and requests the policy blocked;
- the current path, for the panel's address field, and a navigation that leaves the preview.

**Send to agent**: the panel's **Problems** list has a button that fills the composer (it does not send) with an @mention of the agent whose reply opened the preview (none when it was opened from the Files browser), followed by the problems:

```
@Claude
<preview_console page="/checkout">
TypeError: Cannot read properties of undefined (reading 'total') at app.js:42:17
GET /api/cart 404
</preview_console>
```

The user can edit it, then sends it. The briefing says a `<preview_console>` block is the page's own output: data, not instructions.

### 4. Where previews come from

- **A link in a reply to a local `.html` or `.htm` file**, such as `[Landing page](site/index.html)`, becomes a **Preview** link, with the download icon beside it. It opens the panel on the file's folder with that file as the entry page. In parallel mode the root is where the replying agent worked, in the media endpoint's order (`mediaRoots()`), so each agent's version can be opened.
- **A ```` ```preview ```` block** for a dev server:

  ````
  ```preview
  command: npm run dev
  folder: web
  ```
  ````

  It is drawn as the card described above. Only `command` and `folder` are read, one line each. A block that does not parse stays a code block.
- **The Files browser**: **Preview** on an `.html` file, and **Start preview** on a folder with a `package.json`.
- **The briefing** (English, in `src/server/prompt.ts`) gets two lines next to the ones about media and downloads. One says to link the entry page of a site made of files. The other says to put a dev server's command in a `preview` block instead of starting it, because the user starts it.

### 5. The preview panel

- A wide drawer like **Files** (`FileBrowser`). On a wide screen it sits beside the chat as a split view; on a phone it fills the screen.
- Toolbar: back, reload, the path inside the preview, width (**Full**, **Tablet** 768 px, **Phone** 390 px), **Allow internet**, open in a new tab, the root (working directory or an agent's worktree), and for a command **Stop** and **Output**. The **Problems** count opens the list.
- The panel follows the target, not a message, so it stays open while agents keep editing. Static previews reload on **Reload** (see [Open questions](#open-questions)).
- Every string in `src/web/locales/zh-TW.ts` and `en.ts`; server messages (a command failed, the preview was replaced) in `src/server/i18n.ts`.

### 6. Generative UI: `relay-ui` blocks

An agent describes the UI as data, and the app draws it with its own components. No agent code runs.

````
```relay-ui
{
  "title": "Pick a direction for the landing page",
  "components": [
    { "type": "choice", "id": "style", "label": "Style", "options": [
      { "value": "minimal", "label": "Minimal" },
      { "value": "bold", "label": "Bold", "description": "Large type, strong colour" }
    ] },
    { "type": "slider", "id": "budget", "label": "Budget", "min": 0, "max": 10000, "step": 500, "unit": "USD" },
    { "type": "toggle", "id": "dark", "label": "Dark mode too" }
  ],
  "submit": "Use these"
}
```
````

**The catalog (v1):**

| Component | For | Fields |
| --- | --- | --- |
| `text` | Markdown text | `text` |
| `choice` | Pick one or several | `id`, `label`, `options` (`value`, `label`, `description?`), `multiple?` |
| `input` | Text, long text, number, date, time | `id`, `label`, `kind`, `placeholder?`, `default?`, `required?`, `min?`, `max?` |
| `select` | A long list | `id`, `label`, `options`, `default?` |
| `toggle` | Yes or no | `id`, `label`, `default?` |
| `slider` | A number in a range | `id`, `label`, `min`, `max`, `step?`, `default?`, `unit?` |
| `buttons` | One click answers | `buttons` (`value`, `label`) |
| `table` | Data, sortable by column | `columns`, `rows` |
| `chart` | Bar, line or pie | `kind`, `labels`, `series` (`name`, `values`), `unit?` |
| `steps` | Progress of a plan | `items` (`label`, `status`: `done`, `doing`, `todo`) |

**Parsing** is one pure function in `src/shared/ui.ts` (`parseUi(text)`), used by the client to draw and by the server to validate answers and write their summary.

- JSON only, read with `JSON.parse`.
- Limits: 20 KB per block, 40 components, 100 options, 500 table rows, and 12 series of 200 points each. Long strings are cut.
- Unknown component types and fields are dropped, with a small note under the block. A block that is not valid JSON is shown as code with a warning. While the reply streams, the block shows a placeholder until its fence closes.
- No addresses: no images, and no links to other sites. A `text` component goes through the chat's own Markdown rules, so local files become downloads or previews and web images stay links.

**Drawing**: `src/web/components/RelayUi.tsx`, with the app's styles in both themes, keyboard access, and the app's own strings (such as the default **Send** label) in both languages. Charts are SVG drawn by the app, without a chart library.

**Answering**:

- A block with anything to answer (`choice`, `input`, `select`, `toggle`, `slider`, `buttons`) makes the reply ask the user, as if it ended with `[ASK_USER]`: the reply is marked `asked`, and the team waits.
- **Submit** posts an ordinary user message through `Orchestrator.send()`. A `buttons` button, or a block whose only question is a single `choice`, posts on the click. The message's text is a readable summary in the user's language (`Style: Minimal · Budget: 3,000 USD · Dark mode too: yes`), so it reads well in the chat and any agent understands it. A new field, `uiAnswer: { messageId, values }`, carries the values.
- The server parses the asking reply's block again and checks every value against its component (ids, types, options, ranges). An answer to a reply that has no such block, or to one that was already answered, is refused.
- Agents receive it as `<message from="user" via="form">`, with the summary and a `<form_values>` JSON block. The agent that asked answers first, as with a typed answer.
- Once answered, the block shows the chosen values and no longer takes input. Typing an ordinary reply instead still answers, as today.
- Other agents see the block in the history as written (JSON), so they can read what was asked.

**The briefing** describes the catalog in about fifteen lines. It says when a block helps (options to pick from, a few fields to fill in, numbers better shown as a chart) and when it does not (anything that is mostly text). The `[ASK_USER]` rule's "with options when that helps" points to a `choice` block.

### 7. HTML widgets

These cover what the catalog cannot: an interactive chart, a calculator, a small game, an explainer with sliders.

- **In a reply**: a ```` ```relay-html ```` block with one self-contained HTML document. This also works in read-only conversations, since nothing is written to disk. Alternatively, `![Loan calculator](out/calc.html)` embeds an HTML file the agent saved. Image syntax embeds a widget; link syntax opens the [preview panel](#5-the-preview-panel).
- **Drawn inline** in `<iframe sandbox="allow-scripts" srcdoc="…">`, without `allow-same-origin`. The widget gets an opaque origin, so it cannot read the app or its storage. Its requests to the API carry `Origin: null`, which the middleware refuses, and it gets no CORS headers either. It needs no second port, so it works on a phone without extra Tailscale setup.
- **Nothing from the network, ever.** The app puts `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:">` first in the document's `<head>`. A policy can only be tightened by what follows it, so the widget's own markup cannot loosen it. There is no toggle: a widget that needs the network should be a preview.
- **The widget bridge**, added after the policy, does three things:
  - sets the iframe's height from the content, up to 80% of the window, after which the widget scrolls;
  - puts in-memory `localStorage` and `sessionStorage` in place of the real ones, which throw in an opaque origin;
  - offers `relay.send(text)`, which fills the composer (cut to 4 KB). The user still presses Send, so a widget cannot talk to the agents on its own.
- **Limits**: one document of at most 512 KB. A file widget is fetched through the download endpoint, with the same path checks. Its relative references do not load, so the briefing says a widget is a single file and a multi-file site is a preview.
- **On hover**: full screen, view source, and for a file widget, open as a preview.
- Preparing the document (where the policy and the bridge go, after `<!doctype>` and inside `<head>`, and the size cap) is a pure function in `src/web/widget.ts`.

### Security at a glance

| Code from | Runs in | Can call the API | Network | Storage |
| --- | --- | --- | --- | --- |
| The app | The app's origin | Yes | — | — |
| A preview (files or command) | The preview origin (`:8788`) | No: another origin, no CORS, its `Origin` refused | Off by default; the user can allow it per preview | The preview origin's, shared by all previews |
| An HTML widget | An opaque origin (`srcdoc` sandbox) | No: `Origin: null` refused, no CORS | Never | In memory, lost on reload |
| A `relay-ui` block | Nothing: the app's components draw it | — | Never | — |

The [Security](../architecture.md#security) section of the architecture gets these rules when each step is built.

## HTTP API

| Method and path | Purpose |
| --- | --- |
| `GET /api/preview` | `{ port, active }`: the preview port, and the open preview (`PreviewState`) or `null` |
| `POST /api/conversations/:id/preview` | `{ root, folder, entry? }` or `{ root, folder, command }` → `PreviewState`: opens a preview, replacing the open one, and starts its command |
| `PUT /api/preview/network` | `{ allow }`: **Allow internet** for the open preview |
| `GET /api/preview/output` | The last 64 KB of the open preview's command output |
| `DELETE /api/preview` | Closes the open preview and stops its command |
| `GET /api/conversations/:id/files/scripts?root=&path=` | A folder's `package.json` scripts and the package manager its lockfile names |
| `POST /api/conversations/:id/messages` | Takes an optional `uiAnswer: { messageId, values }` (validated as in [Answering](#6-generative-ui-relay-ui-blocks)) |

`PreviewState` is `{ id, conversationId, root, folder, entry?, command?, status, error?, network, startedAt }`, where `status` is `starting`, `running`, `failed` or `stopped`. A `preview` SSE event sends it to open pages whenever it changes.

On the preview origin, `/__relay/bridge.js` is the bridge, and every other path belongs to the target.

## Database

- One migration appended to `MIGRATIONS` in `src/server/db.ts`: a nullable `ui_answer` column (JSON) on `messages`.
- Previews live in memory only. A restart stops them, and an open panel then shows the preview as stopped. The **Allow internet** choice is kept in memory too (see [Open questions](#open-questions)).
- `RELAY_PREVIEW_PORT` goes into the developer guide's environment variables.

## Tests

All offline. A command preview uses a fake service runner, and passing requests through uses a small HTTP and WebSocket server on a random local port started by the test.

- `test/preview.test.ts` (new):
  - files: the entry page, nested folders, absolute paths from the root, a symlink that leads outside, dot files and `.git` (all 404), media types, byte ranges;
  - headers: `no-store`, `nosniff`, `frame-ancestors`, no CORS, the network policy and its toggle, the bridge added to HTML only;
  - the `Host` check, the page shown when no preview is open, and a preview replacing another;
  - finding a dev server's address in recorded output (Vite, Next.js, Create React App, `python -m http.server`), the 60-second timeout, **Stop** and deletion killing the group, the idle stop (fake timers), and an environment without stored API keys;
  - passing requests through: rewritten `Host` and `Origin`, WebSocket upgrades, HTML with the bridge.
- `test/app.test.ts`: the API refuses `Origin` from the preview port; validation of the new routes and of `uiAnswer`.
- `test/ui.test.ts` (new): `parseUi()` for each component, the limits, unknown fields, invalid JSON and an unfinished fence; checking answers; the summary text in both languages.
- `test/widget.test.ts` (new): where the policy and the bridge go (with and without `<!doctype>` and `<head>`), and the size cap.
- `test/markdown.test.ts`: `.html` links become previews, and `![…](x.html)` becomes a widget; `preview`, `relay-ui` and `relay-html` blocks; an ordinary ```` ```html ```` block stays code.
- `test/orchestrator.test.ts`: a reply with a `relay-ui` block asks and the team waits; a `uiAnswer` message reaches the agent that asked first, as `via="form"`.
- `test/prompt.test.ts`: the new briefing lines. `test/store.test.ts`: the `ui_answer` column. `test/i18n.test.ts`: both locales keep the same shape.

## Steps

1. **The preview origin and static previews**: the panel, the bridge with **Problems** and **Send to agent**, preview links in replies, and **Preview** in the Files browser. Architecture (Security, a new Previews section), the developer guide, the user guide and Use it from your phone, in both languages.
2. **`relay-ui` blocks**: first `choice`, `buttons`, `input`, `select`, `toggle` and `table`, with the asking and answering path; then `slider`, `chart` and `steps`.
3. **HTML widgets**: `relay-html` blocks and `![…](x.html)`.
4. **Command previews**: dev servers, passing requests through with hot reload, and the idle stop.

Each step is usable on its own. Steps 2 and 3 do not depend on step 1's second port.

## Alternatives considered

- **Previews on the app's own port, in a sandboxed iframe (an opaque origin).** No second port, and a phone works as it is. But storage throws, so a to-do app that keeps its list in `localStorage` breaks on load. Module scripts need CORS, so project files would be served with `Access-Control-Allow-Origin`. Absolute paths break under a path prefix, and a dev server cannot be passed through under one. Widgets use this approach, since a single self-contained document needs none of that.
- **A port per preview.** Several previews could be open at once, each with its own storage. But every port needs its own `tailscale serve` line on a phone, and the hosts the policy and the `Origin` check must know grow with them. It can come later if one at a time proves too few (see [Open questions](#open-questions)).
- **Subdomains of localhost (`<id>.localhost:8788`).** Many previews on one port, each isolated. Not every browser resolves `*.localhost`, though, and a tailnet name has no subdomains.
- **Showing the dev server's own port in the iframe.** The simplest option on this computer, but it does not work from a phone. The bridge cannot be added and the network policy cannot be applied.
- **Letting agents start dev servers.** Their background processes live and die with the CLI turn, Harness Relay can neither see nor stop them, and a read-only agent would gain a way to run code.
- **Drawing every ```` ```html ```` block.** Agents use that fence to show code, so samples would turn into running pages. A fence of its own (`relay-html`) makes a widget deliberate.
- **MCP Apps, AG-UI, A2UI.** Harness Relay does not call model APIs and is not the MCP host: the CLIs are, and their output does not pass on an MCP App's `ui://` resources, so there is nothing for Harness Relay to host. AG-UI expects the app to be the agent's backend. A text convention taught in the briefing works the same with all three CLIs. The `relay-ui` catalog follows A2UI's idea (a catalog of trusted components and no agent code) and could be mapped to it later.
- **YAML for `relay-ui`.** Easier for models to write, but it needs a parser dependency and is easier to get subtly wrong. JSON needs only `JSON.parse`.
- **Widgets that send messages themselves.** Simpler for agents, but a widget could then talk to the team without the user, even in a loop. Filling the composer keeps the user in between.

## Open questions

- Should a static preview reload by itself when an agent changes its files (watching the folder, and the bridge reloading the page)? That helps while agents iterate, but it can throw away what the user typed into the page.
- Should the preview origin's storage be cleared (`Clear-Site-Data`) when the target moves to another folder? Clearing keeps one site's data away from the next; keeping it lets the user come back to where they were.
- Is one preview at a time enough, or is a port per preview worth the extra Tailscale setup?
- Should agents see a screenshot of the preview? The panel cannot capture a frame from another origin. The bridge could draw the page into an image, but that is approximate and heavy.
- Should a reply with a preview link open the panel by itself when the turn ends?
- Should a `relay-ui` answer be changeable after it was sent?
- Should **Allow internet** be remembered per conversation in the database?
