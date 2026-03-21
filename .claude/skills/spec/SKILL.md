---
name: spec
description: Cross-reference code with the AI Transport specification (AIT- spec points). Verify code comments reference correct spec points and that the spec reflects the implementation.
---

# Spec Cross-Reference

Audit the relationship between this SDK's source code and the AI Transport
specification at `specification/specifications/ai-transport-features.md`.

The specification uses the `AIT-` prefix for spec point identifiers, e.g.
`(AIT-CT2a)`. Code references these in comments like `// Spec: AIT-CT2a` or
`// AIT-CT2a`.

## Step 1: Load the specification

Read the full contents of `specification/specifications/ai-transport-features.md`.
Parse out every spec point identifier (pattern: `AIT-[A-Z]+[0-9]+[a-z0-9]*`).
Build a map of spec point ID → description.

## Step 2: Find all spec references in code

Search `src/` for any comment referencing an `AIT-` identifier. Collect:
- File path and line number
- The spec point ID referenced
- Surrounding code context (the function or block it appears in)

Also search `test/` for spec references in test descriptions or comments.

## Step 3: Cross-reference

Spec points fall into two categories that require different verification
approaches:

### General Principles (`AIT-GP*`)

General principles are cross-cutting constraints that the entire codebase
must conform to. They will NOT typically have explicit `// Spec: AIT-GP1`
comments in the code. Instead, verify conformance by inspecting the code
structurally:

- `AIT-GP1` (two-layer split): Check that `src/core/` has no imports from
  `ai` or other framework packages; check that framework-specific code
  lives in `src/vercel/` (or similar).
- `AIT-GP2` (codec parameterization): Check that generic transport/tree
  components use `<TEvent, TMessage>` type parameters.
- `AIT-GP3` (header discipline): Grep `src/core/` for header strings and
  verify only `x-ably-*` headers appear.
- `AIT-GP4` (single shared channel): Verify transport constructors accept
  one channel, not multiple.
- `AIT-GP5` (dependency injection): Check for absence of singletons,
  module-level mutable state, or service locators.
- `AIT-GP6*` (error codes): Verify `ErrorCode` values come from
  ably-common or the `104xxx` range.
- `AIT-GP7*` (error messages): Grep for `new Ably.ErrorInfo(` and verify
  messages follow the `unable to <op>; <reason>` pattern.

For each general principle, report whether the codebase **conforms**,
**violates** (with specific locations), or is **not yet applicable**
(the relevant code doesn't exist yet).

### Feature Spec Points (all other `AIT-*`)

These map to specific implementations and should have explicit
`// Spec: AIT-XXn` comments in code.

#### Direction 1: Code → Spec (are code references valid?)

For each spec reference found in code:
1. Verify the referenced spec point exists in the specification
2. Verify the code's behavior matches the spec point's description
3. Flag any references to non-existent spec points
4. Flag any references where the code appears to contradict the spec

#### Direction 2: Spec → Code (is the spec covered?)

For each feature spec point in the specification:
1. Check if there is at least one code reference or implementation
2. Identify spec points with no corresponding code (not yet implemented)
3. Identify spec points marked `[Testable]` that have no corresponding test

## Step 4: Report

Present a structured report with these sections:

### General Principles Conformance
For each `AIT-GP*` point: conforming, violating (with locations), or not
yet applicable. This section should always be present even when no feature
spec points exist yet.

### Invalid References
Spec points referenced in code that don't exist in the specification.

### Contradictions
Code that appears to implement behavior different from what the spec requires.

### Unimplemented Feature Spec Points
Feature spec points (non-GP) with no corresponding code. Group by section.

### Untested Spec Points
Spec points marked `[Testable]` with no corresponding test.

### Coverage Summary
A table showing each spec section and the number of implemented vs total
spec points. General principles have their own row showing conformance
count rather than code-reference count.

## Step 5: Suggest updates

If the implementation includes behavior not covered by the specification,
suggest new spec points that should be added. Present these as markdown
in the spec format:

```
- `(AIT-XXn)` Description of the requirement.
```

If the specification includes requirements that are incorrect based on the
actual implementation, suggest amendments.

Ask the user whether they want to apply any of the suggested updates to either
the code comments or the specification file.

## Important: Specification changes require explicit approval

Never commit changes to the specification submodule without explicit user
approval. Always present proposed spec changes (additions, modifications,
removals) for the user to review before writing them to the file. The
specification is a shared contract — changes must be deliberate and reviewed.
