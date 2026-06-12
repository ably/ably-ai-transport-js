# Design: Trivia Night demo — agent-refereed quiz over AI Transport + LiveObjects

## Goal

A new demo app at `demo/vercel/react/trivia` — a multiplayer trivia game where an AI
agent is the quizmaster. The agent asks questions and judges answers over the
conversation (Vercel codec, `useChat`), while the game state — player roster, current
question, scores — lives in LiveObjects on the **same channel**, mutated by both the
agent (via tools) and the players (directly from the browser).

It is the first demo to exercise the LiveObjects pass-through shipped in
`feat: liveobjects passthrough` (`4020777`), and showcases:

| Feature                                | Where it shows up                                                                          |
| -------------------------------------- | ------------------------------------------------------------------------------------------ |
| `session.object` on both session types | Agent writes scores/questions; clients write the roster                                    |
| `channelModes: OBJECT_MODES`           | Provider + agent session opt-in                                                            |
| Agent-side object writes from tools    | `askQuestion` / `awardPoints` tool calls visible in chat                                   |
| Client-side object writes              | Join flow writes the player entry, no chat message involved                                |
| `LiveCounter` merge semantics          | Two players answer concurrently → both `awardPoints` increments land                       |
| Late-joiner hydration                  | Reload mid-game → scoreboard and current question reappear without history replay          |
| Concurrent runs                        | Every player's answer is its own run on the shared channel                                 |
| Multi-client message sync              | All players see all answers and the agent's verdicts (existing `useMessageSync` behaviour) |

## Background — constraints that shape the design

These were verified against the SDK source and `ably` 2.22.1 (`liveobjects.d.ts`).

### 1. LiveObjects prerequisites

Three things are required (the plugin and modes per `docs/features/liveobjects.md`,
plus its capability note):

- The Realtime client must be constructed with `plugins: { LiveObjects }`
  (`import { LiveObjects } from 'ably/liveobjects'`). The demo's `providers.tsx`
  constructs the browser client, so it adds the plugin there; the agent route adds it
  to its per-request client.
- Sessions must pass `channelModes: OBJECT_MODES`. `ChatTransportProviderProps`
  already forwards it (it is `ClientSessionProviderProps` minus `codec`), and the
  provider seeds its internal `<ChannelProvider>` with the same resolved modes.
- The token capability must include `object-subscribe` / `object-publish`. The demo
  token route currently grants only `['publish', 'subscribe', 'history']`
  (`src/app/api/auth/ably-token/route.ts:34`) — the trivia route adds the two object
  capabilities. The agent uses the API key directly, which has full capability.

### 2. The agent cannot (today) see who sent a message

The agent-side `Run` interface does not expose the invoking client's identity. The SDK
resolves `inputClientId` internally from the matched input event and re-stamps it on
the agent's publishes (`agent-session.ts`), but it is not public API. Client-side,
the View exposes `runOf(message) → RunInfo.clientId` — the existing demos use it to
colour user bubbles per sender — but the agent endpoint has no equivalent.

User-message **`metadata` does not roundtrip** the wire: `encodeMessagePayloads`
(`src/vercel/codec/encoder.ts:483`) encodes only `text`, `file`, and `data-*` parts.
**`data-*` parts do roundtrip** on the input wire and reappear in the agent's
`run.messages`.

**Consequence:** player attribution rides on a `data-*` part attached to each answer
(see "Player attribution" below).

### 3. LiveObjects API shape (ably-js ≥ 2.20, PathObject API)

- `channel.object.get<T>()` → root `LiveMapPathObject` (implicitly attaches).
- Nested objects are created as value types: `LiveMap.create(initialEntries)`,
  `LiveCounter.create(initialCount)`, passed to `map.set(key, value)`.
- `map.set` is **last-write-wins** per key; `counter.increment(n)` is commutative —
  concurrent increments merge. This is why scores are counters, not numbers in a map.
- `path.subscribe(listener)` observes nested changes by default and survives the
  instance at the path being replaced.
- `path.compactJson()` gives a JSON-serializable snapshot — used to feed the game
  state to the model and to render React state.

### 4. Agent route lifecycle

The existing route creates a fresh Ably client per request and closes the session in
`after()` (`use-chat/src/app/api/chat/route.ts`). `streamText()` is eager in AI SDK
v6 — tool `execute` calls can start as soon as the model emits them, possibly before
`after()` runs — but `run.pipe(result.toUIMessageStream())` does not resolve until
the multi-step stream finishes, which includes every awaited `execute`, and
`session.close()` / `ably.close()` only run after that. Object writes inside tools
are therefore safe **as long as they are awaited in `execute`**. Object state is
re-synced from the server on each request's attach, so the per-request ephemeral
client needs no carry-over.

## Game design

Three phases, stored in the object so every client (and the agent, each request)
agrees on where the game is:

1. **Lobby** — players open the page, pick a display name, and join. Joining writes
   the roster entry and a zeroed score counter to the object — no chat message. The
   roster renders live as players arrive. Anyone can type "start the quiz" (or tap a
   suggestion chip) to begin.
2. **Question loop** — the agent (LLM-generated questions, no question bank) calls
   `askQuestion` to publish the current question to the object, and streams banter in
   chat. Players answer in chat; every answer invokes the agent (one run per answer,
   concurrent when players race). The agent judges against the current question, calls
   `awardPoints` for correct answers, and replies in chat ("10 points to Alice!").
   After each settled question it moves on or wraps up.
3. **Finished** — after `totalQuestions`, the agent calls `endQuiz`; the UI shows a
   winner banner over the final scoreboard. The channel stays usable for post-game
   chat, and "play again" starts a rematch (`startQuiz` from `finished` zeroes the
   counters and clears the previous winner).

Players can also join mid-game: a new roster entry and counter are no risk (there
are no points to lose), so the game pane keeps a join form in the `question` phase.

Write ownership is **per key**, and that is what keeps the LWW semantics of `map.set`
harmless: the agent is the only writer of `game` and the only _incrementer_ of score
counters; each client writes only its own `players.<clientId>` entry and creates only
its own score counter (at join, and lazily re-created by the agent's `awardPoints` if
missing — see below). No key ever has two concurrent writers racing on `set`.

## Object schema

```ts
import type { LiveCounter, LiveMap } from 'ably/liveobjects';

// Type aliases, not interfaces: LiveMap's parameter is constrained to
// `Record<string, Value>`, and interfaces have no implicit index signature,
// so an interface here fails to typecheck.

/** A player's roster entry — plain JSON, written once by that player at join. */
type PlayerEntry = {
  name: string; // display name (clientIds are random; names needn't be unique)
  joinedAt: number;
};

/** Quiz progress — written only by the agent. Flat primitives, LWW per key. */
type GameMeta = {
  phase: 'lobby' | 'question' | 'finished';
  questionNumber: number; // 1-based; 0 in lobby
  totalQuestions: number;
  question?: string;
  category?: string;
  winnerClientId?: string; // set by endQuiz
};

/** The channel root. */
type TriviaRoot = {
  game: LiveMap<GameMeta>;
  players: LiveMap<Record<string, PlayerEntry>>; // keyed by clientId
  scores: LiveMap<Record<string, LiveCounter>>; // keyed by clientId
};
```

### Initialization and the first-joiner race

The three root maps are created lazily by the first client to join: if
`root.get('players').instance()` is `undefined`, the client creates `game`, `players`,
and `scores` via `LiveMap.create(...)` sets on the root. Two simultaneous first
joiners can race — root `set` is LWW, so the loser's roster entry can be dropped with
the map that contained it.

The join flow self-heals instead of trying to win the race: the client's root
subscription checks on every update that its own `players.<clientId>` entry still
exists while it believes it has joined, and re-asserts it if missing. This is a few
lines, demonstrates a real LiveObjects pattern, and makes the race harmless.

The score counter needs more care: re-asserting `LiveCounter.create(0)` is a LWW
`set` that would wipe accrued points if it ever fired mid-game (a delayed root
replacement arriving late, for instance), so the client only re-creates its counter
while `game.phase` is `lobby`. Once the quiz is running, a missing counter is healed
by the agent instead: `awardPoints` lazily creates it before incrementing. Together
these keep counter `set`s out of the window where points exist.

## Player attribution

**Decision: attach a `data-player` part to every user message.**

The answer send path becomes:

```ts
sendMessage({
  parts: [
    { type: 'text', text: answer },
    { type: 'data-player', id: clientId, data: { clientId, name } },
  ],
});
```

- The part roundtrips the input wire (verified: `encodeMessagePayloads` encodes
  `data-*` parts; the decoder reconstructs them), so it is present on the agent's
  `run.messages`.
- `convertToModelMessages` drops `data-*` parts by default, but accepts a
  `convertDataPart` option (AI SDK v6) — the route passes a converter that turns each
  `data-player` part into a `Alice (player:user-3f2a) says:` text prefix (with an
  "unknown player" fallback when the part is missing or malformed). The model then
  attributes answers and passes the right `playerClientId` to `awardPoints`. No
  message-mapping layer needed.
- The part is **client-asserted and unverifiable** — any client could claim any
  identity. Fine for a demo; noted because the rejected SDK alternative below
  (`inputClientId`) _is_ server-verified, which strengthens the case for it as a
  follow-up.
- The chat UI renders the part as a small name badge on the bubble (or filters it out
  and keeps the existing `runOf(message).clientId` colouring — see Decisions).

**Alternative considered — expose the invoking clientId on the agent `Run`.** The SDK
already resolves `inputClientId` internally; surfacing it (e.g. `run.clientId`) would
make attribution first-class and is arguably the right long-term API for any
multi-user session. Rejected _for this demo_ because it is an SDK + spec change
(`AIT-` points) that shouldn't be driven from a demo branch. Flagged as a candidate
follow-up issue.

**Alternative rejected — route looks up the input event's publisher via
`channel.history()`.** Re-implements SDK internals in demo code.

## Agent endpoint

`src/app/api/chat/route.ts`, cloned from the use-chat demo with these changes:

```ts
const ably = new Ably.Realtime({ key, plugins: { LiveObjects }, ... });
const session = createAgentSession({
  client: ably,
  channelName: invocation.sessionName,
  channelModes: OBJECT_MODES,
});
await session.connect();
const root = await session.object.get<TriviaRoot>();
```

- The system prompt sets the quizmaster persona (pacing, tone, judging leniency,
  "never reveal the answer before judging") and embeds a JSON snapshot of the live
  game state — `root.compactJson()` — so every run knows the phase, current question,
  roster, and scores without any conversation archaeology.
- `run.messages` is transformed (attribution prefixes, above) before
  `convertToModelMessages`.
- Tools close over `root`; every object write is awaited inside `execute`.

### Tools (all server-executed)

| Tool                                              | Effect on the object                                                                                                                                                               | Guard                                                                                                                      |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `startQuiz({ totalQuestions, category? })`        | `game`: phase → `question`, `questionNumber` → 0. From `finished` (a rematch) it first zeroes every counter (`decrement` by current value) and clears the previous winner/question | phase is `lobby` or `finished`, and at least one player has joined                                                         |
| `askQuestion({ question, category })`             | `game`: sets `question`/`category`, increments `questionNumber`                                                                                                                    | phase is `question`, `questionNumber < totalQuestions`                                                                     |
| `awardPoints({ playerClientId, points, reason })` | `scores.get(playerClientId).increment(points)`, creating the counter first if missing (self-heal, see above)                                                                       | `playerClientId` exists in `players` (the model can hallucinate ids — unknown id returns a tool error result, not a throw) |
| `endQuiz({ winnerClientId })`                     | `game`: phase → `finished`, sets `winnerClientId`                                                                                                                                  | phase is `question`                                                                                                        |

Tool calls render in chat with the existing `tool-invocation` component, so the
object writes are _visible_ in the conversation — part of the demo's point.

Guards live in the tools, not the model: each tool re-reads the object and returns a
descriptive error result when the call doesn't fit the current phase, so a confused
model self-corrects instead of corrupting state.

### Concurrency limits (accepted)

Every player answer is its own agent run, so tools from concurrent runs can
interleave, and LiveObjects offers no cross-call transactions — the guards are
read-then-write, best-effort. The demo keeps the remaining races benign rather than
pretending to eliminate them:

- All `game`-map writes go through `batch()` — one channel message per tool call, so
  clients and competing runs never observe a partially-applied state.
- The rematch score reset decrements each counter by its value read at decrement
  time, not from the run's earlier snapshot, narrowing double-reset to milliseconds.
- The worst surviving race — two simultaneous correct answers both advancing the
  question — costs a question slot, never scores or phase integrity. (Both answers
  getting points is deliberate: each was first from its own view.)

## Client app

Cloned from the use-chat demo (same `package.json` shape, `link:../../../..` SDK,
token route, mock model, shared e2e launcher) with the chat pane kept and the debug
pane replaced by the game pane.

### Wiring

- `providers.tsx`: add `plugins: { LiveObjects }` to the Realtime constructor.
- `page.tsx`: pass `channelModes={OBJECT_MODES}` to `ChatTransportProvider`
  (constant module-level reference — the provider requires `channelModes` stable for
  its lifetime).
- Token route: capability `['publish', 'subscribe', 'history', 'object-subscribe', 'object-publish']`.
- Channel naming, `?channel=` pinning, and "open in new tab" carry over unchanged —
  `?channel=` is how a second player joins the same game, exactly like today's
  multi-client flow.

### `useTriviaState` hook

There are no first-party LiveObjects React hooks (by design — see
`liveobjects-design.md`, Out of scope), so the demo owns one thin hook following the
documented imperative pattern (`docs/features/liveobjects.md`): `object.get<TriviaRoot>()`
on mount, `root.subscribe(...)` (nested by default), state = `root.compactJson()`
snapshot per update, cleanup on unmount. It also exposes the join/self-heal write path:

```ts
const { game, players, scores, joined, join } = useTriviaState(session, clientId);
```

This hook is the demo's reference implementation of "how to consume `session.object`
from React" — worth keeping clean enough to lift into the docs later.

### UI

Left: the chat (existing message list; user bubbles coloured by
`runOf(message).clientId` as today). Right: the game pane, driven entirely by
`useTriviaState` — deliberately _not_ by chat messages, so it works for a late joiner
whose view hasn't loaded history:

- **Lobby**: name input + Join button; live roster; Start hint once ≥ 1 player.
- **Question**: question card (number/total, category, question text) + scoreboard
  sorted by score, updating live as counters tick.
- **Finished**: winner banner over the final scoreboard. The banner resolves
  `winnerClientId` through `players` for the display name, falling back to the raw
  clientId if the roster entry is missing.

Suggestion chips (existing component) offer "Start the quiz 🎲" in lobby and nothing
during questions (answers are free text).

## Testing

**No mock model, no scripted e2e suite.** Unlike the existing demos, this one targets
a real provider key only (`ANTHROPIC_API_KEY` / OpenAI / Vercel AI Gateway, same
`model.ts` resolution minus the `MOCK_LLM` branch) — it is meant to be run as a real
application. LLM-dependent flows are exercised manually against a live key; automated
coverage is unit tests.

(Sandbox LiveObjects support is confirmed, so no spike is needed; the sandbox remains
available for any future e2e work.)

### Unit tests (vitest, jsdom — demo-level)

Matching the existing demos' depth (`__tests__/chat.test.tsx`, `helpers.test.ts`):

- `useTriviaState`: join creates the three maps when absent; self-heal re-asserts a
  dropped player entry; snapshot updates on subscription events (fake `session.object`).
- Attribution helpers: `data-player` part construction; the `convertDataPart`
  converter (unknown/missing part → "unknown player" fallback, never a throw).
- Scoreboard ordering/winner derivation.
- Tool guards: each tool rejects out-of-phase calls and unknown player ids with error
  results (fake root).

## Out of scope

- **Buzzer / first-to-answer mechanics.** "First write wins" can't be built safely on
  LWW map sets; answers race through chat instead, and the agent judges arrival order
  from the conversation. A buzzer is a nice future extension if/when it can be done
  honestly.
- **Exposing `inputClientId` on the agent `Run`** — candidate SDK follow-up, tracked
  separately (see Player attribution).
- **First-party LiveObjects React hooks** — already out of scope SDK-side; the demo's
  `useTriviaState` is app code.
- Timed rounds, question banks, difficulty levels, spectator mode, game persistence
  beyond the channel.

## Work breakdown

1. Scaffold `demo/vercel/react/trivia` from the use-chat demo (config, providers,
   token route with object capabilities, README) — dropping the mock model, the
   Playwright suite, and the client-tool/approval machinery the trivia flow doesn't
   use.
2. Object layer: `TriviaRoot` types, `useTriviaState` hook (init, join, self-heal,
   snapshot subscription) + unit tests.
3. Game pane UI: lobby / question / finished states, scoreboard, winner banner.
4. Chat integration: `data-player` part on send, name badge rendering, suggestion
   chips + unit tests for the attribution helpers.
5. Agent route: `channelModes: OBJECT_MODES`, plugin, system prompt with
   `compactJson()` snapshot, the `convertDataPart` attribution converter, the four
   tools with guards + unit tests for the guards.
6. README: setup (real provider key required), how to invite a second player
   (`?channel=`), what to watch for (scoreboard on both tabs, reload mid-game).
7. Independent subagent review against this doc and `.claude/rules/`.

## Decisions

1. **Base demo** — cloned from `use-chat` (not `use-client-session`): the game wants
   `useChat`'s send/status ergonomics, and its multi-client sync is already proven.
2. **Attribution** — `data-player` part on each user message, converted to a text
   prefix via `convertToModelMessages`'s `convertDataPart` option. No SDK change;
   client-asserted identity accepted as a demo trade-off.
3. **Scores are `LiveCounter`s** — concurrent `awardPoints` merge; everything else is
   LWW-safe because every map key has a single writer.
4. **Questions are LLM-generated** — no question bank; the mock model provides
   determinism for tests.
5. **Per-key write ownership** — agent writes `game` and increments scores; each
   client writes only its own roster entry; counter creation is client-at-join
   (lobby only) with agent-side lazy creation thereafter.

### Open questions

1. Render the `data-player` part as a visible name badge on bubbles, or filter it and
   keep only the existing per-client colour? (Badge proposed — makes attribution
   visible, which is half the demo.)
2. Demo directory name: `trivia` (proposed) vs something more descriptive
   (`liveobjects-trivia`).
3. Should question-advance be agent-judged ("move on when a question is settled") or
   should any player be able to nudge with "next question"? (Proposed: both — the
   agent advances after a correct answer; players can nudge a stalled round.)
