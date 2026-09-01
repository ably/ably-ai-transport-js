# Promises

## Async/await over promise chains

- **Use `async`/`await` with `try`/`catch`**, not `.then()`/`.catch()` chains.
- **Exceptions** (must be commented with the reason):
  - Fire-and-forget promises where `await` would block a value the caller needs now (e.g. `void collector.awaitRunId(…)` in the Vercel chat transport's `_send`: awaiting it would hold the stream back from useChat while the run id arrives over the channel).
  - `Promise.race` discriminants where `.then(() => value)` transforms a void promise into a tagged union member.
  - Fire-and-forget in HTTP handlers where the response is already sent and errors are unrecoverable.
