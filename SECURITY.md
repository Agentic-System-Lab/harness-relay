**English** | [繁體中文](SECURITY.zh-TW.md)

# Security policy

Harness Relay starts coding agents that can change your files and run commands, so a way past its defences can do real harm. Thank you for helping keep its users safe.

## Reporting a vulnerability

Please **don't** open a public issue or pull request about it, and don't put the details in a shared conversation.

Report it privately on GitHub with **[Report a vulnerability](https://github.com/Agentic-System-Lab/harness-relay/security/advisories/new)** (the repository's **Security** tab → **Report a vulnerability**). Only you and the maintainers see the report, and we can work on the fix together there. If you can't use GitHub, email [chihyu.jimmy.yeh@gmail.com](mailto:chihyu.jimmy.yeh@gmail.com) with "Security" in the subject. Writing from the app's **Report a problem**? Leave out **Upload screenshots**: it puts them in a secret gist that anyone with the link can see.

Write in English or Traditional Chinese, and include:

- what an attacker can do, and what they need first (a website open in the same browser, a program on the same computer, code an agent runs, a device on the tailnet, …);
- the steps to reproduce it, or a proof of concept;
- the Harness Relay version (**Settings & sign-in → Version**, or `git rev-parse --short HEAD` in a clone), how you run it (the desktop app, `npm start` or `npm run dev`), your operating system, and the agent CLIs involved with their versions;
- the conversation's mode and permission, if they matter.

Leave out real API keys, tokens and private files: made-up values work just as well.

## What happens next

1. A maintainer replies within a week to confirm the report arrived, and keeps you posted while we look into it.
2. Once the problem is confirmed, we fix it on `main` and make a release with the fix. The desktop app offers the new version to its users by itself.
3. Then we publish a GitHub security advisory that credits you, unless you'd rather not be named.

Please give us time to release the fix before you talk about the problem in public; we'll agree on a date with you.

## Supported versions

Releases are named by date (for example `2026-11-11.1`). Fixes go into the next release; older releases and release candidates don't get fixes of their own.

| Version | Supported |
| --- | --- |
| The newest release | ✅ |
| `main` | ✅ |
| Older releases and release candidates | ❌ |

The desktop app offers the newest release once it is out, and installs it when you choose **Update** (**Settings & sign-in → Version**). Running from a clone, pull `main`.

## What counts

Only browsers the user signed in may use the server. Below full access, the commands of Claude Code, Codex, Grok and Copilot run in their CLI's sandbox where the platform has one, set up by Harness Relay; the open-source agents (OpenCode, Goose, Cline, OpenHands, Pi) run in Harness Relay's own sandbox ([OS sandboxes by platform → Harness Relay's own sandbox](docs/sandboxing.md#harness-relays-own-sandbox)); and Cursor, which has none, asks before each command. Harness Relay also keeps them out of a few places ([OS sandboxes by platform → What agents may not read or write](docs/sandboxing.md#what-agents-may-not-read-or-write)). [Architecture → Security](docs/architecture.md#security) lists the defences. A way past them is a vulnerability, for example:

- a website, or a program on the same computer (code an agent runs included), that drives the API or the agents without a signed-in browser's cookie and key;
- an agent's reply that makes the browser load something from another site, or that runs a script in the app's page;
- a way past the path checks of the media, download and file-browsing endpoints (through a link in an agent's reply or a symlink, say) to files outside the working directory, the agents' worktrees and the attachments, or to anything in `.git`;
- API keys or MCP servers' secret values reaching the browser, a log or a command line, or the database on a system that has a credential store;
- an agent below full access reaching a place Harness Relay keeps it out of (the browsers' folders, Harness Relay's database and its temporary folder), or edit mode starting in a folder Harness Relay refuses (Harness Relay itself, your home folder, a CLI's own folder), because of how Harness Relay set up its CLI;
- an open-source agent below full access getting out of Harness Relay's own sandbox: writing where its permission does not allow, reading another conversation's or member's state, or reaching a host it was not allowed to without asking;
- a Cursor command, or a write Cursor asks about, running below full access without the user allowing it (other than one on a Cursor team's auto-run allowlist);
- a Copilot turn below full access starting when Copilot's sandbox is not the one Harness Relay set up (off, one a command can leave, one that gives commands the keychain or git and gh credentials, or without a path Harness Relay gave it), or a project's hooks running before the user allowed them or before that sandbox was checked;
- a model backend's or an endpoint's key reaching a run that does not use it, or a member's turn on one of your endpoints going to the CLI's own service instead;
- a shared conversation publishing something the user did not choose to share;
- the desktop app's window loading another site or reaching Node.

## What doesn't count

These are known and documented, so they are not vulnerabilities:

- what agents do within the permission you gave them, also when a file or web page they read tells them to: with **full access** they can run any command; in **edit** mode they can change files in the working directories and run project commands such as tests, builds and scripts without asking (with Grok, Copilot and the open-source agents, anything but pushing and publishing, and a shell or interpreter running what a pipe gives it; Cursor runs no command without asking, but those on a Cursor team's auto-run allowlist); and in every mode they can read web pages, which can carry away what they read;
- what the CLIs' sandboxes do not cover, as [OS sandboxes by platform → What the sandboxes do not cover](docs/sandboxing.md#what-the-sandboxes-do-not-cover) and [Known limitations](docs/architecture.md#known-limitations) describe. Commands can read almost the whole computer (`~/.ssh` and `~/.aws` included) apart from the places above; project code that Grok or Copilot runs can reach the network; Claude Code's sandbox covers its Bash commands, not its own tools, hooks or MCP servers, and Copilot's does not cover its MCP servers; on macOS Copilot's read-only paths inside the working directory are path rules, which a command can get around by renaming the folder above them; a command you allow runs outside the sandbox; and on native Windows Claude Code and Grok have no sandbox at all, and the open-source agents run only with full access;
- Cursor having no sandbox in the mode Harness Relay runs it in: a command you allow runs with your full rights, a Cursor team's auto-run allowlist runs commands without asking, and the deny rules that keep its own file tools from the protected paths match the path as written (another letter case, or a link, gets past them);
- what sign-in does not stop, as [Architecture → Signing in](docs/architecture.md#signing-in) describes: a program outside the sandboxes that can read your browser's profile or write Harness Relay's `data/` folder; a page an agent serves on another port of this computer getting the cookie if you open it, which is all the read-only routes the browser loads by itself need; a program that keeps sending wrong codes, so that new browsers cannot sign in while it does;
- API keys kept in `data/relay.db` on a system without a credential store, as the [README](README.md#safety) says;
- what every device in your tailnet can reach once you share the server with `tailscale serve`: its sign-in page, and AgentsView, which has no sign-in ([Use it from your phone → Security](docs/remote-access.md#security));
- reaching the server some other way (binding it to `0.0.0.0`, `tailscale funnel`), which that page warns against;
- problems in the agent CLIs themselves or in their own sandboxes: report those to their makers (`claude` to Anthropic, `codex` to OpenAI, `grok` to xAI, `cursor-agent` to Cursor, `copilot` to GitHub, and OpenCode, Goose, Cline, OpenHands and Pi to their projects). If Harness Relay makes one worse, report it here as well.

Not sure? Report it anyway, and we'll work it out together.
