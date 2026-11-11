**English** | [繁體中文](SECURITY.zh-TW.md)

# Security policy

Harness Relay starts coding agents that can change your files and run commands, so a way past its defences can do real harm. Thank you for helping keep its users safe.

## Reporting a vulnerability

Please **don't** open a public issue or pull request about it, and don't put the details in a shared conversation.

Report it privately on GitHub with **[Report a vulnerability](https://github.com/Agentic-System-Lab/harness-relay/security/advisories/new)** (the repository's **Security** tab → **Report a vulnerability**). Only you and the maintainers see the report, and we can work on the fix together there. If you can't use GitHub, email [chihyu.jimmy.yeh@gmail.com](mailto:chihyu.jimmy.yeh@gmail.com) with "Security" in the subject.

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

The desktop app updates itself to the newest release (**Settings & sign-in → Version**). Running from a clone, pull `main`.

## What counts

Only browsers the user signed in may use the server, and agents below full access stay inside their CLI's sandbox, which Harness Relay sets up. [Architecture → Security](docs/architecture.md#security) lists the defences. A way past them is a vulnerability, for example:

- a website, or a program on the same computer (code an agent runs included), that drives the API or the agents without a signed-in browser's cookie and key;
- an agent's reply that makes the browser load something from another site, or that runs a script in the app's page;
- reading or downloading, through the app, files outside the working directory, the agents' worktrees and the attachments, or anything in `.git`;
- API keys or MCP servers' secret values reaching the browser, the database, a log or a command line;
- an agent below full access reaching what Harness Relay keeps from it (the browsers' folders, Harness Relay's database, Harness Relay itself in edit mode) because of how Harness Relay set up its CLI;
- a shared conversation publishing something the user did not choose to share;
- the desktop app's window loading another site or reaching Node.

## What doesn't count

These are known and documented, so they are not vulnerabilities:

- what agents do within the permission you gave them: with **full access** they can run any command, and in **edit** mode they can change any file in the working directory, also when a file or web page they read tells them to;
- the gaps in the CLIs' sandboxes listed in [OS sandboxes by platform](docs/sandboxing.md) and [Known limitations](docs/architecture.md#known-limitations): project code that Grok runs can reach the network, and on native Windows Claude Code and Grok have no sandbox at all;
- a program outside the sandboxes that can already read your browser's profile or write Harness Relay's `data/` folder;
- reaching the server some other way than through `tailscale serve` (binding it to `0.0.0.0`, a public tunnel), which [Use it from your phone](docs/remote-access.md#security) warns against;
- problems in the `claude`, `codex` and `grok` CLIs themselves or in their sandboxes: report those to Anthropic, OpenAI and xAI. If Harness Relay makes one worse, report it here as well.

Not sure? Report it anyway, and we'll work it out together.
