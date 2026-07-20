# Sharing the channel with Pub/Sub

An AI Transport session channel is an ordinary Ably channel, so applications can publish their own Pub/Sub messages on it alongside the conversation — a human-handoff exchange, moderation events, custom telemetry. The transport ignores traffic it does not own, and the SDK ships helpers to read that raw record back and merge it with the conversation into one serial-ordered transcript.

## The reservation

The transport reserves two things on the channel, and classifies by them:

- the **`ai-` message-name prefix** (exported as `TRANSPORT_NAME_PREFIX`) — every transport wire message rides a name under it (`ai-input`, `ai-output`, `ai-run-start`, …);
- the **`extras.ai` envelope** — the SDK's corner of the message extras, carrying transport and codec headers.

A message carrying either is transport traffic; everything else is **foreign** — application-owned. Application code must not publish messages under the `ai-` prefix or write the `extras.ai` envelope (the application's own `extras.headers` is untouched and free to use). Two predicates make the classification available to application code:

```typescript
import { isForeignMessage, isTransportMessage } from '@ably/ai-transport';

channel.subscribe((message) => {
  if (isForeignMessage(message)) {
    // application traffic — yours to handle
  }
});
```

## Reading the raw record: `fetchRawHistory`

`fetchRawHistory` pages `channel.history()` internally and returns matching raw messages **oldest-first**. It is the reliable read path for the raw record: a cold-started client or agent can always (re-)fetch messages it never observed live.

```typescript
import { fetchRawHistory } from '@ably/ai-transport';

const raw = await fetchRawHistory(channel, {
  filter: (m) => m.name === 'handoff.message', // default: isForeignMessage
  sinceSerial, // inclusive floor — stop paging below this serial
  untilSerial, // inclusive ceiling — with sinceSerial, a closed serial window
});
```

Behaviour to know:

- **Attaches the channel first** (idempotent), and bounds the read at the attach point by default (`untilAttach: true`) so it composes gaplessly with a live subscription registered before the call. Pass `untilAttach: false` to read up to the present.
- **Never silently truncates.** The read walks up to `maxPages` history pages (default 50); if pages remain beyond the cap it rejects with `HistoryFetchFailed` rather than returning a partial record. Raise `maxPages` or bound the read with `sinceSerial` to go deeper.
- Accepts a `logger` for diagnostics, like the other transport components.

### The fetch-on-load + live-append recipe

To observe the raw record continuously — past and future — subscribe first, then fetch, and de-duplicate by message `id`:

```typescript
const byId = new Map<string, Ably.InboundMessage>();
const upsert = (message: Ably.InboundMessage) => {
  const key = message.id ?? message.serial;
  if (key !== undefined) byId.set(key, message);
};

// Live first: nothing published after the attach point is missed…
await channel.subscribe((message) => {
  if (isForeignMessage(message)) upsert(message);
});

// …then the retained record, bounded at the attach point (the default).
const history = await fetchRawHistory(channel);
for (const message of history) upsert(message);
```

## Merging with the conversation: `mergeBySerial`

Every Ably message carries a channel **serial** — a lexicographically ordered identity. `mergeBySerial` interleaves a View's conversation messages with raw messages into one serial-ordered transcript, for rendering or for assembling an LLM context that includes the raw exchange:

```typescript
import { mergeBySerial, runStartSerialOf } from '@ably/ai-transport';

const transcript = mergeBySerial(
  view.getMessages(), // conversation, in View order
  runStartSerialOf(session.view, session.tree), // codec-message-id → owning run's start serial
  raw, // oldest-first, as fetchRawHistory returns
);

for (const item of transcript) {
  if (item.kind === 'conversation') {
    // item.codecMessageId, item.message — a View message
  } else {
    // item.message — a raw Ably.InboundMessage
  }
}
```

Each conversation message is positioned by the serial `serialOf` returns for its codec-message-id. `runStartSerialOf` builds the canonical lookup — the owning run's start serial — from a View and its Tree (run start serials live on the Tree's `RunNode`, not the View-facing `RunInfo`). A conversation message with no serial yet (an optimistic local message whose run has not started) stays in place at the end, and raw messages without a serial are dropped.

## Limitations

- **The conversation Tree does not model raw traffic.** Raw messages are not nodes: they cannot be branched, edited, or regenerated, and branch navigation skips over them. The merged transcript is a _projection_ for rendering and context assembly, not conversation state.
- **The raw record depends on channel history retention.** The channel's namespace must have message persistence enabled, and the history TTL bounds how far back `fetchRawHistory` can rebuild the record. (The transport's own streaming additionally needs mutable messages — see [History](history.md).)
