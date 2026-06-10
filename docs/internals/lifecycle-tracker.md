# Lifecycle tracker

The lifecycle tracker (`src/core/codec/lifecycle-tracker.ts`) ensures that required lifecycle events are emitted before content events, even when a client joins mid-stream. It synthesizes missing events so that consumers always see a well-formed event sequence - start before deltas, start-step before content.

## The problem

When a client subscribes to a channel mid-stream (reconnect, late join, second client), the [decoder](decoder.md#first-contact) reconstructs stream state from the current message content. But the decoder only handles the stream-level lifecycle (start → delta → end). The higher-level message lifecycle (start → start-step → content → finish-step → finish) is composed of discrete events that may have already been published and lost.

Without the lifecycle tracker, a late-joining client would see text deltas without a preceding `start` event. The [reducer](codec-interface.md#reducer-and-projection) would have no message to fold the deltas into, and the events would be silently dropped.

## How it works

The tracker is configured with an ordered list of **phases** - lifecycle events that must precede content. Each phase has a key and a build function that produces synthetic events:

```typescript
const tracker = createLifecycleTracker<UIMessageChunk>([
  {
    key: 'start',
    build: (ctx) => [{ type: 'start', messageId: ctx.messageId }],
  },
  {
    key: 'start-step',
    build: () => [{ type: 'start-step' }],
  },
]);
```

Phases are scoped by an arbitrary string key - typically a [run ID](glossary.md#run-id-vs-invocation-id-vs-message-id). Each scope tracks independently which phases have been emitted.

### ensurePhases

Called before processing content events. Returns synthetic events for any phases not yet marked as emitted, then marks them. Returns an empty array if all phases are current.

```
ensurePhases("run-1", { messageId: "msg-abc" })
  → first call:  [{ type: 'start', messageId: 'msg-abc' }, { type: 'start-step' }]
  → second call: []  (all phases already emitted)
```

### markEmitted

Called when the real event arrives from the wire, so the tracker doesn't re-synthesize it. The [Vercel decode lifecycle policy](vercel-codec.md) calls this from its `onDiscrete` entries when a `start` or `start-step` event is decoded.

### resetPhase

Resets a phase so it will be re-synthesized on the next `ensurePhases()` call. Used for repeating phases - the Vercel codec resets `start-step` after each `finish-step`, because multi-step runs require a new `start-step` before each step's content.

### clearScope

Removes all tracking state for a scope. Called on run completion (`finish`, `error`, `abort`) to free memory.

## Operations

| Method                           | What it does                                                    |
| -------------------------------- | --------------------------------------------------------------- |
| `ensurePhases(scopeId, context)` | Returns synthetic events for missing phases, marks them emitted |
| `markEmitted(scopeId, phaseKey)` | Marks a phase as received from the wire                         |
| `resetPhase(scopeId, phaseKey)`  | Resets a phase for re-emission (repeating phases)               |
| `clearScope(scopeId)`            | Removes all state for a scope                                   |

## Wiring the tracker: the decode lifecycle policy

A codec no longer calls the tracker from hand-written decoder hooks. Instead it supplies `defineCodec` with a `decodeLifecycle` factory - a function returning a `LifecyclePolicy<TOutput>` (`src/core/codec/define-codec.ts`). `defineCodec` invokes the factory once per decoder instance, so each decoder gets its own tracker and independent per-run phase state. The policy is the seam where the tracker plugs into the generic [descriptor-driven decoder](decoder.md); the descriptor driver always runs after the policy, and the policy's returned events are **prepended** to the driver's output - the policy never replaces a decode.

```typescript
interface LifecyclePolicy<TOutput> {
  // keyed on the discrete codec `kind`; runs a tracker side effect and returns lead-in events to prepend.
  // LifecycleDiscreteContext carries the inbound codec headers (e.g. to recover a stream's message id).
  onDiscrete?: Record<string, (runId: string, ctx: LifecycleDiscreteContext) => TOutput[]>;
  // lead-in prepended to a stream's start events (the mid-stream-join pre-roll)
  onStreamStart?: (runId: string, tracker: StreamTrackerState) => TOutput[];
}
```

## Vercel codec usage

The Vercel decode lifecycle (`src/vercel/codec/decode-lifecycle.ts`, `createVercelDecodeLifecycle`) builds a tracker with two phases - `start` and `start-step` - and returns a policy that drives it:

- **`onStreamStart`** - calls `ensurePhases()` with the run ID and the `messageId` recovered from the stream tracker's codec headers. Any missing lifecycle events are prepended ahead of the stream's `start` events.
- **`onDiscrete['tool-input']`** - also calls `ensurePhases()` (a tool-input discrete needs the same `start` / `start-step` pre-roll).
- **`onDiscrete.start`** - `markEmitted(runId, 'start')`
- **`onDiscrete['start-step']`** - `markEmitted(runId, 'start-step')`
- **`onDiscrete['finish-step']`** - `resetPhase(runId, 'start-step')` (next step needs a new start-step)
- **`onDiscrete.finish` / `.error` / `.abort`** - `clearScope(runId)`

This means a mid-stream join produces the sequence: synthetic `start` → synthetic `start-step` → real `text-delta` (from decoder first-contact) - which the reducer can process correctly.

## Design

The tracker is generic - it knows nothing about Vercel's event types or the specific phases. Codecs configure it with their own phase list and drive it from a `LifecyclePolicy`. The `context` parameter passes through codec-specific data (like `messageId`) without the tracker needing to interpret it.

See [Decoder](decoder.md) for how the decoder core handles stream-level reconstruction (first-contact, prefix-match). See [Vercel codec](vercel-codec.md) for the full Vercel decoder integration. See [Codec interface: reducer and projection](codec-interface.md#reducer-and-projection) for how folded events build messages.
