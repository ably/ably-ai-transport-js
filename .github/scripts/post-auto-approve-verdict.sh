#!/usr/bin/env bash
# Post the auto-approve verdict as a single PR review. Chooses the review
# state from the verdict, so an approval cannot be posted for a needs-human
# verdict regardless of what the caller asks for.
#
# Usage: post-auto-approve-verdict.sh <pr-number> <low-risk|needs-human> <rationale>
# Requires: GH_TOKEN and GITHUB_REPOSITORY in the environment.

set -euo pipefail

pr_number=$1
verdict=$2
rationale=$3

case "$verdict" in
  low-risk|needs-human) ;;
  *)
    echo "::error::Unknown verdict '${verdict}' (expected low-risk or needs-human)" >&2
    exit 1
    ;;
esac

if [ "$verdict" = low-risk ]; then
  review_flag=--approve
  verdict_line='**Verdict: low-risk** — approving.'
else
  # Deliberately --comment, not --request-changes: a human being needed is not
  # the same as changes being needed, and request-changes would block merge.
  review_flag=--comment
  verdict_line='**Verdict: additional human review warranted.**'
fi

body=$(printf '<!-- claude-auto-approve -->\n\n%s\n\n%s\n' "$rationale" "$verdict_line")

echo "::notice::Posting ${review_flag} review for verdict '${verdict}'"
gh pr review "$pr_number" --repo "$GITHUB_REPOSITORY" "$review_flag" --body "$body"
