# Does `useChat` consume `generateText()` output?

_An investigation by Claude, at Lawrence's direction. Pinned to `ai@6.0.185`
(the version this repo depends on)._

## TL;DR

No. The default `useChat` transport consumes **only** an SSE stream of
`UIMessageChunk`s. `generateText()` does **not** return a `UIMessage`, and there
is no framing of its result (a `UIMessage`, the raw `GenerateTextResult`, or a
`ModelMessage`) that the default transport will render — each is either silently
ignored or rejected with a validation error. Getting `generateText` output in
front of `useChat` requires decomposing it into a `UIMessageChunk` stream — which
is precisely the gap AIT-870 would fill, and what the converter proposed in the
options doc (the Option A spike's `generateTextToUIMessageStream`) is for.

## Why this writeup exists

The options doc states, as a premise, that there's no vanilla drop-in for
`generateText` + `useChat`. Claude had reached that conclusion from the docs.

In a conversation with Mike, he reasonably pushed back on it — the AI SDK's
layering isn't obvious, and his mental model was a plausible one:

- **(X)** he understood `generateText()` to return a **`UIMessage`-shaped**
  result;
- **(Y)** so he wondered whether, using the default `useChat` transport, a server
  route could simply **return that `UIMessage` in the HTTP response** and have
  `useChat` render it; and
- **(Z)** or, alternatively, **send a complete `UIMessage` on the SSE connection**
  (instead of the usual chunks) and have it materialise client-side.

If any of those held, one-shot output would already be supported by `useChat`
and worth handling directly. That's a fair challenge, and it was worth being
sure rather than taking the docs at face value — so Claude re-investigated, this
time against the SDK source **and** with an empirical repro driving the real
`useChat` engine. This note records what it found. The short version is that the
original premise holds, but the investigation is much more solid for having been
pushed on.

## Method

- Read the source of `ai@6.0.185` (and `@ai-sdk/react@3.0.187`) directly — the
  transport interface, the two HTTP transports, the chunk schema, and how the
  chat engine consumes a transport's stream.
- Wrote [`repro.ts`](./repro.ts): a headless reproduction that drives the **real**
  `Chat` engine from `@ai-sdk/react` (the exact class `useChat` wraps — the hook
  only adds React state subscription) against the **real** `DefaultChatTransport`
  / `TextStreamChatTransport`, talking to a **real** local HTTP route. A mock
  language model produces a genuine `generateText()` result deterministically, so
  no network or LLM is involved, but nothing about the SDK is stubbed.
- Before feeding it in, the repro **self-certifies the `UIMessage` with the SDK's
  own `validateUIMessages`** — so the rejections below are "the transport rejects
  a _valid_ `UIMessage`", not "the transport rejects an object we mis-built".

Run it:

```bash
pnpm exec tsx usechat-generatetext-investigation/repro.ts
```

## Findings

### 1. `generateText()` does not return a `UIMessage`

`GenerateTextResult` (`ai/src/generate-text/generate-text-result.ts`) exposes
`text: string`, `content: ContentPart[]`, `toolCalls`, `finishReason`, `steps`,
and `response.messages: ResponseMessage[]` — where `ResponseMessage` is a
**`ModelMessage`** (the backend conversation format), not a UI-tier `UIMessage`
(`{ id, role, parts, metadata }`). The repro confirms it at runtime:

```
typeof gen.text: string -> "Hello from generateText()."
gen.response.messages roles: assistant      ← model-tier ResponseMessage[]
has .role / .parts (UIMessage shape)? false / false
has .toUIMessageStream? undefined            ← no UI bridge
```

The decisive detail: `streamText`'s result has `toUIMessageStream()` /
`toUIMessageStreamResponse()` / `pipeUIMessageStreamToResponse()`.
`generateText`'s result has **none** of these — there is no built-in bridge from
a `generateText` result to the UI wire. (The entire `04-ai-sdk-ui` docs section
never once mentions `generateText`.)

### 2. The default transport only consumes a `UIMessageChunk` stream

- The transport contract (`ai/src/ui/chat-transport.ts`) types `sendMessages` as
  returning `Promise<ReadableStream<UIMessageChunk>>` — the return value _is_ a
  chunk stream.
- The chat engine (`ai/src/ui/chat.ts`) takes the transport's stream and pipes it
  straight through `processUIMessageStream` (the chunk → message reducer). No
  branch inspects for, or accepts, a complete message.
- `DefaultChatTransport` (`ai/src/ui/default-chat-transport.ts`) parses the HTTP
  body as an **SSE** stream, validating each event against `uiMessageChunkSchema`
  — a discriminated union on `type` (`start`, `text-start`, `text-delta`,
  `text-end`, `tool-input-available`, `finish`, …). There is **no "whole message"
  chunk type**; the largest unit is a delta.

### 3. What `useChat` actually renders for each server response

Every scenario builds its SSE identically (`data: ${JSON.stringify(x)}\n\n`); the
only thing that varies is the payload.

| #   | Server returns                                    | Transport  | `useChat` renders                | Error                    |
| --- | ------------------------------------------------- | ---------- | -------------------------------- | ------------------------ |
| A   | a whole `UIMessage`, as JSON                      | Default    | nothing                          | none (silent no-op)      |
| B   | a whole `UIMessage`, SSE-framed                   | Default    | nothing                          | `AI_TypeValidationError` |
| C   | the `GenerateTextResult`, as JSON                 | Default    | nothing                          | none (silent no-op)      |
| D   | **correct `UIMessageChunk`s, SSE** (control)      | Default    | ✅ the text                      | none                     |
| E   | a whole `UIMessage`, as plain text                | TextStream | the **raw JSON as literal text** | none                     |
| F   | the `GenerateTextResult`, SSE-framed              | Default    | nothing                          | `AI_TypeValidationError` |
| G   | the result's assistant `ModelMessage`, SSE-framed | Default    | nothing                          | `AI_TypeValidationError` |

Reading the table:

- **B / F / G** are the heart of it: feeding the default transport a whole message
  — whether a `UIMessage`, the raw `GenerateTextResult`, or a `ModelMessage`, and
  even when SSE-framed exactly like the working control — fails validation.
- **A / C** fail _silently_: a plain-JSON body isn't SSE-framed, so the parser
  emits zero events and nothing renders — no error at all. Notable in its own
  right: returning one of these to the default transport doesn't even fail loudly.
- **D (control)** renders correctly, proving the harness is sound: the transport
  works the moment it's fed actual chunks.
- **E** shows the text-only transport just dumps the bytes as literal text —
  useless for a structured or tool-bearing message.

### 4. The rejection is structural, not a framing mistake

For B, the underlying zod error is `invalid_union`: it tries every chunk variant
and rejects each with, e.g., `invalid_value` at `path: ["type"]` ("expected
`text-start`") plus `unrecognized_keys: ["role", "parts"]`. In other words the
value has no `type` discriminator and carries message-shaped keys no chunk schema
recognises. There is no "right key" to nest a message under — the schema wants a
member of a discriminated union keyed on `type` (a chunk), and a complete message
simply isn't one. (The only message-level chunks — `start`, `message-metadata`,
`finish` — carry ids/metadata, never `parts`/content.) The control (D) renders
with byte-identical framing, so framing is not the variable.

## What this means for AIT-870

There is no supported "return a complete message" path into `useChat`, in any
framing of `generateText`'s output. The AI SDK itself treats "one-shot output for
`useChat`" as "convert it to a chunk stream". This confirms the options doc's
premise: the gap is real, so closing it means building that conversion ourselves
— there is no native path to lean on. _Whether_ we should close it, and _how_
(the Option A converter vs. the alternatives), remain open questions for the
team; see the options doc. This investigation only establishes the constraint
those options have to work within.

## Caveats

- **Version-pinned.** Everything here is true of `ai@6.0.185` (this repo's
  dependency). Future SDK versions could add a first-class one-shot path; if the
  premise matters later, re-run the repro against the then-current version.
- **Mock model, real everything else.** A mock language model produces a genuine
  `generateText()` result deterministically. The chat engine, transports, SSE
  parsing, and schema validation are all the real SDK.
- **Headless, not a browser.** The repro drives the `Chat` engine directly rather
  than a rendered React tree, because `useChat` is a thin React wrapper over that
  exact class.
