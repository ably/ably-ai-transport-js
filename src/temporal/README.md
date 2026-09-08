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

| Activity     | Publishes           | What it does                                                    |
| ------------ | ------------------- | --------------------------------------------------------------- |
| `openRun`    | `ai-run-start`      | Creates the run, finds its trigger in channel history, opens it |
| `endRun`     | `ai-run-end`        | Publishes a terminal                                            |
| `cleanupRun` | `ai-run-end{error}` | Closes a run whose turn failed, so a waiting client unsticks    |

Every run this plugin opens starts and ends. It parks none, so there is no
suspend activity, no `RunHandle.suspend()` and no continuation to resume. An
application that does want to park a run still can: an activity holding the core
run handle calls `run.suspend()` on it, which costs nothing extra there. What is
gone is the shim's way of parking one from workflow code.

The plugin registers all three, so none of them appear in your code. Two carry
subtleties worth knowing: `openRun` pins the run id to the invocation id, which
is what makes a retry re-enter the same run rather than opening a second one in
parallel; and `cleanupRun` reads no wire state before publishing, so it ends the run
`error` whatever state the run was in. On an already-ended run that costs a
second `ai-run-end` on the channel, which the shipped Vercel adapter absorbs
idempotently, and which a consumer merging the event stream itself should
absorb by honouring the first terminal in serial order.

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
the activity returns. `echoMessages` can be either setting: every framing
activity confirms its own publish from the acknowledgement and never reads its
own echo. A client per activity is a correctness requirement, not
tidiness — a transport takes its channel from `client.channels.get(name)`, which
caches per name, and detaching that channel detaches it for every holder, so two
transports sharing a client on one channel would break each other.

Other options: `logger`, `heartbeat`, `maxHistoryPages` and `historyPageSize`.

### `heartbeat` and Temporal-side cancellation

`heartbeat` is on by default, and it does two things rather than one.

The first is progress reporting, so a long history scan does not look like a
hang.

The second is why it defaults on. `@temporalio/activity` states the rule:
"Activities can only receive Cancellation if they emit heartbeats or are Local
Activities". Every framing activity passes
`Context.current().cancellationSignal` into the transport, so without a beat
that signal stays inert and a workflow cancelled through
`WorkflowHandle.cancel()`, the CLI or the Web UI does not reach the run until
the activity finishes on its own.

That is a separate path from the SDK's own `ai-cancel` message, which a client
publishes and the transport routes onto the run's `abortSignal`. That one works
regardless, because it arrives over the channel rather than from Temporal.

**`heartbeat: true` is a request, and the activity's own options decide whether
it is honoured.** `Info.heartbeatTimeoutMs` states the contract: "if this
timeout is defined, the Activity must heartbeat before the timeout is reached.
The Activity must **not** heartbeat in case this timeout is not defined." So the
pump reads that value per activity and stays silent without one, which means
the default costs nothing for an activity scheduled without a heartbeat
deadline. An activity scheduled without one reports it as `0` rather than
absent, so the gate tests for a positive value.

`withRun` supplies `heartbeatTimeout: '30 seconds'` for the three activities it
drives, so the pump beats out of the box and a Temporal-side cancel reaches a
running framing activity. Override it like any other activity option:

```ts
await withRun(invocation, { activityOptions: { default: { heartbeatTimeout: '1 minute' } } }, body);
```

Raising it raises the latency of a Temporal-side cancel with it: Core throttles
heartbeats to 0.8 of the timeout, so 30 seconds means beats flow about every 24.

**Do not set it below about 10 seconds.** The pump's interval is a fixed 5
seconds, and Core throttles a set timeout to 0.8 of it, so beats actually leave
every `max(5s, 0.8 × timeout)`. Below roughly 6 seconds that figure exceeds the
timeout itself and the activity fails its heartbeat deadline instead of
reporting faster. A short timeout buys no speed here; it only cuts the margin.

Two notes on that number. Temporal defines no default for
`ActivityOptions.heartbeatTimeout` — unset is a supported state, which is why
the worker carries a `defaultHeartbeatThrottleInterval` for that case. Its
default, 30 seconds, is the nearest Temporal-authored value for how often
heartbeats should flow when nobody said, so it is the one matched here. It is
copied rather than imported: nothing in `@temporalio/worker` exports it, and the
shim is workflow-side and cannot import worker code regardless.

`cleanupRun` is scheduled with no heartbeat timeout on purpose. It exists to run
while the workflow is being cancelled, so it wants no cancellation delivered to
it.

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
non-cancellable scope, so it still fires when the workflow itself is cancelled. A
_terminated_ workflow is beyond its reach: a terminate dispatches no further
workflow task, so no cleanup activity runs.

Best-effort is literal, and deliberate. Cleanup gets one attempt with a short
timeout, because retrying would let a hanging cleanup hold up a terminate; it
reads no wire state, so it publishes its error terminal over a run that already
ended too — a second `ai-run-end`, which a reader is expected to absorb by
honouring the first terminal. Its own failure is swallowed so the body's error
reaches Temporal unmasked. It also only fires on
a throw — a body that returns without publishing a terminal leaves the run open.

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
already holds the run handle, so `run.end(...)` there costs nothing extra. This
is what the `temporal-agent` demo does.

**From the workflow, via the handle.** `run.end({ reason })` puts the whole
lifecycle in one place and shows every terminal in the Temporal history. Each call is a fresh process, so it pays a new connection and an
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
publish to the same run without their step-1s
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
