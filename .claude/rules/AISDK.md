# Vercel AI SDK

## AI SDK v6 specifics

- `AI.UIMessageChunk`'s `data-${string}` variant requires the `data` field (use `data: undefined` if no payload).
- `providerMetadata` uses `AI.SharedV3ProviderMetadata` (not `Record<string, Record<string, unknown>>`). It is NOT present on `tool-output-available` or `tool-output-error` chunk types.
- `streamText()` no longer has `maxSteps` — multi-step tool use is automatic.
- Get a `AI.UIMessageChunk` stream from `streamText()` via `.toUIMessageStream()`.
