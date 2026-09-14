#!/usr/bin/env bash
#
# Mechanical PR checks for the `code-review-ci` skill.
#
# Every check is a regex or a presence test over the lines a change ADDS, with a
# fixed severity. Nothing here forms a judgement about design, naming,
# correctness, or simplicity — those belong to human review and to the local
# `/code-review-all` skill.
#
# Two exclusions keep the run cheap and quiet:
#
#   * Anything `pnpm run lint`, `pnpm run typecheck`, `pnpm run format:check` or
#     `pnpm run check:error-codes` already enforces is absent. CI runs those, so
#     `any`, `!`, unused vars, `.js` import extensions, private-field naming,
#     import order and error-code enum values need no check here.
#   * A pattern that cannot mechanically separate a violation from a legitimate
#     use is absent even where a rule covers it. A gate that cries wolf gets
#     ignored. Each such omission is noted at its check.
#
# Usage: checks.sh <base-ref> [head-ref]
# Output: one `SEVERITY<TAB>check-id<TAB>path:line<TAB>detail` record per
#         finding, then a `SUMMARY` block. Exit status is always 0 — the caller
#         decides the verdict from the records.

set -uo pipefail

# Character classes and sort order must not depend on the runner's locale:
# `[A-Z]` interleaves cases under most collations, so a lowercase string would
# match an uppercase-first test.
export LC_ALL=C

if [ $# -lt 1 ]; then
  echo 'usage: checks.sh <base-ref> [head-ref]' >&2
  exit 2
fi
BASE=$1
HEAD=${2:-HEAD}

# A ref the runner cannot resolve would otherwise yield an empty diff and a
# clean pass, which is the worst way for a gate to fail.
for ref in "$BASE" "$HEAD"; do
  if ! git rev-parse --verify --quiet "$ref^{commit}" >/dev/null; then
    echo "checks.sh: cannot resolve ref '$ref'" >&2
    exit 2
  fi
done

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

DIFF_RANGE="$BASE...$HEAD"

# ---------------------------------------------------------------- diff corpora

# Every file the change touches, with its status letter.
git diff --name-status "$DIFF_RANGE" > "$WORK/names" 2>/dev/null

# Added lines as `path:line:content`. Line numbers are post-change, so they
# address the head revision and are clickable in a review.
git diff -U0 "$DIFF_RANGE" | awk '
  /^\+\+\+ b\// { path = substr($0, 7); next }
  /^@@/         { match($0, /\+[0-9]+/); ln = substr($0, RSTART+1, RLENGTH-1) + 0; next }
  /^\+/         { print path ":" ln ":" substr($0, 2); ln++; next }
  /^ /          { ln++ }
' > "$WORK/added"

# Removed lines, for the public-API notice.
git diff -U0 "$DIFF_RANGE" | awk '
  /^--- a\// { path = substr($0, 7); next }
  /^-/       { if ($0 !~ /^--- /) print path ":" substr($0, 2) }
' > "$WORK/removed"

# Added lines with every test file dropped. Test fixtures legitimately throw
# plain Errors and suppress lint rules, so holding them to the source rules is
# pure noise.
NOT_TEST='(__tests__|__mocks__|\.test\.(ts|tsx)|(^|/)tests?/)'
grep -vE "^[^:]*$NOT_TEST" "$WORK/added" > "$WORK/added-nontest" || true

# The published SDK. Most rules bind here and nowhere else.
grep -E '^src/' "$WORK/added-nontest" > "$WORK/added-sdk" || true

# ------------------------------------------------------------------- reporting

finding() { printf '%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4"; }

# The `path:line` of the first added line containing a literal. Checks that
# match on an extracted string (a message, a log line) use this to anchor
# their finding; grepping the working tree instead would miss whenever the
# head revision is not the checkout.
site_of() {
  grep -F -- "$1" "$WORK/added" 2>/dev/null | head -1 | cut -d: -f1,2
}

# Reports each `path:line:content` record on stdin under one check id.
# Deduplicates against the base revision: a line whose exact text already
# existed in that file before the change is not this change's finding. Without
# this, renaming a symbol re-adds every line around it and a pre-existing wart
# is blamed on the rename.
report_new_lines() {
  local severity=$1 id=$2 detail=$3
  local record path line content trimmed
  while IFS= read -r record; do
    path=${record%%:*}
    line=${record#*:}; line=${line%%:*}
    content=${record#*:}; content=${content#*:}
    trimmed=$(printf '%s' "$content" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
    [ -z "$trimmed" ] && continue
    if git show "$BASE:$path" 2>/dev/null | grep -qF -- "$trimmed"; then
      continue
    fi
    finding "$severity" "$id" "$path:$line" "$detail: $trimmed"
  done
}

# ------------------------------------------------------------------ the checks

## 1. Submodule ref bumps (CLAUDE.md, Workflow rules).
## The parent repo records a submodule as one gitlink path, so this fires on the
## ref moving; an edit inside a submodule working tree is invisible here, and
## invisible to CI too, which checks submodules out at their pinned ref.
## Reported as a fact: CLAUDE.md permits a bump to a commit that already exists
## upstream, and only a reviewer can confirm that it does.
awk '{print $2}' "$WORK/names" \
  | grep -E '^(ably-common|specification)$' \
  | while IFS= read -r path; do
      finding NOTICE submodule-bump "$path" \
        'submodule ref moved; CLAUDE.md allows this only towards a commit that already exists upstream, authored and reviewed in a real clone of that repository'
    done

## 2. Type and lint suppressions (.claude/rules/TYPES.md).
## A `@ts-*` comment is always a blocker: TYPES.md admits no form of it. An
## `eslint-disable` carrying a `-- <justification>` is reported as a notice,
## because the repo's own source uses that form and review has accepted it; a
## bare disable, with nothing said about why, stays a blocker.
grep -E '@ts-(ignore|expect-error|nocheck)' "$WORK/added-nontest" \
  | grep -E '^(src|examples|demo)/' \
  | report_new_lines BLOCKER suppression \
    'TypeScript suppression added; TYPES.md forbids @ts-ignore/@ts-expect-error/@ts-nocheck in source, example and demo code'

grep -E 'eslint-disable' "$WORK/added-nontest" \
  | grep -E '^(src|examples|demo)/' \
  | grep -vE ' -- [^[:space:]]' \
  | report_new_lines BLOCKER suppression \
    'eslint-disable with no `-- <justification>`; TYPES.md forbids disable directives in source, example and demo code'

grep -E 'eslint-disable' "$WORK/added-nontest" \
  | grep -E '^(src|examples|demo)/' \
  | grep -E ' -- [^[:space:]]' \
  | report_new_lines NOTICE justified-suppression \
    'justified eslint-disable added; TYPES.md forbids disable directives outright, so confirm the justification holds'

## 3. Ably.ErrorInfo is the sole error type (.claude/rules/ERRORS.md).
grep -E 'new Error\(' "$WORK/added-sdk" \
  | report_new_lines BLOCKER plain-error \
    'plain Error constructed in src/; ERRORS.md makes Ably.ErrorInfo the sole error type'

## 4. Every `as` cast carries a comment explaining why (.claude/rules/TYPES.md).
## The comment may sit on the cast's own line or the line directly above it, so
## each candidate is re-read from the head revision to see its neighbour.
## `Foo as Bar` inside a multi-line import or export block is an alias, not a
## cast, so a line of that exact shape is skipped. The check binds to src/
## only: in a demo's JSX, ` as Word` is as often prose in a text node
## ("appear here as JSON.") as a cast, and demos are outside eslint's scope.
cast_candidates() {
  grep -vE ':[0-9]+:[[:space:]]*(import|export)[[:space:]]' \
    | grep -vE ':[0-9]+:[[:space:]]*(type[[:space:]]+)?[A-Za-z0-9_]+ as [A-Za-z0-9_]+,?[[:space:]]*$' \
    | grep -E ' as ([A-Z][A-Za-z0-9_.]*|unknown|string|number|boolean)\b'
}

# Whether an explaining comment covers the cast on the given line. The comment
# may share the line, or sit above it across a wrapped expression. Walking up,
# the first significant line decides: a comment covers this cast, while
# another cast or a closed statement means any comment above it belongs there
# instead.
cast_is_explained() {
  local path=$1 line=$2 body probe text
  body=$(git show "$HEAD:$path" 2>/dev/null) || return 1
  text=$(printf '%s\n' "$body" | sed -n "${line}p")
  printf '%s' "$text" | grep -qE '//|/\*' && return 0
  probe=$((line - 1))
  while [ "$probe" -ge 1 ] && [ "$probe" -ge $((line - 5)) ]; do
    text=$(printf '%s\n' "$body" | sed -n "${probe}p")
    if printf '%s' "$text" | grep -qE '^[[:space:]]*(//|/\*|\*)'; then
      return 0
    fi
    if printf '%s' "$text" | grep -qE ' as[[:space:]]*$| as [A-Za-z(]'; then
      return 1
    fi
    # A line closing a statement ends the search: a comment above it introduces
    # that statement, not this cast.
    if printf '%s' "$text" | grep -qE '[;}][[:space:]]*$'; then
      return 1
    fi
    probe=$((probe - 1))
  done
  return 1
}

report_casts() {
  local severity=$1
  local record path line content trimmed
  while IFS= read -r record; do
    path=${record%%:*}
    line=${record#*:}; line=${line%%:*}
    content=${record#*:}; content=${content#*:}
    cast_is_explained "$path" "$line" && continue
    trimmed=$(printf '%s' "$content" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
    finding "$severity" uncommented-cast "$path:$line" \
      "\`as\` cast with no explaining comment; TYPES.md requires one: $trimmed"
  done
}

cast_candidates < "$WORK/added-sdk" | report_casts BLOCKER

## 5. No new spec-point references (CLAUDE.md: the specification is not maintained).
## Scoped to the code trees. Outside them the pattern appears in prose about the
## rule rather than as a reference — this script's own text among it.
grep -E '^(src|test|examples|demo)/' "$WORK/added" \
  | grep -E '// Spec: AIT-' \
  | report_new_lines BLOCKER new-spec-ref \
    'new `// Spec: AIT-*` reference; CLAUDE.md states the specification is stale and forbids adding new spec references'

## 6. ErrorInfo message format (.claude/rules/ERRORS.md).
## Only a literal passed straight to the constructor is judged. A message built
## from a variable or a call carries no literal, and the rule cannot speak to it.
git diff -U0 "$DIFF_RANGE" -- 'src/*' \
  | grep -E '^\+' \
  | grep -oE "new Ably\.ErrorInfo\([\`']([^\`']*)" \
  | sed -E "s/new Ably\.ErrorInfo\([\`']//" \
  | sort -u \
  | while IFS= read -r msg; do
      [ -z "$msg" ] && continue
      git grep -qF -- "$msg" "$BASE" -- 'src/*' 2>/dev/null && continue
      site=$(site_of "$msg")
      case $msg in
        'unable to '*';'*) : ;;
        [[:upper:]]*)
          finding MAJOR error-message-format "${site:-src/}" \
            "ErrorInfo message starts with a capital; ERRORS.md requires lowercase: $msg" ;;
        'cannot '*|'can not '*|'failed to '*|'could not '*)
          finding MAJOR error-message-format "${site:-src/}" \
            "ERRORS.md forbids this message prefix; the pattern is \"unable to <operation>; <reason>\": $msg" ;;
        'unable to '*)
          finding MAJOR error-message-format "${site:-src/}" \
            "ErrorInfo message has no \"; <reason>\" clause; ERRORS.md pattern is \"unable to <operation>; <reason>\": $msg" ;;
        *)
          finding MAJOR error-message-format "${site:-src/}" \
            "ErrorInfo message does not open with \"unable to \"; ERRORS.md pattern is \"unable to <operation>; <reason>\": $msg" ;;
      esac
    done

## 7. ErrorInfo statusCode matches its code (.claude/rules/ERRORS.md).
## For codes 10000-59999 the HTTP statusCode is the code's first three digits.
## Custom 104xxx codes are exempt: ERRORS.md has those pick a status by hand.
grep -oE 'ErrorInfo\([^)]*,[[:space:]]*[0-9]{5},[[:space:]]*[0-9]{3}' "$WORK/added-sdk" \
  | grep -oE '[0-9]{5},[[:space:]]*[0-9]{3}$' \
  | tr -d ' ' \
  | sort -u \
  | while IFS=, read -r code status; do
      [ "$code" -ge 10000 ] && [ "$code" -le 59999 ] || continue
      expected=${code:0:3}
      [ "$status" = "$expected" ] && continue
      site=$(grep -E "${code},[[:space:]]*${status}" "$WORK/added-sdk" 2>/dev/null | head -1 | cut -d: -f1,2)
      finding MAJOR error-status-code "${site:-src/}" \
        "code $code should carry statusCode $expected, not $status (ERRORS.md, StatusCode derivation)"
    done

## 8. Log message format `ClassName.methodName(); <description>` (.claude/rules/LOGGING.md).
grep -oE "logger\.(trace|debug|info|warn|error)\([\`'][^\`']*" "$WORK/added-sdk" \
  | sed -E "s/logger\.(trace|debug|info|warn|error)\([\`']//" \
  | sort -u \
  | while IFS= read -r msg; do
      [ -z "$msg" ] && continue
      printf '%s' "$msg" | grep -qE '^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)?\(\);' && continue
      git grep -qF -- "$msg" "$BASE" -- 'src/*' 2>/dev/null && continue
      site=$(site_of "$msg")
      finding MAJOR log-message-format "${site:-src/}" \
        "log message does not match \"ClassName.methodName(); <description>\" (LOGGING.md): $msg"
    done

## 9. Log data belongs in the context object, not the message (.claude/rules/LOGGING.md).
grep -E "logger\.(trace|debug|info|warn|error)\(\`[^\`]*\\\$\{" "$WORK/added-sdk" \
  | report_new_lines MAJOR log-interpolation \
    'log message interpolates a value; LOGGING.md requires structured data in the context object instead'

## 10. Channel state names are UPPERCASE and unquoted in prose (CLAUDE.md,
## Additional conventions). Prose only: comments, JSDoc, markdown and test
## descriptions. SUSPENDED and FAILED are omitted from the word list: `suspended`
## and `failed` also name run and tool-call statuses, and nothing mechanical
## separates that prose from a channel state.
grep -E ':[0-9]+:[[:space:]]*(//|\*|/\*)|\.md:|\b(it|test|describe)\(' "$WORK/added" \
  | grep -vE '^\.claude/' \
  | grep -E "[\`'\"](initialized|attaching|attached|detaching|detached|INITIALIZED|ATTACHING|ATTACHED|DETACHING|DETACHED)[\`'\"]" \
  | report_new_lines MINOR channel-state-case \
    'channel state name in prose is quoted or backticked; CLAUDE.md writes them bare and UPPERCASE'

## 11. Comments anchor to the present, not to the prior design (.claude/rules/COMMENTS.md).
## The word list holds only phrases that can mean nothing but "how it used to
## be". "no longer" and "replaces" are deliberately absent: both read naturally
## as present-tense descriptions of runtime behaviour ("the done entry replaces
## the executing one", "the run is no longer this workflow's") and of a
## dependency's current state, so matching them buries the real hits.
grep -E ':[0-9]+:[[:space:]]*(//|\*|/\*)|\b(it|test|describe)\(' "$WORK/added" \
  | grep -vE '^\.claude/' \
  | grep -iE '(previously|used to be|used to have|now-removed|now removed|formerly|pre-PR|before this change|instead of the old|in the old )' \
  | report_new_lines MINOR backward-looking-comment \
    'comment or test description anchors to how the code used to be; COMMENTS.md requires present-tense description of current behaviour'

## 12. Source changes ship with tests (CLAUDE.md, Workflow rules).
## `src/version.ts` is excluded: it holds only the VERSION constant that
## `/release` bumps in lockstep with package.json, so a release PR touches it
## with nothing to test, every time.
changed_src=$(awk '{print $2}' "$WORK/names" | grep -E '^src/.*\.tsx?$' | grep -vE '^src/version\.ts$')
if [ -n "$changed_src" ]; then
  if ! awk '{print $2}' "$WORK/names" | grep -qE '^test/'; then
    finding BLOCKER missing-tests 'test/' \
      "$(printf '%s\n' "$changed_src" | wc -l | tr -d ' ') file(s) under src/ changed and no file under test/ did; CLAUDE.md requires test coverage with every change (only purely cosmetic changes are exempt)"
  fi
fi

## 13. Public API removals, reported as a fact for the reviewer to confirm.
## Only what an entry-point index.ts re-exports is public API (ABSTRACTIONS.md).
## An export that merely moved to a different entry point is not a removal, so
## the identifiers are compared against every index.ts at the head revision.
# The entry points, from package.json's `exports` map: each subpath's `types`
# points at dist/<subpath>/index.d.ts, whose source is src/<subpath>/index.ts.
git show "$HEAD:package.json" 2>/dev/null \
  | node -e '
      let raw = "";
      process.stdin.on("data", (c) => (raw += c));
      process.stdin.on("end", () => {
        const map = JSON.parse(raw).exports ?? {};
        for (const sub of Object.keys(map)) {
          const dir = sub.replace(/^\.\/?/, "");
          console.log(dir ? `src/${dir}/index.ts` : "src/index.ts");
        }
      });
    ' 2>/dev/null | sort -u > "$WORK/entry-points"

# Fall back to every index.ts if package.json could not be parsed, so the check
# degrades to over-reporting rather than silently passing.
[ -s "$WORK/entry-points" ] || git ls-tree -r --name-only "$HEAD" -- src 2>/dev/null \
  | grep -E 'index\.ts$' > "$WORK/entry-points"

while IFS= read -r idx; do git show "$HEAD:$idx" 2>/dev/null; done < "$WORK/entry-points" \
  > "$WORK/head-exports"

# One record per entry point, listing every identifier it no longer exports —
# an API restructure drops many names at once, and a line each buries the fact
# in its own repetition.
grep -E "^($(paste -sd'|' "$WORK/entry-points" | sed 's/\./\\./g')):" "$WORK/removed" \
  | while IFS= read -r record; do
      path=${record%%:*}
      content=${record#*:}
      # A bare `Identifier,` line is one member of a multi-line export block.
      case $content in
        *'export'*|*'{'*) ;;
        *) content="{ $(printf '%s' "$content" | sed -E 's/,[[:space:]]*$//') }" ;;
      esac
      # The identifiers inside the braces of `export { a, type B } from '...'`,
      # or the single identifier on one line of a multi-line `export type { }`.
      printf '%s' "$content" | sed -nE 's/.*\{([^}]*)\}.*/\1/p' | tr ',' '\n' \
        | sed -E 's/^[[:space:]]*(type[[:space:]]+)?//; s/[[:space:]]+as[[:space:]]+.*//; s/[[:space:]]*$//' \
        | grep -E '^[A-Za-z_][A-Za-z0-9_]*$' \
        | while IFS= read -r name; do
            grep -qE "(\{|,|[[:space:]])(type[[:space:]]+)?${name}([[:space:],}]|$)" "$WORK/head-exports" \
              || printf '%s\t%s\n' "$path" "$name"
          done
    done \
  | sort -u > "$WORK/api-gone"

cut -f1 "$WORK/api-gone" | sort -u | while IFS= read -r path; do
  names=$(grep -F "$path	" "$WORK/api-gone" | cut -f2 | sort -u | paste -sd' ' -)
  count=$(printf '%s\n' $names | wc -l | tr -d ' ')
  finding NOTICE public-api-change "$path" \
    "$count identifier(s) no longer exported from any entry point, so this is a public API change: $names"
done

## 14. The generic layer knows nothing about any codec (.claude/rules/ABSTRACTIONS.md).
## ABSTRACTIONS.md calls this the most important invariant in the codebase. A
## generic-layer file that imports a codec directory, or names a codec's wire
## type, has broken it.
grep -E '^src/(core|react)/' "$WORK/added" \
  | grep -E "from '(\.\./)*(vercel|openai|temporal)/|from '@?ai\b|from 'openai'" \
  | report_new_lines BLOCKER layer-violation \
    'the generic layer imports from a codec; ABSTRACTIONS.md requires src/core and src/react to know nothing about any specific codec'

# --------------------------------------------------------------------- summary

echo 'SUMMARY'
printf 'base\t%s\n' "$(git rev-parse --short "$BASE" 2>/dev/null || echo "$BASE")"
printf 'head\t%s\n' "$(git rev-parse --short "$HEAD" 2>/dev/null || echo "$HEAD")"
printf 'files-changed\t%s\n' "$(wc -l < "$WORK/names" | tr -d ' ')"
printf 'added-lines\t%s\n' "$(wc -l < "$WORK/added" | tr -d ' ')"
