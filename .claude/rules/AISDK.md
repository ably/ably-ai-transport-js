# Vercel AI SDK

## Supported majors

The `ai` peer range is `^6 || ^7`, and CI typechecks and tests against both
(`test-ai-peer-range` in `.github/workflows/dev.yml`). Source must compile and
behave correctly on either major.

**Never name a chunk or part type that exists in only one major.** Naming a v7
variant in a `switch` is a compile error on v6 (`TS2678`), and the reverse holds
for anything v7 drops. Narrow structurally instead — the `data-*` wildcard descriptor in
`src/vercel/codec/outputs.ts` and the `part.type.startsWith('data-')` test in
`src/vercel/codec/inputs.ts` both key on the prefix rather than enumerating
everything that is _not_ a data part.

Exhaustiveness comes from the descriptor table, not from a `switch`: an output
type that is neither described nor an explicit `drop` throws at encode
(`src/core/codec/output-descriptor-encoder.ts`), so a variant a future major
adds fails loudly at runtime rather than being dropped silently.

**The merge is the SDK's, not ours.** Hydration replays chunks through the
provider's own reducer (`readUIMessageStream`) rather than reimplementing it;
the adapter only does the demultiplexing a reducer cannot do for itself. That
makes `ai` a runtime dependency of `src/`, not a types-only peer, so any value
imported from it must exist with the same signature in both supported majors.
`test-ai-peer-range` in CI is the only thing checking that.

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
  `kind`. Codec inputs carry `kind`, but so does v7's `custom` output chunk.
  The wire separates them by message name (`EVENT_AI_INPUT` / `EVENT_AI_OUTPUT`
  in `src/constants.ts`), and `defineCodec` binds each direction's descriptor
  table to its own name — so direction is resolved at decode by the message
  name, never by probing for `kind`.
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
