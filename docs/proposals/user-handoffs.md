**English** | [繁體中文](user-handoffs.zh-TW.md)

# Steps only the user can take: secrets, fixed commands and interactive steps

**Status.** Built: S (secret cards), A (fixed commands: Try it, the outbox, schedules), B1 (interactive commands), B2's hand-over of the chat's browser (a window on the same computer, a screencast from elsewhere; started by a browser tool, `browser_hand_over`, rather than a reply block), editing and uploading in the Files panel (2) and a card of steps (10); the [architecture](../architecture.md#secrets-and-fixed-commands), [user guide](../user-guide.md#secrets-and-fixed-commands) and [developer guide](../developer-guide.md) describe them. Still open: B2's browser for the user alone and **Save selection as a secret**, a program that keeps running (7), inbound webhooks (8), and the open questions below. The names below are the design's; the built ones are in those docs.

## Where it comes from

In one conversation a team set up automatic posting to Threads through its API. The agent wrote a script, `setup_token.py`, that asked for the access token with hidden input (and for the app secret when the token was a short-lived one, to exchange it) and stored the token in `.secrets/threads.env` (folder 700, file 600, ignored by git), then a `verify.py` and a `post.py` that posts the next approved row of a `queue.csv`. The user had to leave Harness Relay to run `setup_token.py` in a terminal on the computer the server runs on: nothing in the chat could take a secret without keeping it, and no command an agent runs can be typed into. What came next met more of the same: posting on a schedule meant an agent's turn each time (that conversation's agent turns cost $0.09 to $0.63 each), adding a post meant asking an agent to edit `queue.csv`, and nothing let the user approve each post before it went out.

## What exists today

- **Questions.** An agent ends its reply with `[ASK_USER]` (`src/shared/ask.ts`) and the team waits; the answer is an ordinary message, kept in the database, shown in shares and given to the agents' prompts.
- **Commands agents run.** Each CLI runs its own shell tool. Harness Relay sees what the CLI reports about a command but holds none of its processes' input, so a command that waits for typing (a password, `y/N`, a sign-in code) cannot be answered.
- **Sign-ins without a terminal.** `CliLogin` (`src/server/login.ts`) runs a program with pipes, shows its output with the links and codes in it, and writes what the user pastes to its input (one line, trimmed). It runs the agent CLIs' own sign-ins in Settings and gh's wherever Relay uses gh (sharing, publishing, problem reports, the GitHub row in Common apps). It has no terminal: a program that reads `/dev/tty` (ssh's passphrase, `sudo` without `-S`) cannot be answered through it.
- **Commands Relay runs itself.** Team checks' commands (`src/server/checkCommands.ts`, `runCheckCommand()`) run through a fixed shell script that reads the command line from the environment, with an environment of its own (`checkEnv()`: no API key, no token), below full access in Harness Relay's own sandbox: no network but the openings the user turned on for that command (every local port on macOS, every Unix socket on Linux), writing only in the working directories and the run's temporary folder, the protected paths unreadable, and not run at all when the sandbox cannot start. They are not run on native Windows, whatever the permission. A run whose changes touch the files a command names or the test and lint configuration (`namedFiles()`, `checkConfigFiles()`, `CONFIG_FILE`) does not run the commands until the user agrees, and a run nobody watched fails them (the orchestrator's config gate). The same sandbox already filters the network by host for the open agents (`allowedDomains` through its proxy, `src/server/relaySandbox.ts`).
- **Protected reads.** Below full access the CLIs' sandboxes cannot read the browsers' folders, Relay's database, `data/tmp` and `data/browser` (`protectedReads()` in `src/server/protect.ts`; none on native Windows). The relay sandbox's run folders (`data/relay-sandbox/<id>`) are kept from the open agents only (`privateRoots()` in `src/server/agents/open.ts`): Claude Code, Codex and most of the other CLIs can read them.
- **The outbox** (`src/server/outbox.ts`): what Relay's own tools would send to other people (a mail, an invitation, a Slack or Teams post, a Docs or Obsidian write) waits there until the user clicks Send. A script that calls an API is a command, not one of those tools: it never reaches the outbox, and detecting publishing commands is best effort (`isPublishCommand()`).
- **Schedules** send a message to the team at their times (`src/server/scheduler.ts`), and an agent then does the work. In an automation's runs, anything beyond the conversation's permission is refused unless the user always allowed it in that chat, chose **Ask me**, or uses **Approve for me**, where the lead agent approves what it judges safe first. Schedules run only while Relay runs, one per conversation, intervals in whole hours. What an automation can wait for is a new mail, an event about to begin, a pull request or a failed CI run, and a file in the working directory (`src/server/watch.ts`). A schedule's webhook (`POST /api/hooks/:id`) must be reachable, and the server binds to `127.0.0.1` unless `HOST` says otherwise; a phone reaches it through [remote access](../remote-access.md).
- **Files panel** (`src/server/files.ts`): browsing, preview, download and ZIP; every route is a `GET`. Attachments go with a message, not into the working directory at a path.
- **Browser tools** (`src/server/browser/`): a headless Chromium per chat (`--headless=new`), with an empty profile of its own deleted with the chat. The user sees screenshots in replies, never the browser itself.
- **OAuth** (`src/server/oauth/`): Microsoft and Google accounts, and the tool library's HTTP MCP servers. Another service's OAuth (an app the user registered at Meta, X, LinkedIn…) has no place there.
- **Snapshots** (`snapshot()` in `src/server/workspace.ts`) take untracked files, honouring ignores, into commits kept under `refs/harness-relay/…`. A secrets file an agent writes and does not ignore goes into the repository's objects.
- **Harness Relay's own tools** reach Grok, Muse Code, Goose, Cline, OpenHands and Pi only with full access (`GATEWAY_FULL_ACCESS_ONLY`). A block at the end of a reply works for every CLI at every permission: `[ASK_USER]`, and `<remember>` and `<progress>` where they apply (long-term memory on, a tracked goal).

## What is missing

| # | Scenario | Example | Today |
| --- | --- | --- | --- |
| 0 | Giving a secret | An API token, an app secret, a database password | Pasted in the chat (kept and shared), or typed in a terminal outside Relay |
| 1 | A script on a schedule, without an agent | `python3 post.py` every day at 09:00 | Each run is an agent's turn: paid, not the same each time, approvals refused |
| 2 | Editing a file in the working directory | Adding a row to `queue.csv` from a phone | Ask an agent to do it |
| 3 | Approving an outward action a script takes | Each post approved before it goes out | Only Relay's own tools' sends wait in the outbox |
| 4 | A site the user must sign in to (2FA, CAPTCHA) | Creating the Meta app, its token generator | The chat's browser is headless; the user cannot take it over |
| 5 | Another service's OAuth | Threads with a redirect URL and refresh | Only Microsoft, Google and MCP servers |
| 6 | A command that waits for typing | `sudo`, `y/N`, `gcloud auth login`, `npm login`, an ssh passphrase | No input reaches the agents' commands |
| 7 | A program that keeps running | A Telegram or LINE bot, a webhook receiver | Commands end with the turn; only publishing to Render stays up |
| 8 | Starting on another event | A new RSS item, an API's change, a service's webhook | Mail, calendar, GitHub and files only; the webhook needs Relay reachable |
| 9 | A QR code to scan with a phone | WhatsApp Web, a LINE bot's sign-in | An agent can save it as an image for its reply |
| 10 | "Do this, then come back" | "Reply *done* once the token is saved" | A free-text answer to `[ASK_USER]` |

Desktop apps (computer use) are out of scope.

## The design

Three parts. S takes the secret; A runs fixed commands with it; B lets the user take over what only they can do.

### S. Secret cards

An agent ends its reply with one block per secret it needs:

```text
<secret name="THREADS_ACCESS_TOKEN" label="Threads access token">From the app's User Token Generator.</secret>
```

The team waits, as for `[ASK_USER]`. The chat shows a card with a masked field for each, which says which agent asks, which fixed commands (A) will get it, that the value never enters the chat or the agents' prompts, and that Relay never needs the password of the user's own accounts. **Save** sends it to the server (`POST /api/conversations/:id/secrets`, under `/api/` with its checks); the server keeps it through `SecretStore` (`openSecretStore()`: the OS credential store, or encrypted in the database without one), by working directory and name. No route gives a value back. The message records only "THREADS_ACCESS_TOKEN given", never the value: not in messages, SSE, shares, AgentsView, long-term memory or notifications. The briefing lists the names a folder has (never the values) and tells agents to ask with the block, never to ask for a secret in the chat or to have the user run a script in a terminal. Names are `[A-Z_][A-Z0-9_]*`; Settings lists them by folder, with Replace and Delete.

The values go to no agent's CLI, environment or working directory. They go only to fixed commands (A) that name them.

### A. Fixed commands

A fixed command is a command line the user saved for a working directory, with the hosts it may reach and the secrets it gets:

```text
<command name="post" hosts="graph.threads.net" secrets="THREADS_ACCESS_TOKEN">python3 post.py</command>
```

An agent proposes one with that block; the chat shows a card with the command line, the folder, the hosts and the secrets, and the user **Saves** it (or changes it first). Nothing runs from the block alone.

**How it runs.** As a check's command runs (`runCheckCommand()`): the fixed shell script, an environment of its own, below full access in Harness Relay's own sandbox, writing only in the working directories and its temporary folder, the protected paths unreadable; and, beyond a check's command, the network only to its own hosts (the sandbox's `allowedDomains`). Like check commands, it does not run on native Windows.

**Its secrets come in a file, never in its environment.** A dotenv file in the run's temporary folder, named by `RELAY_SECRETS_FILE`. Not environment variables: other processes of the same user can read a process's environment, and a name such as `PATH`, `LD_PRELOAD` or `RELAY_CHECK_COMMAND` would change how the command starts. A needs the relay sandbox's run folders (`relaySandboxRoot()`, `relaySandboxHostRoot()`) kept from the other CLIs too, through a list of their own given to their sandboxes (Claude Code's, Codex's, Grok's, Copilot's and Muse Code's; Cursor's deny rules; Antigravity's refusals), so that none can read the file while the command runs. Not through `protectedReads()`: the relay sandbox takes those as paths no run may read or write, its own folders included, which is why the open agents get `privateRoots()` instead. The briefing tells agents to have a script read the file itself and never pass a value to another program as an argument (`curl -H …`), where `ps` shows it. After the run, values of the names the command has that the file now holds otherwise are stored back (a token renewed), and the file goes with the folder.

**Its output is masked.** Before the output goes anywhere (its card, the chat, an agent, a notification), every value Relay holds for it, the ones written back included, is replaced by `••••`. This catches the values as they are, not encoded.

**Pinned to its code.** Saving keeps the contents of the code in the working directory (the files the command line names, every other file with an extension `namedFiles()` counts, so a module the script imports or a planted `json.py` too, the configuration `CONFIG_FILE` matches, and `package.json`), as a snapshot. When any of it changed, the next run asks the user and shows the diff; an automation's run is refused until then, and the team is told, as the config gate does for check commands. Data the command writes (`queue.csv`) is not pinned. Below full access on macOS and Linux, for the commands agents run in a sandbox, an agent then cannot read the secret (it is in no folder or environment its sandbox can read), a change to the pinned code shows its diff before it runs with the secret, and what runs reaches only its hosts. What a snapshot leaves out is not pinned: ignored folders such as `.venv/` and `node_modules/`, which agents in edit mode can write and scripts load code from, and files of kinds `namedFiles()` does not count (`.pyc`, `.so`, `.node`, Perl's `.pm`); see the open questions. Pinning is also what keeps a script from writing a secret into the working directory, where agents can read it; masking covers only the output. A command the user allows outside a sandbox runs with the user's rights and could read the file, as it can read Relay's database and `secrets.key` today; so can every agent with full access. The card says so.

**Where it is used.**

1. **Try it** on its card, by the user (`--dry-run` added for one run, say), with the output in the card.
2. **In a schedule**: an automation's action can be "run this fixed command" instead of a message. It calls no model. Exit code 0 means nothing to do; a code set aside for it (say 10) means news, and its output goes to the team; any other code is a failure, whose output goes to the team as one. This also gives polling: a command run every hour that checks a feed or an API.
3. **In the outbox**: an agent proposes one run of a saved command with an input (the post's text), which goes on the command's stdin, never in its command line. The outbox card shows the input and the command; **Send** runs it once. A schedule can do the same (draft, then the user approves on a phone).

### B. The user takes over

**B1. Interactive commands.** An agent proposes a command that needs the user (`gcloud auth login --no-launch-browser`, `npm login`) with a block. The card shows the command line, the folder, and that it runs with the user's rights, outside the agents' sandboxes; **Start** runs it, never from an automation's run. It starts as check commands do: the fixed shell script reading the command line from the environment, with the variables `checkEnv()` keeps (never the server's environment, which may hold API keys) but without its `CI=1`, which makes many programs skip their prompts, in an empty folder of its own; in the working directory only when the user chooses so, the card then listing the configuration files there it may load (`.npmrc`, `.env`…), since an agent can write them. Its output, with links and codes picked out, is masked as A's is, in the card too, and so is what was typed hidden, should the program echo it. The card has an input line with **Hide what I type**, Cancel and a time limit; what is typed is sent as it is (`CliLogin.write()` trims). For the programs that ask through a helper, B1 gives one of its own: a program of fixed text that takes the prompt as its only argument, reads where to ask from B1's environment and asks the card for one hidden line; like the hooks' program (`hookShim.ts`, `hookProgram()`), it needs a Node, which the desktop app may not have on its `PATH`. It serves `sudo -A` with `SUDO_ASKPASS`, ssh with `SSH_ASKPASS` and `SSH_ASKPASS_REQUIRE=force` (OpenSSH 8.4 or later), git with `GIT_ASKPASS`. The output reaches the agents only when the user clicks **Send to the team**. What a sign-in saves goes where the program keeps it, usually the user's home (`~/.config/gcloud`, `~/.npmrc`), which agents below full access can read: the card says so. Still not covered: programs that need a terminal (full-screen programs, prompts that check for one). The process has no terminal, so Python's `getpass` falls back to its input and works. Native Windows has no `/bin/sh`, so B1 does not run there at first (see the open questions).

**B2. Taking over a browser.** When a page needs the user (a sign-in, 2FA, a CAPTCHA, a consent screen), an agent asks for it with a block. Headless is only a launch flag (`--headless=new` in `src/server/browser/session.ts`): the same browser, with the same profile, can run with a window. So B2 shows the page one of two ways:

- **A window on the computer Relay runs on.** Offered when that computer can show one (the desktop app; macOS in a signed-in session; Linux with `DISPLAY` or `WAYLAND_DISPLAY`; Windows), and chosen first when the page seems to be on that computer too (the desktop app's window, or a page opened at `127.0.0.1` or `localhost` over a loopback connection). The chat's headless browser closes and the same profile opens without `--headless=new`; the card says that the window opens on the computer Relay runs on. In the window the clipboard, the input method, a password manager's paste and hardware keys work, and the user agent is the browser's own. When the user closes it, or clicks **Done** in the chat, it closes, and the agents' next call opens the browser headless again, with what the user signed in to.
- **A screencast, from anywhere.** For a server elsewhere (a homelab, a codespace, a phone through remote access): the chat opens a panel that shows the page from Chromium's screencast (`Page.startScreencast`) and sends the user's clicks and keys back (`Input.dispatch…`).

Either way, everything still goes through the browser's proxy and its host checks (an address the user types asks as usual below full access), downloads and file choosers stay refused, and the browser keeps to one tab, so a tab the user opens is closed (the window says so). The agents' browser tools wait meanwhile.

What the user signed in to stays: the agents can use it in that chat's browser until the chat is deleted, and read whatever that account can show (`browser_snapshot`); the card says so before it starts. So a page that shows a secret (a token generator) is not for the chat's browser:

- **On the same computer**, the user opens it in their own browser and pastes the value into the S card.
- **From elsewhere**, in **a browser for the user alone**: a screencast of a browser with a profile of its own that no agent drives or reads, deleted when the user closes the panel. **Save selection as a secret** has the server read the text the user selected on the page, in a field too, through its debugging pipe, and store it under an S card's name itself: the card then says it was saved from the page, and the value is never sent to the browser as data (the screencast's picture aside).

Limits: the browser is still driven over its debugging pipe, so a site may still take it for an automated one (whether Google's sign-in lets the window through is to be tried), and passkeys kept in the system's keychain may not be offered (it runs with `--use-mock-keychain`). Through the screencast, also: its user agent says it is headless, and some sites refuse such browsers (Google's sign-in may; CAPTCHAs may be harder); passkeys and hardware keys cannot pass; and some keys may not get through (see the open questions).

## Security

- **Secret values** reach only `SecretStore` and the file of a fixed command's run: never a message, the client after **Save**, a command line, an agent's environment or a working directory.
- **The boundary holds below full access on macOS and Linux, for commands run in a sandbox.** With full access agents run with the user's rights, and so does a command the user (or the lead agent, with Approve for me) allows outside a sandbox: Cursor and Antigravity have none, and Claude Code asks to run a command outside its own. There the boundary is that approval, as it already is for Relay's database and `secrets.key`. On native Windows fixed commands do not run.
- **No value goes on a command line.** The briefing has scripts read the file themselves.
- **Below full access it rests on three things together:** the protected run folders, the pinned code and the command's hosts. Masking is a last net, for the values as they are.
- **B1 and B2 act with the user's rights or session.** Each is shown before it starts and never starts from an automation's run. A page that shows a secret opens in the user's own browser, or B2's browser for the user alone, never in the chat's.
- **Agents write the cards' labels and reasons.** Each card says which agent asks and what will use the value, and that Relay never needs the user's account passwords.

## Which scenarios this covers

| # | Scenario | S | A | B | After S, A and B |
| --- | --- | --- | --- | --- | --- |
| 0 | Giving a secret | ✓ | ✓ the values stay out of the agents' reach | ✓ the user's own browser, or B2's for the user alone | Mostly: below full access on macOS and Linux, for secrets fixed commands use; a command allowed outside a sandbox can still read them |
| 1 | A script on a schedule | | ✓ | | Covered, while Relay runs, on macOS and Linux |
| 2 | Editing a file | | | | Not covered: the Files panel needs editing and upload |
| 3 | Approving a script's outward action | | ✓ outbox | | Covered for fixed commands |
| 4 | A site the user signs in to | | | ✓ B2 | Mostly: in a window on the same computer, hardware keys and the clipboard work, though a site may still take it for automated (to be tried); through the screencast, not passkeys or hardware keys, nor sites that refuse a headless browser |
| 5 | Another service's OAuth | ✓ a token from a generator | ✓ the exchange and the renewal with the app secret | ✓ B2 for the consent page | Partly: no provider of Relay's own for it, and a redirect URL the service accepts is the user's |
| 6 | A command that waits for typing | | | ✓ B1 | Partly: `sudo -A`, ssh and git through the helper; not programs that need a terminal, nor native Windows |
| 7 | A program that keeps running | | | | Not covered |
| 8 | Another event | | ✓ polling every hour or more | | Partly: no inbound webhook |
| 9 | A QR code | | | ✓ B1 output, B2 page | Partly: a terminal's QR code in text may not scan |
| 10 | "Do this, then come back" | | | | Not covered: a card of steps with **Done** is a small part of its own |

## Steps

1. S, and A with **Try it** (the part the shared conversation needed), with the relay sandbox's run folders kept from the other CLIs' sandboxes. Relay's own secrets live in no working directory, so snapshots never take them.
2. A in schedules, and in the outbox.
3. B1.
4. B2: the window first, then the screencast and the browser for the user alone.

Apart from these: editing and upload in the Files panel (2), and a card of steps (10).

## Alternatives rejected

- **A terminal in the page** (a shell in the working directory, xterm.js as the preview's terminal). It covers more of 6, but needs a pseudo-terminal (a native module such as node-pty, for the desktop app and Windows too), is a whole shell outside every sandbox for any signed-in browser, and most of Relay's users are not developers. B1 runs only commands the user saw first.
- **Typing into the commands agents run.** Their processes are the CLIs', not Relay's.
- **Secrets in the CLIs' environment.** Each CLI passes its environment to its commands its own way; any `env` puts the values in the model's context; a renewed token cannot be written back.
- **A secrets file in the working directory** (what the shared conversation did). Every agent below full access can read it, a snapshot takes it unless it is ignored, and whatever syncs the folder copies it.
- **Pasting secrets in the chat.** Kept in the database, shown in shares, given to every prompt.
- **A gateway tool instead of reply blocks.** Six CLIs get Relay's tools only with full access; the blocks work for all twelve.
- **Making the headless browser look like one with a window** (another user agent). It disguises an automated browser; for the user's own sign-in, a real window is the honest way.
- **The user's own browser and its sign-ins.** The agents would get every site the user is signed in to, which the browser tools rule out today.
- **A provider of Relay's own for each service's OAuth.** Too many services, each with its own rules (Threads wants an HTTPS redirect URL that is not localhost, which Relay's callback on `http://127.0.0.1` is not); S and A let the user's own script do the exchange.

## Open questions

- Secrets and fixed commands by working directory, or by conversation? An automation that opens a new chat each time (`sendInNewChat()`) needs them by folder; two conversations in one folder then share them.
- Is pinning every code file and configuration file in the folder enough? Ignored folders (`.venv/`, `node_modules/`) are not in a snapshot, yet scripts load code from them, and some code is in files `namedFiles()` does not count (`.pyc`, `.so`, `.node`, `.pm`): pin those folders too, or run the command on a copy of the pinned snapshot?
- Masking catches the values as they are, not encoded (base64, URL-encoded); is pinning enough against a script that encodes them?
- Fixed commands on native Windows, where Relay's own sandbox does not run.
- B1 with a pseudo-terminal (node-pty, or `script(1)` on macOS and Linux) for the programs that need one?
- B1 on native Windows: started as the program itself, never through `cmd.exe`. There Python's `getpass` reads the console Windows gives the process, not its input.
- A sign-in that redirects to `localhost` on the server while the browser is elsewhere: should B1 take the address the browser ended at and request it on the server, only on the port its own process listens on?
- B2's screencast: which keys can it not send (IME composition, the clipboard)? And should a password field's value ever appear in `browser_snapshot`?
- B2's window: how to tell that the page is on the computer Relay runs on? An SSH tunnel also arrives at `localhost` over loopback, so the card always says where the window opens and lets the user pick the screencast instead.
- B2's window: do Google's sign-in and passkeys work in a browser driven over its debugging pipe with `--use-mock-keychain`?
- How to keep an agent's card from asking for what it should not (the password of the user's own Google account, say) beyond what the card says?
- 7 (a program that keeps running): a service Relay supervises (start, stop, logs), or the system's own (launchd, systemd) with the user's consent?
