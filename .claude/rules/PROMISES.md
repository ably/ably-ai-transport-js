# Promises

## Async/await over promise chains

- **Use `async`/`await` with `try`/`catch`**, not `.then()`/`.catch()` chains.
- **Exceptions** (must be commented with the reason):
  - Fire-and-forget promises where `await` would block a value the caller needs now, and the awaited work reports its own failure by another route (an error event, or a stream the caller already holds). Comment which route carries the failure.
  - `Promise.race` discriminants where `.then(() => value)` transforms a void promise into a tagged union member.
  - Fire-and-forget in HTTP handlers where the response is already sent and errors are unrecoverable.
  - A no-op `.catch()` attached to a promise the caller may legitimately never await, so an ignored value cannot surface as an unhandled rejection. Comment where the failure does surface — the same promise still rejects for anyone who does await it.
