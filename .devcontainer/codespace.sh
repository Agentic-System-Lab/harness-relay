# shellcheck shell=bash
# Sourced by start.sh and count.sh.

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
