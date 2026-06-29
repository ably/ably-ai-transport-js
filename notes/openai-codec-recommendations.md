# OpenAI codec — investigation findings and recommendations

_Companion to `openai-codec-investigation.md`. Addresses AIT-742 (parent epic
AIT-897 "OpenAI"). Grounded in: our own code; the official OpenAI SDKs
(`openai-node` v6.45.0, `openai-python` v2.44.0, `openai-agents-js`,
`openai-agents-python`), cloned and read directly; and official OpenAI docs.
Source list at the end._

---

## 0. TL;DR

1. **The ticket's premise needs correcting.** "OpenAI-compatible" (OpenRouter et
   al.) overwhelmingly means the **Chat Completions** API, **not** the Responses
   API. Targeting Responses does **not** buy broad third-party compatibility.
2. **This is therefore a three-way decision, not two**, and it rests on a
   product priority only you can set: _broadest provider reach_ (Chat
   Completions) vs _richest OpenAI-native experience_ (Responses → Agents SDK).
3. **The Agents SDK event stream is a genuine strict superset of the Responses
   API stream** — so a codec built on the Responses raw-event layer grows into
   the Agents SDK additively, not by rewrite. But the Agents SDK is client-side
   orchestration, irrelevant to third-party compatibility.
4. **My recommendation: build the Responses API codec first**, designed so the
   Agents SDK is a later additive phase. It is the true "OpenAI" codec, it is the
   best showcase and the strongest test of whether our codec abstraction
   generalises beyond Vercel, and its event model maps cleanly onto our existing
   declarative API. **Pick Chat Completions instead only if broad provider reach
   is the actual priority** — that is the one decision I can't make for you.
5. **Good news for the "don't change the codec API" constraint:** the Responses
   target needs **essentially no change to the core `Codec`/transport contract**.
   The two places our abstraction is currently untested (string-append streams;
   the codec-message-id routing convention) are both satisfied by the Responses
   shape.
6. **Complexity: moderate.** The declarative API does the heavy lifting and the
   Responses event model is a near-1:1 fit. Most effort is in the reducer, the
   demo's backend agentic loop, and a codec-specific run-outcome mapping — all
   work that lives _outside_ core, exactly as it does for Vercel.

---

## 1. What "OpenAI-compatible" actually means (the premise correction)

The ticket reasons: _we want broad compatibility → what do people mean by
"OpenAI compatible"? → maybe everyone uses Responses → if the Agents SDK is a
superset, target that and solve both._ The first hop is the one that breaks.

**Two distinct, mutually unparseable wire formats:**

- **Chat Completions** (`POST /v1/chat/completions`): the long-standing surface.
  Streaming is SSE chunks of `{"object":"chat.completion.chunk", choices:[{delta:{content,tool_calls:[{index,...}]}}]}`,
  terminated by a literal `data: [DONE]`. (`openai-node` `chat/completions/completions.ts:732`.)
- **Responses** (`POST /v1/responses`, launched 11 Mar 2025): the newer agentic
  primitive. Streaming is a typed, named **semantic event** model (see §2). No
  `[DONE]`; terminal state is `response.completed` / `.failed` / `.incomplete`.

A consumer written for one cannot parse the other.

**Who implements which** (survey of 12 "OpenAI-compatible" providers):

| Provider | Chat Completions | Responses (`/v1/responses`) |
| --- | --- | --- |
| OpenRouter, Together, Groq, Fireworks, Ollama, Mistral, Gemini-compat, Anthropic-compat | ✅ | ❌ |
| vLLM | ✅ | ⚠️ experimental / version-dependent |
| **Azure OpenAI** | ✅ | ✅ |
| **LM Studio** | ✅ | ✅ |

**Only Azure and LM Studio expose Responses.** Everyone else is Chat Completions
only. OpenAI itself calls Chat Completions "an industry standard" it will
"support indefinitely", while positioning Responses as the forward path **on
OpenAI**. The "Responses is a superset of Chat Completions" line from the launch
refers to _capability_, not _wire compatibility_.

**Consequence:** breadth and richness pull in opposite directions.

- Want the widest set of providers to work? → **Chat Completions** (flat stream:
  `delta.content`, `tool_calls[].index`, `[DONE]`).
- Want the richest OpenAI-native semantics? → **Responses** (and then the Agents
  SDK on top).

> _Confidence note:_ the event taxonomy (§2–3) is high-confidence — read directly
> from two official SDKs at pinned versions that agree exactly. The
> compatibility/positioning claims rely on web retrieval because
> `platform.openai.com` / `openai.com` return 403 to automated fetch; provider
> endpoints and OpenAI's "industry standard / indefinitely" wording are cited
> individually (the latter via a contemporaneous secondary quotation). Treat
> Fireworks `/responses` as unconfirmed and vLLM as version-dependent.

---

## 2. The Responses API streaming event model (and why it fits our codec)

With `stream: true`, the server emits named SSE events, each with a `type`
discriminator and a monotonic `sequence_number`. The full union is
`ResponseStreamEvent` (`openai-node` `responses.ts:6198`; identical in
`openai-python`). The shape is a clean **item → content-part → delta/done**
hierarchy:

- **Response lifecycle** (payload is a full `Response`): `response.created`,
  `response.in_progress`, `response.queued`, `response.completed`,
  `response.incomplete`, `response.failed`, and a stream-level `error`.
- **Structure**: `response.output_item.added` / `.done` (an output item:
  message, `function_call`, `reasoning`, hosted-tool call, …, keyed by
  `output_index` / `item_id`); `response.content_part.added` / `.done` (a part
  within a message).
- **Assistant text**: `response.output_text.delta` (`delta: string`) /
  `.done` (`text: string`), plus `…annotation.added` for citations.
- **Function/tool calls**: `output_item.added` with `item.type==='function_call'`
  (carries `call_id`, `name`); then
  `response.function_call_arguments.delta` (`delta: string`, partial JSON) /
  `.done` (`arguments: string`, full JSON); then `output_item.done`. Multiple
  tool calls are **separate output items**, disambiguated by `output_index` —
  no combined array delta. **The tool _result_ is not in the stream**: the
  developer executes the function and submits a `function_call_output` (keyed by
  `call_id`) as input to the _next_ request (see §5).
- **Reasoning** (reasoning models): `response.reasoning_summary_text.delta`/`.done`
  and `response.reasoning_text.delta`/`.done`.
- **Refusals**: `response.refusal.delta` / `.done`.
- **Hosted tools** (file/web search, code interpreter, image gen, remote MCP):
  each has its own `…in_progress`/`…completed` lifecycle family.

**Why this matters for us:** our declarative codec API already models exactly
this shape. `stream(kind, { start, delta, end })` descriptors map onto
`output_text.delta`/`.done` and `function_call_arguments.delta`/`.done`; `event(type, …)`
descriptors map onto the discrete lifecycle and `output_item`/`content_part`
events. The deltas are **strings**, which is the one hard constraint our stream
model imposes (`StreamPayload.data: string`) — so the fit is natural, not forced.

---

## 3. The Agents SDK, and the superset relationship

The **Agents SDK** is a **client-side orchestration library** that runs in your
process and drives a model API (Responses by default). It adds, over a raw
Responses call: the **multi-turn run loop**, **local function-tool execution**,
**handoffs** (agent→agent), **guardrails**, **sessions/memory**, and
**human-in-the-loop tool approval**. It is not a wire protocol and not something
third-party providers expose — so **it does nothing for broad compatibility**.

Its streaming run emits exactly three top-level event types
(`openai-agents-js` `agents-core/src/events.ts`):

1. `raw_model_stream_event` — wraps the low-level model events.
2. `run_item_stream_event` — semantic items: `message_output_created`,
   `tool_called`, `tool_output`, `handoff_requested`/`occurred`,
   `tool_approval_requested`, `reasoning_item_created`, tool-search.
3. `agent_updated_stream_event` — which agent is now active (multi-agent).

**Superset: confirmed.** The raw Responses events are carried through —
_literally_ in Python (`data` is OpenAI's `ResponseStreamEvent`,
`openai-agents-python` `items.py`), and _verbatim-but-nested_ in JS (inside a
`type:'model'` envelope variant, recoverable via the SDK's own
`isOpenAIResponsesRawModelStreamEvent` guard,
`agents-openai/src/rawModelEvents.ts`). On top, it adds the run-item and
agent-updated layers, which have **no Responses-API analogue**.

Directional consequence for a codec:

- A codec that consumes the **Agents SDK** raw layer **also handles a plain
  Responses stream** (the raw events are present) → the Responses case is a
  degenerate subset.
- A **Responses-only** codec **cannot** represent handoffs, framed
  tool-call/output items, approvals, or agent switches — those events would be
  dropped.
- **JS/Python caveat:** the two SDKs normalise the raw layer differently (JS
  nests it in its own protocol union; Python passes OpenAI's type 1:1). A codec
  spanning both must reconcile this at the boundary. For a JS demo this is moot.

So "target the superset to solve both" is correct **only within the OpenAI
family** (Agents ⊇ Responses). It does **not** extend to Chat-Completions-only
providers.

---

## 4. Recommendation on which target

**Build the Responses API codec first; design it so the Agents SDK is an additive
later phase; treat Chat Completions as a separate decision driven by whether
broad provider reach is the real goal.**

Reasoning:

- **It is the actual "OpenAI" codec** the epic asks for, and the richest, most
  semantically structured OpenAI stream.
- **It is the strongest test of the abstraction.** A core motivation for a second
  codec is to learn whether our declarative `Codec` API is too Vercel-specific.
  The Responses event model is rich and _structurally different_ from Vercel's
  (item/content-part hierarchy, separate-output-item tool calls, first-class
  reasoning/refusal) — so it exercises the abstraction far harder than a flat
  Chat Completions stream would, while still mapping cleanly.
- **It grows into the Agents SDK without a rewrite** (the superset relationship),
  so we don't foreclose the richest agentic demo.
- **It maps onto the existing declarative API with no core changes** (see §7).

**Choose Chat Completions first instead if** the priority is genuinely "as many
OpenAI-compatible providers as possible work with `@ably/ai-transport`". That is
a legitimate, different goal — and it's the one judgement here that is yours, not
mine, because it's a product-priority call sitting on the corrected premise
above. If you take that path, note the Agents-SDK superset argument drops out
entirely (it's irrelevant to provider breadth), and the demo/abstraction-test
value is lower.

I do **not** recommend leading with the Agents SDK: it adds the most dependencies
and OpenAI-specific orchestration surface, and its richest features (handoffs,
multi-agent) are a "phase 3 wow", not a first shippable increment.

---

## 5. Codec generic type arguments (concrete proposal, Responses target)

Recall the **four** real generic parameters (`src/core/codec/types.ts:567`) — the
notes were right; the `TEvent, TMessage` in the rules docs is stale drift:
`Codec<TInput, TOutput, TProjection, TMessage>`. How Vercel binds them, and what
I propose for OpenAI:

| Param | Role | Vercel binds | Proposed OpenAI (Responses) |
| --- | --- | --- | --- |
| `TInput` | what the **UI sends** on the `ai-input` wire (union, `kind`-discriminated) | all SDK well-known variants, zero codec-local | the same well-known variants, parameterised with OpenAI payloads (see below) |
| `TOutput` | what the **agent publishes** on the `ai-output` wire (union, `type`-discriminated) | `AI.UIMessageChunk` (pass-through) | OpenAI's `ResponseStreamEvent` union (pass-through), handling a subset initially |
| `TProjection` | opaque **per-node accumulator** the reducer folds into | `VercelProjection` (messages + trackers) | codec-local accumulator: text buffers keyed by `item_id`/`content_index`, in-flight `function_call`s keyed by `call_id`, reasoning buffers |
| `TMessage` | the **per-message shape the UI renders** | `AI.UIMessage` | **a codec-defined normalised message** (see below) |

**`TMessage` — the most consequential choice.** Unlike Vercel (where
`AI.UIMessage` is _the_ thing `useChat` renders), OpenAI has **no single
canonical "UI message" type** — the Responses API has input items and output
items, not a render model. So I recommend a **codec-defined message**: a
`{ role, parts: [...] }` shape where `parts` is a discriminated union of
`text` / `tool-call` / `tool-result` / `reasoning` / `refusal` (mirroring the
Responses content-part kinds), reusing OpenAI SDK part types where they're clean.
This keeps `TMessage` a rendering model we own, decoupled from the wire union
`TOutput`.

**`TInput`.** The well-known variants already cover OpenAI's needs and were
_explicitly_ designed for non-Vercel domains (`types.ts:411-456`):
`UserMessage<TMessage>` (user turn); `ToolResult<payload>` for the
`function_call_output` keyed by `call_id`; `Regenerate`; and `ToolApprovalResponse`
_if_ we layer approvals (Responses has no native gating — the codec's reducer
would impose it, exactly as the JSDoc anticipates). Likely **zero codec-local
input variants**, like Vercel.

**`TOutput`.** Bind to the `ResponseStreamEvent` union and pass through, mirroring
Vercel's `UIMessageChunk` approach. The descriptor tables only need to handle the
subset we render initially (lifecycle + `output_text` + `function_call_arguments`
+ `output_item`/`content_part`); reasoning/refusal/hosted-tools come later.

---

## 6. The agentic loop and the demo

The Vercel demo's backend pipes one AI-SDK `UIMessageChunk` stream (with
`streamText(... stopWhen: stepCountIs(10))` doing multi-step internally) through
`run.pipe(...)`, and decides `run.suspend()` vs `run.end()` from Vercel's
`finishReason`. The frontend consumes the **generic core/React surface directly**
(`view.getMessages()`, `view.send(...)`, `view.regenerate(...)`) — it does **not**
use the `useChat` `ChatTransport` adapter. That demo is the right template.

For the Responses target, the key structural fact is **the tool result is not in
the stream** (§2). So the backend must run the loop itself:

```
call /v1/responses (stream) → pipe events into run.pipe(...)
  → see function_call → execute tool locally
  → call /v1/responses again with function_call_output → pipe more events
  → … until a response with no pending tool calls → run.end()
```

This is exactly the "simple agentic loop in the backend that does server-side
tool calls (e.g. 'what's the weather in London')" the investigation notes
anticipate. With the Agents SDK (later phase) this loop is free and the stream
carries framed tool calls/outputs and handoffs directly.

Two codec-specific, **outside-core** pieces the demo needs (Vercel has analogues,
both deliberately outside core):

- A **run-outcome mapping** (when does a run `suspend` vs `end`) — Vercel's is
  explicitly Vercel-shaped (`run-end-reason.ts`); OpenAI defines its own (likely
  simpler: end when the loop completes; suspend only if/when we add HITL).
- A **per-run consumer stream builder** _if_ we want a `useChat`-style surface.
  My recommendation: **skip the adapter**, consume the generic React hooks
  directly like the use-client-session demo. OpenAI has no `useChat` to satisfy,
  and this keeps the demo proving the generic surface.

---

## 7. Does this require changing the `Codec` / transport API?

**For the Responses target: essentially no.** The internal review found core
(Tree/View/Session, transport headers, run lifecycle, the four-param `Codec`,
`defineCodec`, descriptor builders, well-known inputs) carries **zero Vercel
types** and is ready for a second codec. The two places the abstraction is so far
**untested** are both satisfied by the Responses shape:

1. **String-append-only streams** (`StreamPayload.data: string`, single
   `deltaField`). Responses `output_text.delta` and `function_call_arguments.delta`
   are both string deltas → fits.
2. **The implicit "every output is addressed by a codec-message-id" routing
   convention** the reducer relies on. We map this onto the Responses
   `item_id` / response id → fits.

So building this codec respects your "change the API only if really necessary"
constraint. **What I'd watch** (report-if-it-strains, don't pre-emptively change):

- Whether multiple concurrent `function_call` output items (each its own
  `item_id` + arg-delta stream) compose cleanly under the single-`deltaField`
  stream model. Expected fine; first real multi-stream-per-message test.
- The Agents SDK phase (later) is where strain is more plausible — the nested
  JS raw-event envelope and the run-item/agent-updated layers may want richer
  expression. That's a phase-3 question, not now.

If anything _does_ need to change, I'll surface it explicitly with the cost
rather than just doing it — and the author of the codec API is the right person
to sanity-check any such proposal.

---

## 8. Phased plan (shippable increment at each phase)

**Phase 0 — spike (½–1 day).** Stand up the Responses event types in a scratch
reducer; confirm the item/content-part/delta model folds into messages cleanly
and the string-append + codec-message-id assumptions hold. _Output: a go/no-go on
"no core API change", de-risking §7._

**Phase 1 — Responses text + server-side tools (the first shippable codec).**
Codec handling: response lifecycle, `output_text` streaming, single+multiple
`function_call`s with arg deltas, `function_call_output` as `ToolResult` input.
Demo: a copy of use-client-session whose backend runs the simple
Responses agentic loop with a server-side tool (weather), frontend on the generic
React hooks. _Shippable: a working OpenAI-backed streaming chat with server-side
tool calls, proving the codec abstraction generalises beyond Vercel._

**Phase 2 — richer Responses semantics.** Reasoning summaries, refusals, text
annotations/citations; branching/regenerate (transport already supports it);
optionally tool approval (HITL) layered via the well-known `ToolApprovalResponse`
variant. _Shippable: a feature-comparable OpenAI chat demo (reasoning + citations
+ regenerate), still single-agent._

**Phase 3 (optional, OpenAI-rich) — Agents SDK.** Consume the Agents SDK stream;
add framed tool calls/outputs, native HITL approvals, handoffs and multi-agent
(`agent_updated_stream_event`). Reconcile the JS/Python raw-layer difference if
both are in scope. _Shippable: a multi-agent, handoff-capable demo — the
"wow"._

**Phase 3′ (optional, broad-reach alternative) — Chat Completions codec.** Only
if broad provider compatibility is prioritised. A second, flatter codec
(`chat.completion.chunk`, `tool_calls[].index`, `[DONE]`). _Shippable: works
against OpenRouter/Groq/Together/etc._ Note 3 and 3′ are different goals; you'd
rarely do both first.

De-scope from Phase 1 to reduce complexity: client-side tools, tool approvals,
reasoning, hosted tools, multi-agent. All are additive later via mechanisms that
already exist (well-known input variants) or later phases.

---

## 9. Complexity assessment

**Moderate overall**, front-loaded onto understanding rather than volume of code:

- **Codec itself: low-to-moderate.** The declarative API removes the
  encoder/decoder boilerplate; the Responses event model is a near-1:1 fit for
  the descriptor tables. Real work is the reducer (fold events → projection →
  messages) and the `TMessage`/part-union design.
- **Demo backend: moderate.** The hand-rolled Responses agentic loop (call →
  execute tool → call again) is the most fiddly new code, but it's small and
  well-bounded; the weather example is the canonical shape.
- **Demo frontend: low.** Reuse the generic React hooks; the use-client-session
  demo is a direct template.
- **Risk areas:** the multi-stream-per-message question (§7), and — only if Phase
  3 is taken — the Agents SDK JS/Python raw-layer divergence and the richer
  event layers.

The biggest _conceptual_ cost was the compatibility correction in §1, which is
now resolved.

---

## 10. Decisions for you

| # | Decision | My recommendation | Why it's yours |
| --- | --- | --- | --- |
| 1 | **Primary target**: Chat Completions (breadth) vs Responses (OpenAI-rich) vs Agents SDK | **Responses first**, growing into Agents SDK | Product-priority call resting on the corrected premise — breadth vs richness is a business trade-off, not a technical one |
| 2 | `TMessage`: reuse an OpenAI SDK type vs codec-defined normalised message | **Codec-defined** `{role, parts[]}` | OpenAI has no canonical UI-message type; affects the public render model |
| 3 | Where the agentic loop lives in Phase 1 | **Hand-rolled backend loop** with server-side tools | Sets demo scope/ambition |
| 4 | Phase-1 feature scope | **De-scope** client tools, approvals, reasoning, hosted tools, multi-agent | Sets time-to-first-ship |
| 5 | Build a `useChat`-style adapter for OpenAI? | **No** — consume generic React hooks directly | — |
| 6 | If Phase 3: support both Agents SDK JS _and_ Python raw-layer shapes? | Defer; decide at Phase 3 | Scope of the agentic phase |

---

## 11. Sources

**Our code** (ground truth): `src/core/codec/types.ts` (`Codec` at :567,
well-known inputs :376–465), `define-codec.ts`, `output-descriptors.ts`,
`input-descriptors.ts`, `well-known-inputs.ts`; `src/core/transport/` (Tree/View/
Session, `decode-fold.ts`, `materialisation.ts`); `src/constants.ts`,
`src/utils.ts`, `headers.ts` (transport vs codec header tiers); `src/vercel/codec/*`
(the only worked codec); `demo/.../use-client-session/*` (template demo,
server route + generic-hooks frontend).

**OpenAI Responses / Chat Completions** (cloned, read directly):
`openai/openai-node` v6.45.0 `src/resources/responses/responses.ts`
(`ResponseStreamEvent` :6198) and `src/resources/chat/completions/completions.ts`
(`ChatCompletionChunk` :732); `openai/openai-python` v2.44.0
`src/openai/types/responses/response_stream_event.py`.
Docs: https://developers.openai.com/api/docs/guides/streaming-responses,
https://developers.openai.com/api/docs/guides/migrate-to-responses,
https://developers.openai.com/blog/responses-api. Provider compat:
OpenRouter, Groq, Gemini, Anthropic, Azure, LM Studio, Ollama OpenAI-compat docs
(URLs in research notes). "Industry standard / support indefinitely" quote via
https://simonwillison.net/2025/Mar/11/responses-vs-chat-completions/ (original
openai.com page 403-gated).

**OpenAI Agents SDK** (cloned, read directly): `openai/openai-agents-js`
`packages/agents-core/src/events.ts`, `types/protocol.ts`, `types/helpers.ts:16`,
`runner/streaming.ts`, `run.ts`; `packages/agents-openai/src/rawModelEvents.ts`,
`openaiResponsesModel.ts`. `openai/openai-agents-python`
`src/agents/stream_events.py`, `src/agents/items.py`.

_Caveat: OpenAI doc pages 403 automated fetch; §1/§4 positioning claims rely on
provider-doc retrieval and one secondary quotation, flagged inline._
