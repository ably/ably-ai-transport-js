#!/usr/bin/env bash
#
# Decision-record signals for the `dr-required` skill.
#
# A DR records a choice that outlives the pull request making it. This script
# does not judge that — it finds the places where such a choice would have to
# leave a mark, and hands them to the model with the pull request's own
# description. Judging is Step 3 of SKILL.md.
#
# The bias here is the opposite of `code-review-ci/checks.sh`. That script is
# precision-first: a pattern that cannot separate a violation from legitimate
# use is left out. This one is recall-first — a signal is a place to look, and
# the model is the filter. The cost of a spurious signal is a few hundred
# tokens; the cost of a missing one is a decision that never got recorded.
#
# Two free short-circuits keep almost every run at zero model tokens: a run
# whose description already links a DR, and a run where nothing fired, are both
# settled before the model reads anything.
#
# Usage: signals.sh <base-ref> [head-ref]
# Env:
#   PR_NUMBER  the pull request to read the description from. Defaults to the
#              open PR for the checked-out branch.
#   BODY_FILE  read the description from this file instead of calling `gh`,
#              for testing and for runners without a GitHub token.
# Output: `TITLE`, `DRLINK`, `OVERRIDE` and `SIGNAL` records, then the
#         description between `BODY-BEGIN`/`BODY-END`, then a `SUMMARY` block.
#         Exit 0 whatever it finds; exit 2 when it could not read a ref or the
#         description, which is never a pass.

set -uo pipefail

# `[A-Z]` interleaves cases under most collations, so a lowercase string would
# match an uppercase-first test.
export LC_ALL=C

if [ $# -lt 1 ]; then
  echo 'usage: signals.sh <base-ref> [head-ref]' >&2
  exit 2
fi
BASE=$1
HEAD=${2:-HEAD}

for ref in "$BASE" "$HEAD"; do
  if ! git rev-parse --verify --quiet "$ref^{commit}" >/dev/null; then
    echo "signals.sh: cannot resolve ref '$ref'" >&2
    exit 2
  fi
done

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

DIFF_RANGE="$BASE...$HEAD"
BODY_CAP=8000
LARGE_SRC_LINES=500

# Records are collected rather than printed as they are found, so the summary
# can count them and the description can be printed last.
emit() { printf 'SIGNAL\t%s\t%s\t%s\n' "$1" "$2" "$3" >> "$WORK/signals"; }
: > "$WORK/signals"
: > "$WORK/markers"

# `git diff` with each changed line tagged by its side and its line number on
# that side, so a removal cites where it was and an addition where it is.
sided() {
  git diff -U0 "$DIFF_RANGE" -- "$@" | awk '
    /^@@/ {
      match($0, /-[0-9]+/); o = substr($0, RSTART+1, RLENGTH-1) + 0
      match($0, /\+[0-9]+/); n = substr($0, RSTART+1, RLENGTH-1) + 0
      next
    }
    /^(---|\+\+\+)/ { next }
    /^-/  { print "-\t" o "\t" substr($0, 2); o++; next }
    /^\+/ { print "+\t" n "\t" substr($0, 2); n++; next }
    /^ /  { o++; n++ }
  '
}

# The named object in package.json at one revision, one `key value` per line.
# Relies on the two-space indentation prettier enforces on this file.
pkg_block() {
  git show "$1:package.json" 2>/dev/null | awk -v want="$2" '
    $0 ~ "^  \"" want "\": \\{" { inb = 1; next }
    inb && /^  \}/              { inb = 0; next }
    inb                         { gsub(/^[ \t]+|[ \t]+$/, ""); gsub(/,$/, ""); print }
  '
}

git diff --name-status "$DIFF_RANGE" > "$WORK/names" 2>/dev/null

# ------------------------------------------------------------- the description

if [ -n "${BODY_FILE:-}" ]; then
  if [ ! -f "$BODY_FILE" ]; then
    echo "signals.sh: BODY_FILE '$BODY_FILE' does not exist" >&2
    exit 2
  fi
  cp "$BODY_FILE" "$WORK/body"
  TITLE=$(head -1 "$WORK/body")
else
  if ! command -v gh >/dev/null 2>&1; then
    echo 'signals.sh: gh is not installed and BODY_FILE is unset' >&2
    exit 2
  fi
  # A gate on the description cannot pass a change whose description it could
  # not read.
  if ! gh pr view ${PR_NUMBER:+"$PR_NUMBER"} --json title,body \
    --jq '.title, "", (.body // "")' > "$WORK/pr" 2>"$WORK/gh-err"; then
    echo "signals.sh: cannot read the pull request: $(tr '\n' ' ' < "$WORK/gh-err")" >&2
    exit 2
  fi
  TITLE=$(head -1 "$WORK/pr")
  tail -n +3 "$WORK/pr" > "$WORK/body"
fi

printf 'TITLE\t%s\n' "$TITLE"

# ------------------------------------------------------ short-circuit markers

# An identifier is enough. Whether the DR itself is any good is the `dr-check`
# skill's question, not this gate's.
{
  grep -oiE 'AITDR-[0-9]+' "$WORK/body" | sort -u
  grep -oE 'https://[a-z.]*atlassian\.net/wiki/[^ )>]*' "$WORK/body" | sort -u
} | while read -r id; do
  printf 'DRLINK\t%s\n' "$id" >> "$WORK/markers"
done

# The escape hatch. A judgement gate without one gets switched off the first
# time it is wrong, so the author may overrule it in the description — on the
# record, with a reason, where a reviewer sees it.
grep -iE '^[[:space:]]*>?[[:space:]]*No DR needed:[[:space:]]*[^[:space:]]' "$WORK/body" \
  | sed 's/^[[:space:]]*>*[[:space:]]*//' | while read -r line; do
  printf 'OVERRIDE\t%s\n' "$line" >> "$WORK/markers"
done

# ------------------------------------------------------------------- signals

## The wire is the most expensive thing in the repo to change twice: a header
## or event name is a compatibility contract with every deployed client.
sided src/constants.ts | grep -E $'\t'"(export const (HEADER_|EVENT_)|  '?[a-z-]+'?:)" \
  | grep -E '^[-+]' | head -40 | while IFS=$'\t' read -r side line text; do
  case $side in
  -) emit wire-format "src/constants.ts:$line" "removed: $(echo "$text" | sed 's/^[[:space:]]*//')" ;;
  +) emit wire-format "src/constants.ts:$line" "added: $(echo "$text" | sed 's/^[[:space:]]*//')" ;;
  esac
done

## A new entry point is a new public surface with its own peer dependencies;
## a removed one is a break. Either is settled once and lived with.
diff <(pkg_block "$BASE" exports) <(pkg_block "$HEAD" exports) 2>/dev/null \
  | grep -E '^[<>][[:space:]]*"\./|^[<>][[:space:]]*"\.":' | while read -r line; do
  case $line in
  '<'*) emit entry-point package.json "removed: ${line#< }" ;;
  '>'*) emit entry-point package.json "added: ${line#> }" ;;
  esac
done

## A dependency is a commitment the whole package inherits, and a peer range is
## a compatibility promise.
for block in dependencies peerDependencies; do
  diff <(pkg_block "$BASE" "$block") <(pkg_block "$HEAD" "$block") 2>/dev/null \
    | grep -E '^[<>]' | while read -r line; do
    case $line in
    '<'*) emit dependency package.json "$block removed: ${line#< }" ;;
    '>'*) emit dependency package.json "$block added: ${line#> }" ;;
    esac
  done
done

## Only what an `index.ts` re-exports is public API (ABSTRACTIONS.md). Adding to
## it is cheap; taking something out of it is a break someone downstream pays
## for, so removals are the signal.
awk '$1 ~ /^[MDR]/ { print $2 }' "$WORK/names" | grep -E '(^|/)index\.ts$' | grep '^src/' \
  | while read -r path; do
  sided "$path" | awk -F'\t' '$1 == "-" && $3 ~ /^[[:space:]]*export/ { print $2 "\t" $3 }' \
    | head -10 | while IFS=$'\t' read -r line text; do
    emit public-removal "$path:$line" "removed from the public surface: $(echo "$text" | sed 's/^[[:space:]]*//')"
  done
done

## The public surface only ever grows on purpose. A new export is a promise
## that cannot be withdrawn without a breaking release, so it is reported as a
## count — the description says what was added, this says how much.
awk '$1 ~ /^[MA]/ { print $2 }' "$WORK/names" | grep -E '(^|/)index\.ts$' | grep '^src/' \
  | while read -r path; do
  n=$(sided "$path" | awk -F'\t' '$1 == "+" && $3 ~ /^[[:space:]]*export/' | wc -l | tr -d ' ')
  [ "$n" -gt 0 ] && emit public-addition "$path" "$n export statements added to the public surface"
done

## The error taxonomy is a small finite set a caller switches on (ERRORS.md).
## Which failures deserve to be distinguishable is a design choice, not a
## consequence of the code.
sided src/errors.ts | awk -F'\t' '$3 ~ /^[[:space:]]*[A-Za-z][A-Za-z0-9]* = [0-9]+,?$/ { print }' \
  | head -30 | while IFS=$'\t' read -r side line text; do
  case $side in
  -) emit error-taxonomy "src/errors.ts:$line" "removed: $(echo "$text" | sed 's/^[[:space:]]*//')" ;;
  +) emit error-taxonomy "src/errors.ts:$line" "added: $(echo "$text" | sed 's/^[[:space:]]*//')" ;;
  esac
done

## A new directory under src/ is a new home for something — a codec, a tier, a
## layer. Where a thing lives is an architectural choice.
awk '$1 ~ /^A/ { print $2 }' "$WORK/names" | grep '^src/.*/' | while read -r path; do
  dir=${path%/*}
  while [ "$dir" != "src" ] && [ -n "$dir" ]; do
    parent=${dir%/*}
    if [ -z "$(git ls-tree "$BASE" -- "$dir/" 2>/dev/null)" ]; then
      echo "$dir"
    fi
    [ "$parent" = "$dir" ] && break
    dir=$parent
  done
done | sort -u | while read -r dir; do
  emit new-module "$dir" "directory does not exist at the base revision"
done

## A rule file states a convention every future change is held to. Writing one
## down is the decision.
awk '$1 ~ /^[MAD]/ { print $2 }' "$WORK/names" \
  | grep -E '^(\.claude/rules/.*\.md|CLAUDE\.md)$' | while read -r path; do
  n=$(sided "$path" | grep -c '^[-+]')
  emit rule-change "$path" "$n changed lines in a file that states a convention"
done

## Removing a module removes whatever it did. Nothing else in the diff says
## that as plainly.
awk '$1 ~ /^D/ { print $2 }' "$WORK/names" | grep -E '^src/.*\.tsx?$' | grep -v '\.test\.' \
  | head -20 | while read -r path; do
  emit src-deletion "$path" "source module deleted"
done

## A `types` module is where a contract is written down, so a change to one is
## usually a change to what callers may rely on.
awk '$1 ~ /^[MADR]/ { print $2 }' "$WORK/names" \
  | grep -E '^src/.*(/types/[^/]+\.ts|/types\.ts)$' | while read -r path; do
  n=$(sided "$path" | grep -c '^[-+]')
  emit contract-change "$path" "$n changed lines in a contract module"
done

## The weakest signal, and last on purpose: size is not a decision. A change
## this large has usually made one somewhere, but which one is not in the
## numbers — read the description, not this record.
src_lines=$(git diff --numstat "$DIFF_RANGE" -- src/ 2>/dev/null \
  | grep -v '\.test\.' | awk '{ a += $1 } END { print a + 0 }')
if [ "$src_lines" -ge "$LARGE_SRC_LINES" ]; then
  emit large-src-change src/ "$src_lines added lines under src/ (threshold $LARGE_SRC_LINES)"
fi

# ---------------------------------------------------------------------- output

cat "$WORK/markers"
cat "$WORK/signals"

echo 'BODY-BEGIN'
head -c "$BODY_CAP" "$WORK/body"
body_bytes=$(wc -c < "$WORK/body" | tr -d ' ')
if [ "$body_bytes" -gt "$BODY_CAP" ]; then
  printf '\n[TRUNCATED at %s of %s bytes]\n' "$BODY_CAP" "$body_bytes"
fi
echo
echo 'BODY-END'

echo 'SUMMARY'
printf 'signals: %s\n' "$(grep -c '^SIGNAL' "$WORK/signals" || true)"
printf 'signal ids: %s\n' "$(cut -f2 "$WORK/signals" | sort -u | tr '\n' ' ')"
printf 'dr links: %s\n' "$(grep -c '^DRLINK' "$WORK/markers" || true)"
printf 'overrides: %s\n' "$(grep -c '^OVERRIDE' "$WORK/markers" || true)"
printf 'description bytes: %s\n' "$body_bytes"
printf 'range: %s\n' "$DIFF_RANGE"
