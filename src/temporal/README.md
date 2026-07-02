# `@ably/ai-transport/temporal`

Temporal-specific helpers for building durable agents. Codec-agnostic.

Ships two deterministic-identifier helpers — `stepIdFor` and
`activityInvocationIdFor` — that survive cross-process retries and don't
collide across workflows.

## Install

```sh
npm install @ably/ai-transport ably @temporalio/activity @temporalio/worker @temporalio/client @temporalio/workflow
```

`@temporalio/activity` is an optional peer dependency of `@ably/ai-transport`
— it's required only if you import from `/temporal`.

## Deterministic identifiers

`stepIdFor` and `activityInvocationIdFor` give you globally-unique identity
strings for `run.createStep({ stepId })` and `session.adoptRun({ invocationId })`
respectively. Both are workflow-scoped so multiple workflows can publish to
the same run (suspend + continuation) without their step-1s colliding.

```ts
import { Context } from '@temporalio/activity';
import { stepIdFor, activityInvocationIdFor } from '@ably/ai-transport/temporal';

export async function myInferenceStep(input) {
  const activityId = Context.current().info.activityId;
  const session = createAgentSession({ client: ably, channelName, codec });
  await session.connect();
  const run = session.adoptRun({
    runId: input.ids.runId,
    invocationId: activityInvocationIdFor(),
    triggerEventId: input.ids.triggerEventId,
  });
  await run.load();
  const step = run.createStep({
    stepId: stepIdFor(input.ids.invocationId, activityId),
  });
  // ...
}
```

**Why workflow-scoped?** Temporal's `activityId` is unique within one
workflow, not across workflows. If two workflows both publish under
`step-id: "1"` on the same run (e.g. after a suspend + continuation), the
SDK's supersede semantics eat the earlier attempt's output. Prefixing with
the workflow id keeps them distinct while still letting a retry of the same
activity coalesce cleanly.
