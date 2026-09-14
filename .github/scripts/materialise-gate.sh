#!/usr/bin/env bash
# Extract the review gate from a named ref into ./.gate/.
#
# claude-code-action replaces the whole `.claude/` tree with the PR base
# branch's version before Claude starts, and deletes anything the base does not
# have, because the CLI reads settings and hooks from there and a PR head is
# untrusted. The gate lives under `.claude/skills/`, so it is not in the
# checkout by the time the model could run it. Extract it from git instead,
# where the action's rewrite cannot reach.
#
# The ref is the PR head, so a change to a check is gated by its own version —
# which is the only way to test one. Pass `origin/<base>` instead if the merged
# version should always be the one that gates.
#
# Usage: materialise-gate.sh <ref>

set -euo pipefail

ref=$1

GATES=(
  .claude/skills/code-review-ci
  .claude/skills/dr-required
)

REQUIRED=(
  .claude/skills/code-review-ci/SKILL.md
  .claude/skills/code-review-ci/checks.sh
  .claude/skills/code-review-ci/candidates.sh
  .claude/skills/dr-required/SKILL.md
  .claude/skills/dr-required/signals.sh
)

rm -rf .gate
mkdir -p .gate/report

for gate in "${GATES[@]}"; do
  if ! git archive "$ref" "$gate" 2>/dev/null | tar -x -C .gate; then
    echo "::error::${gate} is not present at ${ref}. The gate cannot review a" \
         "revision that does not carry it — merge it first, or point this step" \
         "at a ref that has it." >&2
    exit 1
  fi
done

missing=0
for path in "${REQUIRED[@]}"; do
  if [ ! -s ".gate/$path" ]; then
    echo "::error::${path} is missing or empty at ${ref}" >&2
    missing=1
  fi
done
[ "$missing" -eq 0 ] || exit 1

echo "::notice::Gate materialised from ${ref} into .gate/"
