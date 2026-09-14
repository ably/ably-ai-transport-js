#!/usr/bin/env bash
# Read the gate reports and comment on the PR when a gate has something to say,
# then exit non-zero when the blocking gate did not pass.
#
# A gate that passed says nothing: the check's own status already reports that,
# and a comment restating it is noise above the conversation. The comment exists
# to carry a reason, so only the gates that did not pass appear in it, and it is
# removed once they all do.
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

# A heading, the report minus its verdict line, and what the reader does next.
# The command substitution drops the report's trailing newlines and the sed its
# leading blank lines, so the spacing does not depend on how the gate wrote it.
section() {
  local title=$1 report=$2 note=$3 body
  if [ -s "$report" ]; then
    body=$(grep -v '^VERDICT: ' "$report" | sed '/./,$!d')
  else
    body='The gate produced no report. See the workflow logs.'
  fi
  printf '\n## %s\n\n%s\n\n_%s_\n' "$title" "$body" "$note"
}

{
  printf '%s\n' "$MARKER"

  case "$rules_verdict" in
    PASS) ;;
    FAIL)
      section 'Rules gate failed' "$rules_report" \
        'Address the findings and push — the gate re-runs on every push.'
      ;;
    *)
      section 'Rules gate could not run' "$rules_report" \
        'The check fails rather than passing untested.'
      ;;
  esac

  case "$dr_verdict" in
    PASS) ;;
    FAIL)
      section 'Decision record required' "$dr_report" \
        'Advisory: the decision-record gate does not affect this check.'
      ;;
    *)
      section 'Decision-record gate could not run' "$dr_report" \
        'Advisory: the decision-record gate does not affect this check.'
      ;;
  esac
} > /tmp/ci-review-comment.md

# --jq runs per page, so the filter emits ids and the pick happens in the pipe.
existing=$(gh api "repos/$GITHUB_REPOSITORY/issues/$pr_number/comments?per_page=100" --paginate \
  --jq ".[] | select(.body | startswith(\"$MARKER\")) | .id")

if [ "$rules_verdict" = PASS ] && [ "$dr_verdict" = PASS ]; then
  for id in $existing; do
    gh api --method DELETE "repos/$GITHUB_REPOSITORY/issues/comments/$id"
  done
  echo "::notice::Both gates passed; nothing to report"
  exit 0
fi

# One comment per PR, edited in place, so a PR under repair does not collect a
# comment per push.
target=$(echo "$existing" | tail -n 1)

if [ -n "$target" ]; then
  gh api --method PATCH "repos/$GITHUB_REPOSITORY/issues/comments/$target" \
    -f body="$(cat /tmp/ci-review-comment.md)" --jq .html_url
else
  gh pr comment "$pr_number" --repo "$GITHUB_REPOSITORY" --body-file /tmp/ci-review-comment.md
fi

echo "::notice::Rules gate ${rules_verdict}; decision record ${dr_verdict}"

if [ "$rules_verdict" != PASS ]; then
  echo "::error::Rules gate verdict is ${rules_verdict}" >&2
  exit 1
fi
