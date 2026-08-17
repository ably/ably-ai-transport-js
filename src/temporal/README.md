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

Three things: the framing activities, a scaffold for your own activities, and the
worker's pool of Ably connections.

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
parallel; and `cleanupRun` status-gates before publishing, so it quietly does
nothing when the run already finished or is parked suspended.

## Worker setup

Build the plugin in its own module, because your activities module needs it too
and your worker entry already imports that:

```ts
// ably-transport.ts
import { createAblyTransportPlugin } from '@ably/ai-transport/temporal';
import { createUIMessageCodec } from '@ably/ai-transport/vercel';

export const ablyTransport = createAblyTransportPlugin({
  codec: createUIMessageCodec(),
  createClient: () => new Ably.Realtime({ key: process.env.ABLY_API_KEY }),
});
```

```ts
// worker.ts
import { NativeConnection, Worker } from '@temporalio/worker';
import { ablyTransport } from './ably-transport.js';
import * as activities from './activities.js'; // YOUR inference and tool activities

const worker = await Worker.create({
  connection,
  taskQueue: 'my-agent',
  workflowsPath: require.resolve('./workflows'),
  activities,
  plugins: [ablyTransport],
});
```

`createClient` is required: the SDK never reads your environment or builds Ably
clients for you. It is called only when the plugin's connection pool has none
idle, so it is not once per activity.

Other options: `logger`, `maxIdle`, `maxHistoryPages` and `historyPageSize`.

## Wrapping your own activities

`ablyTransport.activity(...)` writes the preamble every activity in a durable
agent needs. It leases a connection, connects a session, adopts the run the
workflow is threading, loads it, and tears all of that down whether the body
returns or throws.

```ts
import { ablyTransport } from './ably-transport.js';

export const runInferenceStep = ablyTransport.activity(
  { history: 'full' },
  async ({ run }, input: RunActivityInput) => {
    // `run` is typed from the codec you configured. No type arguments needed.
    const result = streamText({ model, messages: run.view.getMessages().map((m) => m.message) });
    // …
  },
);
```

One option, `history`, which defaults to `'minimal'`. Pass `'full'` to page the
whole conversation in first, which an inference body needs and a tool body does
not.

**One activity is one step.** The scaffold opens a started step before the body
runs and closes it after, under an id derived from the Temporal activity id, so
there is nothing to write for the tool case:

```ts
export const runToolStep = ablyTransport.activity(
  async ({ step }, input: RunActivityInput & { toolCall: ToolCall }) => {
    const output = await tools[input.toolCall.toolName].execute(input.toolCall.input);
    await step.send({ type: 'tool-output-available', toolCallId: input.toolCall.toolCallId, output });
  },
);
```

The close derives its reason from what was piped: `failed` if any pipe errored,
`complete` otherwise. Close the step yourself when you need a different reason —
`finishStep(step, outcome)` does, and it is how a cancelled turn gets a
`cancelled` step. The scaffold's own close is then a no-op, because `end` is
idempotent.

A body that throws leaves the step **open**, deliberately. Temporal retries the
activity under the same `stepId`, and the retry supersedes the failed attempt's
output; a closed step would have nothing to supersede.

**Annotate the `input` parameter.** The activity's input type is inferred from
that annotation, and the returned function is typed to match. Omitting it widens
the input to `RunActivityInput`, and nothing warns you.

Two things come free with the wrapper, and they are the reason to prefer it over
writing the preamble by hand. The run is adopted with the activity's cancellation
signal, and the body runs under the heartbeat pump. Those only work together: see
below.

## Heartbeating, and why cancellation depends on it

Every activity the SDK runs heartbeats, and there is no way to turn it off.
Temporal reports a cancellation request only in the response to a heartbeat, so an
activity that does not heartbeat never learns it was cancelled, and the
cancellation signal the SDK passes into its run can never fire. The framing
activities also declare a `heartbeatTimeout`, which Temporal enforces from
activity start, so a pump is required rather than optional.

How quickly a cancel arrives is set by throttling, not by the pump's interval.
Temporal throttles reports to 80% of the activity's `heartbeatTimeout`, and to 30
seconds when there is no `heartbeatTimeout`. So **declare one in your
`proxyActivities` options**:

```ts
const { runInferenceStep } = proxyActivities<typeof activities>({
  startToCloseTimeout: '5 minutes',
  heartbeatTimeout: '10 seconds', // cancel latency ~8s instead of 30s
  retry: { maximumAttempts: 3 },
});
```

It earns its place twice: it also gives Temporal a local timer, so a wedged
activity fails in seconds rather than at `startToCloseTimeout`.

The framing activities and anything wrapped by `activity()` heartbeat for you. An
activity you write by hand does not, so it needs its own pump.

Note that a cancel from the browser needs none of this. That arrives as
`ai-cancel` on the channel and the session routes it to `run.abortSignal` without
Temporal's involvement. What heartbeating fixes is cancelling or terminating the
workflow from Temporal's side.

## Connection pooling

The plugin holds a pool of Ably connections for the life of `worker.run()`, so an
activity leases a live connection instead of paying a WebSocket handshake and an
auth round trip. `maxIdle` sets how many connections stay open between activities,
and defaults to 4. Set it to `0` to close every connection on release, which
disables reuse.

Concurrency is never capped: a burst larger than the pool opens fresh connections
rather than queueing. During a burst the open count reaches peak concurrency;
between bursts it settles at `maxIdle`.

A lease is **exclusive and owns one channel name**, which is the safety argument.
A session takes its channel from `client.channels.get(name)`, which caches per
name, and detaching a session detaches that channel — so two concurrent sessions
sharing a client on one channel would tear each other down. An exclusive lease
makes that unreachable.

A connection is only handed out again when ably-js dropped its channel
synchronously and the connection is still connected. Both are checked when the
lease comes back, and the connected check runs again when the next lease takes it,
because a parked connection can drop while nobody holds it. Either check failing
closes the connection, so the fallback costs one handshake.

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
otherwise fold onto the first one's run. Whatever you pass must be the id the
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

Every framing activity also carries a 10-second `heartbeatTimeout` by default,
which is what makes a cancel reach it.

## Where to publish a terminal

Both styles are safe. They differ only in cost.

**Inside the activity that ran the work (cheapest).** Your inference activity
already has the run loaded, so `run.end(...)` or `run.suspend()` there costs
nothing extra. This is what the `use-client-session-temporal` demo does. With the
Vercel codec, `finishRun(run, outcome)` routes a `VercelRunOutcome` to the right
call, and `finishStep(step, outcome)` closes the step with the matching reason.

**From the workflow, via the handle.** `run.end({ reason })` and `run.suspend()`
put the whole lifecycle in one place and show every terminal in the Temporal
history. Each call is a separate activity, so it pays a fresh adopt and `load()`
(though not a fresh connection, since the pool supplies one). That is a bounded
cost, not one that grows with response length: a streamed response is a single
Ably message that grows by append, so paging back to the run's start stays a
handful of messages per turn.

## Troubleshooting

**"activity type not registered"** on the first turn means the workflow imported
the shim but the worker never registered the plugin. Add `plugins: [ablyTransport]`
to `Worker.create`.

**A workflow cancel does nothing.** The activity is not heartbeating. Check that
its `proxyActivities` options declare a `heartbeatTimeout`, and that the body is
wrapped by `ablyTransport.activity(...)` rather than hand-written.

**Consuming the SDK through a local link?** The shim imports
`@temporalio/workflow`, and Node resolves that from the link's real path, so
webpack can bundle two copies. Temporal's runtime classes use private fields, so
a `CancellationScope` built by one copy cannot be read by the other
("Cannot read private member #cancelRequested"). Alias the package to one copy in
`bundlerOptions.webpackConfigHook`; see
`demo/temporal/use-client-session-temporal/src/worker/bundler.ts`. Installing from
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
