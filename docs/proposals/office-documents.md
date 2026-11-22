**English** | [繁體中文](office-documents.zh-TW.md)

# Office documents

> **Status: not started; a survey, and the design it recommends.** See [Proposals](README.md).

Whether agents could work on the user's Word, Excel and PowerPoint documents, and on Apple's Pages, Numbers and Keynote, through **Common apps**: in Microsoft 365 (OneDrive, SharePoint), in the desktop apps on Windows and macOS, and with what Linux has. Which official MCP servers exist for them, and what each route would ask of Harness Relay's defences.

## How this was found

A survey on 2026-11-22 of Harness Relay's code, and of the makers' documentation, blogs and published code, checked again by a reviewer who had not done it. Nothing was installed, signed in to or run. Each finding about another product has a label:

- **docs**: in its maker's documentation, announcements or published code;
- **reported**: only in the press or a third party's write-up;
- **unsure**: not confirmed; to be checked before anything is built on it.

What is said about Harness Relay itself cites its file, and has no label.

## What exists today

- **Files in the working directory.** Agents already read and write `.docx`, `.xlsx` and `.pptx` files there with their own tools (python-docx, openpyxl, python-pptx, LibreOffice, Anthropic's docx, xlsx and pptx skills), on every system, with nothing from Harness Relay. What they cannot reach is a document in the user's cloud, or one open in the user's app.
- **A Microsoft account that signs in with OAuth** (`microsoftProvider()` in `src/server/oauth/providers.ts`), with the user's own Entra app: Graph's calendar (`calendar`), Exchange Online's IMAP and SMTP (`mail`), Teams reads (`teams`). Its Graph token goes only to Graph's host (`hosts`), through `hostOnlyFetch()`, which follows no redirect (`src/server/oauth/broker.ts`); its mail token only to Exchange Online's IMAP and SMTP servers (`mailLogin()`).
- **Teams through Microsoft Graph PowerShell** (`src/server/connectors/teamsPowerShell.ts`): `Connect-MgGraph -UseDeviceCode -TenantId organizations`, with Microsoft's own client, so without an Entra app of the user's own, for work and school accounts only.
- **Google Drive and Docs** (`src/server/connectors/apps.ts`, `driveDocuments.ts`): search and read are `read` tools; a document created or a passage replaced is a `send` tool: the outbox shows the change, frozen when it was proposed, and only the user's confirmation writes it, an edit checked against the revision it was made from (Google's `requiredRevisionId`). Their uses, `drive` and `documents`, are Google's throughout: `startSignIn()` refuses them for another provider (`src/server/oauth/service.ts`), and the Drive tools pick their accounts by use alone.
- **Hosted connections** (`HOSTED_APPS` in `src/shared/apps.ts`, `src/server/connectors/hostedApps.ts`): Slack, connected in Claude or Codex themselves; Harness Relay only checks their state (`claude mcp get`; Codex's app server, and a read of the user's own profile through the app).
- **Official remote MCP servers in the catalog** (`APP_SERVERS`): Notion and Heptabase, signed in through the tool library's MCP sign-in (`src/server/oauth/mcp.ts`), which registers its client dynamically (RFC 7591); for Slack's server it only renews a grant saved before, with its own client. A server without dynamic registration is not taken yet ([OAuth proposal](oauth.md#not-built-yet), item 1), and a signed-in server's token goes to the CLI, in its headers, for each turn.
- **AppleScript and JXA** only where no other app is sent an Apple Event: the folder dialog's `choose folder` (`src/server/folderPicker.ts`) and a rename when a browser is installed (`src/server/browser/install.ts`). The desktop app's only privacy entitlement (`desktop/entitlements.mac.plist`) and only usage description (`desktop/electron-builder.yml`) are the microphone's.

## What is missing

- A use and tools of a Microsoft account for files: the account Outlook and Teams use reaches neither OneDrive nor SharePoint.
- Any tool for a document open in a desktop app, and, in the desktop app on macOS, what an Apple Event to another app needs.
- A catalog server whose authorization server has no dynamic registration (Entra's), and a signed-in server's tools passed through the gateway.

## Microsoft 365: OneDrive and SharePoint

What Microsoft Graph gives (**docs**):

| | Personal account (OneDrive) | Work or school account (OneDrive for Business, SharePoint) |
| --- | --- | --- |
| Search, list, download, upload, versions (driveItem) | yes: `Files.Read`, `Files.ReadWrite` (`.All` for files shared with the user) | yes; SharePoint's sites with `Sites.Read.All` too |
| Conversion to PDF (`?format=pdf`, source files of 2 MB at most) | yes | yes |
| Excel's workbook API (worksheets, ranges, tables, charts; `.xlsx` only) | no: "not available" for OneDrive's consumer accounts (so too [a Microsoft Q&A answer](https://learn.microsoft.com/en-us/answers/questions/5835926/microsoft-graph-api-workbook-paths-for-excel-store) of March 2026) | yes |
| Word or PowerPoint content (paragraphs, comments, slides) | no API | no API |

- A download (`…/content`) answers with a 302 to a preauthenticated address on another host (`*.files.1drv.com`, or SharePoint's), which takes no token. `hostOnlyFetch()` would not follow it: the server would read the item's `@microsoft.graph.downloadUrl` and fetch that on its own, without the token, over https only, through the address checks the browser tools use.
- An upload is a `PUT …/content` of up to 250 MB, or an upload session (`createUploadSession`), whose `if-match` is documented: a 412 when the item's eTag is no longer the one sent. Whether `PUT …/content` takes `If-Match` is **unsure** (its page does not list it).
- Delegated `Files.Read.All`, `Files.ReadWrite.All`, `Sites.Read.All` and `Sites.ReadWrite.All` need no admin consent (**docs**, Graph's permissions reference); a tenant's own user-consent policy can still refuse them.
- `Files.SelectedOperations.Selected` (access to chosen files only) needs admin consent itself, and each file granted through `POST …/permissions` by an app holding `Sites.FullControl.All`, or a Selected scope and a full-control or owner role (**docs**): of no use for a user picking files.

Sources: [driveItem content](https://learn.microsoft.com/en-us/graph/api/driveitem-get-content), [format conversion](https://learn.microsoft.com/en-us/graph/api/driveitem-get-content-format), [upload](https://learn.microsoft.com/en-us/graph/api/driveitem-put-content), [upload session](https://learn.microsoft.com/en-us/graph/api/driveitem-createuploadsession), [Excel](https://learn.microsoft.com/en-us/graph/api/resources/excel), [permissions reference](https://learn.microsoft.com/en-us/graph/permissions-reference), [selected permissions](https://learn.microsoft.com/en-us/graph/permissions-selected-overview).

## Official MCP servers

| Server | What it does | What it needs | State |
| --- | --- | --- | --- |
| Microsoft's Work IQ MCP (`https://workiq.svc.cloud.microsoft/mcp`) | Graph's paths under `/me/`, `/users/` and `/sites/` (`fetch`, `create_entity`, `update_entity`…); `fetch_blob` returns an Office file in Base64 (4 MB by default) or as a PDF; writes refused by the tenant's policy until an admin allows them | Delegated scopes that need admin consent (`WorkIQAgent.Ask` among them); a Global Administrator creates its service principal; Copilot Credits billing on an Azure subscription; work accounts (personal ones: **unsure**, its docs speak of tenants only). Entra has no dynamic client registration, so the tool library would need a client ID typed in by hand | announced as generally available from 2026-06-16 (**docs**, Microsoft's licensing news of 2026-06-02), over MCP too (Ignite 2026); creating and editing Word, Excel and PowerPoint content "on the way" (Microsoft's Ignite blog, 2026-11-17) |
| Agent 365's Word server | Reads a Word document's text and comments, creates a document, adds comments; never edits its body | A tenant; Microsoft calls these servers legacy, not for new projects | preview (**docs**) |
| For desktop Office | none: MCP on Windows (the on-device agent registry) has File Explorer's and Settings' connectors, none of Office's | — | — |
| Apple's Keynote, Pages and Numbers | External agents read the open documents, edit them and run actions in the app | macOS 27 and an Apple Creator Studio subscription; turned on in the app's settings, which copies a URL to give the agent; the first connection confirmed with Touch ID or the password. Its transport and tools are not published (**unsure**) | announced 2026-10-27 among new AI features in beta (**docs**); whether MCP itself is beta: **unsure** |
| LibreOffice | none: "There's no AI in LibreOffice 26.8", by choice (**reported**); community servers only | — | — |
| ONLYOFFICE's DocSpace MCP | Rooms and files in DocSpace (its cloud, or self-hosted), not the desktop editors | a DocSpace | official (**docs**) |
| Microsoft's MarkItDown MCP | One tool: a file or URL to Markdown, read-only | It fetches `http(s):` URIs itself, around Harness Relay's address checks, and reads `file:` URIs, around its protected paths | official (**docs**) |

Sources: [Work IQ's tools](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/work-iq/mcp/tool-reference), [its permissions](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/work-iq/permissions), [turning it on](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/work-iq/enable-work-iq), [its general availability](https://microsoft.com/en-us/licensing/news/work-iq-general-availability), [Ignite 2026](https://techcommunity.microsoft.com/blog/microsoft_365blog/whats-new-in-work-iq-at-ignite-2026-agents-that-get-work-done/4572219), [Agent 365's servers](https://learn.microsoft.com/microsoft-agent-365/tooling-servers-overview), [the Word server](https://learn.microsoft.com/en-us/microsoft-copilot-studio/mcp-word-tools), [MCP on Windows](https://learn.microsoft.com/en-us/windows/ai/mcp/overview), [Apple Creator Studio](https://www.apple.com/newsroom/2026/10/apple-creator-studio-adds-powerful-new-ai-features-and-even-more-creative-tools/), [Keynote's external agents](https://support.apple.com/guide/keynote/connect-external-agents-to-keynote-tan59af18df1/16.0/mac/1.0), [LibreOffice 26.8](https://itsfoss.com/news/libreoffice-26-8-release/), [ONLYOFFICE](https://onlyoffice.com/mcp-server), [MarkItDown](https://github.com/microsoft/markitdown).

The agents' own makers, each of which would be a hosted connection like Slack's:

- **Claude's Microsoft 365 connector** (**docs**): search and reading in SharePoint, OneDrive, Outlook and Teams, and, with its write actions on, files created and updated in OneDrive and SharePoint. A work account needs a Global Administrator's consent to Anthropic's app; a personal account gets OneDrive and Outlook on the individual plans. Claude Code loads claude.ai's connectors only when it is signed in with a claude.ai subscription, and Microsoft 365 is connected on claude.ai, not from Claude Code. [The connector](https://claude.com/docs/connectors/microsoft/365), [Claude Code's MCP](https://code.claude.com/docs/en/mcp.md).
- **ChatGPT's SharePoint app** (**docs**): search, and, where a workspace admin turns them on, uploading and updating files ("may" be supported), for work accounts, with Entra's admin consent where the organization requires it. Whether the Codex CLI can use it: **unsure**. [Its help page](https://help.openai.com/en/articles/12143177-sharepoint-connectors-in-chatgpt).
- **Work IQ's plugins**: one for GitHub Copilot CLI (**docs**), with Codex's and Claude's manifests in its repository, in public preview; they need the tenant set up as above.
- **Claude for Word, Excel and PowerPoint** are Office add-ins the user runs: they work on the open file only, and offer nothing another program can call (**docs**).

## The desktop apps

| System | Apps | Route | How deep | What stands in the way |
| --- | --- | --- | --- | --- |
| Windows | Word, Excel, PowerPoint | COM from PowerShell 7 (`New-Object -ComObject Word.Application`) | the whole object model: open, read, write, save, export | Microsoft does not support Office automation from an unattended client: a dialog hangs the app, a file's macros run unless `AutomationSecurity` says otherwise, one thread, Office installed and licensed (**docs**) |
| Windows | any app | the on-device agent registry (`odr.exe mcp`), App Actions | what an app registers | Office registers neither (**unsure**: none found); preview; its stable release will require the host's package identity (MSIX) (**docs**) |
| macOS | Word, Excel, PowerPoint | AppleScript or JXA through `osascript` | good, from old dictionaries; Anthropic's own "Word (By Anthropic)" and "PowerPoint (By Anthropic)" connectors take this route (2026-10, **docs**) | the Automation consent (TCC) for each app; Office's sandbox asks for access to files outside its container; the app comes to the front |
| macOS | Pages, Numbers, Keynote | AppleScript or JXA; or their MCP on macOS 27 | text, cells, slides, export to PDF and Office formats | the same consent; the MCP needs the subscription |
| Linux | LibreOffice | `soffice --headless --convert-to`, UNO | full, with LibreOffice's layout | installed apart |
| Windows, macOS | Word, Excel, PowerPoint | an Office add-in (Office.js) | the deepest, on the open document | the open document only; sideloaded, or deployed by an admin; the add-in served over HTTPS |

On macOS, Harness Relay's desktop app runs with the hardened runtime: an Apple Event to another app needs the `com.apple.security.automation.apple-events` entitlement and an `NSAppleEventsUsageDescription` (in both languages, as the microphone's is in `desktop/macos/`). The consent is asked for the app responsible for the process (**reported**), so for Terminal under `npm start`. The desktop app is signed ad hoc (`identity: '-'` in `desktop/electron-builder.yml`): whether macOS asks again after each update is **unsure**.

Sources: [unattended automation](https://learn.microsoft.com/en-us/office/client-developer/integration/considerations-unattended-automation-office-microsoft-365-for-unattended-rpa), [App Actions](https://learn.microsoft.com/en-us/windows/ai/app-actions/), [an MCP host on Windows](https://learn.microsoft.com/en-us/windows/ai/mcp/quickstart-mcp-host), [Word (By Anthropic)](https://claude.com/connectors/word-by-anthropic), [file access in Office for Mac](https://learn.microsoft.com/en-us/office/vba/office-mac/grantaccesstomultiplefiles), [the Apple Events entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.automation.apple-events), [Office add-ins](https://learn.microsoft.com/en-us/office/dev/add-ins/overview/office-add-ins).

## Design

In this order, each a pull request of its own.

1. **OneDrive and SharePoint over Graph**, for the Microsoft account that signs in with OAuth, with uses and a tool group of their own, since `drive` and `documents` are Google's: say `files` (search and read, `Files.Read.All`) and `files-write` (writes, `Files.ReadWrite.All`), both on Graph's host, and the downloads fetched as above. Its tools:
   - `onedrive_search` (`read`): by name, in the user's drive and what is shared with them; a work account's SharePoint sites with `Sites.Read.All`, if a later step asks for it.
   - `onedrive_read` (`read`): a file's text, made by the server from the downloaded file (Word's paragraphs, PowerPoint's slides and notes, Excel's sheets as rows; a ZIP reader beside `zip.ts`, which only writes, with limits on its entries, their size and their ratio, and XML read with no DTD or entities), within the size `readTool()` keeps; on a work account, Excel's ranges through the workbook API.
   - `onedrive_propose_upload` (`send`): a file the agent made in the working directory, as a new file in a folder or a new version of a file. Its bytes are copied and hashed when the proposal is made (a link or a protected path refused, `src/server/protect.ts`), and exactly those are uploaded. The outbox card shows the account, the place, the name, the size and, for a Word or PowerPoint file, its text against the current version's. **Upload** opens an upload session with `if-match` on the eTag the proposal was made from, so a file changed meanwhile is refused and the agent asked for a fresh proposal, as for Docs edits; the bytes then go to the session's `uploadUrl`, a preauthenticated address on another host, sent as downloads are fetched: without the token, over https only, through the address checks.
   - `excel_update_range` (`send`, work accounts): the cells before and after on the card, written on confirmation, checked against the values read.
   The agent edits a document with its own tools: Harness Relay never edits the OOXML itself. Personal and work accounts both get files; only work accounts get Excel's API.
2. **Claude's Microsoft 365 connector as a hosted connection**, as Slack's is: its row in Common apps checks Claude Code's state for it and links to claude.ai to connect it. The CLI calls it itself, under its own approvals (in full access nothing asks) and without the outbox; the row says so, and where a member has step 1's tools, its briefing says to propose writes through them, never through another connector (as it says for Google Docs and Teams, `src/server/prompt.ts`). Codex's SharePoint app joins once a check shows the Codex CLI can call it.
3. **On macOS, Office for Mac, Pages, Numbers and Keynote through `osascript`**, run by the server as the folder dialog is: fixed JXA text, the document and the values as its run handler's arguments, a time limit, through `process.ts`. Listing the open documents and reading one are `read`; exporting one to the working directory is `act`; an edit is `send`, through the outbox. The desktop app gets the entitlement and the usage description. Apple's own MCP in iWork is added as a tool library server once its transport and tools are known, and macOS 27 is common.
4. **Work IQ in the catalog**, once the [OAuth proposal](oauth.md#not-built-yet)'s item 1 is built: its tools passed through the gateway, so its token stays in the server, each given a tier by Harness Relay (its reads `read`; `create_entity`, `update_entity`, `delete_entity` and `do_action` `send`, through the outbox), and a client ID typed in by hand; for a tenant whose admin consented and set up its billing.
5. **On Windows, COM, read-only first**: listing the open documents, reading one, exporting one to PDF, through a PowerShell runner like Teams', with macros off (`msoAutomationSecurityForceDisable`), alerts off, a time limit, and the process killed when it hangs. Writes only after a live check on Windows that dialogs and sign-in prompts cannot hang the tool.
6. **On Linux, steps 1 and 2.** Where LibreOffice is installed, `soffice --headless` could also make step 1's text and PDFs (Graph converts files of 2 MB at most), on every system.

## Security

- No token reaches a CLI in steps 1, 3, 4 and 5: Graph's calls are the server's, as the calendar's are. A download address (short-lived, good for one file without a token) is fetched by the server and never shown to an agent.
- What a document holds is given to agents as data, never instructions (`readTool()`'s `<app_data>`); the ZIP reader keeps to its limits, and reads XML with no DTD or entities.
- Every write of steps 1, 3, 4 and 5 to a user's document waits for the user in the outbox, in every permission, full access included, as Docs and Obsidian writes do, and sends exactly what the card showed.
- Fixed script texts: JXA's values as its run handler's arguments, as the folder dialog's (`folderPicker.ts`); PowerShell's in its environment or as JSON lines on its stdin, as Teams' (`teamsPowerShell.ts`); never in the text (AGENTS.md, Code).
- The desktop tools act on the user's own running apps: below full access, every call but a read asks first.
- Step 2 is the exception: the CLI holds the connection, so its own approvals and the briefing are all that govern it, as for Slack in Claude or Codex today.

## Alternatives considered

- **An Office add-in (Office.js).** The deepest editing, on Windows, Mac and the web; but on the open document only, served over HTTPS, sideloaded or deployed by an admin, and whether its page may reach Harness Relay on 127.0.0.1 is **unsure**.
- **WOPI.** Only for storage providers in Microsoft's Cloud Storage Partner Program.
- **Office for the web in the browser tools.** Their browser starts each chat with an empty profile, so a Microsoft sign-in every time, on pages whose layout changes.
- **Community MCP servers for files** (excel-mcp-server, GongRzhe's Word and PowerPoint servers). The agents' own tools already do this in the working directory; GongRzhe's are archived.
- **Agents running `osascript` or PowerShell themselves.** No tiers and no outbox, and each CLI's sandbox decides what happens; the tools of steps 3 and 5 keep the decision with Harness Relay.
- **Waiting for Work IQ alone.** Its admin consent and billing leave out personal accounts and most small teams.

## Open questions

- Personal accounts first, or work accounts (Excel's API, SharePoint)?
- `Files.Read.All` for reading, or `Files.Read` (the user's own files only)?
- Where a file the agent wants to edit goes: a copy in the working directory (an `act` tool), or the chat's attachments folder?
- The name Claude's Microsoft 365 connector has in `claude mcp list`, which `HOSTED_APPS` needs: **unsure** until a signed-in check.
- Whether the CLIs' own sandboxes let an agent's `osascript` reach another app, and whether macOS asks for the Automation consent again after an update of the ad hoc signed app: **unsure**, not tried.
- Apple's iWork MCP: its transport, its tools, and whether a local client like Harness Relay may connect to it.
- Whether Windows' agent registry reaches general availability, and whether Office ever registers in it.

## Tests

- A stand-in Graph drive in `test/fake-oauth-server.ts`: search, the 302 to a download host, an upload session with `if-match` (412 when the file changed), the workbook API's ranges, and a personal account's refusal of it.
- The read tool's text from Word, PowerPoint and Excel files in `test/fixtures/`, and the ZIP reader's refusals (too many entries, too large, a DTD).
- The outbox: an upload proposed, confirmed with the bytes copied at the proposal, refused when the file changed, and a link or a protected path refused.
- `osascript` and PowerShell through a fake runner: the fixed text, the arguments, the time limit; never run for real on CI.
- An end-to-end spec against a stand-in Microsoft, as `e2e/specs/oauth.spec.ts` does for the calendar with its own `fakeMicrosoft()`.
