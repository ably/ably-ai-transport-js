# Vercel AI SDK

## AI SDK v6 specifics

- `AI.UIMessageChunk`'s `data-${string}` variant requires the `data` field (use `data: undefined` if no payload).
- `providerMetadata` uses `AI.ProviderMetadata` (the public alias of the underlying `SharedV3ProviderMetadata` from `@ai-sdk/provider`; only the alias is exported from `ai`). It IS present (optional) on every chunk variant that carries it, including `tool-output-available` and `tool-output-error` — verify against the chunk type in `node_modules/ai/dist/index.d.ts` rather than guessing.
- `streamText()` replaces `maxSteps` with `stopWhen` (e.g. `stopWhen: stepCountIs(5)`). The default is `stepCountIs(1)` — multi-step tool use is **not** automatic; without `stopWhen`, the model calls the tool, the SDK runs it, then the stream ends with no final assistant text. Pass `stopWhen` whenever tools are configured. (`generateText` shares the same `stepCountIs(1)` default; the higher-level `ToolLoopAgent` defaults to `stepCountIs(20)`.)
- Get a `AI.UIMessageChunk` stream from `streamText()` via `.toUIMessageStream()`.
