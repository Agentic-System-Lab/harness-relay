**English** | [繁體中文](codespaces.zh-TW.md)

# Try it in GitHub Codespaces

A codespace is a Linux machine of your own in GitHub's cloud. This repository's dev container (`.devcontainer/`) sets one up for Harness Relay: Node.js, what the sandboxes need on Linux, five agent CLIs, the app built and started. You try Harness Relay in your browser without installing anything on your computer.

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/Agentic-System-Lab/harness-relay?quickstart=1)

## What it costs

A codespace runs on your GitHub account. A GitHub Free personal account includes 120 core-hours and 15 GB-month of storage a month; the 2-core machine this dev container asks for uses 2 core-hours an hour, so about 60 hours. A codespace stops after 30 minutes without use (your setting on GitHub), and a stopped one still counts its storage until you delete it at [github.com/codespaces](https://github.com/codespaces). See [About billing for GitHub Codespaces](https://docs.github.com/en/billing/managing-billing-for-your-products/managing-billing-for-github-codespaces/about-billing-for-github-codespaces).

## Steps

1. **Create it.** Click the button above, then **Create codespace**. The first time takes two minutes or so: it installs the packages and the CLIs and builds the UI. With **Change options**, you can also give it the API keys it offers (see [API keys](#api-keys)).
2. **Sign in.** When the editor opens, its terminal starts Harness Relay (`bash .devcontainer/start.sh`) and prints a sign-in link on the codespace's own address, `https://<codespace>-8787.app.github.dev/#code=…`, with its code beside it. Open the link. The first time, GitHub may check that it is you before it lets the page through and then the page asks for the code: type the one the terminal printed.
3. **Sign the agents in.** In **Settings & sign-in**, sign in to Claude Code or Codex with a link or a device code, or set up a [model backend](open-agents.md) for OpenCode and Pi. Copilot is signed in already with the codespace's GitHub token, if your GitHub account has Copilot (see [The codespace's GitHub token](#the-codespaces-github-token)).
4. **Ask.** Click **New chat** and use `/workspaces/playground` as the working directory: the dev container makes it for you. Harness Relay's own folder (`/workspaces/harness-relay`) and `/workspaces`, which holds it, are refused in edit mode below full access.

Stop the server with Ctrl+C in that terminal, and start it again with `bash .devcontainer/start.sh`. Run the same command while it runs to get another sign-in link, for another browser or a phone.

Installed: Claude Code, Codex, Copilot, OpenCode and Pi. Install the others in the codespace's terminal as the [README](../README.md#requirements) says; Harness Relay finds them when you open **Settings & sign-in** again.

## What works differently there

- **No folder dialog.** The system's folder dialog opens only for a browser on the server's own computer, so type the working directory's path.
- **No sharing as a link.** Sharing a conversation needs the GitHub CLI (`gh`), which the dev container does not install.
- **No desktop app.** The menu, sharing with Tailscale and the app's updates are the desktop app's; here it is the server alone (`npm start`).
- **Not tried there:** voice input, push notifications, and signing in to Claude Code and Codex.

## Safety

- **The address is private.** Codespaces lets only your GitHub account open it. Do not make the port public (**Ports** → **Port Visibility**): anyone with the address could then reach the sign-in page of agents that can write.
- **The sandboxes work below full access.** For bubblewrap, the dev container runs with `seccomp`, `apparmor` and `systempaths` unconfined, and with a TUN device for Copilot's sandbox. That leaves the container less isolated from the machine around it; in a codespace that machine is yours alone. Harness Relay's own sandbox (`npx tsx scripts/sandbox-check.ts`: 51 of 51 checks), Codex's and Copilot's were tried in a codespace; see [OS sandboxes by platform](sandboxing.md#docker-and-dev-containers).
- **What you sign in to stays in the codespace**: the CLIs' sign-ins in its home folder, the database in `data/`. Anyone who can use your GitHub account can open it. Delete the codespace when you are done, and sign the CLIs out first if you want their sessions ended too.

### The codespace's GitHub token

Codespaces puts a GitHub token of yours in the codespace's environment (`GITHUB_TOKEN`). Harness Relay passes it on to the agents as it does your shell's: Copilot signs in with it, and an agent with full access can use it as you could, for what Codespaces lets it do (see [Security in GitHub Codespaces](https://docs.github.com/en/codespaces/reference/security-in-github-codespaces)). To keep it from the agents, start the server without it:

```bash
env -u GITHUB_TOKEN bash .devcontainer/start.sh
```

### API keys

A codespace has no system keyring, so an API key you type in **Settings** stays in the database, in the codespace. Give it as a Codespaces secret instead: the create page's **Change options** offers `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and `XAI_API_KEY`, and **Settings → Codespaces** on GitHub keeps any other one for this repository. They reach the server as environment variables. Claude Code then runs on `ANTHROPIC_API_KEY`, and Codex on `OPENAI_API_KEY`, instead of your sign-in, billed by use.

## Elsewhere

The same dev container works with VS Code's Dev Containers or the `devcontainer` CLI on your own computer. There `start.sh` is `npm start`: open the `http://127.0.0.1:8787` link it prints.

For maintainers: [prebuilds](https://docs.github.com/en/codespaces/prebuilding-your-codespaces) would make a codespace ready sooner. They are billed to the repository's owner, and are not set up.
