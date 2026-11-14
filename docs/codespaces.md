**English** | [繁體中文](codespaces.zh-TW.md)

# Try it in GitHub Codespaces

A codespace is a Linux machine of your own in GitHub's cloud. This repository's dev container (`.devcontainer/`) sets one up for Harness Relay: Node.js, what the sandboxes need on Linux, the GitHub CLI, the seven agent CLIs that are not open source (Claude Code, Codex, Copilot, Grok, Cursor, Antigravity and Muse Code), and the app built and started. You try Harness Relay in your browser without installing anything on your computer.

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/Agentic-System-Lab/harness-relay/tree/latest-release?quickstart=1)

The button opens the newest release of Harness Relay, not `main` as it is: the `latest-release` branch, which the Release workflow moves to each release. To work on Harness Relay itself in a codespace, make one on `main` or on a branch of yours from the repository's **Code → Codespaces**.

## What it costs

A codespace runs on your GitHub account. A GitHub Free personal account includes 120 core-hours and 15 GB-month of storage a month; the 2-core machine this dev container asks for uses 2 core-hours an hour, so about 60 hours. A codespace stops after 30 minutes without activity (change it under **Settings → Codespaces** on GitHub; raise it before a long run), and a stopped one still counts its storage until you delete it at [github.com/codespaces](https://github.com/codespaces). See [About billing for GitHub Codespaces](https://docs.github.com/en/billing/managing-billing-for-your-products/managing-billing-for-github-codespaces/about-billing-for-github-codespaces).

## Steps

1. **Create it.** Click the button above, then **Create codespace**. The first time takes a few minutes: it installs the packages and the CLIs and builds the UI.
2. **Sign in.** When the editor opens, its terminal starts Harness Relay (`bash .devcontainer/start.sh`) and prints a sign-in link on the codespace's own address, `https://<codespace>-8787.app.github.dev/#code=…`, with its code beside it. Open the link. The first time, GitHub may check that it is you before it lets the page through and then the page asks for the code: type the one the terminal printed.
3. **Sign the agents in.** In **Settings & sign-in**, sign in to the ones you have an account for: Claude Code and Cursor with their links, Codex with its device code (its browser sign-in sends the browser back to `localhost`, which is your own computer, not the codespace), Grok and Muse Code with their device codes, and Antigravity with Google's link and the code it gives you to paste back. Copilot signs in with the codespace's GitHub token (see [The codespace's GitHub token](#the-codespaces-github-token)), and shows as signed in once Copilot reports a plan for your account; Copilot Free counts.
4. **Ask.** Click **New chat** and use `/workspaces/playground` as the working directory: the dev container makes it for you. Harness Relay's own folder (`/workspaces/harness-relay`) and `/workspaces`, which holds it, are refused in edit mode below full access.

Stop the server with Ctrl+C in that terminal, and start it again with `bash .devcontainer/start.sh`. Run the same command while it runs to get another sign-in link, for another browser or a phone.

A codespace keeps the release it was made with, and the button offers it again (**Resume this codespace**). For a newer release, choose **Create a new one** there (and delete the old one at [github.com/codespaces](https://github.com/codespaces)): a new codespace also gets what a newer dev container installs. Or, in the old one's terminal, stop the server, run `git pull && npm ci && npm run build`, and start it again.

Installed: Claude Code, Codex and Copilot from npm, and Grok, Cursor, Antigravity and Muse Code with their makers' own installers, which keep them up to date. The open-source agents (OpenCode, Goose, Cline, OpenHands, Pi) are not: install the ones you want in the codespace's terminal as the [README](../README.md#requirements) says, and give them a [model backend](open-agents.md) in **Settings → Model backends**. Two exceptions: the README installs Goose with Homebrew, which the codespace does not have (see Goose's own install guide), and OpenHands needs [uv](https://docs.astral.sh/uv/) first. A CLI installed into `~/.local/bin` is found once you start the server again from a new terminal (whose shell puts that folder on its `PATH`).

## What works differently there

- **No folder dialog.** The system's folder dialog opens only for a browser on the server's own computer, so type the working directory's path.
- **OpenCode runs with full access only**, if you install it. On Linux, Harness Relay's own sandbox cannot watch OpenCode's server, so below full access it refuses to run it ([Open agents](open-agents.md)). The other open-source agents run below full access.
- **Sharing as a link needs gh signed in.** The GitHub CLI is installed, but the codespace's own token cannot make the gist a shared conversation goes into, and `gh auth login` refuses to keep a sign-in while that token is set. Sign gh in once in the codespace's terminal, without it:

  ```bash
  env -u GITHUB_TOKEN gh auth login
  ```

  Harness Relay's `gh` then uses that sign-in for sharing (and leaves out the codespace's token there). With no keyring in a codespace, gh keeps the sign-in in a file in its folder (`~/.config/gh`); below full access, agents cannot read that folder in a codespace (see [Safety](#safety)).
- **No desktop app.** The menu, sharing with Tailscale and the app's updates are the desktop app's; here it is the server alone (`npm start`).
- **Antigravity's Google sign-in** is kept in the system's keyring elsewhere, which a codespace does not have: whether it stays signed in there was not tried. It also runs on a Gemini API key (`GEMINI_API_KEY`), which needs no keyring.
- **Not tried there:** finishing the sign-ins of Claude Code, Codex, Grok, Cursor, Antigravity and Muse Code (each one's starts there and shows its link or code), voice input and push notifications.

## What is counted

GitHub does not tell a repository's maintainers how many codespaces people make of it. So a codespace says once that it was made: `.devcontainer/count.sh`, run as the dev container's `postCreateCommand`, sends one request to Harness Relay's download mirror (the Cloudflare Worker the website's download buttons use, `mirror/`).

- **What it sends:** an empty `POST` to the mirror's `/codespaces`. No account, name, token or anything else about you or the codespace goes with it.
- **What is kept:** how many codespaces were made each day, and nothing else: no address, no time of day, no user agent. Like any website, Cloudflare sees where the request comes from: the codespace's address in GitHub's cloud, not your computer's.
- **When:** once, after the codespace has been made for you. Not when it starts again, nor when it is rebuilt (it leaves a mark in `data/`, which a rebuild keeps), and never outside GitHub Codespaces, such as in a dev container on your own computer. If the mirror cannot be reached, the codespace goes uncounted and starts as usual.
- **To turn it off,** set `DO_NOT_TRACK` to `1` before you make the codespace, as a Codespaces secret for this repository under **Settings → Codespaces** on GitHub. It then says that it is not counted, and sends nothing.

## Safety

- **The address is private.** Codespaces lets only your GitHub account open it. Do not make the port public (**Ports** → **Port Visibility**): anyone with the address could then reach the sign-in page of agents that can write.
- **The sandboxes work below full access.** For bubblewrap, the dev container runs with `seccomp`, `apparmor` and `systempaths` unconfined, and with a TUN device for Copilot's sandbox. That leaves the container less isolated from the machine around it; in a codespace that machine is yours alone. Harness Relay's own sandbox (`npx tsx scripts/sandbox-check.ts`: 51 of 51 checks), Codex's and Copilot's were tried in a codespace; Grok's and Muse Code's were not. Cursor and Antigravity have none in Harness Relay's runs, so below full access they ask before each command. See [OS sandboxes by platform](sandboxing.md#docker-and-dev-containers).
- **The codespace's token files are kept from the agents** below full access: `/workspaces/.codespaces`, where Codespaces keeps its token, its registry sign-ins and your Codespaces secrets in files every program there may read, and gh's folder ([What agents may not read or write](sandboxing.md#what-agents-may-not-read-or-write)). With full access an agent can read anything in the codespace.
- **What you sign in to stays in the codespace**: the CLIs' sign-ins in its home folder, the database in `data/`. Anyone who can use your GitHub account can open it. Delete the codespace when you are done, and sign the CLIs out first if you want their sessions ended too.

### The codespace's GitHub token

Codespaces gives every program in the codespace a GitHub token of yours (`GITHUB_TOKEN`), for what Codespaces allows it (see [Security in GitHub Codespaces](https://docs.github.com/en/codespaces/reference/security-in-github-codespaces)). Harness Relay passes it on to the agents with the rest of its environment, as it does your shell's: Copilot signs in with it, and any agent's commands can use it, also below full access (Copilot's sandbox, for one, lets its commands reach the network). To keep it out of the agents' environment, start the server without it:

```bash
env -u GITHUB_TOKEN bash .devcontainer/start.sh
```

For Copilot, its own device sign-in needs a keyring, which a codespace does not have: give it a token of its own instead, as a `COPILOT_GITHUB_TOKEN` Codespaces secret.

### API keys

A codespace has no system keyring, so an API key you type in **Settings** is kept in the database in the codespace, encrypted with the key in `data/secrets.key` (agents below full access can read neither). For Claude Code and Codex you can give it as a Codespaces secret instead, kept by GitHub rather than in the codespace: `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`, set for this repository under **Settings → Codespaces** on GitHub before you make the codespace. They reach the server as environment variables. Claude Code then runs on `ANTHROPIC_API_KEY`, and Codex on `OPENAI_API_KEY`, instead of your sign-in, billed by use. The open-source agents take only the keys set in **Settings → Model backends**.

## On your own computer

The same dev container works with VS Code's Dev Containers, which forwards the port to your computer: there `start.sh` is `npm start`, so open the `http://127.0.0.1:8787` link it prints. Its container options weaken Docker's isolation from your computer too: there an agent with full access could reach your computer through them, so give agents full access only in a codespace.

For maintainers: [prebuilds](https://docs.github.com/en/codespaces/prebuilding-your-codespaces) would make a codespace ready sooner. They are billed to the repository's owner, and are not set up; the count would still count only the codespaces made for someone (a prebuild does not run `postCreateCommand`). How to read the count, and how `latest-release` moves: the [developer guide](developer-guide.md#releasing).
