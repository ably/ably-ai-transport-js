# Shared e2e harness

Test-suite scaffolding shared by the demos, so each demo doesn't duplicate it.

- `run-e2e.mjs` - the launcher each demo's `test:e2e` script invokes
  (`node ../../../e2e/run-e2e.mjs`). It provisions a throwaway Ably sandbox app,
  enables the mock LLM, and runs that demo's Playwright suite. It resolves
  Playwright and the `ably-common` submodule relative to the invoking demo, so
  one copy serves every demo. See a demo's `tests/e2e/README.md` for the full
  picture.

## `temporal-agent` has no Playwright suite

Every other demo is in the `demo-e2e` CI matrix; `demo/temporal/temporal-agent`
is not, and that is a decision rather than an oversight. The launcher below
boots one thing: the demo's Next.js dev server. That demo additionally needs a
`temporal server start-dev` and a worker process registered on the task queue,
both up before the first POST, and both torn down after. Adding them means the
launcher grows a second and third managed process with their own readiness
checks — worth doing, but a change to the harness rather than to the demo.

Until then its coverage is the unit tier: the workflow tests run a real
Temporal `TestWorkflowEnvironment` with faked activities, and `outcome.test.ts`
covers the end-not-suspend invariant the durable path turns on.

The per-demo `tests/e2e/chat.spec.ts` helper functions are not shared here yet:
they import `@playwright/test` (for `expect` and the `Page`/`Locator` types),
which must resolve to each demo's own Playwright install. Sharing them cleanly
needs the demos to resolve a common package through their `node_modules` (i.e. a
pnpm workspace), which is a larger change to the demos' install model. The
launcher avoids this because it resolves its dependencies at runtime from the
invoking demo's directory.
