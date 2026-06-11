# AIT-870 — Supporting `generateText()` output: options & open questions

**Status:** discussion document — _let's figure out what to do here_
**Ticket:** [AIT-870](https://ably.atlassian.net/browse/AIT-870) (parent epic: AIT-716 Core SDK)
**Author:** Lawrence (with Claude)

This is a thinking-out-loud document to align the team before we commit to an
approach. It captures what we've found, the design choices, and — importantly —
the things we are **not** yet sure about and should confirm together.

---

## 1. What the ticket asks for

The Vercel AI SDK offers two ways to produce LLM text:

- **`streamText()`** — streams output incrementally. We support this today: the
  agent does `run.pipe(result.toUIMessageStream())` (see the demos' `route.ts`).
- **`generateText()`** — a one-shot call that returns the _complete_ result in
  one go. We have **no** way to get this onto the Ably wire.

AIT-870 is to close that gap.

---

## 2. Why are we doing this? (UNCONFIRMED — please confirm in-team)

The ticket is light on motivation, and we should **not proceed without
pinning this down**, because it changes the scope. Our best speculation is one
(or both) of:

- **(a) Drop-in for developers already using `generateText()`.** Removing a
  sharp edge so someone who already has a `generateText`-based agent isn't
  forced to rewrite to `streamText` to adopt Ably.
- **(b) Developers who deliberately want one-shot.** e.g. to **inspect /
  validate / transform the complete output before emitting it** (moderation,
  JSON repair, redaction) — something streaming can't do, because you've
  already sent tokens before you can check them.

### The sharper question: who is the _consumer_?

It is **not clear who consumes a durable session whose agent uses
`generateText()`** — i.e. what we're enabling client-side. This cuts
differently for the two motivations:

- Under **(a)**, developers using `generateText` today almost certainly **aren't
  using `useChat`** — `generateText` produces no stream for `useChat` to consume,
  so their consumer is typically a request/response flow (`await` the full text)
  or a server-side pipeline. So "drop-in" is murky: we'd be offering durable
  sessions / multi-device for a flow that was previously plain request/response,
  and they'd have to adopt our _client_ too — not really "drop-in".
- Under **(b)**, the consumer is a `useChat`-style streaming UI and the developer
  just wants server-side control before emitting. This maps cleanly onto our
  existing demos.

**Working assumption for this document:** we're building an app like our existing
demo apps, where the backend happens to use `generateText()` instead of
`streamText()`. This aligns with motivation (b); motivation (a) is the one that
needs the team to identify a concrete consumer.

### Important reassurance

Whatever the motivation, **what we deliver client-side is unchanged**: the client
still consumes `UIMessageChunk`s via `useChat`. Only the backend changes
(`generateText` instead of `streamText`). That is the honest scope of "drop-in"
here. We are **not** introducing one-shot as a "better" delivery model —
streaming remains the right default for the things Ably sells (resumable
streaming, multi-device continuity, live steering). This is gap-filling, in the
spirit of the AIT-716 epic's "no gaps or DX smells".

---

## 3. Relevant facts about the Vercel SDK

- **There is no vanilla drop-in for `generateText` + `useChat`.** `useChat`
  requires a UI-message _stream_; `generateText`'s result has **no**
  `toUIMessageStream()` / `toUIMessageStreamResponse()` (those exist only on
  `streamText`). So we're enabling a pattern Vercel doesn't natively support,
  not reproducing one.
- **`generateText` reports failure by promise rejection / throw** (incl.
  `NoOutputGeneratedError`, abort errors, provider errors) — the opposite of
  `streamText`, where errors are in-stream. So the developer's `try/catch` is
  the failure channel.
- **There is no official `result → UIMessage` converter**, and this is a known,
  still-open gap in the SDK (vercel/ai issues
  [#7180](https://github.com/vercel/ai/issues/7180),
  [#4875](https://github.com/vercel/ai/issues/4875), discussion
  [#6953](https://github.com/vercel/ai/discussions/6953)). The SDK treats
  chunk→UIMessage assembly as the **client** reducer's job.
- The `generateText` result exposes `text`, `content` (an array of `ContentPart`s
  — text / reasoning / file / source / tool-call / tool-result),
  `toolCalls` / `toolResults`, `response.messages`, `finishReason`, `steps`.

---

## 4. The conversion step (needed by every option)

Whatever we do, we need to convert the one-shot result into something the
transport can publish. We will target **`UIMessageChunk`s**, not `UIMessage`.

### Why chunks, not `UIMessage`

The conversion `GenerateTextResult → UIMessageChunk[]` is a **generic,
Ably-agnostic** operation — it is literally the missing sibling of
`streamText().toUIMessageStream()` ("the chunk stream that would have
represented this generation had it streamed"). The Ably coupling lives only in
the _next_ step (handing chunks to the run). So we'd label it accordingly, e.g.
`generateTextToUIMessageStream(result)` — **not** "convert to a form the run
understands"; the run understands generic chunks.

Targeting a `UIMessage` instead would be worse on three counts:

1. **It re-implements assembly the SDK deliberately doesn't expose** (§3) — most
   visibly the tool-part state machine — and so is fragile across SDK versions.
2. **Nothing downstream consumes it as a `UIMessage` anyway.** The decoder
   _always_ emits chunks (`DefaultUIMessageDecoder.decode` →
   `outputs: UIMessageChunk[]`), and `useChat` assembles from those. A
   server-built `UIMessage` would be torn into wire parts and reassembled by the
   client — a throwaway intermediate, with extra divergence risk at each step.
3. **It introduces a new concept: server-authored `UIMessage`.** Today the server
   only ever emits chunks; all `UIMessage` creation is client-side. Keeping the
   converter chunk-shaped preserves the clean invariant **"server emits chunks;
   the client (AI SDK) is the sole authority that assembles them into
   `UIMessage`s."**

This rules out a `run.send(message: UIMessage)`-style API: we don't need a
`UIMessage` to get a complete response onto the wire.

---

## 5. How it lands on the Ably wire

This is the **main open design decision**. First, a key finding from the codec:

> **A one-shot result is already almost entirely supported for discrete
> (non-streamed) emit.** The encoder already publishes tool calls, tool outputs,
> files, sources, lifecycle events and errors as single discrete messages. In
> particular, `tool-input-available` arriving with **no active stream** already
> falls through to a `publishDiscrete` (`src/vercel/codec/encoder.ts:179-205`),
> and the decoder reconstructs it (`decodeNonStreamingToolInput`). **The only
> part of an assistant turn with no discrete representation is `text` /
> `reasoning`** — because the `UIMessageChunk` vocabulary has no "complete text"
> chunk analogous to `tool-input-available`.

So the choice reduces to: **how do we want `text`/`reasoning` to land?**

### Option A — reuse `run.pipe()` (streamed emit). Zero codec change.

The converter emits chunks; we feed them to the existing `run.pipe()`.

- Tool calls, outputs, files, lifecycle → land **discretely** (existing paths).
- `text` / `reasoning` → land as a **degenerate one-delta stream**: the encoder
  does `publish` + one `append` + `close`, and the message carries `stream:true`,
  `status:complete`.
- **Cost:** none beyond the converter. **Blemish:** `text`/`reasoning` messages
  carry `stream:true` — a permanent, queryable false flag (they never actually
  streamed).

### Option C — honest discrete emit. Small, well-precedented codec addition.

Same converter, but give `text`/`reasoning` a discrete representation so they too
land as single immutable `stream:false` messages.

- **New work, narrowly scoped to text/reasoning:**
  - **Decoder:** a discrete `text`/`reasoning` case in `decodeAiOutputPayload`,
    modelled line-for-line on the existing `decodeNonStreamingToolInput`
    (expand one discrete message → `text-start` + `text-delta`(full) +
    `text-end`).
  - **Encoder:** a path to publish a complete `text`/`reasoning` part discretely.
    Note: unlike `tool-input` (which has a single `tool-input-available` chunk to
    trigger the discrete publish), text's content arrives via `text-delta`s, so
    this needs either a small buffering step (accumulate, flush one discrete
    message at `text-end`) or a dedicated "publish complete text" path the
    converter targets. This is the only genuinely new bit, and it does **not**
    touch the generic stream machinery — `publishDiscrete` is already a clean,
    first-class primitive.
- **Benefit:** the durable channel record is honest — one immutable message per
  part, uniformly `stream:false`.

### Option B — `run.send(message: UIMessage)` — **rejected** (see §4).

We considered a `send`-style API taking a complete message, but a `UIMessage` is
the wrong target (server-authored-`UIMessage` smell, re-implements SDK assembly,
torn apart downstream anyway). Not pursuing.

### The decision criterion for A vs C

Both options produce **identical** client-side rendering — `useChat` reconstructs
the same `UIMessage` either way. The _only_ difference is the durable wire
record. Relevant facts:

- Ably history returns **only the latest version** of a message — so the sole
  artifact of A's fake-stream is the `stream:true` / `status:complete` header on
  the final message (plus the message being a mutated-rather-than-virgin publish
  in Ably's metadata). There is no delta-by-delta replay.
- Practical harm of the `stream:true` blemish is **near zero**: nothing
  downstream reads it in a way that affects behaviour, and `useChat` renders
  identically.

So: **do we care that the persisted record honestly says `stream:false` for
something that wasn't streamed?** If yes → C. If we want the absolute minimum and
can live with a cosmetic header inaccuracy → A.

---

## 6. Failure handling

`generateText` **rejects/throws** (§3). The pattern in the route handler is:

```ts
try {
  const result = await generateText({
    /* ..., abortSignal: run.abortSignal */
  });
  await run.pipe(toUIMessageChunkStream(result)); // or discrete equivalent
  return oneShotOutcome(result); // suspend / complete / error
} catch (error) {
  // emit an `error` output chunk (encoder already supports `type: error`)
  // then run.end('error')
}
```

We'd provide:

- An **outcome helper** for one-shot — the analogue of the existing
  `vercelRunOutcome`, but simpler: `generateText`'s `finishReason` is a plain
  value (not a promise), so `'tool-calls' → suspend`, else `'complete'`, with no
  abort-rejection guard needed (aborts surface via the `try/catch`).
- A small helper to turn a caught error into an `error` output + `run.end('error')`.

---

## 7. Demonstrating it

**Recommendation: a toggle in the existing `use-chat` demo**, not a new app —
because it shows the _same_ client working against both a `streamText` and a
`generateText` backend (Ably bridging the gap), which is the strongest message.

The concern is not bloating the slim `streamText` route. The fix is to extract
the shared run lifecycle (session/run/start/loadConversation/`after`/outcome/end)
so the two modes are tiny sibling leaves, selected by a flag — the streaming leaf
stays byte-for-byte what it is today:

```ts
export const POST = withAgentRun(req, async (run) => (MODE === 'complete' ? handleOneShot(run) : handleStreaming(run)));
```

(There's already appetite for this — the e2e launcher was recently extracted to a
shared module.) Alternatively, a second route file reusing the same helper, so
neither file carries a branch.

---

## 8. Open questions for the team

1. **Why are we doing this, and who is the consumer?** (§2) — the one that most
   affects scope. Especially: is there a real motivation (a) consumer, or is this
   really motivation (b) (one-shot-by-choice, same `useChat` client)?
2. **Wire emit: Option A vs Option C?** (§5) — i.e. do we care about an honest
   `stream:false` durable record, given the only artifact is a header and
   rendering is identical?
3. **Scope of v1:** text-only first, or text + tools from the start? (Tools are
   _already_ supported discretely end-to-end, so including them is nearly free.)
4. **Demo:** toggle in the existing `use-chat` demo (recommended) vs a new demo.

---

## 9. Current recommendation

- **Converter:** `GenerateTextResult → UIMessageChunk[]`, a generic
  Vercel-domain helper (the missing sibling of `toUIMessageStream()`). Settled.
- **Emit:** lean **A to ship the capability with zero codec risk**, with **C as a
  fast follow** if the team decides the honest history representation matters —
  C is cheap (the only gap is discrete text/reasoning, with an in-repo template),
  so doing it up front is also defensible.
- **Tools:** include from v1 (nearly free).
- **Demo:** toggle in the existing `use-chat` demo via extracted shared
  scaffolding.
- **Blocked on:** confirming §2 (the why / the consumer).
