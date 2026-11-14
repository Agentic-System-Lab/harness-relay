#!/usr/bin/env bash
# Run once when the dev container is made (onCreateCommand in devcontainer.json): what the sandboxes
# need on Linux, and the seven agent CLIs that are not open source. The open-source agents (OpenCode,
# Goose, Cline, OpenHands, Pi) install as the README says, in the codespace's terminal.
set -euo pipefail

# Claude Code's, Codex's and Harness Relay's own sandboxes: bubblewrap and socat (and ripgrep for
# Harness Relay's). Copilot's needs slirp4netns, iproute2 and iptables besides.
sudo apt-get update
sudo apt-get install -y --no-install-recommends bubblewrap socat ripgrep slirp4netns iproute2 iptables

# Claude Code, Codex and Copilot, from npm.
npm install -g @anthropic-ai/claude-code @openai/codex @github/copilot

# Grok, Cursor, Antigravity and Muse Code, with their makers' own installers, which put them in
# ~/.grok/bin and ~/.local/bin and keep them up to date. Each is fetched whole first, and given no
# input to read. Linked from /usr/local/bin, so that the server finds them however it is started (only
# an interactive shell's profile puts those folders on the PATH).
install_with() {
  local script
  script="$(mktemp)"
  curl -fsSL "$1" -o "$script"
  bash "$script" < /dev/null
  rm -f "$script"
}
install_with https://x.ai/cli/install.sh
install_with https://cursor.com/install
install_with https://antigravity.google/cli/install.sh
install_with https://dev.meta.ai/install.sh
sudo ln -sf "$HOME/.grok/bin/grok" /usr/local/bin/grok
for cli in cursor-agent agy muse; do
  sudo ln -sf "$HOME/.local/bin/$cli" "/usr/local/bin/$cli"
done

# A folder for the agents to work in. Harness Relay's own folder will not do below full access in edit
# mode, nor /workspaces, which holds it; /workspaces is what a codespace keeps when it is rebuilt.
# Made by root, for this user: outside a codespace, Docker makes /workspaces root's.
sudo install -d -o "$(id -u)" -g "$(id -g)" /workspaces/playground
