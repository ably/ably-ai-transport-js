# Abstractions

## Layout

The generic layer lives in `src/core/` and `src/react/`; each codec lives in its
own directory (`src/vercel/`, `src/openai/`, …), with any React hooks under a
`react/` subdirectory (e.g. `src/vercel/react/`). Within each, `codec/` and
`transport/` are separate concerns. Shared header/event/message-name constants
and Ably message helpers sit at the top of `src/` (`constants.ts`, `utils.ts`).
Tests mirror `src/` under `test/`.

The package ships several entry points, each with its own `index.ts` (see the
table). That `index.ts` is the authoritative list of what is public — only
types and functions it re-exports are public API. New codecs add a new entry
point — plus a `/react` one if they ship React hooks — rather than changing an
existing one.

The entry points are listed here for orientation; the authoritative list is
`package.json`'s `exports` map.

| Entry point                            | Purpose                                                                                                                                 | Peer deps               |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| `@ably/ai-transport`                   | Core, codec-agnostic transports and codec interfaces (`createClientTransport`, `createAgentTransport`, `defineCodec`, `WireCodec`)      | `ably`                  |
| `@ably/ai-transport/react`             | Transport-shaped React surface for any codec (`ClientTransportProvider`, `useClientTransport`, `useTransportEvents`, `useAblyMessages`) | `ably`, `react`         |
| `@ably/ai-transport/vercel`            | Vercel AI SDK codec, transport factories pre-bound to it, and the `useChat` adapter (`createChatTransport`)                             | `ably`, `ai`            |
| `@ably/ai-transport/vercel/react`      | React provider and hook for the `useChat` adapter (`ChatTransportProvider`, `useChatTransport`)                                         | `ably`, `ai`, `react`   |
| `@ably/ai-transport/openai`            | OpenAI Responses codec (`createResponsesCodec`)                                                                                         | `ably`, `openai`        |
| `@ably/ai-transport/temporal`          | Temporal worker plugin and framing activities                                                                                           | `ably`, `@temporalio/*` |
| `@ably/ai-transport/temporal/workflow` | Workflow-side halves of the Temporal integration (sandbox-safe: no `ably` import)                                                       | `@temporalio/workflow`  |

## Two-layer architecture

The codebase splits into two layers: a **generic layer** and a **codec layer**.
The codec layer is implemented once per provider — each such implementation a
_codec_ (Vercel, OpenAI, …). This separation is the most important invariant to
preserve:

- **Generic layer** (`src/core/`, `src/react/`) — defines the wire-only
  `WireCodec<TInput, TOutput>` interface (see `src/core/codec/types.ts`) and
  the codec-parameterized transports (`ClientTransport`, `AgentTransport`, run
  and step bracketing, cancel and steer routing, history paging). It is
  framework-agnostic: `TInput` and `TOutput` are unconstrained type
  parameters, the transport carries them as opaque values, never inspects
  them, and reads or writes only transport-tier metadata — never
  codec-specific domain metadata (see header discipline below).
- **Codec layer** (`src/vercel/`, `src/openai/`, …) — one _codec_ per provider,
  each implementing the `WireCodec` for that provider's wire format against
  its types, and optionally adding convenience factories and React hooks.
  Vercel is the fullest worked example: its `createChatTransport` adapter
  wraps a generic `ClientTransport` to satisfy the interface `useChat`
  expects.

Codec and transport are themselves distinct: the **codec** owns the wire
format (encode/decode of events and messages); the **transport** owns runs,
steps, channel I/O, cancel and steer routing, and history paging. The
transport is parameterized by the codec and never hardcodes a wire format.

**The SDK does not assemble messages.** Merging decoded events into messages,
storing them, and rendering a thread belong to the application. The wire
carries the provider's own event vocabulary, which is what lets the provider's
own reducer do the merge (`readUIMessageStream` from `ai`; OpenAI's
`accumulateResponse`). The application's one structural job is
demultiplexing: bucket a batch's `message` events by `meta.transportMessageId`
and feed each bucket to the provider's reducer — delivery order is
conversation order, so no sorting is needed. The decoder's mid-stream-join
repair (synthesising the openers a late joiner never saw) is the contract
that makes the strict provider reducers safe to lean on; if a gap turns up,
fix the decoder — do not add a reducer to the SDK.

**The transport constrains nothing about an input.** An input is a
codec-defined body the transport carries opaquely. Addressing (the
transport-message-id, parent, fork and regenerate structure) travels on
`PublishInputOptions` on the way out and `WireMeta` on the way back — never on
the event itself. Codecs pick the provider's own types for bodies wherever one
exists (a `UIMessage` for a turn, a `tool-output-*` chunk for a resolution, a
`function_call_output` item), so the provider's reducer merges inputs and
outputs through one code path; the approval decision is the one codec-defined
body, because no provider models it.

**Wire curation belongs to the codec, at encode.** Every event a codec
supports is transmitted (as a discrete event or a stream, possibly with a
slimmed payload) or deliberately kept off the wire (a `drop` descriptor);
anything else throws at the encoder, so a genuinely unexpected provider event
fails loudly rather than leaking onto the channel. Agents pipe their output
stream to the transport as-is for everything the codec supports — an agent
that opts into a provider surface the codec doesn't model must filter those
events out before publishing, and the throw makes forgetting that loud. (A
provider SDK may still supply its own conversion first — Vercel's
`toUIMessageStream()` turns a `streamText` result into the chunk stream that
the codec's union models — but that is the provider's shape conversion, not
our curation point.)

## The transports

- **`ClientTransport`** — publish inputs (nothing is emitted locally: the
  sender's own input reaches it back as the ordinary channel delivery, keyed
  by the returned `transportMessageId`), cancel and steer runs (a steer's
  `published` resolves from the publish acknowledgement's serial), subscribe
  to the classified event stream, and page history. Holds no conversation
  state: the only cross-message state is the steer ledger and the pending
  run-id watches.
- **`AgentTransport`** — open runs (`ai-run-start` / `ai-run-resume`, decided
  by the located trigger's run-id header; `adoptRun` re-enters durably and
  puts nothing on the wire until output or a terminal), pipe output through the encoder bracketed in steps,
  locate the input that woke an invocation (`locateInput`), and page history
  for model context. Cancels route onto the matching run handle; steers flip
  `hasInput()`.
- Both share one receive path (`receive-transport.ts`): decode, classify into
  `TransportEvent` (`message` / `run-lifecycle` / `step-lifecycle`), emit to
  subscribers. `history()` is bounded at the channel attach point and shares
  the live decoder, so a stream spanning the boundary is decoded once — live
  and history cannot overlap, and a consumer merges each delivered event once,
  in delivery order, with no dedup machinery.

## Composition, not inheritance

Transports are assembled from composable parts, not class hierarchies. A
`ClientTransport` composes the codec's encoder/decoder, the receive stream,
the steer coordinator, and the history walk. An `AgentTransport` composes the
codec's encoder with per-run stream piping (the run/step writer) and run
registration for cancel routing.

## Dependency injection

All dependencies are passed through constructors or option objects. There are
no singletons or service locators.

## Class pattern

Use ES6 classes with the **interface + default implementation** pattern:

- Define a public **interface** for the contract (e.g. `ClientTransport`,
  `TransportReceiver`).
- Implement it with a **`Default*` class** (e.g. `DefaultClientTransport`).
  The interface is public API; the class is internal.

### Private state

Use `private readonly` fields with an underscore prefix. Store all
constructor-injected dependencies as private fields:

```ts
class DefaultFoo<TInput, TOutput> implements Foo<TInput, TOutput> {
  private readonly _dep: SomeDependency<TOutput>;
  private readonly _logger: Logger;

  constructor(options: FooOptions<TInput, TOutput>) {
    this._dep = options.dep;
    this._logger = options.logger.withContext({ component: 'Foo' });
  }
}
```

### Property access

Expose public state via getters that return the interface type, not the
implementation.

### Factory functions as entry points

Public entry points (e.g. `createClientTransport()`) are factory functions
that instantiate and wire up the internal classes. Consumers never call `new
Default*` directly.

### Classes vs plain functions

- **Class** — when a component holds state, manages subscriptions, or has a
  lifecycle (construct/dispose). Most transport sub-components.
- **Plain function** — stateless transformations, one-shot utilities, codec
  encode/decode. Input in, output out, no retained state.

## Summary of principles

1. **Generic-vs-codec split** — the generic transport knows nothing about any
   specific codec; each codec (Vercel, OpenAI, …) implements the `WireCodec`
   and provides wrappers.
2. **Codec/transport separation** — codec owns the wire format; transport owns
   runs, steps, and channel I/O, parameterized by the codec.
3. **Codec-parameterized, unconstrained** — generic components are
   parameterized by `<TInput, TOutput>` via `WireCodec`; the transport never
   inspects an event.
4. **Constructor/option injection** — no singletons, no globals.
5. **Composition, not inheritance** — compose features; no class hierarchies.
6. **Interface-first** — public contracts are interfaces; implementations are
   internal `Default*` classes, exposed via factory functions.
7. **Header discipline** — SDK metadata travels on the wire under an
   `extras.ai` envelope split into a transport tier (`extras.ai.transport`,
   always present) and an optional codec tier (`extras.ai.codec`). The generic
   layer reads and writes only the transport tier; codec-specific metadata
   belongs in the codec tier, owned by the codec layer. The envelope is also
   what marks a wire as ours: a transport shares its channel with the
   application, so a message without `extras.ai` is **foreign** — it decodes
   to no events and drives no run, while still surfacing raw on
   `ably-message`. Classify foreign traffic by the envelope, never by the wire
   `name`, which the platform does not echo on appends.
8. **Explicit exports** — only what an `index.ts` re-exports is public API.
9. **Self-contained features** — each manages its own subscriptions, state, and
   cleanup.
10. **Single shared channel, caller-owned** — one Ably channel per transport,
    shared by all features. The caller resolves and owns the channel; the
    transport subscribes its own listener and never detaches it.
11. **No message assembly in the SDK** — no reducer, no merge driver, no
    projection type; the application merges with the provider's own machinery.
