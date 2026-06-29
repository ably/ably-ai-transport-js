# OpenAI codec — investigation findings and recommendations

_Companion to `openai-codec-investigation.md`. Addresses AIT-742 (parent epic
AIT-897 "OpenAI"). Grounded in: our own code; the official OpenAI SDKs
(`openai-node` v6.45.0, `openai-python` v2.44.0, `openai-agents-js`,
`openai-agents-python`), cloned and read directly; and official OpenAI docs.
Source list at the end._

---

## 0. TL;DR

1. **The ticket's premise needs refining, not discarding.** A verified survey of
   ~25 targets (§1) shows **~18 expose a Responses API** — all the major inference
   providers (OpenAI, Azure GA; OpenRouter, Groq, Fireworks beta; SambaNova, xAI,
   Perplexity), every serious OSS runtime (vLLM, SGLang, Ollama, llama.cpp, LM
   Studio, LocalAI, KoboldCpp; only TGI lacks it), and the big clouds/gateways
   (Bedrock, Cloudflare, Vercel, LiteLLM, HF). The real holdouts are some
   aggregators (Together, Cerebras, DeepInfra…) and, notably, **the model labs'
   OpenAI-compat layers** (Mistral, Gemini, Anthropic, Cohere). Two caveats shape
   the codec: implementations **diverge in event detail** (OpenRouter notably), so
   "Responses" is not one stable wire format; and **statefulness is uneven**, so
   the codec should use Responses statelessly (§1).
2. **This is a three-way decision** (Chat Completions vs Responses vs Agents SDK)
   resting on a product priority only you can set. But the trade-off is softer
   than first thought: Responses now offers **both** broad-and-growing reach
   _and_ rich semantics, while Chat Completions remains the only **universal**
   target (it also reaches the Responses holdouts).
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

OpenAI explicitly positions Responses as the forward path **for OpenAI's own
models**, while keeping Chat Completions supported (verbatim, first-party —
`developers.openai.com` pages fetch fine; only `platform.openai.com` /
`openai.com` 403 automated fetch):

- "While Chat Completions remains supported, Responses is recommended for all
  new projects." / "The Responses API represents the future direction for
  building agents on OpenAI." — migrate-to-responses guide.
- "we expect Responses to become the default way developers build with OpenAI
  models" / "This is the API we'll be building on for the years ahead." /
  "Chat Completions isn't going away. If it works for you, keep using it." —
  responses-api blog.

Note the scoping: "on OpenAI" / "with OpenAI models". This is a forward path for
_OpenAI_, not a statement about the wider "OpenAI-compatible" ecosystem.

**Who actually implements Responses** (rigorously redone survey of ~25 targets;
quotes and per-claim confidence live in the source notes — VERIFIED = primary/SDK
source, ⚠️ = beta/partial/uncertain):

_Has a Responses endpoint (~18 of 25):_

- **Inference providers:** OpenAI (defines it), Azure OpenAI (GA), OpenRouter
  (⚠️ beta), Groq (⚠️ beta), Fireworks (⚠️ beta), SambaNova, xAI/Grok, Perplexity
  (a `/v1/responses` alias of its `/v1/agent`).
- **OSS / self-host runtimes (verified in cloned source):** vLLM, SGLang, Ollama
  (≥ 0.13.3), llama.cpp (⚠️ maintainer-labelled "partial"), LM Studio, LocalAI,
  KoboldCpp. Only **TGI** lacks it.
- **Clouds & gateways:** AWS Bedrock (native, on `bedrock-mantle`), Cloudflare
  (Workers AI `/ai/v1/responses` + AI Gateway), Vercel AI Gateway, LiteLLM (native
  for ~13 providers, else translates down), Portkey (hosted), Kong (enterprise
  plugin), Hugging Face Router (⚠️ beta), Helicone (legacy proxy, pass-through).

_Chat-Completions-only (source-confirmed negatives):_

- **Aggregators/providers:** Together, Cerebras, DeepInfra, Novita, Hyperbolic,
  Baseten (managed), Anyscale (defunct).
- **The model labs' OpenAI-compat layers:** Mistral, Google Gemini, Anthropic,
  Cohere, AI21. **This is the notable gap** — the big labs expose only
  Chat-Completions-shaped compatibility, not Responses.
- **Runtimes/gateways:** TGI; Helicone's newer Rust gateway; Kong's OSS-CE plugin.

So the ticket's instinct ("maybe everyone uses responses") is **substantially
right for inference providers and OSS runtimes, but wrong for the model labs'
compat layers and a chunk of aggregators**. Responses is no longer niche — but
"every OpenAI-compatible endpoint speaks Responses" is still false. Breadth and
richness therefore no longer strictly oppose: Responses now offers _both_ rich
semantics _and_ broad-and-growing reach, while Chat Completions remains the only
truly universal target (it reaches the holdouts above too).

### Two design inputs that matter more than the headcount

**1. "Responses" is not one stable wire format — dispatch on `type`, tolerate
variation.** Providers that document events mostly use OpenAI-canonical
`response.*` names (the OSS runtimes, Groq, Perplexity, Vercel, HF Router).
**OpenRouter diverges** (confirmed against its docs twice): `response.content_part.delta`
(not `response.output_text.delta`), `response.done` (not `response.completed`),
and a trailing `data: [DONE]` that OpenAI's Responses stream never emits. Several
others (Azure, Fireworks, SambaNova, xAI, Cloudflare, Bedrock, Kong) don't
enumerate event names at all. _Aside, correcting an earlier draft error:
`response.done` and `response.content_part.delta` are **not** OpenAI Responses
events — `response.done` is OpenAI's **Realtime** API; the canonical Responses
text-delta is `response.output_text.delta`._ **Implication:** the codec must
dispatch on the JSON `type`, treat both `response.completed` and `response.done`
as terminal, alias divergent delta names, and tolerate a stray `[DONE]`.

**2. Statefulness is uneven — so use Responses _statelessly_, which fits our
architecture.** Server-side chaining (`previous_response_id` / `store`) exists on
OpenAI, Azure, Bedrock, Fireworks, LM Studio and xAI — but **OpenRouter, Groq,
Ollama, llama.cpp and vLLM (by default) are non-stateful, and Perplexity's
`previous_response_id` is a no-op**. A codec that relied on server-side chaining
would break across providers. The lowest-common-denominator — **send the full
conversation each request** — is exactly how our transport already works (the
Tree + `loadConversation` own conversation state). The most broadly compatible
design is therefore also the one that fits us best.

> _Confidence note:_ the OpenAI event taxonomy (§2–3) is high-confidence — read
> from two official SDKs at pinned versions that agree exactly (52 event types,
> a clean zero-diff between `openai-node` and `openai-python`). The provider
> survey was redone rigorously: OSS positives verified in cloned source;
> commercial/gateway claims cross-checked across ≥ 2 sources and tagged
> VERIFIED / CLAIMED / UNCERTAIN in the source notes. Known gaps: exact streaming
> event names for Azure / Fireworks / SambaNova / xAI / Cloudflare / Bedrock / Kong
> are not byte-confirmed; the Kong version and a few provider statuses are
> unresolved; `platform.openai.com` / `openai.com` 403 automated fetch (worked
> around via SDK source and `developers.openai.com`). OpenAI's positioning quotes
> above are first-party verified from `developers.openai.com`.

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

### There is a canonical reduced form (which settles the `TMessage` question)

Going looking for whether OpenAI offers a _canonical reduction_ of the stream —
the thing a render model could be built on — it does. A turn is modelled as
**items**, and the stream reduces to a `Response` whose `output` is
`ResponseOutputItem[]`. This is developer-facing two ways: non-streaming
`responses.create()` returns the `Response` directly, and the streaming helper
`responses.stream()` exposes `.finalResponse()` (public example:
`examples/responses/stream.ts`). Streaming and non-streaming therefore **converge
on the same `Response.output` items**.

The reducer behind this — `accumulateResponse(event, snapshot): Response`
(`src/lib/responses/ResponseAccumulator.ts`) — was originally a private method
(`#accumulateResponse`); following a community request [1] it is now an **exported
function**, importable via the deep path `openai/lib/responses/ResponseAccumulator`
(the package's wildcard `exports` exposes all subpaths). _We found it by digging
for the reduction, not from a usage example — but it is genuinely public, not
internal-only._ So our codec's `fold` can **mirror or directly call** it to
maintain the projection — i.e. the reduction can be OpenAI's own code, not ours.
Mild caveat: a deep `lib/` import has weaker semver guarantees than a top-level
export.

This is what makes the **items-based `TMessage`** the judicious choice (§5): the
items are simultaneously the canonical renderable form _and_ losslessly
model-input (see §5).

[1] https://github.com/openai/openai-node/issues/1736

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

### Does the Agents SDK save us the Phase 2 layering? (HITL & client-side tools)

A natural question: the two parity items we'd otherwise build on top of raw
Responses — **tool approvals** and **client-side tool calls** (§8 Phase 2) — does
adopting the Agents SDK hand them to us for free instead? Verified against
`openai-agents-js` source, the answer splits, and it turns on the word "client":
the SDK's tools run **in the backend process** (function tools) or on
OpenAI/MCP servers — it has **no concept of a tool executed on the end-user's
device**. Ably's "client-side tool" is inherently distributed and made durable by
suspend/resume; that is squarely transport territory, not an SDK feature.

**The resume/HITL API (verified):**

- Resolution is **`RunState.approve(item)` / `reject(item)` only** (`runState.ts:844,871`)
  — a boolean gate. **Neither injects a tool result.** You resume by re-running
  the agent with the same `RunState` (serializable via `toJSON`).
- An **approved tool is executed in-process** via its `invoke` function
  (`tool.ts:313`; `runner/toolExecution.ts` gates then calls `invoke`). There is
  no remote/client execution path and no "defer this call back to the caller"
  mechanism (`deferLoading` exists but is about lazy *MCP tool loading*).
- `run()` does accept `string | AgentInputItem[] | RunState` (`run.ts:433`), and
  the item unions include `FunctionCallResultItem` (`function_call_result`,
  `protocol.ts:538`). So you **can** re-run an agent from a full history that
  already contains a tool result you computed elsewhere.

**What this means per capability:**

| Phase 2 capability | Does the Agents SDK save the layering? |
| --- | --- |
| **Tool approvals (HITL)** | **Partially.** The SDK gives the gating state machine — `needsApproval` → interruption → `approve`/`reject` → resume — so we don't hand-build "pause before this tool, wait for a decision". But after approval the SDK executes the tool **in its own process**, and the actual approver is in a **browser**, so we still ferry the request/response over Ably and bridge it to the SDK's `approve`/`reject`. Our transport already models this (`ToolApprovalResponse` + suspend/resume). |
| **Client-side (browser) tools** | **Essentially not at all.** No native remote-tool concept; `approve`/`reject` can't inject a browser-produced result. The only durable fit is "suspend → browser computes → re-run with `function_call_result` in history" — **identical to the raw-Responses path** (`function_call_output` in the next request). Worse, the SDK's in-process `invoke` model assumes the run stays alive in one process, which **rubs against** Ably's suspend/resume (serverless backends, disconnect survival). For client-side tools you'd bypass the SDK's tool execution entirely — at which point, for that path, the SDK is just calling the model. |

**Conclusion:** the Agents SDK meaningfully reduces Phase 2 work for **approvals**
(the gating primitive), but **not for client-side tools** — those are Ably-transport
work either way, and we already have the machinery. This is itself a mild argument
for the thin, provider-agnostic raw-Responses codec: the gating we'd "lose" by not
using the SDK is small and provider-neutral, while the client-side-tool plumbing is
ours regardless.

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
- **Breadth is no longer a strong argument against Responses.** ~18 of 25
  surveyed targets expose it (§1), including every major inference provider and
  OSS runtime. Betting on Responses is well-aligned with where the ecosystem is
  heading — provided the codec dispatches on `type`, tolerates per-provider
  event-name variation, and uses the API statelessly (the lowest common
  denominator, and the way our transport already works).

**Choose Chat Completions first instead if** the priority is genuinely "as many
OpenAI-compatible providers as possible work with `@ably/ai-transport`". That is
a legitimate, different goal — and it's the one judgement here that is yours, not
mine, because it's a product-priority call sitting on the corrected premise
above. If you take that path, note the Agents-SDK superset argument drops out
entirely (it's irrelevant to provider breadth), and the demo/abstraction-test
value is lower.

I do **not** recommend leading with the Agents SDK: it adds the most dependencies
and OpenAI-specific orchestration surface, and its richest features (handoffs,
multi-agent) are a "Phase 4 wow", not a first shippable increment. And adopting it
early doesn't even remove the Phase 2 work: per §3, the Agents SDK hands you the
*approval* gating primitive but **not** client-side tools (those stay
Ably-transport work regardless), so "switch to the SDK to get HITL for free" only
trims half of Phase 2 — at the cost of OpenAI-coupling the backend.

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
| `TProjection` | opaque **per-node accumulator** the reducer folds into | `VercelProjection` (messages + trackers) | the run's OpenAI items, accumulated — mirroring or directly calling the SDK's `accumulateResponse`; one turn's `ResponseOutputItem`s plus tool-result items added as tools run |
| `TMessage` | the **per-turn shape the UI renders** | `AI.UIMessage` | **a turn's worth of OpenAI items** (`ResponseOutputItem`-grounded; see below) |

**`TMessage` — grounded in OpenAI's items, not a bespoke shape.** We first
assumed OpenAI had "no canonical render type" and leaned toward a hand-rolled
`{ role, parts[] }`. Digging (§2) showed otherwise: a turn is modelled as
**items**, the stream reduces to `Response.output: ResponseOutputItem[]`, and —
critically — **those output items are valid model-input items** (`ResponseInputItem`
includes `ResponseOutputMessage` / `ResponseFunctionToolCall` / `ResponseReasoningItem`
/ `ResponseFunctionToolCallOutputItem`). So an items-based `TMessage` uniquely
satisfies both constraints at once: it is the canonical **renderable** form _and_
it is losslessly **model-input**. Concretely:

- **`TMessage` = one turn's OpenAI items**, roles `user` / `assistant`.
  System/developer instructions are server-side config, not part of the rendered
  tree.
- **Per-turn = one message** (one run → one message), matching Vercel (verified in
  `fold-lifecycle.ts`: `start` makes one message; `start-step` adds boundaries
  _within_ it). A run's multiple `/responses` calls accumulate into the one
  message; `suspend`/`resume` reuses the same `runId` → same node → same message,
  so a client-tool round-trip stays in one message too. The **codec-message-id is
  the message boundary**.
- **The `fold` _is_ the reduction** — mirror or directly call `accumulateResponse`
  (§2) to accumulate items into the projection; `getMessages` returns the turn's
  items.
- **Tool call and result are two separate items** (`function_call` +
  `function_call_output`) linked by `call_id`. The result is **input-only** (the
  model never emits it), so it is appended to the turn when the tool runs —
  server-side in the loop, or client-side via the browser's `ToolResult`. To draw
  the call and its result together, the UI uses a small **render-time pairing
  helper** keyed on `call_id`. We do **not** invent a merged "tool" type, so
  `TMessage` stays a faithful item list.

**Two boundaries, to keep "input/output" straight** (this tripped us up
repeatedly):

- _Ably wire_ — `TOutput` is the agent's OpenAI event stream; `TInput` is the
  client's discrete actions (user message, tool result, regenerate, approval).
- _OpenAI model API_ — model input (`ResponseInputItem[]`) and model output (the
  event stream / reduced `Response`). Because output items are valid input items,
  **the conversation (`TMessage[]`) is essentially the model input already**:
  `toResponsesInput` is **near-identity** — concatenate each turn's items, no real
  translation, and nothing to "split" (the call and its result are already
  separate items).

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
- The Agents SDK phase (Phase 4) is where strain is more plausible — the nested
  JS raw-event envelope and the run-item/agent-updated layers may want richer
  expression. That's a Phase 4 question, not now.

If anything _does_ need to change, I'll surface it explicitly with the cost
rather than just doing it — and the author of the codec API is the right person
to sanity-check any such proposal.

---

## 8. Phased plan (two axes, shippable increment at each phase)

Each phase is described along **two independent axes**, because they are the two
things "progress" can mean here and they don't move in lockstep:

- **Axis A — OpenAI SDK domain functionality**: which underlying OpenAI
  capability the codec/backend consumes at this phase.
- **Axis B — use-client-session parity**: which feature of the existing demo the
  OpenAI demo reaches at this phase.

The structural fact that shapes the split: most of use-client-session's behaviour
— **branching, regenerate, edit, cancel, history hydration, multi-client sync,
run-status UI** — is **transport-level and codec-agnostic** (node/fork structure
lives in transport headers, not codec types), so it arrives as soon as the codec
can decode a basic stream and the demo uses the generic React hooks. The only
parity work that is genuinely codec-and-backend-specific is **client-side tool
calls** and **tool approvals**, because on the Responses path both require the
backend loop to suspend → await a client-published input → resume.

**Full use-client-session parity is reached at the end of Phase 2.**

---

**Phase 0 — spike (½–1 day).** Stand up the Responses event types in a scratch
reducer; confirm the item/content-part/delta model folds into messages cleanly
and that the string-append + codec-message-id assumptions hold. _Output: a go/no-go
on "no core API change", de-risking §7._

**Phase 1 — first OpenAI chat (server-side tools).**

- _Axis A (OpenAI domain):_ response lifecycle + streaming text
  (`output_text.delta/.done`); single and multiple `function_call`s with argument
  deltas; `function_call_output` fed back as the well-known `ToolResult` input —
  driven by a hand-rolled **server-side** agentic loop (the "weather in London"
  example), called **statelessly** (full history per request; see §1).
- _Axis B (parity):_ text rendering, server-side tool rendering, **branching /
  regenerate / edit**, cancel/stop, history hydration, multi-client sync,
  run-status UI — all transport-provided, so they come along once the codec
  decodes the stream and the demo (a copy of use-client-session) uses the generic
  React hooks. (Excluding branching would mean *deleting* the demo's existing
  navigator UI — strictly more work than keeping it.)
- _Shippable:_ a working OpenAI-backed streaming chat with server-side tools and
  full branch navigation — proving the codec abstraction generalises beyond Vercel.
- _Parity:_ **partial** — everything except client-side tools and approvals.

**Phase 2 — full use-client-session parity.**

- _Axis A (OpenAI domain):_ extend the backend loop with **suspend/resume** so a
  tool call can be delegated out of the backend and awaited; **layer approval
  gating** on top of Responses (which has no native HITL) using the well-known
  input variants.
- _Axis B (parity):_ **client-side tool calls** (browser executes → publishes
  `ToolResult` → continuation run) and **tool approval / HITL**
  (`ToolApprovalResponse`).
- _Shippable:_ ✅ **feature parity with use-client-session.**
- _Parity:_ **complete.**

**Phase 3 — beyond parity: richer OpenAI domain (single-agent).**

- _Axis A (OpenAI domain):_ reasoning summaries + reasoning text; refusals; text
  annotations/citations; optionally hosted tools (web/file search, code
  interpreter, image generation, MCP) — each a renderable signal the Vercel demo
  doesn't surface. (The Vercel codec *decodes* reasoning, but use-client-session's
  UI drops it — see the reasoning finding — so this is genuinely net-new on screen.)
- _Axis B (parity):_ already complete; these are net-new capabilities, not parity.
- _Shippable:_ an OpenAI chat that **exceeds** use-client-session (reasoning +
  citations), still single-agent.

**Phase 4 — beyond parity: Agents SDK (multi-agent).**

- _Axis A (OpenAI domain):_ adopt the Agents SDK stream (strict superset, §3):
  framed tool calls/outputs, native HITL & sessions, **handoffs + multi-agent**
  (`agent_updated_stream_event`). Reconcile the JS/Python raw-layer difference if
  both SDKs are in scope.
- _Axis B (parity):_ already complete; additive.
- _Shippable:_ a multi-agent, handoff-capable demo — the "wow".

**Alternative track — Chat Completions codec (broad-reach).** Pursue only if the
universal long tail is a priority: the providers that lack Responses (Together,
Cerebras, DeepInfra…) and especially **the model labs' OpenAI-compat layers**
(Mistral, Gemini, Anthropic, Cohere), which speak only `chat.completion.chunk`
(`delta.content`, `tool_calls[].index`, `[DONE]`). This is a *different goal* from
Phases 3–4, not a continuation. Note **OpenRouter and Groq are not in the holdout
set** — they expose Responses (beta), so the Responses codec already reaches them.

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
  4 is taken — the Agents SDK JS/Python raw-layer divergence and the richer
  event layers.

The biggest _conceptual_ cost was the compatibility correction in §1, which is
now resolved.

---

## 10. Decisions for you

| # | Decision | My recommendation | Why it's yours |
| --- | --- | --- | --- |
| 1 | **Primary target**: Chat Completions (breadth) vs Responses (OpenAI-rich) vs Agents SDK | **Responses first**, growing into Agents SDK | Product-priority call resting on the corrected premise — breadth vs richness is a business trade-off, not a technical one |
| 2 | `TMessage` shape | **A turn's OpenAI items** (`ResponseOutputItem`-grounded), per-turn; a render-time helper pairs tool call+result by `call_id` | It is the canonical renderable form _and_ losslessly model-input; affects the public render model and makes `toResponsesInput` near-identity |
| 3 | Where the agentic loop lives in Phase 1 | **Hand-rolled backend loop** with server-side tools | Sets demo scope/ambition |
| 4 | Phase-1 feature scope | **De-scope** client tools, approvals, reasoning, hosted tools, multi-agent | Sets time-to-first-ship |
| 5 | Build a `useChat`-style adapter for OpenAI? | **No** — consume generic React hooks directly | — |
| 6 | If Phase 4: support both Agents SDK JS _and_ Python raw-layer shapes? | Defer; decide at Phase 4 | Scope of the agentic phase |
| 7 | **Codec stream target**: raw Responses events vs the Agents SDK superset stream | **Raw Responses**; defer Agents SDK to Phase 4 | Determines backend coupling (OpenAI-specific vs provider-agnostic) and whether Phase 2 gating is ours or the SDK's |

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
(`ResponseStreamEvent` :6198, `Response.output: ResponseOutputItem[]` :279/1018,
`ResponseInputItem` :3718) and `src/resources/chat/completions/completions.ts`
(`ChatCompletionChunk` :732); `openai/openai-python` v2.44.0
`src/openai/types/responses/response_stream_event.py`. Stream reduction:
`src/lib/responses/ResponseAccumulator.ts` (`accumulateResponse`), `ResponseStream.ts`
(`finalResponse`), example `examples/responses/stream.ts`; "make it public" request
https://github.com/openai/openai-node/issues/1736.
Docs: https://developers.openai.com/api/docs/guides/streaming-responses,
https://developers.openai.com/api/docs/guides/migrate-to-responses,
https://developers.openai.com/blog/responses-api. **Provider survey** (~25
targets, redone rigorously; OSS positives verified in cloned source, others
cross-checked across ≥ 2 sources with per-claim VERIFIED/CLAIMED/UNCERTAIN tags):
full per-provider notes and citation URLs under the scratchpad at
`scratchpad/responses-api-research/`. "Industry standard / support indefinitely"
quote via https://simonwillison.net/2025/Mar/11/responses-vs-chat-completions/
(original openai.com page 403-gated).

**OpenAI Agents SDK** (cloned, read directly): `openai/openai-agents-js`
`packages/agents-core/src/events.ts`, `types/protocol.ts` (`FunctionCallResultItem`
:538, item unions), `types/helpers.ts:16`, `runner/streaming.ts`, `run.ts`
(`run()` input types :433), `runState.ts` (`approve` :844 / `reject` :871),
`tool.ts` (`invoke` :313, `needsApproval`), `runner/toolExecution.ts` (approval
gate → in-process execute); `packages/agents-openai/src/rawModelEvents.ts`,
`openaiResponsesModel.ts`. `openai/openai-agents-python`
`src/agents/stream_events.py`, `src/agents/items.py`.

_Caveat: OpenAI doc pages 403 automated fetch; §1/§4 positioning claims rely on
provider-doc retrieval and one secondary quotation, flagged inline._
