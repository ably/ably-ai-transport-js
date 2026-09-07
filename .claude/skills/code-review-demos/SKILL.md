---
name: code-review-demos
description: Audit whether the demos under demo/ are still current with a change — they compile against and use the changed public API correctly, showcase new or renamed capabilities, and keep their e2e test coverage current. Read-only; produces a conformance report and never edits code.
license: proprietary
metadata:
  team: engineering
  tags: code-review, demos, examples, api-drift, tests, quality
  mcp: false
allowed-tools: Read, Grep, Glob, Skill, Bash(git diff *), Bash(git status *)
---

# Code Review: demos currency

Audit whether the demos in `demo/` are up to date with the change.

## Step 1 — scope & protocol

Invoke the `ably-skills:code-review-protocol` skill (via the Skill tool). It
defines the report-only rule, scope resolution (honouring any `$ARGUMENTS`
override), the severity scale, and the exact report format. Use
**concern = `demos`**. Apply the criteria below, then emit the report it
specifies.

The demos live under `demo/` — `demo/vercel`, `demo/vercel/react`, and the
shared e2e harness `demo/e2e`. Each demo carries its own Playwright suite under
`<demo>/tests/e2e/*.spec.ts`, launched through `demo/e2e/run-e2e.mjs`. Identify
which public API surface the change touched (additions, renames, removals,
signature changes in any entry-point `index.ts`).

## Step 2 — what to look for

- **Broken usage.** A demo imports or calls public API the change renamed,
  removed, or whose signature/options it altered. Grep the demos for each changed
  symbol. Where practical, confirm by typechecking the relevant demo rather than
  only reading it.
- **Stale patterns.** A demo uses a now-superseded approach the change replaced
  (e.g. an old factory, option name, or wiring) when the demo is meant to model
  current best practice.
- **Missing showcase.** A change adds a notable public capability that the demos
  are the natural place to demonstrate, and none does. Raise this as `minor`
  unless the change's whole point is the new capability.
- **References to removed APIs** in demo READMEs or comments.
- **Test coverage.** Each demo's Playwright e2e suite
  (`<demo>/tests/e2e/*.spec.ts`, run via `demo/e2e/run-e2e.mjs`) still covers the
  flows the change touches. A change that adds or alters a demo flow has matching
  e2e assertions; a selector, route, or behaviour the suite drives that the
  change renamed or removed is updated, so the suite is neither silently broken
  nor asserting stale behaviour. Flag new demo functionality that ships with no
  e2e coverage, and any `test:e2e` script or shared-harness wiring the change has
  broken.

Judge against intent: demos exist to show developers the current, recommended way
to use the SDK, and their e2e suites are what keep them honest. A demo that still
compiles but teaches a stale pattern is a real finding; a demo flow left without
e2e coverage is at least `minor`; a demo that no longer compiles against the
changed API, or whose e2e suite the change has broken, is at least `major`.
