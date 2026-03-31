# Core Codec Review — Actionable Findings

Review of the core codec layer (`src/core/codec/`) per [AIT-604](https://ably.atlassian.net/browse/AIT-604). Full checklist review in [REVIEW.md](REVIEW.md).

**Overall**: The core codec primitives are solid. No bugs found. Three actionable items below.

---

## 1. `clearScope` not called on error path (Medium)

**Location**: `src/vercel/codec/decoder.ts:280-283`

The lifecycle tracker's `clearScope` is called on `finish` and `abort` but not on `error`. If `error` is the last event in a turn (no subsequent `finish`), the scope entry leaks.

Likely intentional (Vercel protocol expects `finish` after `error`), but fragile if the server crashes or the stream ends on `error` alone. `clearScope` is idempotent — adding it defensively is harmless:

```typescript
const decodeError = (data: unknown, turnId: string, lifecycle: LifecycleTracker<AI.UIMessageChunk>): Out[] => {
  lifecycle.clearScope(turnId);
  const errorText = typeof data === 'string' ? data : '';
  return event({ type: 'error', errorText });
};
```

## 2. Missing test scenarios (Low)

Code is correct; these are coverage gaps from the checklist:

1. **Encoder**: Selective `appendMessage` failure for one of two concurrent streams — verify recovery runs only for the failed stream.
2. **Decoder**: `message.append` with no matching tracker and empty data — verify no crash.
3. **Decoder**: Two consecutive `finished` appends on the same serial — verify no double end-event.
4. **LifecycleTracker**: Phase `build` function that throws — verify propagation.
5. **EventEmitter**: No test file exists. Listener exception isolation should be tested.

## 3. EventEmitter internal API dependency (Low)

**Location**: `src/event-emitter.ts:78-83`

Accesses `Ably.Realtime.EventEmitter` via `as unknown as` cast — not part of Ably's public API. Documented with a `// CAST:` comment. Risk: a minor Ably SDK update could break this at runtime without compile-time warning.

Recommendation: add a comment noting the validated version (`ably@2.21.0`) and consider a runtime existence check.

## Observations from building a second codec

Building the Anthropic Agent SDK codec with zero core changes validated the architecture. Two improvement opportunities:

- **Lifecycle tracker `build()` ergonomics**: Forces complex SDK types to construct full `TEvent` objects (~25 lines + casts for Anthropic vs 1 line for Vercel). The tracker could report missing phases instead of constructing events.
- **`MessageAccumulator.messages` contract**: Not documented whether it returns a stable reference or a new array. Both implementations return stable references, but a JSDoc note would prevent accidental breakage.
