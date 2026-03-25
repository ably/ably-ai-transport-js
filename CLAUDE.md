# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

`@ably/ai-transport` — Ably transport and codecs for building AI applications with Ably. Ships as a single npm package with four entry points: core, react, vercel, and vercel/react.

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

## Architecture & conventions

Detailed guidance lives in `.claude/rules/`:

| Rule file | Covers |
|---|---|
| `ABSTRACTIONS.md` | Two-layer architecture, directory layout, class pattern, composition, dependency injection |
| `ERRORS.md` | Error type (`Ably.ErrorInfo`), error codes, message format, wrapping, testing |
| `LOGGING.md` | Logger interface, log levels, message format, context propagation |
| `PROMISES.md` | async/await policy, exception handling |
| `TYPES.md` | Type safety rules, import conventions, no `any`/`as`/`!` policy |
| `TESTS.md` | Unit vs integration tests, mocking strategy, coverage expectations |
| `AISDK.md` | Vercel AI SDK v6 specifics |

Additional conventions not covered by rule files:

- **Imports**: Always include `.js` extension. Import peer dependency types as namespaces (`import type * as Ably from "ably"`, `import type * as AI from "ai"`).
- **JSDoc on exported types**: Every property and method on an exported interface or type must have a JSDoc comment. Exported interfaces themselves should also have a JSDoc comment describing their purpose. JSDoc comments must describe the **contract** — what the caller or implementor needs to know — not just restate the name. For callbacks and hooks, state whether they are called with a value to observe, to mutate in place, or to return a replacement.

## Workflow rules

- **Never commit changes.** All changes must be reviewed by a human before committing. Stage files and present a summary of changes, but wait for the user to approve via `/commit` or explicit instruction.
- **Never push or pull the remote.** Do not run `git push`, `git pull`, `git fetch`, or any command that interacts with the remote repository.
- **Run validation after every change.** After modifying source or test files, run `npm run typecheck` and `npm run lint`. Fix all errors **and warnings** before presenting changes. If tests exist for the changed code, run `npm test` too.
- **Include test coverage with every change.** Every code change must include appropriate tests. New functions and modules need unit tests. Bug fixes need a test that would have caught the bug. Behavioral changes need updated tests. Only purely cosmetic changes (formatting, comments, renames) are exempt.
- **Keep the specification in sync.** When implementing a new feature or changing behavior covered by the spec, update `specification/specifications/ai-transport-features.md` with new or amended `AIT-` spec points. Never commit spec changes — present them to the user for review alongside the code changes.
- **Review changes with an independent subagent.** After completing implementation work, use an independent subagent to review the changes against the plan (if one exists) and the project guidance in `.claude/rules/`. Address any issues found before presenting changes to the user.
- **YAGNI — no unused or speculative code.** Never include unused, redundant, or speculative code. Do not add anything "in case we need it later." Every added line must be used and necessary for the current task. Remove dead code, unused imports, unused parameters, placeholder implementations, and premature abstractions.

## Submodules

- `ably-common/` — shared Ably protocol resources. Contains `protocol/errors.json` with canonical error code definitions. Run `npm run check:error-codes` to validate `ErrorCode` enum values.
- `specification/` — the Ably specification repo, on the `ai-transport-features` branch. Contains `specifications/ai-transport-features.md` with the AI Transport features spec using `AIT-` prefixed spec points. Reference spec points in code comments as `// Spec: AIT-CT2a`. Run `/spec` to cross-reference code against the specification. **Never commit changes to the specification submodule without explicit user approval** — always present proposed spec changes for review first.
