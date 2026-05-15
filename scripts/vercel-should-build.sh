#!/usr/bin/env bash
#
# Vercel "Ignored Build Step" for the use-chat demo.
#
# Configured in the Vercel project: Settings -> Git -> Ignored Build Step.
# Vercel runs this from the project's Root Directory; we cd to repo root so
# the watchlist paths below stay relative to the repo, not the demo.
#
# Exit-code contract (Vercel):
#   exit 0 = skip this deploy (shown as "Ignored" in the dashboard)
#   exit 1 = proceed with the build
#
# Anything else is treated as a script failure and the build runs.

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

PREV="${VERCEL_GIT_PREVIOUS_SHA:-}"

# First build on this branch, or the previous SHA is no longer reachable
# (force-push, rebase, expired shallow clone). Build to be safe.
if [ -z "$PREV" ] || ! git cat-file -e "${PREV}^{commit}" 2>/dev/null; then
  echo "vercel-should-build: no reachable previous SHA; building."
  exit 1
fi

# Paths that, when changed, justify a fresh demo deploy. Err on the side of
# over-inclusion; a wasted build costs minutes, a skipped one ships stale.
WATCH=(
  "src/"
  "demo/vercel/react/use-chat/"
  "package.json"
  "package-lock.json"
  "tsconfig.json"
  "scripts/vercel-should-build.sh"
)

CHANGED=$(git diff --name-only "$PREV" HEAD -- "${WATCH[@]}")
if [ -n "$CHANGED" ]; then
  echo "vercel-should-build: relevant changes since ${PREV}; building:"
  echo "$CHANGED"
  exit 1
fi

echo "vercel-should-build: no relevant changes since ${PREV}; skipping deploy."
exit 0
