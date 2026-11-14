#!/usr/bin/env bash
# Start Harness Relay in a codespace (postAttachCommand in devcontainer.json; run it again yourself
# after stopping it), or, when it is running already, print another sign-in link. The links point at
# the codespace's forwarded address, which only your GitHub account can open, and the server takes
# that address (RELAY_ALLOWED_HOSTS). Outside a codespace it is `npm start`.
set -euo pipefail
cd "$(dirname "$0")/.."

# A variable Codespaces sets, also in a shell that did not load its profile (`gh codespace ssh -- …`):
# only the one named, from the file the profile reads, which holds the codespace's tokens too.
codespace_var() {
  local value="${!1:-}"
  if [ -z "$value" ] && [ -r /workspaces/.codespaces/shared/.env ]; then
    value="$(sed -n "s/^$1=//p" /workspaces/.codespaces/shared/.env | tail -n 1)"
  fi
  printf '%s' "$value"
}

port="${PORT:-8787}"
public=""
name="$(codespace_var CODESPACE_NAME)"
domain="$(codespace_var GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN)"
if [ -n "$name" ] && [ -n "$domain" ]; then
  public="${name}-${port}.${domain}"
  export RELAY_ALLOWED_HOSTS="${public}${RELAY_ALLOWED_HOSTS:+,${RELAY_ALLOWED_HOSTS}}"
fi

# The sign-in links on the forwarded address instead of 127.0.0.1, each with its code beside it: a
# browser that has not opened the codespace's ports yet signs in to GitHub first, and may lose the link's
# code on the way back. Vite's link (`npm run dev`) means nothing here.
links() {
  if [ -z "$public" ]; then
    cat
    return
  fi
  sed -u -E \
    -e '/With npm run dev:/d' \
    -e '/^Or type the code on the sign-in page:/d' \
    -e "s#http://127\\.0\\.0\\.1:${port}/\\#code=([0-9A-Z-]+)#https://${public}/\\#code=\\1\\n  (or type this code on the sign-in page: \\1)#"
}

if curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:${port}/api/auth" 2>/dev/null; then
  echo "Harness Relay is running already."
  npm run --silent login | links
  exit 0
fi

echo "Starting Harness Relay. Stop it with Ctrl+C; start it again with: bash .devcontainer/start.sh"
npm start 2>&1 | links
