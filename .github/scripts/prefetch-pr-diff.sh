#!/usr/bin/env bash
# Fetch a PR diff, strip noise files (lockfiles), and truncate to a line
# budget. Writes the result to /tmp/pr-diff.txt.
#
# Usage: prefetch-pr-diff.sh <pr-number> <max-lines>
# Requires: GH_TOKEN and GITHUB_REPOSITORY in the environment.

set -euo pipefail

pr_number=$1
max_lines=$2

gh pr diff "$pr_number" --repo "$GITHUB_REPOSITORY" \
  | awk '/^diff --git/{
      skip = (/pnpm-lock\.yaml/ \
           || /package-lock\.json/ \
           || /yarn\.lock/)
    } !skip' \
  > /tmp/pr-diff.txt

diff_lines=$(wc -l < /tmp/pr-diff.txt)
if [ "$diff_lines" -gt "$max_lines" ]; then
  echo "::warning::Diff is ${diff_lines} lines; truncating to ${max_lines}"
  { head -n "$max_lines" /tmp/pr-diff.txt
    printf '\n[TRUNCATED — diff exceeded %s lines]\n' "$max_lines"
  } > /tmp/pr-diff-truncated.txt
  mv /tmp/pr-diff-truncated.txt /tmp/pr-diff.txt
fi
