# Vercel AI SDK

## Supported majors

The `ai` peer range is `^6 || ^7`, and CI typechecks and tests against both
(`test-ai-peer-range` in `.github/workflows/dev.yml`). Source must compile and
behave correctly on either major.

**The codec's union is the SDK's `UIMessageChunk` plus the chunk types some
supported releases lack.** `VercelCrossMajorChunk` in
`src/vercel/codec/events.ts` declares those members structurally (the three
v7 adds, and `reset-step`, added within v7), so the row table in
`src/vercel/codec/index.ts` has one row per member on every supported release.
On a release that has a member the declaration coincides with the SDK's own;
on one that does not, it is a member nothing produces. Never name a chunk type
in a `switch` or an `if` against the SDK's union: comparing to a literal the
installed major lacks is a compile error (`TS2678`). Narrow structurally, or
give the type a row.

**Exhaustiveness comes from the row table's type, and its runtime guard is
the throw.** `EventRows<E, K>` is keyed by the union `typeOf` returns, so a
member with no row is a compile error, and the `data-*` wildcard row covers the
`` `data-${string}` `` template member. At runtime an event whose type has no
row throws `InvalidArgument` at encode, which is what happens when the AI SDK
adds a chunk type after the codec was written: a consumer whose `ai` resolves
newer than the SDK's lockfile sees the new member in the union, and the pipe
fails loudly on the first one rather than dropping it. When that happens, add
the member to `VercelCrossMajorChunk` and give it a row.

**`ai` is a types-only import in `src/`.** Every import is
`import type * as AI from 'ai'`, so the published bundle carries no `ai` code
and no value has to exist under the same name in both majors. Assembling chunks
into messages is not this package's job: a consumer folds the decoded chunks
with the SDK's own reducer (`readUIMessageStream`).

**Do not assert the AI SDK's internal accounting.** Callback call-counts, log
output and similar implementation details move between AI SDK releases,
including within a single major through patch bumps. Assert the property that
matters to this SDK (a stream is consumed, a message lands, ordering holds) and
let their bookkeeping vary. A test that pins an exact count is testing their
code and will break on an upgrade that changed nothing here.

## Cross-major gotchas

- `AI.UIMessageChunk`'s `data-${string}` variant requires the `data` field (use
  `data: undefined` if no payload).
- `providerMetadata` is `AI.ProviderMetadata`, not
  `Record<string, Record<string, unknown>>`. Always reference the exported alias:
  it resolves to a different underlying `SharedV*ProviderMetadata` per major.
- `streamText()` has no `maxSteps`; multi-step tool use is automatic.
- `tool-input-available` can arrive with no `tool-input-start` before it: the
  SDK emits it straight from a `tool-call` when a provider does not stream tool
  input. Its row is therefore a publish that ends the key, never an append.
- Getting a `AI.UIMessageChunk` stream from `streamText()` differs by major: v6
  offers `result.toUIMessageStream()`, which v7 deprecates in favour of the
  standalone `toUIMessageStream({ stream })`. A consumer pins one major and may
  use either; SDK source does not call it at all.

## Consumers pin one major

Dual support holds for the published package because its `ai` surface is small
and every type in it changed additively across v6 → v7. That is not true of the
AI SDK generally: `ToolExecutionOptions`, for instance, gained both a required
type parameter and a required `context` property in v7, so no single spelling
compiles on both. Dual support is a claim about this package's own use of
`ai`, not about the AI SDK generally. Anything built on top of it, an example
or an application, picks one major and uses that major's spelling;
`demo/minimal` pins `^7` and calls the standalone `toUIMessageStream`.
