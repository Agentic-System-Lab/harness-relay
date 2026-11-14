#!/usr/bin/env bash
# Start Harness Relay in a codespace (postAttachCommand in devcontainer.json; run it again yourself
# after stopping it), or, when it is running already, print another sign-in link. The links point at
# the codespace's forwarded address, which only your GitHub account can open, and the server takes
# that address (RELAY_ALLOWED_HOSTS). Outside a codespace it is `npm start`.
set -euo pipefail

# A variable Codespaces sets, also in a shell that did not load its profile (`gh codespace ssh -- …`):
# only the one named, from the file the profile reads (`$2`, for a test), which holds the codespace's
# tokens too.
codespace_var() {
  local value="${!1:-}" file="${2:-/workspaces/.codespaces/shared/.env}"
  if [ -z "$value" ] && [ -r "$file" ]; then
    value="$(sed -n "s/^$1=//p" "$file" | tail -n 1)"
  fi
  printf '%s' "$value"
}

# The sign-in links on the forwarded address instead of 127.0.0.1, each with its code beside it: a
# browser that has not opened the codespace's ports yet signs in to GitHub first, and may lose the link's
# code on the way back. Vite's link (`npm run dev`) means nothing here. Line by line, as they come; on
# Ctrl+C on to the end, so that what the server says as it stops is still shown.
links() {
  trap '' INT
  if [ -z "$public" ]; then
    cat
    return
  fi
  local line re="^(.*)http://127\\.0\\.0\\.1:${port}/#code=([0-9A-Z-]+)(.*)\$"
  while IFS= read -r line; do
    case "$line" in
      'With npm run dev:'* | 'Or type the code on the sign-in page:'*) continue ;;
    esac
    if [[ $line =~ $re ]]; then
      printf '%s\n' "${BASH_REMATCH[1]}https://${public}/#code=${BASH_REMATCH[2]}${BASH_REMATCH[3]}" \
        "  (or type this code on the sign-in page: ${BASH_REMATCH[2]})"
    else
      printf '%s\n' "$line"
    fi
  done
}

port="${PORT:-8787}"
public=""
name="$(codespace_var CODESPACE_NAME)"
domain="$(codespace_var GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN)"
if [ -n "$name" ] && [ -n "$domain" ]; then
  public="${name}-${port}.${domain}"
  export RELAY_ALLOWED_HOSTS="${public}${RELAY_ALLOWED_HOSTS:+,${RELAY_ALLOWED_HOSTS}}"
fi

# Sourced (test/devcontainer.test.ts): the functions and the address only.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  return 0
fi

cd "$(dirname "$0")/.."

if curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:${port}/api/auth" 2>/dev/null; then
  echo "Harness Relay is running already."
  npm run --silent login | links
  exit 0
fi

echo "Starting Harness Relay. Stop it with Ctrl+C; start it again with: bash .devcontainer/start.sh"
npm start 2>&1 | links
