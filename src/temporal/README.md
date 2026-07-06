# `@ably/ai-transport/temporal`

Temporal-specific helpers for building durable agents. Codec-agnostic.

Ships one deterministic-identifier helper — `stepIdFor` — that survives
cross-process retries and doesn't collide across workflows.

## Install

```sh
npm install @ably/ai-transport ably @temporalio/activity @temporalio/worker @temporalio/client @temporalio/workflow
```

`@temporalio/activity` is an optional peer dependency of `@ably/ai-transport`
— it's required only if you import from `/temporal`.

## `stepIdFor`

`stepIdFor(invocationId)` gives you a globally-unique `stepId` string for
`run.createStep({ stepId })`. It's workflow-scoped so multiple workflows can
publish to the same run (suspend + continuation) without their step-1s
colliding.

For the `invocationId` you pass to `session.adoptRun({ invocationId })`,
use the same invocation id the workflow was started with (returned to the
HTTP caller and threaded through the workflow input as `input.ids.invocationId`).
Every activity in that HTTP invocation stamps the same invocation-id on its
events, matching the value the caller received.

```ts
import { stepIdFor } from '@ably/ai-transport/temporal';

export async function myInferenceStep(input) {
  const session = createAgentSession({ client: ably, channelName, codec });
  await session.connect();
  const run = session.adoptRun({
    runId: input.ids.runId,
    invocationId: input.ids.invocationId, // the HTTP invocation's id — shared by every activity
    triggerEventId: input.ids.triggerEventId,
  });
  await run.load();
  const step = run.createStep({
    stepId: stepIdFor(input.ids.invocationId),
  });
  // ...
}
```

`stepIdFor` reads `Context.current().info.activityId` internally, so it must
be called from inside a Temporal activity.

**Why workflow-scoped?** Temporal's `activityId` is unique within one
workflow, not across workflows. If two workflows both publish under
`step-id: "1"` on the same run (e.g. after a suspend + continuation), the
SDK's supersede semantics eat the earlier attempt's output. Prefixing with
the invocation id keeps them distinct while still letting a retry of the
same activity coalesce cleanly.
