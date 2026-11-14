#!/usr/bin/env bash
# Once, when a codespace has been made for someone (postCreateCommand in devcontainer.json: never in a
# prebuild, and not again when it is rebuilt): tells Harness Relay's download mirror that one was made,
# so that the maintainers know how many people try Harness Relay in a codespace, which GitHub does not
# tell them (docs/codespaces.md, "What is counted"). One request with nothing in it: no account, name or
# token goes with it, and the mirror's count keeps only how many were made a day (mirror/worker.ts).
# Only a codespace the README's and the website's links make: this repository's (not a fork's), on the
# newest release's branch (not one made to work on Harness Relay). Never outside GitHub Codespaces, and
# never with DO_NOT_TRACK set (a Codespaces secret). It never fails the codespace, and says nothing
# unless it was turned off.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 0
source .devcontainer/codespace.sh

[ "$(codespace_var CODESPACES)" = true ] || exit 0
# This repository, and the mirror (none when MIRROR is empty: last, so that read leaves it empty), as
# the website names them.
read -r repo mirror < <(node --input-type=module -e "import { MIRROR, REPO } from './site/assets/downloads.js'; console.log(REPO, MIRROR);" 2>/dev/null) || exit 0
[ -n "$mirror" ] || exit 0
[ "$(codespace_var GITHUB_REPOSITORY)" = "$repo" ] || exit 0
# The branch the links open (CODESPACES_BRANCH in .github/workflows/release.yml).
[ "$(git symbolic-ref --short HEAD 2>/dev/null)" = latest-release ] || exit 0
dnt="$(codespace_var DO_NOT_TRACK)"
if [ -n "$dnt" ] && [ "$dnt" != 0 ]; then
  echo "DO_NOT_TRACK is set: this codespace is not counted."
  exit 0
fi
# Counted already: a rebuild keeps /workspaces, and with it this file (data/ is git-ignored).
marker=data/codespace-counted
[ -e "$marker" ] && exit 0
# Briefly: the editor's first start of the server (postAttachCommand) waits for this.
if curl -fsS -o /dev/null --connect-timeout 3 --max-time 5 -X POST "$mirror/codespaces" 2>/dev/null; then
  mkdir -p data && : > "$marker"
fi
exit 0
