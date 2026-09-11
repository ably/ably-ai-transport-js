---
name: code-review-ci
description: Gate a change on the rules in .claude/rules/ and CLAUDE.md that have one right answer — the mechanical ones a regex settles, plus a short list that need reading but not opinion (log levels, hook naming, comments that only restate their code). Skips anything lint or typecheck already covers, and anything two reviewers would score differently. Cheap and repeatable enough to run on every PR in CI. Read-only; never edits code.
license: proprietary
metadata:
  team: engineering
  tags: code-review, ci, deterministic, gate
  mcp: false
allowed-tools: Bash(bash .claude/skills/code-review-ci/checks.sh *), Bash(bash .claude/skills/code-review-ci/candidates.sh *), Bash(git diff *), Bash(git show *), Bash(git rev-parse *), Bash(git merge-base *), Bash(gh pr view *), Grep, Read
argument-hint: '[base-ref]  (optional; defaults to the PR target branch, else main)'
---

# Code Review: CI gate

Report the change's violations of the rules that can be settled mechanically.
Every check lives in `checks.sh` beside this file as a regex or a presence test
over the lines the change **adds**. A second script, `candidates.sh`, finds
the sites where a rule that needs judgement might be broken; you adjudicate
those against the binary tests in Step 3.

This skill is a gate, not a review. `/code-review-all` is the review.

## Step 1 — resolve the base

- If `$ARGUMENTS` names a ref, use it verbatim.
- Otherwise take the current branch's open-PR target:
  `gh pr view --json baseRefName --jq .baseRefName`.
- If there is no PR, use `main`.

In CI the base is supplied explicitly; do not guess it there.

## Step 2 — run the checks

```bash
bash .claude/skills/code-review-ci/checks.sh <base> [head]
```

`head` defaults to the checkout. Pass it when the revision under review is
not checked out — reviewing a PR from another branch, or a merged one.

It prints one `SEVERITY<TAB>check-id<TAB>path:line<TAB>detail` record per
finding, then a `SUMMARY` block, and exits 0 whatever it finds — the verdict is
yours to draw in Step 4.

Exit 2 means it could not resolve a ref and ran no checks. Report that as
`VERDICT: ERROR` with the message; never read it as a pass. A shallow clone is
the usual cause, so CI must check out with full history.

Run it **once**. Do not re-run it with different arguments to look for more,
and do not reimplement its greps by hand.

Then collect the judgement candidates the same way:

```bash
bash .claude/skills/code-review-ci/candidates.sh <base> [head]
```

Each `CANDIDATE` record is a **site where a rule might be broken**, not a
finding. Step 3 decides. A `TRUNCATED` line means one extractor proposed more
sites than the cap; adjudicate what is listed and repeat the line in the
report so the reviewer knows the list was cut.

## Step 3 — adjudicate the candidates

`candidates.sh` proposes sites; you decide each one. Answer only the binary
test written below for that check id — not whether you would have written the
code differently. **Default to no violation.** These are rules a competent
reviewer applies the same way every time, and where a call is genuinely
arguable it is not one of them, so it is not a finding.

Do not open files unless a test tells you to; each record carries its context.

### `restating-comment` → MINOR

Does the comment state anything the annotated line does not already say?
Content the code cannot carry includes a reason, a constraint, a trade-off, a
consequence, a unit, a default, a wire-format mapping, or when a value is
absent. If it supplies any of those, **no violation**.

VIOLATION only when the comment is the code's own identifiers rephrased as
prose, adding nothing — `// Increment the retry count` above
`this._retryCount++`. Per COMMENTS.md, such a comment adds reading cost and
drifts, while a comment carrying intent earns its place.

### `backward-looking-prose` → MINOR

COMMENTS.md requires a comment to describe what the code does **today**. Each
candidate contains "used to", "no longer", or "replaces the" — phrases that
read as past-tense narration about half the time and as present-tense prose the
other half.

**No violation** when the phrase describes the present: "used to" meaning
_employed in order to_ ("the wire tier, used to create a per-stream encoder");
"no longer" or "replaces" describing runtime behaviour ("the done entry
replaces the executing one", "a cancel naming it no longer aborts") or a
dependency's current state ("Preflight no longer sets `cursor: pointer`").

VIOLATION only when the phrase narrates this codebase's own history — what the
code did before this change, what a prior design required. Per COMMENTS.md that
belongs in the commit message, not the source.

### `log-level` → MINOR

LOGGING.md maps levels to call sites:

| Level   | Site                                                             |
| ------- | ---------------------------------------------------------------- |
| `trace` | routine operations, method entry                                 |
| `debug` | a completed operation, a state change, a taken branch            |
| `info`  | an operationally significant but expected lifecycle event        |
| `warn`  | not an error yet, but something that could cascade               |
| `error` | an operation failed unrecoverably, or a developer callback threw |

VIOLATION only when the site clearly belongs at a different level. All of
these are **correct**: `error` where a provided callback threw; `warn` for a
full buffer, lost continuity, or a missing wire field; `info` for session or
run open and close; `debug` for a publish that completed or a branch taken.

### `hook-naming` → MAJOR

Per CLAUDE.md: a hook's parameter object must be a named `{HookName}Options`
interface, and a hook returning a **structured object** must have a
`{HookNameWithoutUse}Handle` type. A hook returning `void`, a primitive, an
array, a Map, or a library type needs no Handle. Both named types must be
exported from the entry point's `index.ts`.

Grep the relevant `index.ts` to confirm the exports. VIOLATION only when a
name departs from the convention, or a required type is not exported.

### `new-error-code` → MINOR

Read the whole `ErrorCode` enum in `src/errors.ts` once, then judge every
candidate against it. Per ERRORS.md the set is kept small, related errors
share a code where they share a recovery action, and a new code is warranted
only where distinguishing it has value a caller could act on.

VIOLATION only when an existing code already covers the same failure with the
same recovery action. A code for a genuinely distinct recovery action is
correct, and so is a rename of an existing one.

### Beyond the candidates

- Report each candidate you judge a violation at the severity above, with its
  `path:line` and one sentence naming the rule it breaks. Say nothing about the
  candidates you cleared beyond a count — one line per check id, not a row
  each.
- Do not add a finding at a site no check proposed, however clear it looks.
  That is a gap in the extractors to raise with a maintainer.
- Do not comment on design, structure, correctness, simplicity, duplication, or
  test quality. No check covers them, so they are not in scope.

## Step 3b — the one mechanical exemption

Exactly one `checks.sh` record is yours to overrule:

- **`missing-tests`** — drop it if every changed file under `src/` is purely
  cosmetic: formatting, comments, or a rename that alters no behaviour.
  CLAUDE.md exempts those and nothing else. Read the diff of the named files and
  decide; if any changed line alters what the code does, the finding stands.

No other `checks.sh` record may be dropped, softened, or re-graded — not
`uncommented-cast`, not `justified-suppression`, not any of them. The script
already accounts for the judgement each needs. A MINOR or a NOTICE is never
dropped either: neither fails the gate, and a NOTICE exists to be passed on.

## Step 4 — report

Print one table of everything that survived Step 3 — `checks.sh` records and
adjudicated candidates together — blockers first, each with its check id and
`path:line`. A severity is never re-derived: a `checks.sh` record keeps the
severity it was emitted with, and an adjudicated candidate takes the one
Step 3 gives its check id. Add a line giving the number of candidates cleared, and repeat any
`TRUNCATED` line. If nothing survived, say so in one line.

Then a single verdict line:

- `VERDICT: FAIL` — any BLOCKER or MAJOR survived.
- `VERDICT: PASS` — only MINOR or NOTICE records, or none at all.
- `VERDICT: ERROR` — either script exited 2.

MINOR and NOTICE never fail the gate; they are there for the reviewer to read.
Keep the report to the findings and the verdict — no summary of the change, no
advice.

## What this gate does not check, and why

Two categories are absent, and adding them back would defeat the point:

- **Anything CI already enforces.** `pnpm run lint`, `pnpm run typecheck`,
  `pnpm run format:check` and `pnpm run check:error-codes` run on every PR, so
  `any`, `!`, unused code, `.js` import extensions, private-field naming,
  import order, formatting and error-code enum values are already gated. A
  second opinion on them costs tokens and finds nothing new.
- **Judgement a competent reviewer would not always share.** The bar for a
  judgement check here is not "does it need a model" — it is "would two
  reviewers reach the same verdict". Correctness, DRY, simplicity, whether an
  abstraction is the right one, whether a test is a good test: all real
  concerns, none of them settled the same way twice. `/code-review-all` covers
  them, run by a person on a change that warrants it.

The line falls between those, not at the edge of what a regex can do. Some
rules need reading and still have one right answer — a log level against
LOGGING.md's table, a hook name against CLAUDE.md's convention, whether a
comment says anything its own line does not. Those are in Step 3, priced per
candidate rather than per diff, so a clean change pays nothing for them.

Two exclusions worth recording, so they are not "fixed" back in:

- **JSDoc that restates its member name.** CLAUDE.md requires JSDoc to describe
  the contract rather than restate the name, and the sites are easy to find. But
  the verdict is genuinely contested — is `/** The run's resolved id. */` on
  `runId: string` a violation? — and on this repo's history the candidates were
  right about a third of the time. A gate that argues with two thirds of its own
  findings gets ignored.
- **`no longer` in a comment, `failed` as a channel state.** Both are covered by
  rules, and neither can be separated from legitimate use: "the done entry
  replaces the executing one", "the run is no longer this workflow's". Each
  omission is commented at its check in `checks.sh`.
