# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

`@ably/ai-transport` — Ably transport and codecs for building AI applications with Ably. Ships as a single npm package with six entry points: core, react, vercel, vercel/react, openai, and temporal.

## Commands

This repo uses pnpm; `npm install` is rejected by `devEngines.packageManager`.

```bash
pnpm run lint              # ESLint
pnpm run lint:fix          # ESLint + Prettier auto-fix
pnpm run format:check      # Prettier check
pnpm run typecheck         # tsc --noEmit
pnpm test                  # Unit tests (vitest, mocks only)
pnpm run test:integration  # Integration tests
pnpm run check:error-codes # Validate ErrorCode enum against ably-common
pnpm run precommit         # format:check + lint + typecheck
```

## Architecture & conventions

Detailed guidance lives in `.claude/rules/`. These files state durable **principles, conventions, and rationale** — what an agent cannot cheaply reconstruct by reading the code. They deliberately avoid mirroring code-discoverable detail (directory trees, exhaustive export/symbol lists, exact enum values, real log strings, copied signatures), which only drifts and creates a second source of truth. When editing a rule, state the rule and its reason and point to the authoritative source in code for the instance; prefer generic examples (`Foo.bar()`) that can't drift against real symbols.

| Rule file         | Covers                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------ |
| `ABSTRACTIONS.md` | Two-layer architecture, directory layout, class pattern, composition, dependency injection |
| `ERRORS.md`       | Error type (`Ably.ErrorInfo`), error codes, message format, wrapping, testing              |
| `LOGGING.md`      | Logger interface, log levels, message format, context propagation                          |
| `PROMISES.md`     | async/await policy, exception handling                                                     |
| `TYPES.md`        | Type safety rules, import conventions, no `any`/`as`/`!` policy                            |
| `TESTS.md`        | Unit vs integration tests, mocking strategy, coverage expectations                         |
| `COMMENTS.md`     | Comments, JSDoc, and test descriptions anchor to present state, not prior/removed code     |
| `AISDK.md`        | Vercel AI SDK: supported majors, cross-major gotchas, dual-version discipline              |

Additional conventions not covered by rule files:

- **Channel state names in prose**: When referring to Ably channel states as state names (in comments, commit messages, documentation, and test descriptions), write them in UPPERCASE: INITIALIZED, ATTACHING, ATTACHED, DETACHING, DETACHED, SUSPENDED, FAILED. Do not use backticks or quotes — the capitalisation makes them self-evident. Keep lowercase when the word is used as a verb (e.g. "before re-attaching").
- **Imports**: Always include `.js` extension. Import peer dependency types as namespaces (`import type * as Ably from "ably"`, `import type * as AI from "ai"`).
- **JSDoc on exported types**: Every property and method on an exported interface or type must have a JSDoc comment. Exported interfaces themselves should also have a JSDoc comment describing their purpose. JSDoc comments must describe the **contract** — what the caller or implementor needs to know — not just restate the name. For callbacks and hooks, state whether they are called with a value to observe, to mutate in place, or to return a replacement.
- **React hook types**: Every hook's parameter object must be a named `{HookName}Options` interface (e.g. `UseClientTransportOptions`, `UseChatTransportOptions`). When the hook returns a structured object, name it `{HookNameWithoutUse}Handle` (e.g. `ClientTransportHandle`, `ChatTransportHandle`). Both types must be exported from the entry-point `index.ts`. Hooks that return primitives or library types (arrays, Maps) need no wrapper Handle type.

## Workflow rules

- **Never edit submodule contents directly.** Do not modify, stage, or commit files inside the `ably-common/` or `specification/` working trees. A submodule's pinned ref may only be bumped to a commit that already exists upstream — made and reviewed through a proper clone of that repository, not authored in-place in the submodule working tree. If a submodule change is needed, say so and let the user make it in the real clone first.
- **Run validation after every change.** After modifying source or test files, run `pnpm run typecheck`, `pnpm run lint`, and `pnpm run format:check`. Fix all errors **and warnings** before presenting changes. If tests exist for the changed code, run `pnpm test` too.
- **Include test coverage with every change.** Every code change must include appropriate tests. New functions and modules need unit tests. Bug fixes need a test that would have caught the bug. Behavioral changes need updated tests. Only purely cosmetic changes (formatting, comments, renames) are exempt.
- **The specification is not maintained.** `specification/` is stale and is not kept in sync with the code. Do not gate work on it, cite it as authority, or add new `// Spec: AIT-*` references to spec points. Treat `specification/` as read-only — revert any unintended changes there before presenting work. Existing `// Spec: AIT-*` comments may stay as-is. Implementation comments may describe new behaviour in prose without citing a spec ID. Only update the spec if the user explicitly asks for a specific change, and then only via the real-clone path above — never edit `specification/` in-tree.
- **Review substantial changes with `/code-review-all`.** After completing implementation work on a large or higher-risk change, run the `/code-review-all` skill to review it. It fans out independent, read-only reviewers across every relevant concern — the local `code-review-*` skills plus the shared `ably-skills` `code-review-*` plugin — and synthesises one report. Address any issues it raises, and confirm the change still satisfies the plan (if one exists), before presenting changes to the user. For small or routine changes, this full fan-out is overkill — use judgement, or skip it unless the user asks for it.
- **YAGNI — no unused or speculative code.** Never include unused, redundant, or speculative code. Do not add anything "in case we need it later." Every added line must be used and necessary for the current task. Remove dead code, unused imports, unused parameters, placeholder implementations, and premature abstractions.

## Submodules

- `ably-common/` — shared Ably protocol resources. Contains `protocol/errors.json` with canonical error code definitions. Run `pnpm run check:error-codes` to validate `ErrorCode` enum values.
- `specification/` — the Ably specification repo, on the `ai-transport-features` branch (`specifications/ai-transport-features.md`, using `AIT-` prefixed spec points). **Stale and not maintained** — it is no longer kept in sync with the code; treat it as read-only and do not gate work on it (see the workflow rule above). Existing `// Spec: AIT-*` comments in the code may remain. Never edit this submodule in-tree (see the workflow rule above); any approved change is authored in a proper clone and the ref bumped separately.
