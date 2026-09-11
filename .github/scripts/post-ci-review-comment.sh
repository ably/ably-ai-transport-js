#!/usr/bin/env bash
# Read the gate reports, post them to the PR as a single upserted comment, and
# exit non-zero when the blocking gate did not pass.
#
# The rules gate blocks; the DR gate is reported and never affects the exit
# code. A missing or unparseable rules report is treated as a failure — a gate
# that could not run is not a gate that passed.
#
# Usage: post-ci-review-comment.sh <pr-number> <rules-report> <dr-report>
# Requires: GH_TOKEN and GITHUB_REPOSITORY in the environment.

set -uo pipefail

pr_number=$1
rules_report=$2
dr_report=$3

MARKER='<!-- claude-ci-review -->'

# The report's own verdict line, or ERROR when the gate produced no readable
# report at all.
verdict_of() {
  if [ ! -s "$1" ]; then
    echo ERROR
    return
  fi
  local line
  line=$(grep -m1 -oE '^VERDICT: (PASS|FAIL|ERROR)' "$1" | awk '{print $2}')
  echo "${line:-ERROR}"
}

rules_verdict=$(verdict_of "$rules_report")
dr_verdict=$(verdict_of "$dr_report")

# Everything except the verdict line, so the body can render it as a heading.
body_of() {
  if [ -s "$1" ]; then
    grep -v '^VERDICT: ' "$1" | sed '/./,$!d'
  else
    echo '_The gate produced no report. Check the workflow logs._'
  fi
}

icon_of() {
  case "$1" in
    PASS) echo '✅' ;;
    FAIL) echo '❌' ;;
    *) echo '⚠️' ;;
  esac
}

{
  printf '%s\n\n' "$MARKER"
  printf '## %s Rules gate — %s\n\n' "$(icon_of "$rules_verdict")" "$rules_verdict"
  body_of "$rules_report"
  printf '\n\n## %s Decision record — %s\n\n' "$(icon_of "$dr_verdict")" "$dr_verdict"
  body_of "$dr_report"
  printf '\n\n---\n\n'
  case "$rules_verdict" in
    PASS) printf 'The rules gate passed. The decision-record result is advisory and does not affect this check.\n' ;;
    FAIL) printf 'The rules gate blocks this check. Address the findings above and push; the gate re-runs on every push.\n' ;;
    *) printf 'The rules gate could not run, so this check fails rather than passing untested. See the workflow logs.\n' ;;
  esac
} > /tmp/ci-review-comment.md

# One comment per PR, edited in place, so a fixed PR does not keep a stale
# failure sitting above the conversation.
# --jq runs per page, so the filter emits ids and the pick happens in the pipe.
existing=$(gh api "repos/$GITHUB_REPOSITORY/issues/$pr_number/comments?per_page=100" --paginate \
  --jq ".[] | select(.body | startswith(\"$MARKER\")) | .id" | tail -n 1)

if [ "$rules_verdict" = PASS ] && [ "$dr_verdict" = PASS ] && [ -z "$existing" ]; then
  echo "::notice::Both gates passed; nothing to comment"
  exit 0
fi

if [ -n "$existing" ]; then
  gh api --method PATCH "repos/$GITHUB_REPOSITORY/issues/comments/$existing" \
    -f body="$(cat /tmp/ci-review-comment.md)" --jq .html_url
else
  gh pr comment "$pr_number" --repo "$GITHUB_REPOSITORY" --body-file /tmp/ci-review-comment.md
fi

echo "::notice::Rules gate ${rules_verdict}; decision record ${dr_verdict}"

if [ "$rules_verdict" != PASS ]; then
  echo "::error::Rules gate verdict is ${rules_verdict}" >&2
  exit 1
fi
