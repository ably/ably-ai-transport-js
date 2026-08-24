# Type safety

## No type erosion

- **No `any`** in source code. If a dependency types something as `any` (e.g. `Ably.Message.extras`), add runtime checks and cast to the narrowest known type with a `// CAST:` comment.
- **No `as` casts** unless strictly necessary. Valid reasons: trust boundaries (wire data from `JSON.parse`), Ably SDK `any` types after runtime guards, TypeScript limitations (template literal narrowing in `data-*` part construction). Every `as` cast must have a comment explaining why.
- **No `unknown`** where a concrete type is available. Use the actual return type from SDK methods (e.g. `Promise<Ably.ChannelStateChange | null>` not `Promise<unknown>`). Exception: a promise awaited purely as a synchronisation barrier — its resolved value is never read, only its settling is awaited for ordering — may be typed `Promise<unknown>`. Document at the declaration that the value is intentionally discarded.
- **No `!` non-null assertions.** Use explicit narrowing (destructure into a local variable, add a runtime guard, or restructure to avoid the need).
- **No `@ts-ignore`, `@ts-expect-error`, or `@ts-nocheck`** in source, example, or demo code — type errors are fixed, never suppressed.
- **`eslint-disable` only as a documented exception.** A single-line `eslint-disable-next-line` is allowed when the flagged code is deliberately unidiomatic and restructuring would harm the design (e.g. `promise-function-async` on a method that must return a cached promise by reference, `unicorn/no-null` where a dependency's contract requires `null`). Every directive names the one rule it disables and carries a trailing `--` comment stating the reason. File-wide or reasonless disables are never allowed.
- Use `AI.isDataUIPart()` to narrow `data-*` parts — never cast with `as { id?; data? }`.

## Import types from dependencies, don't redefine them

- **Use real SDK types from peer dependencies**, not custom redefinitions. Import `Ably.Message` from `ably` and `AI.UIMessageChunk` from `ai`. This ensures compile-time breakage when peer SDK types change.
- Import all peer dependency types as namespaces: `import type * as Ably from "ably"` then use `Ably.Message`, `Ably.PublishResult`, etc. `import type * as AI from "ai"` then use `AI.UIMessageChunk`, `AI.UIMessage`, etc.
- When the AI SDK exports an interface (e.g. `AI.ChatTransport`, `AI.FinishReason`, `AI.ProviderMetadata`), import and extend it — don't redefine. Our `ChatTransport<…>` extends the SDK's `AI.ChatTransport<AI.UIMessage<…>>` with `close()`, `streaming`, and `onStreamingChange` (see `src/vercel/transport/chat-transport.ts`). The SDK type is referenced via a named import there only because `import-x/namespace` can't verify a namespaced generic in an `extends` clause; prefer the `AI.*` namespace everywhere else.
- Our `ChannelWriter` interface is satisfied directly by `Ably.RealtimeChannel` — no adapter needed. Prefer structural interfaces the SDK types already satisfy over wrapping them.
- For HTTP request/response body types, define a typed interface and assert it on `req.json()` / `JSON.parse()` rather than using untyped destructuring.
