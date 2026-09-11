#!/usr/bin/env bash
#
# Judgement candidates for the `code-review-ci` skill.
#
# Some rules in .claude/rules/ cannot be settled by a regex but are still
# clear-cut: a competent reviewer reaches the same verdict every time. This
# script finds the *sites* where such a rule might be broken and prints them
# with enough context to decide. It never decides — the model does, against the
# binary test the skill states for each check id.
#
# The point of the pre-filter is cost. Adjudication is priced per candidate, so
# each extractor is tuned to propose few sites rather than every site a rule
# could touch: a change of 52k added lines yields a couple of dozen candidates,
# not a couple of thousand. Where a filter cannot get precision high enough for
# the verdict to be uncontroversial, the check is absent — see the skill.
#
# Usage: candidates.sh <base-ref> [head-ref]
# Output: `CANDIDATE<TAB>check-id<TAB>path:line<TAB>context` records, then a
#         `CANDIDATES` count block. Exit 0, or 2 on an unresolvable ref.

set -uo pipefail
export LC_ALL=C

if [ $# -lt 1 ]; then
  echo 'usage: candidates.sh <base-ref> [head-ref]' >&2
  exit 2
fi
BASE=$1
HEAD=${2:-HEAD}
for ref in "$BASE" "$HEAD"; do
  if ! git rev-parse --verify --quiet "$ref^{commit}" >/dev/null; then
    echo "candidates.sh: cannot resolve ref '$ref'" >&2
    exit 2
  fi
done

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# Added lines as `path<TAB>line<TAB>content`, so a tab-separated pipeline can
# carry the content without re-splitting on colons inside code.
git diff -U0 "$BASE...$HEAD" | awk '
  /^\+\+\+ b\// { p = substr($0, 7); next }
  /^@@/         { match($0, /\+[0-9]+/); ln = substr($0, RSTART+1, RLENGTH-1) + 0; next }
  /^\+/         { print p "\t" ln "\t" substr($0, 2); ln++; next }
  /^ /          { ln++ }
' > "$WORK/added"

# Per-check cap. A change that trips one extractor hundreds of times is not a
# change a per-site gate should adjudicate; the overflow is reported as a count
# so the reviewer knows the list was truncated.
CAP=${CANDIDATE_CAP:-25}

candidate() { printf 'CANDIDATE\t%s\t%s\t%s\n' "$1" "$2" "$3"; }

# Emits at most $CAP candidates from `path<TAB>line<TAB>context` records on
# stdin, and records how many were dropped.
emit() {
  local id=$1 seen=0
  while IFS=$'\t' read -r path line context; do
    seen=$((seen + 1))
    if [ "$seen" -le "$CAP" ]; then
      candidate "$id" "$path:$line" "$context"
    fi
  done < <(cat)
  if [ "$seen" -gt "$CAP" ]; then
    printf 'TRUNCATED\t%s\t%s of %s shown\n' "$id" "$CAP" "$seen"
  fi
  printf '%s\t%s\n' "$id" "$seen" >> "$WORK/counts"
}

# --------------------------------------------------- restating comments

## A comment that restates its code shares most of its vocabulary with the
## identifiers on the line below. That overlap is what makes a candidate;
## whether the comment nonetheless carries a reason is the model's call.
## COMMENTS.md: "a comment that restates self-evident code adds reading cost".
awk -F'\t' 'BEGIN { OFS = "\t" }
  { path[NR] = $1; line[NR] = $2; txt[NR] = $3 }
  END {
    for (i = 1; i < NR; i++) {
      if (path[i] !~ /^src\//) continue
      if (txt[i] !~ /^[[:space:]]*\/\/ /) continue
      # A `// CAST:` comment is mandated by TYPES.md for the cast below it.
      if (txt[i] ~ /\/\/[[:space:]]*CAST:/) continue
      if (path[i + 1] != path[i] || line[i + 1] != line[i] + 1) continue
      # Only a comment annotating code, not the first line of a comment block.
      if (txt[i + 1] ~ /^[[:space:]]*(\/\/|\*)/) continue
      c = txt[i]; sub(/^[[:space:]]*\/\/[[:space:]]*/, "", c)
      print path[i], line[i], c, txt[i + 1]
    }
  }' "$WORK/added" \
  | python3 -c '
import re, sys

STOP = set("the a an of to for is are this that it its and or in on with as by be we".split())


def words(text):
    out = []
    for token in re.sub(r"[^A-Za-z]+", " ", text).split():
        out += [w.lower() for w in re.findall(r"[A-Z]+(?![a-z])|[A-Z][a-z]*|[a-z]+", token)]
    return out


for row in sys.stdin:
    try:
        path, line, comment, code = row.rstrip("\n").split("\t")
    except ValueError:
        continue
    prose = [w for w in words(comment) if w not in STOP and len(w) > 2]
    if not prose:
        continue
    identifiers = set(words(code))
    shared = sum(1 for w in prose if w in identifiers)
    # Half the comment already appearing in the code is the signal. Tuned on
    # this repo: at this threshold a clean change proposes nothing, so the
    # check costs nothing until a comment actually drifts towards restatement.
    if shared / len(prose) >= 0.5:
        print(f"{path}\t{line}\tcomment: {comment.strip()}  ||  code: {code.strip()}")
' 2>/dev/null \
  | emit restating-comment

# ------------------------------------------------------------- log levels

## LOGGING.md maps each level to a kind of call site. A trace whose message
## opens with `Class.method();` is a method entry by construction, which is
## what the table prescribes, so it is filtered out whatever context it also
## passes; what is left is the calls where the level was a choice.
grep -E "^src/" "$WORK/added" \
  | grep -E "logger\.(trace|debug|info|warn|error)\(" \
  | grep -vE "logger\.trace\('[A-Za-z0-9_]+\.[A-Za-z0-9_]+\(\);'" \
  | while IFS=$'\t' read -r path line content; do
      # The enclosing declaration gives the model what the site is doing.
      enclosing=$(git show "$HEAD:$path" 2>/dev/null \
        | head -n "$line" \
        | grep -nE '^[[:space:]]*(export )?(private |public |protected )?(async )?[A-Za-z_][A-Za-z0-9_]*(\(| = )' \
        | tail -1 | cut -d: -f2- | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
      printf '%s\t%s\t%s  ||  in: %s\n' "$path" "$line" \
        "$(printf '%s' "$content" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')" \
        "${enclosing:-<unknown>}"
    done \
  | emit log-level

# ------------------------------------------------------------ React hooks

## CLAUDE.md fixes the names: a hook's parameter object is `{HookName}Options`
## and a structured return is `{HookNameWithoutUse}Handle`, both exported from
## the entry-point index.ts. Whether a return counts as structured is the
## model's call, so every added hook declaration is a candidate.
grep -E "^src/" "$WORK/added" \
  | grep -E "export (const|function) use[A-Z]" \
  | while IFS=$'\t' read -r path line content; do
      signature=$(git show "$HEAD:$path" 2>/dev/null | sed -n "${line},$((line + 12))p" | tr '\n' ' ' | tr -s ' ')
      printf '%s\t%s\t%s\n' "$path" "$line" "${signature:0:400}"
    done \
  | emit hook-naming

# ------------------------------------------------------------ error codes

## ERRORS.md: keep the set small, group errors that share a recovery action,
## and add a code only where distinguishing it has genuine value. Whether an
## existing code already covers a new one is the model's call.
grep -E "^src/errors\.ts" "$WORK/added" \
  | grep -E "= [0-9]{5,6},[[:space:]]*$" \
  | while IFS=$'\t' read -r path line content; do
      printf '%s\t%s\t%s\n' "$path" "$line" \
        "$(printf '%s' "$content" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    done \
  | emit new-error-code

# ------------------------------------------------- backward-looking prose

## COMMENTS.md forbids anchoring a comment to how the code used to be. The
## unambiguous markers ("previously", "formerly", "now-removed") are a
## mechanical check in checks.sh. These three are not: each reads at least as
## often as present-tense prose — "the codec used to project messages" means
## employed-in-order-to, "the done entry replaces the executing one" and
## "Preflight no longer sets cursor: pointer" describe current behaviour. The
## site is proposable; only the reading settles it.
grep -vE '^\.claude/' "$WORK/added" \
  | grep -E $'\t'"[[:space:]]*(//|\*|/\*)|\b(it|test|describe)\(" \
  | grep -iE 'used to [a-z]+|no longer|replaces the' \
  | while IFS=$'\t' read -r path line content; do
      printf '%s\t%s\t%s\n' "$path" "$line" \
        "$(printf '%s' "$content" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    done \
  | emit backward-looking-prose

# ------------------------------------------------------------------ counts

echo 'CANDIDATES'
if [ -s "$WORK/counts" ]; then
  sort "$WORK/counts"
else
  echo 'none'
fi
