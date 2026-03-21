# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

`@ably/ably-ai-transport-js` — Ably transport and codecs for building AI applications with Ably. Ships as a single npm package with four entry points: core, react, vercel, and vercel/react.

## Commands

```bash
npm run lint              # ESLint
npm run lint:fix          # ESLint + Prettier auto-fix
npm run format:check      # Prettier check
npm run typecheck         # tsc --noEmit
npm test                  # Unit tests (vitest, mocks only)
npm run test:integration  # Integration tests (needs ABLY_API_KEY)
npm run check:error-codes # Validate ErrorCode enum against ably-common
npm run precommit         # format:check + lint + typecheck
```

## Architecture

Two-layer design: a **generic layer** (`src/core/`, `src/react/`) that is codec-agnostic and framework-agnostic, and a **Vercel layer** (`src/vercel/`) that implements the codec for Vercel AI SDK v6. The generic layer uses only `x-ably-*` headers; domain-specific headers belong in the Vercel layer.

All generic components are parameterized by `Codec<TEvent, TMessage>`. Transports are assembled via composition (not inheritance) with all dependencies passed through constructors.

## Key conventions

- **Error type**: `Ably.ErrorInfo` exclusively — no custom error classes. Error codes come from ably-common or the `104xxx` range. Message format: `"unable to <operation>; <reason>"`.
- **Logging**: `Logger` interface with `trace`/`debug`/`info`/`warn`/`error`/`withContext()`. Create once at top level with `makeLogger()`, propagate down via constructors, add context at each layer with `withContext()`. Message format: `ClassName.methodName(); <description>`.
- **Async**: `async`/`await` with `try`/`catch` — not `.then()` chains (exceptions must be commented).
- **Type safety**: No `any`, no `as` casts without `// CAST:` comment, no `!` assertions, no `@ts-ignore`. Import types from peer deps (`ably`, `ai`), don't redefine.
- **Tests**: Unit tests mock everything (`flushMicrotasks()`, mock writers/channels); integration tests hit real Ably with unique channel names and cleanup. Custom Vitest matchers in `test/helper/expectations.ts`.
- **Imports**: Always include `.js` extension. Ably types via namespace (`import type * as Ably from "ably"`), Vercel types directly.

## Workflow rules

- **Never commit changes.** All changes must be reviewed by a human before committing. Stage files and present a summary of changes, but wait for the user to approve via `/commit` or explicit instruction.
- **Never push or pull the remote.** Do not run `git push`, `git pull`, `git fetch`, or any command that interacts with the remote repository.
- **Run validation after every change.** After modifying source or test files, run `npm run typecheck` and `npm run lint`. Fix any errors before presenting changes. If tests exist for the changed code, run `npm test` too.
- **Include test coverage with every change.** Every code change must include appropriate tests. New functions and modules need unit tests. Bug fixes need a test that would have caught the bug. Behavioral changes need updated tests. Only purely cosmetic changes (formatting, comments, renames) are exempt.
- **Keep the specification in sync.** When implementing a new feature or changing behavior covered by the spec, update `specification/specifications/ai-transport-features.md` with new or amended `AIT-` spec points. Never commit spec changes — present them to the user for review alongside the code changes.

## Submodules

- `ably-common/` — shared Ably protocol resources. Contains `protocol/errors.json` with canonical error code definitions. Run `npm run check:error-codes` to validate `ErrorCode` enum values.
- `specification/` — the Ably specification repo, on the `ai-transport-features` branch. Contains `specifications/ai-transport-features.md` with the AI Transport features spec using `AIT-` prefixed spec points. Reference spec points in code comments as `// Spec: AIT-CT2a`. Run `/spec` to cross-reference code against the specification. **Never commit changes to the specification submodule without explicit user approval** — always present proposed spec changes for review first.
