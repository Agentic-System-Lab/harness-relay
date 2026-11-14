#!/usr/bin/env bash
# Run once when the dev container is made (onCreateCommand in devcontainer.json): what the sandboxes
# need on Linux, and the agent CLIs that install with npm. The others (Grok, Cursor, Antigravity,
# Muse Code, Goose, Cline, OpenHands) install as the README says, in the codespace's terminal.
set -euo pipefail

# Claude Code's, Codex's and Harness Relay's own sandboxes: bubblewrap and socat (and ripgrep for
# Harness Relay's). Copilot's needs slirp4netns, iproute2 and iptables besides.
sudo apt-get update
sudo apt-get install -y --no-install-recommends bubblewrap socat ripgrep slirp4netns iproute2 iptables

# The newest Claude Code, Codex and Copilot; the open-source agents at the versions the README names.
npm install -g \
  @anthropic-ai/claude-code \
  @openai/codex \
  @github/copilot \
  opencode-ai@1.19.5 \
  @earendil-works/pi-coding-agent@1.5.1

# A folder for the agents to work in. Harness Relay's own folder will not do below full access in edit
# mode, nor /workspaces, which holds it; /workspaces is what a codespace keeps when it is rebuilt.
# Made by root, for this user: outside a codespace, Docker makes /workspaces root's.
sudo install -d -o "$(id -u)" -g "$(id -g)" /workspaces/playground
