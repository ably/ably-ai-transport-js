---
name: code-review-rules-conformance
description: Audit whether changed code conforms to the project's own rules in .claude/rules/ and the conventions in CLAUDE.md. Read-only; produces a conformance report and never edits code.
license: proprietary
metadata:
  team: engineering
  tags: code-review, rules, conventions, conformance, quality
  mcp: false
allowed-tools: Read, Grep, Glob, Skill, Bash(git diff *), Bash(git status *)
---

# Code Review: rules conformance

Audit whether the changed code obeys the project's rules.

## Step 1 — scope & protocol

Invoke the `ably-skills:code-review-protocol` skill (via the Skill tool). It
defines the report-only rule, scope resolution (honouring any `$ARGUMENTS`
override), the severity scale, and the exact report format. Use
**concern = `rules conformance`**. Apply the criteria below, then emit the report
it specifies.

Read every rule file under `.claude/rules/` and the conventions in `CLAUDE.md`
before judging — they are the authority. This concern checks conformance to the
**project's own** rules; generic logging and correctness hygiene belong to the
`ably-skills:code-review-logging` and `ably-skills:code-review-correctness`
concerns.

## Step 2 — check against every rule

For each changed file, check it against **each** rule file you read in Step 1 and
the conventions in `CLAUDE.md`. Work from the rules as written in those files
today — `.claude/rules/` is the source of truth and its set changes over time, so
do not rely on a remembered or hardcoded list. Read each rule, then hold the
change to what it actually says, covering whatever it addresses (type safety,
error handling, logging, promises, abstractions, comments, framework specifics,
and the CLAUDE.md conventions).

Cite the specific rule file — and the clause within it — in every finding, and
state the rule the change breaks. Per `CLAUDE.md`, the rules state principles and
point to the authoritative source in code; apply the principle, not a stale
summary of it.

A rule violation is at least `major`; a violation the rule itself calls out as a
hard contract (non-negotiable) is a `blocker`.
