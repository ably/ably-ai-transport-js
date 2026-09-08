# `@ably/ai-transport/temporal`

This package streams the output of agents running on Temporal to clients over Ably. Temporal provides the durable execution to run your agent, and Ably provides the durable transport to deliver the agent's responses to clients at scale. Your Temporal activities publish their output straight to the browser over an Ably channel, and when Temporal retries an activity, the retry's output replaces the output of the attempt that failed.

## What you get

- **Streaming from activities.** An activity publishes tokens to every client in the conversation as the model produces them. Nothing proxies through Temporal, a database, or your own API server.
- **Clean retries.** When Temporal retries a failed activity, the retry's output supersedes the failed attempt's output in the conversation, so the user never sees the failed attempt.
- **Recovery on the client.** Messages arrive in order, and a client that reconnects or joins late reads the stream back without gaps.
- **Cancel and steer over the channel.** A client cancels a run mid-stream, or sends a follow-up message to steer the agent's output, and the activity holding the run receives it over the same channel.
- **The run lifecycle handled for you.** The plugin opens the run when your workflow starts, and if your workflow fails it ends the run with an error. When your workflow succeeds, your own code ends the run from wherever the last output was published.

## The two main concepts

- A **run** is one turn, from the user's prompt to the agent's answer. Every run opens with an `ai-run-start` message and ends with an `ai-run-end` message. Clients wait on that end message to know the turn is over and the agent has finished responding.
- A **step** is one unit of output within a run, and maps to one Temporal activity. Steps have a step id, and a retrying activity publishes its new output under the same step id as the failed activity to indicate that the second output supersedes the first.

The plugin opens and closes the run, and you write the Temporal activities that do the agent's work, such as calling the model and running tools. Each of those activities publishes its output to the run as a step.

## Entry points

There are two entry points, split by where the code runs:

| Import                                 | Runs on              | Contains                                                                 |
| -------------------------------------- | -------------------- | ------------------------------------------------------------------------ |
| `@ably/ai-transport/temporal`          | the worker           | `createAblyTransportPlugin`, `createActivityHelpers`, the activity types |
| `@ably/ai-transport/temporal/workflow` | the workflow sandbox | `withRun`, `openRun`, `RunHandle`                                        |

Workflow code must import from the `/workflow` entry point. The worker entry point uses `ably` and `@temporalio/activity`, and neither is allowed to exist inside Temporal's workflow sandbox, because Ably does network I/O and Temporal forbids I/O in workflow code so that it can replay a workflow deterministically.

## Install

```sh
npm install @ably/ai-transport ably @temporalio/activity @temporalio/worker @temporalio/client @temporalio/workflow
```

`@temporalio/activity`, `@temporalio/worker` and `@temporalio/workflow` are optional peer dependencies of `@ably/ai-transport`. You need them when you import from `/temporal`.

## What the plugin registers

The plugin registers three activities on your worker. `withRun` schedules them from your workflow, and they show in your Temporal history under these names.

| Activity     | Publishes                  | What it does                                                                    |
| ------------ | -------------------------- | ------------------------------------------------------------------------------- |
| `openRun`    | `ai-run-start`             | Finds the message that started the turn in channel history and opens the run    |
| `endRun`     | `ai-run-end`               | Ends the run                                                                    |
| `cleanupRun` | `ai-run-end` with an error | Ends a run whose workflow failed, so a client waiting on the stream is released |

A retry of `openRun` re-enters the same run. If the worker crashes after the run opened, the retried activity picks that run up and your workflow continues in it, so clients see one run. The retry's `ai-run-start` carries the same Ably message id as the first, so Ably drops it and the channel holds one start.

`cleanupRun` ends the run with an error whatever state the run is in. If one of your activities had already ended the run, the cleanup arm's `ai-run-end` carries the same message id as the one already on the channel, so Ably drops it and the terminal your activity published stands. Ably deduplicates for two minutes after the first publish, so a cleanup that lands later than that puts a second `ai-run-end` on the channel. If you merge the event stream yourself, treat the first `ai-run-end` as the end of the run and ignore any later one.

## Worker setup

The worker takes a codec. Codecs translate your event format into Ably messages and back again. There are built-in codecs for the Vercel AI SDK in `@ably/ai-transport/vercel` and for OpenAI in `@ably/ai-transport/openai`, and you can define a custom codec for your own event structure.

The plugin's options are the codec and a function that builds an Ably client. Put them in a module of their own, because your own activities use the same options later on:

```ts
// transport.ts
import * as Ably from 'ably';
import type { ActivityHelpersOptions } from '@ably/ai-transport/temporal';

import { codec } from './codec.js'; // the codec your agent publishes with

export const transportOptions: ActivityHelpersOptions<MyInput, MyOutput> = {
  codec,
  createClient: () => new Ably.Realtime({ key: process.env.ABLY_API_KEY }),
};
```

Register the plugin in `Worker.create` with those options:

```ts
import { NativeConnection, Worker } from '@temporalio/worker';
import { createAblyTransportPlugin } from '@ably/ai-transport/temporal';

import * as activities from './activities.js'; // your inference and tool activities
import { transportOptions } from './transport.js';

const connection = await NativeConnection.connect({ address: 'localhost:7233' });

const worker = await Worker.create({
  connection,
  taskQueue: 'my-agent',
  workflowsPath: require.resolve('./workflows'),
  activities,
  plugins: [createAblyTransportPlugin(transportOptions)],
});
```

`createClient` is required, and the plugin calls it once per activity. Return a new `Ably.Realtime` each time, because two activities sharing one client would share one channel object and one activity closing would detach the other's channel. The plugin closes each client before its activity returns. `echoMessages` can be on or off.

The other options are `logger`, `heartbeat`, `maxHistoryPages` and `historyPageSize`. The heartbeat section below covers `heartbeat`.

## Workflow

Your workflow wraps its operations in `withRun`. The workflow below is a sketch: `callModel` and `runTool` stand for your own activities, and the loop is your own agent logic.

```ts
import { proxyActivities } from '@temporalio/workflow';
import type { InvocationData } from '@ably/ai-transport';
import { withRun } from '@ably/ai-transport/temporal/workflow';

import type * as activities from './activities.js';

// Your activities, proxied as usual. Each one adopts the run from `ids`,
// publishes its output as a step, and returns what the workflow needs to
// decide what to do next.
const { callModel, runTool } = proxyActivities<typeof activities>({
  startToCloseTimeout: '5 minutes',
  retry: { maximumAttempts: 3 },
});

export async function chatWorkflow(input: { invocation: InvocationData }): Promise<void> {
  // `withRun` opens the run before the body starts, and ends it with an
  // error if the body throws. `run.ids` carries the run's identity, and
  // every activity needs it to publish into the run.
  await withRun(input.invocation, async (run) => {
    // Call the model once. The activity streams the model's output to the
    // client as a step and returns any tool calls the model asked for.
    let result = await callModel({ ids: run.ids, invocation: input.invocation });

    // While the model wants tools, run them and call the model again. Each
    // tool result is its own step, so a retry of a failed tool replaces
    // only that tool's output.
    while (result.toolCalls.length > 0) {
      for (const call of result.toolCalls) {
        await runTool({ ids: run.ids, invocation: input.invocation, toolCall: call });
      }
      result = await callModel({ ids: run.ids, invocation: input.invocation });
    }

    // The turn is over. `callModel` ended the run inside the activity, so
    // there is nothing left to publish here.
  });
}
```

`withRun` opens the run, runs your code, and if your code throws it ends the run with an error. Without that cleanup, a failed turn leaves the browser waiting on a stream that never ends. The cleanup runs even when the workflow is cancelled. A terminated workflow gets no cleanup, because Temporal runs no more of a terminated workflow's code.

The cleanup is best-effort: it gets one attempt with a 30 second timeout, so a hanging cleanup cannot hold up a terminate. If the cleanup fails, your code's error still reaches Temporal unchanged. It runs only when your code throws, so code that returns without ending the run leaves the run open.

On success `withRun` publishes nothing. Your code ends the run, and the section on where to end the run covers the two places to do it.

### Inside an activity

Every activity runs in a fresh process, so each one has to build an Ably client and a transport, re-enter the run, publish, and close both afterwards. `createActivityHelpers` takes the same options as the plugin and returns three functions that do that for you, each built on the one before:

- `withAgentTransport(invocation, body)` builds an Ably client and a connected agent transport on the invocation's channel, runs your body with them, and closes both afterwards.
- `withRun(input, body)` does that and then adopts the run named by `input.ids`, or opens a run when `input` carries an `invocationId` instead, and hands your body the run and its identity.
- `withStep(input, body)` does that and wraps your body in one step keyed on the Temporal activity id. It ends the step when your body returns, ends it as failed and rethrows when your body throws, and leaves the step alone if your body already ended it or ended the run, which closes the step too. It never ends the run.

Add the helpers to the module that holds the plugin options. They cannot live in the module you hand to `Worker.create({ activities })`, because Temporal registers every export of that module as an activity.

```ts
// transport.ts, continued
import { createActivityHelpers } from '@ably/ai-transport/temporal';

export const { withStep } = createActivityHelpers(transportOptions);
```

The `callModel` activity from the workflow above then looks like this:

```ts
import type { InvocationData, RunIdentity } from '@ably/ai-transport';

import { streamModel } from './model.js'; // your model call, returning a stream of your codec's output events
import { withStep } from './transport.js';

export async function callModel(input: { ids: RunIdentity; invocation: InvocationData }) {
  return withStep(input, async ({ step, run }) => {
    // The step is keyed on this activity's id. A retry of this activity has
    // the same id, so the retry's output supersedes this attempt's output in
    // the conversation.
    const { stream, toolCalls } = await streamModel(run.abortSignal);
    await step.pipe(stream);

    // When the model asked for no tools the turn is over, so end the run
    // here, where the transport is already connected.
    if (toolCalls.length === 0) await run.end({ reason: 'complete' });
    return { toolCalls };
  });
}
```

`withStep` adopts the run with the activity's cancellation signal, so a Temporal cancel aborts the model call through `run.abortSignal`. To react to a client's cancel or steering message, or to keep an activity out of Temporal's cancellation, pass hooks between the input and the body:

```ts
await withStep(input, { onSteer: handleSteer, cancellable: false }, async ({ step }) => {
  // ...
});
```

Temporal activity ids are unique within one workflow, and every run the plugin opens belongs to one workflow from start to end, so the activity id alone identifies the step within its run.

The workflow's `withRun` from the `/workflow` entry point and the activity helper's `withRun` share a name because they do the same job at different scopes. The workflow's wraps a whole turn and schedules the plugin's activities. The activity helper's wraps one activity and works on the run directly.

### Using the run handle from workflow code

`withRun` gives your code a `RunHandle`. It holds `ids`, the run's identity to pass to your activities, and two methods that each schedule one of the plugin's activities:

- `run.end({ reason })` ends the run from workflow code. It schedules `endRun`, and an `errorMessage` goes with it when the reason is `'error'`.
- `run.cleanup(errorMessage)` ends the run with an error. `withRun` calls this for you when your code throws.

`openRun` returns the same handle without the cleanup, for a workflow that wants to own the failure path itself:

```ts
import { openRun } from '@ably/ai-transport/temporal/workflow';

export async function chatWorkflow(input: { invocation: InvocationData }): Promise<void> {
  const run = await openRun(input.invocation);
  try {
    const result = await callModel({ ids: run.ids, invocation: input.invocation });
    await run.end({ reason: result.cancelled ? 'cancelled' : 'complete' });
  } catch (error) {
    await run.cleanup(error instanceof Error ? error.message : undefined);
    throw error;
  }
}
```

### The invocation id

The invocation id identifies one turn, and the plugin uses it as the run's id. You choose it when you start the workflow: generate a fresh id per turn, start the workflow with it as the workflow id, and `withRun` reads it back from `workflowInfo().workflowId`:

```ts
const invocationId = crypto.randomUUID();
await client.workflow.start('chatWorkflow', { workflowId: invocationId, taskQueue, args: [{ invocation }] });
```

If your workflow id is something else, pass `invocationId` to `withRun` yourself:

```ts
await withRun(input.invocation, { invocationId: input.turnId }, body);
```

Whichever way you supply it, the id has to stay the same across retries of the workflow's activities and differ between turns. The plugin does not validate it, so an id that changes between attempts opens a second run on the same channel.

### Activity options

To set timeouts and retry policies for the plugin's activities, pass `activityOptions` to `withRun` or `openRun`. `default` applies to all three activities, and an entry named after an activity overrides `default` for that one:

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

These options live in workflow code because the plugin cannot set them: workflow code cannot read the worker's configuration and stay deterministic. The defaults are:

- `openRun` and `endRun`: a 2 minute `startToCloseTimeout`, a 30 second `heartbeatTimeout`, and 3 attempts.
- `cleanupRun`: a 30 second `startToCloseTimeout`, no `heartbeatTimeout`, and 1 attempt.

## Where to end the run

You end the run in one of two places:

- **Inside the activity that published the last output.** The activity already holds the run, so `run.end(...)` there costs nothing extra. The `callModel` activity above does this.
- **From the workflow, with `run.end({ reason })`.** This keeps the whole lifecycle in workflow code and shows the end of every run in the Temporal history. Each call is its own activity, so it opens a new Ably connection and reconnects to the run. That cost stays small however long the response is, because a streamed response is one Ably message that grows by append, so the activity pages back through only a handful of messages to find the run.

## Heartbeats and cancellation from Temporal

Two different things can cancel a turn:

- A client publishes an `ai-cancel` message on the channel. The activity holding the run receives it on the run's `abortSignal`, with no heartbeat involved.
- Temporal cancels the workflow, through `WorkflowHandle.cancel()`, the CLI or the Web UI. Temporal delivers that cancel to an activity only while the activity heartbeats.

The plugin's activities heartbeat by default, so a Temporal cancel reaches them. The heartbeats also tell Temporal that a long history scan is still making progress.

Temporal allows an activity to heartbeat only when its options set a `heartbeatTimeout`. The workflow's `withRun` sets 30 seconds on `openRun` and `endRun`, so they heartbeat out of the box. An activity scheduled without a `heartbeatTimeout` gets no heartbeats whatever the `heartbeat` option says. Override the timeout like any other activity option:

```ts
await withRun(invocation, { activityOptions: { default: { heartbeatTimeout: '1 minute' } } }, body);
```

Your own activities heartbeat the same way when they run inside the activity helpers, and the same rule applies: set `heartbeatTimeout` in the `proxyActivities` options that schedule them. Without it, a Temporal cancel does not reach the model call until the activity times out. A client's `ai-cancel` over the channel is unaffected either way.

The timeout sets how quickly a Temporal cancel reaches the activity. Temporal sends a heartbeat about every 0.8 of the timeout, so 30 seconds means a cancel arrives within about 24 seconds. Keep the timeout at 10 seconds or more, because the plugin heartbeats every 5 seconds, so a timeout near 5 seconds gives the heartbeat no margin and a shorter one fails the activity on its heartbeat deadline.

`cleanupRun` is the exception, because it runs after you cancel the workflow to end the run and release the waiting client, so it must not itself be cancelled. It is scheduled with no heartbeat timeout for that reason, and a Temporal cancel does not reach it.

## Troubleshooting

**"activity type not registered"** on the first turn means the workflow imported `withRun` and the worker never registered the plugin. Add `plugins: [createAblyTransportPlugin({ ... })]` to `Worker.create`.

**"Cannot read private member #cancelRequested"** when consuming the SDK through a local link. The workflow entry point imports `@temporalio/workflow`, Node resolves that from the link's real path, and webpack bundles two copies. Temporal's runtime classes use private fields, so a `CancellationScope` built by one copy cannot be read by the other. Alias the package to one copy in `bundlerOptions.webpackConfigHook`, as `demo/temporal/temporal-agent/src/worker/bundler.ts` does. Installing from npm resolves the peer dependency to a single copy and never hits this.
