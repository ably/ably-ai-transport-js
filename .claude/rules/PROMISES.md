# Promises

## Async/await over promise chains

- **Use `async`/`await` with `try`/`catch`**, not `.then()`/`.catch()` chains.
- **Exceptions** (must be commented with the reason):
  - Fire-and-forget promises where `await` would block a return value (e.g. the fetch POST in `send()` must not delay the stream return).
  - `Promise.race` discriminants where `.then(() => value)` transforms a void promise into a tagged union member.
  - Fire-and-forget in HTTP handlers where the response is already sent and errors are unrecoverable.
