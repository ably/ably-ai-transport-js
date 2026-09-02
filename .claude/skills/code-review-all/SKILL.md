---
name: code-review-all
description: Run a full code review of the current change — fan out every relevant review concern across independent subagents (the local review skills plus the ably-skills code-review-* plugin) and synthesise one consolidated report. Read-only; never edits code.
license: proprietary
metadata:
  team: engineering
  tags: code-review, orchestration, fan-out, quality
  mcp: false
allowed-tools: Agent, Skill
argument-hint: "[scope]  (optional: a path, 'staged', 'repo', or a base ref; defaults to branch vs PR target/main)"
---

# Code Review: all concerns

Run the full code review for the current change: fan out every relevant concern
across independent subagents — each running one focused review skill — then
synthesise their reports into a single consolidated review. This skill only
reviews; it never edits code.

## Step 1 — resolve the base once

Resolve the **base** to review against, once, and reuse it for every subagent so
they all audit the same change:

- If `$ARGUMENTS` carries a scope override (a path, `staged`, `repo`, or an
  explicit base ref), use that verbatim.
- Otherwise resolve the current branch's open-PR target branch by invoking the
  `ably-skills:gh-resolve-target-branch` skill; fall back to `main` if it reports
  no PR.

## Step 2 — fan out, one subagent per concern

Launch one **general-purpose** subagent per concern below, all in a **single
message** so they run in parallel. Give each subagent this prompt (substituting
the skill and the base from Step 1):

> Run the `<skill>` skill (via the Skill tool) with scope argument `<base>` to
> review the current change. Follow the skill in full and return **only** the
> report it produces, ending in its single `VERDICT:` line. Do not edit anything.

Generic concerns — the shared `ably-skills` plugin skills:

| Concern     | Skill                                 |
| ----------- | ------------------------------------- |
| Back-compat | `ably-skills:code-review-back-compat` |
| Clean code  | `ably-skills:code-review-clean`       |
| Comments    | `ably-skills:code-review-comments`    |
| Correctness | `ably-skills:code-review-correctness` |
| Dead code   | `ably-skills:code-review-dead-code`   |
| DRY         | `ably-skills:code-review-dry`         |
| Error codes | `ably-skills:code-review-error-codes` |
| Logging     | `ably-skills:code-review-logging`     |
| Simplicity  | `ably-skills:code-review-simplicity`  |
| Tests       | `ably-skills:code-review-tests`       |

Project-specific concerns — the local skills in this repo:

| Concern           | Skill                           |
| ----------------- | ------------------------------- |
| Rules conformance | `code-review-rules-conformance` |
| Rules drift       | `code-review-rules-drift`       |

Skip a concern only when it plainly cannot apply to the change (e.g. a
docs-only change and the tests concern). If you skip one, say so in the report
rather than dropping it silently.

## Step 3 — synthesise one report

Collect the subagents' reports and synthesise — do not just concatenate:

- Open with a **summary table**: one row per concern with its verdict
  (PASS / CHANGES REQUESTED) and its blocker/major/minor/nit counts.
- List findings **grouped by severity** (all blockers first, then majors, then
  minors, then nits), each tagged with its concern and `path:line`. De-duplicate
  findings several concerns raised about the same site, noting which concerns
  flagged it.
- Close with the overall verdict: `VERDICT: CHANGES_REQUESTED` if any concern
  requested changes (any blocker or major across the board), otherwise
  `VERDICT: PASS`.

If a subagent fails or returns nothing, note it in the summary table as
`(no report)` rather than dropping the concern silently. Apply no fixes — this
skill only reviews.
