---
name: code-review-docs
description: Review documentation for accuracy, completeness, and conformance to the project's doc standards — whether a code change left docs/ stale or incomplete, or as the review half of the docs writing loop. Read-only; produces a conformance report and never edits code or docs.
license: proprietary
metadata:
  team: engineering
  tags: code-review, documentation, docs-drift, coverage, quality
  mcp: false
allowed-tools: Read, Grep, Glob, Skill, Bash(git diff *), Bash(git status *)
---

# Code Review: documentation

Review documentation against the project's standards. Use it two ways:

- **Change-driven** - after a code change, audit whether `docs/` went stale or
  was left incomplete.
- **Doc-driven** - as the review half of the docs writing loop, audit the pages
  being written or edited against the standards below; a separate action step
  then fixes what this review reports, and the loop repeats until it passes.

Read-only: audit and report, never edit. The `docs` skill owns the writing
standards (principles, voice, page structure); this skill is the reviewer that
holds work to account against them - read it for the full standards behind the
criteria below.

## Step 1 — scope & protocol

Invoke the `ably-skills:code-review-protocol` skill (via the Skill tool) for the
report-only rule, scope resolution (honouring any `$ARGUMENTS` override), the
severity scale, and the report format. Use **concern = `docs`**. Apply the
criteria below, then emit the report it specifies.

## Step 2 — what to review

**Accuracy** - nothing is stale or wrong:

- Code examples are copy-pasteable, use real API surface, and match the current
  source - signatures, parameter names/order, optional markers (`?`), and return
  types included.
- Wire values, chunk/event type names, and header names match the code (check the
  literals in `src/constants.ts`; do not assume them).
- Method-behaviour and priority/ordering claims match the implementation.
- No invented or undocumented API surface, and no undefined references in
  examples.

**Coverage** - nothing public is undocumented:

- Every export added to an entry-point `index.ts` has a home: a `reference/`
  entry with signature, parameters, and return type, plus a `features/` or
  `concepts/` page when it is user-facing.
- New options, members, error codes, events, behaviours, and edge cases are
  documented alongside their siblings.
- Where the page structure expects the full set (every parameter in a signature,
  both client and server sides on a feature page), nothing is left partial.

**Structure & voice** - the page follows the project's doc patterns:

- Opens with a one-sentence definition; feature pages add 1-2 sentences of
  problem framing.
- One developer intent per page; headers read as a scannable table of contents.
- No marketing language, hedging, or meta-commentary; tables used for structured
  comparisons.
- Multi-participant sequence/flow diagrams use Mermaid with valid syntax, not
  ASCII art; plain-text diagrams stay aligned.

**Cross-references & concept audit** - the reader is never stranded:

- Links and anchors resolve to existing pages and headings; every concept
  explained elsewhere is linked at first mention, not parked in a trailing "See
  also".
- Read each paragraph as an outsider: every Ably-specific term, architecture
  term, and protocol jargon is defined inline or linked to the glossary at first
  mention.

Cite the page (or the page that should exist) and the source or standard each
finding is measured against.
