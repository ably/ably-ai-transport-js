# Shared e2e harness

Test-suite scaffolding shared by the demos, so each demo doesn't duplicate it.

- `run-e2e.mjs` - the launcher each demo's `test:e2e` script invokes
  (`node ../../../e2e/run-e2e.mjs`). It provisions a throwaway Ably sandbox app,
  enables the mock LLM, and runs that demo's Playwright suite. It resolves
  Playwright and the `ably-common` submodule relative to the invoking demo, so
  one copy serves every demo. See a demo's `tests/e2e/README.md` for the full
  picture.

The per-demo `tests/e2e/chat.spec.ts` helper functions are not shared here yet:
they import `@playwright/test` (for `expect` and the `Page`/`Locator` types),
which must resolve to each demo's own Playwright install. Sharing them cleanly
needs the demos to resolve a common package through their `node_modules` (i.e. a
pnpm workspace), which is a larger change to the demos' install model. The
launcher avoids this because it resolves its dependencies at runtime from the
invoking demo's directory.
