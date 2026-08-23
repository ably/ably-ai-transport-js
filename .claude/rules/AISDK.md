# Vercel AI SDK

## Supported majors

The `ai` peer range is `^6 || ^7`, and CI typechecks and tests against both
(`test-ai-peer-range` in `.github/workflows/dev.yml`). Source must compile and
behave correctly on either major.

**Never name a chunk or part type that exists in only one major.** Naming a v7
variant in a `switch` is a compile error on v6 (`TS2678`), and the reverse holds
for anything v7 drops. Narrow structurally instead — see `VercelToolOutputChunk`
in `src/vercel/codec/events.ts`, which selects the tool-output chunks by their
`tool-output-` prefix rather than naming each variant.

The trade-off is deliberate: a prefix test cannot give exhaustiveness checking,
so a chunk type added by a future major is silently included (or, in a
prefix-gated read, silently skipped) rather than failing the build. Pin the
knowingly-unhandled set in a test where the gap would otherwise go unnoticed.

**Do not assert the AI SDK's internal accounting.** Callback call-counts, log
output and similar implementation details move between AI SDK releases —
including within a single major, via patch bumps. Assert the property that
matters to this SDK (a stream is consumed, a message lands, ordering holds) and
let their bookkeeping vary. A test that pins an exact count is testing their code
and will break on an upgrade that changed nothing here.

## Cross-major gotchas

- `AI.UIMessageChunk`'s `data-${string}` variant requires the `data` field (use
  `data: undefined` if no payload).
- `providerMetadata` is `AI.ProviderMetadata`, not
  `Record<string, Record<string, unknown>>`. Always reference the exported alias:
  it resolves to a different underlying `SharedV*ProviderMetadata` per major.
  It is NOT present on `tool-output-available` or `tool-output-error` chunks.
- `streamText()` has no `maxSteps` — multi-step tool use is automatic.
- Do not discriminate an input event from an output chunk by the presence of
  `kind`. Codec inputs carry `kind`, but so does v7's `custom` output chunk. The
  wire separates them by message name (`ai-input` / `ai-output`), and the
  decoder returns them as separate `inputs` / `outputs` halves; use those.
- Getting a `AI.UIMessageChunk` stream from `streamText()` differs by major: v6
  offers `result.toUIMessageStream()`, which v7 deprecates in favour of the
  standalone `toUIMessageStream({ stream })`. Demos pin a single major and may
  use either; SDK source does not call it at all.

## Demos pin one major

Dual support holds for the published package because its `ai` surface is small
and every type in it changed additively across v6 → v7. That is not true of the
AI SDK generally — `ToolExecutionOptions`, for instance, gained both a required
type parameter and a required `context` property in v7, so no single spelling
compiles on both. Each demo therefore pins one `ai` major in its own
`package.json` and is free to use that major's spelling.
