# `@ably/ai-transport/temporal`

Temporal support for building durable agents. Codec-agnostic.

Two halves, split by where they run:

| Import                                 | Runs on              | Contains                                                     |
| -------------------------------------- | -------------------- | ------------------------------------------------------------ |
| `@ably/ai-transport/temporal`          | the worker           | `createAblyTransportPlugin`, `stepIdFor`, the activity types |
| `@ably/ai-transport/temporal/workflow` | the workflow sandbox | `withRun`, `openRun`, `RunHandle`                            |

Workflow code must import the `/workflow` subpath. The worker half reaches for
`ably` and `@temporalio/activity`, neither of which exists inside Temporal's
workflow sandbox.

## Install

```sh
npm install @ably/ai-transport ably @temporalio/activity @temporalio/worker @temporalio/client @temporalio/workflow
```

`@temporalio/activity`, `@temporalio/worker` and `@temporalio/workflow` are
optional peer dependencies — required only if you import from `/temporal`.

## What the plugin gives you

A durable agent has two halves. **Inference** is yours: the model, the system
prompt, the tool registry, when to stop. **Framing** is the run lifecycle around
it, and it is identical in every integration:

| Activity     | Publishes                        | What it does                                                    |
| ------------ | -------------------------------- | --------------------------------------------------------------- |
| `openRun`    | `ai-run-start` / `ai-run-resume` | Creates the run, finds its trigger in channel history, opens it |
| `endRun`     | `ai-run-end`                     | Publishes a terminal                                            |
| `suspendRun` | `ai-run-suspend`                 | Parks the run awaiting client input                             |
| `cleanupRun` | `ai-run-end{error}`              | Closes a run whose turn failed, so a waiting client unsticks    |

The plugin registers all four, so none of them appear in your code. Two carry
subtleties worth knowing: `openRun` pins the run id to the invocation id, which
is what makes a retry re-enter the same run rather than opening a second one in
parallel; and `cleanupRun` reads no wire state before publishing, so it ends the run
`error` whatever state the run was in. On an already-ended run that costs a
second `ai-run-end` a reader ignores. On a run the workflow had parked with
`suspend`, it replaces the park with an error terminal — see the note on
`cleanup` below.

## Worker setup

The plugin takes whichever codec your agent publishes with — nothing here reads
a codec's wire types, so the Vercel one below is an example rather than a
requirement.

```ts
import { NativeConnection, Worker } from '@temporalio/worker';
import { createAblyTransportPlugin } from '@ably/ai-transport/temporal';
import { createUIMessageCodec } from '@ably/ai-transport/vercel';

import * as activities from './activities.js'; // YOUR inference and tool activities

const worker = await Worker.create({
  connection,
  taskQueue: 'my-agent',
  workflowsPath: require.resolve('./workflows'),
  activities,
  plugins: [
    createAblyTransportPlugin({
      codec: createUIMessageCodec(),
      createClient: () => new Ably.Realtime({ key: process.env.ABLY_API_KEY }),
    }),
  ],
});
```

`createClient` is required: the SDK never reads your environment or builds Ably
clients for you. It is called once per activity, and the client is closed before
the activity returns. Leave `echoMessages` at its default — `openRun` completes
on the opening event arriving back over the subscription, so a client that does
not echo its own publishes leaves the activity waiting for its timeout. A client per activity is a correctness requirement, not
tidiness — a transport takes its channel from `client.channels.get(name)`, which
caches per name, and detaching that channel detaches it for every holder, so two
transports sharing a client on one channel would break each other.

Other options: `logger`, `heartbeat` (off by default; turn it on if conversations
are long enough that paging history could look like a hang), `maxHistoryPages`
and `historyPageSize`.

## Workflow

```ts
import { proxyActivities } from '@temporalio/workflow';
import { withRun } from '@ably/ai-transport/temporal/workflow';

const { runInferenceStep, runToolStep } = proxyActivities<typeof activities>({
  startToCloseTimeout: '5 minutes',
  retry: { maximumAttempts: 3 },
});

export async function chatWorkflow(input: ChatWorkflowInput): Promise<void> {
  await withRun(input.invocation, async (run) => {
    let outcome = await runInferenceStep({ ids: run.ids, invocation: input.invocation });

    while (outcome.kind === 'server-tools') {
      for (const call of outcome.serverToolCalls) {
        await runToolStep({ ids: run.ids, invocation: input.invocation, toolCall: call });
      }
      outcome = await runInferenceStep({ ids: run.ids, invocation: input.invocation });
    }
  });
}
```

`withRun` opens the run, runs the body, and on a failure makes a **best-effort
attempt to close the run**. That attempt is the reason to use it: an unclosed run
leaves the browser waiting on a stream that never ends, and remembering to clean
up by hand is the easiest part of a durable agent to forget. It runs in a
non-cancellable scope, so it still fires when the workflow itself is cancelled or
terminated.

Best-effort is literal, and deliberate. Cleanup gets one attempt with a short
timeout, because retrying would let a hanging cleanup hold up a terminate; it
no-ops when the run is already terminal or parked suspended; and its own failure
is swallowed so the body's error reaches Temporal unmasked. It also only fires on
a throw — a body that returns without publishing a terminal leaves the run open.

"Opens the run" covers two cases: a fresh turn creates one, and a continuation
resumes the run its trigger names (`ai-run-start` versus `ai-run-resume`). It is
not always a new run.

On success `withRun` publishes nothing — see below.

`invocationId` defaults to the workflow id, which is right when you start one
workflow per POST, as the demo does. Pass it explicitly when one workflow serves
several turns: the workflow id is the same for all of them, so every turn would
otherwise merge onto the first one's run. Whatever you pass must be the id the
client was handed. Nothing validates it, and if the two diverge a retry opens a
second parallel run on the same channel.

### Activity options

Timeouts and retry policies come from workflow code, per activity, over a
`default`. They cannot come from plugin options: the workflow sandbox cannot read
worker-process state and stay deterministic.

```ts
await withRun(
  invocation,
  {
    activityOptions: {
      default: { startToCloseTimeout: '2 minutes' },
      openRun: { retry: { maximumAttempts: 5 } },
    },
  },
  body,
);
```

`cleanupRun` defaults to one attempt with a 30-second timeout, so a hanging
cleanup cannot hold up a terminate.

## Where to publish a terminal

Both styles are safe. They differ only in cost.

**Inside the activity that ran the work (cheapest).** Your inference activity
already holds the run handle, so `run.end(...)` or `run.suspend()` there costs
nothing extra. This is what the `temporal-agent` demo does.

**From the workflow, via the handle.** `run.end({ reason })` and `run.suspend()`
put the whole lifecycle in one place and show every terminal in the Temporal
history. Each call is a fresh process, so it pays a new connection and an
`adoptRun`. That is a bounded cost, not one that grows with response length: a
streamed response is a single Ably message that grows by append, so paging back
to the run's start stays a handful of messages per turn.

## Troubleshooting

**"activity type not registered"** on the first turn means the workflow imported
the shim but the worker never registered the plugin. Add
`plugins: [createAblyTransportPlugin({ ... })]` to `Worker.create`.

**Consuming the SDK through a local link?** The shim imports
`@temporalio/workflow`, and Node resolves that from the link's real path, so
webpack can bundle two copies. Temporal's runtime classes use private fields, so
a `CancellationScope` built by one copy cannot be read by the other
("Cannot read private member #cancelRequested"). Alias the package to one copy in
`bundlerOptions.webpackConfigHook`; see
`demo/temporal/temporal-agent/src/worker/bundler.ts`. Installing from
npm never hits this, because the peer dependency resolves to a single copy.

## `stepIdFor`

`stepIdFor(invocationId)` gives you a globally-unique `stepId` for
`run.createStep({ stepId })`. It is workflow-scoped, so multiple workflows can
publish to the same run (a suspend plus its continuation) without their step-1s
colliding.

```ts
import { stepIdFor } from '@ably/ai-transport/temporal';

const step = run.createStep({ stepId: stepIdFor(input.ids.invocationId) });
```

It reads `Context.current().info.activityId`, so call it inside an activity.

**Why workflow-scoped?** Temporal's `activityId` is unique within one workflow,
not across workflows. If two workflows both published under `step-id: "1"` on the
same run, the SDK's supersede semantics would eat the earlier attempt's output.
Prefixing with the invocation id keeps them distinct while still letting a retry
of the same activity coalesce cleanly.

## Maintaining the replay fixture

Because this package ships workflow-side code, an SDK upgrade changes code inside
workflows that are already running. `test/temporal/replay.temporal.test.ts`
replays a recorded history against the current shim and fails if they disagree.

If it fails, the shim's command sequence changed. Decide whether that is intended
— it means in-flight executions would break on upgrade — then re-record:

```sh
temporal server start-dev                       # in another terminal
pnpm tsx scripts/record-temporal-history.ts
```

The CLI is used deliberately: it emits canonical proto3 JSON, whereas the
in-process `fetchHistory()` returns an internal representation that does not
survive `JSON.stringify`.
