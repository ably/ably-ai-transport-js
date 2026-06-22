---
name: code-review-rules-drift
description: Audit whether the .claude/rules/* guidance still matches the code after a change — stale conventions, drifted examples, rules describing removed behaviour, or new conventions the change introduces that a rule should capture. Read-only; produces a conformance report and never edits code or rules.
license: proprietary
metadata:
  team: engineering
  tags: code-review, rules, conventions, drift, quality
  mcp: false
allowed-tools: Read, Grep, Glob, Skill, Bash(git diff *), Bash(git status *)
---

# Code Review: rules drift

Audit whether the `.claude/rules/*` guidance and the rule-related conventions in
`CLAUDE.md` still describe the code accurately after this change.

## Step 1 — scope & protocol

Invoke the `ably-skills:code-review-protocol` skill (via the Skill tool). It
defines the report-only rule, scope resolution (honouring any `$ARGUMENTS`
override), the severity scale, and the exact report format. Use
**concern = `rules drift`**. Apply the criteria below, then emit the report it
specifies.

This is the inverse of `code-review-rules-conformance`: there we ask "does the
code obey the rules"; here we ask "do the rules still describe the code". A
change can be perfectly conformant yet leave a rule stale. Read the rule files
(`.claude/rules/*.md`) and the rules guidance in `CLAUDE.md`.

## Step 2 — what to look for

- **Drifted references.** A rule cites a symbol, path, signature, enum value, or
  log string that the change renamed, moved, or removed. Per CLAUDE.md, rules
  state principles and point to the authoritative source in code — flag any
  concrete instance a rule names that no longer matches.
- **Outdated examples.** A code example in a rule now contradicts how the code
  works after the change.
- **Removed behaviour.** A rule describes a behaviour, pattern, or constraint the
  change eliminated.
- **Uncaptured new convention.** The change establishes a new convention or
  pattern that future work should follow but no rule records — or it invalidates
  an existing rule's premise.
- **Code-discoverable detail leaking into rules** — a rule edit prompted by the
  change that mirrors drift-prone detail (directory trees, exhaustive symbol
  lists, copied signatures) rather than a principle + pointer, against the
  rules-table preamble in CLAUDE.md.

For each finding, name the rule file and the code it has drifted from, and
suggest principle-level wording rather than a detail that will drift again.
