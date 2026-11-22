**English** | [繁體中文](README.zh-TW.md)

# Proposals

Designs for features Harness Relay does not have yet. What is in this folder is not built yet, apart from the parts each proposal's status names: the [architecture](../architecture.md) and the [developer guide](../developer-guide.md) describe the app as it is.

| Proposal | Status | Summary |
| --- | --- | --- |
| [Scheduled and event-triggered runs](triggers.md) | Steps 1 (schedules) and 2 (webhooks, for a schedule) built, step 3 as a schedule option; a schedule can also track a goal, and start when something happens (a new mail, an event about to begin, a pull request or a failed CI run, a file; one or several of them; checked by Harness Relay); named triggers with webhooks of their own still open | A conversation starts a run by itself: on a schedule, or when a local program reports an event. |
| [Accounts that sign in with OAuth](oauth.md) | The core built, with Microsoft 365 and Outlook.com calendars (Graph), Google Calendar (CalDAV with its token), Microsoft 365, Outlook.com and Gmail mail (IMAP and SMTP with XOAUTH2), Google Drive reading and Google Docs editing with separate grants, and remote MCP servers' own sign-in in the tool library | One sign-in interface for these services and MCP servers: their tokens refreshed and kept in the credential store, used by the calendar and mail tools and the mail trigger, and given to each turn's MCP servers. |
| [Shared memory across agents](shared-memory.md) | Not started | Agents suggest notes for the tool library's memory; the user accepts them. Memory per project, and importing what each CLI remembered. |
| [Website previews and generative UI](preview-and-generative-ui.md) | [App previews](app-preview-runtime.md) implemented, interactive replies proposed | Try a site an agent made in a panel beside the chat, and send its errors back; replies with choices, forms, charts and small interactive pages. |
| [The agent CLIs' own features](agent-cli-features.md) | Steps 1–8 built, from the CLIs' own schemas, bundles and binaries (no live run yet); Cline's subagents also off below full access; Antigravity's and Muse Code's background work not waited for (they report no end of it); Copilot's AI credits counted but not shown. Step 9 (moving the checked versions forward) and the live tests still open | What the twelve CLIs can do by themselves that Harness Relay does not use yet: subagents and workflows governed and shown, context windows for endpoint models, plans, questions, steering a running turn, structured answers and budgets. |
| [One preview for every app](unified-app-preview.md) | Steps 1 to 3 built (a `Dockerfile` app, the terminal, compose) with the agents' briefing; a builder of Relay's own with a registry-only proxy, and generated builds, still open | Any language previewed the same way: a `Dockerfile` or compose file the project declares, a page when the app serves HTTP and a terminal when it does not, services such as a database on a network with no way out. |

## How to use this folder

- One proposal per file, in both languages (`<name>.md` and `<name>.zh-TW.md`), changed together.
- A proposal says what exists today, what is missing, the design it recommends, the alternatives it rejected and why, and the questions still open.
- When part of a proposal is built, describe that part in the architecture and developer guide (both languages) in the same commit, and update the status here. When all of it is built, or it is dropped, delete the file and say so in the commit message.
