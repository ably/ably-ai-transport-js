# Database hydration

Database hydration seeds a conversation from your own store, then reconciles only the not-yet-stored tail off the Ably channel - so a returning user sees their history instantly and the channel supplies just what the store hasn't caught up on yet.

The channel already persists the whole conversation, so [history replay](history.md) alone can rebuild it. But paging the entire channel on every page load is wasteful once you keep your own copy, and most apps already store conversations for search, billing, or analytics. Database hydration lets that store be the source for the bulk of the history and uses the channel only for the live edge.

## The seam

The store and the channel overlap. The store holds every completed turn up to some point; the channel holds everything, including the turns the store hasn't recorded yet. The newest message the store and channel share is the **seam** - the join point.

The seam is keyed on the **domain message id** (`message.id`) - the only id shared between your store and the channel. The transport's internal `codecMessageId` is never persisted, so it can't be the seam key.

[`View.loadUntil`](../reference/react-hooks.md#viewloaduntil) walks the channel back until it reaches the seam, then returns the messages **strictly newer than** it - the seam itself is excluded, because that one message is the overlap you already hold in the seed. Composing `[...seed, ...tail]` therefore has no gap and no duplicate.

With no stored history (an empty seed, or a seam absent from the channel) the predicate never matches and `loadUntil` hydrates the whole conversation - so an unseeded client behaves exactly like plain history replay.

## Server side

The agent is the **sole writer** to the store. After a run completes, it appends that turn; on the next invocation it seeds from the store and reconciles the tail, exactly as the client does. Persist only completed turns - a cancelled or errored partial stays on the channel and is read back from there.

```typescript
import { streamText, convertToModelMessages } from 'ai';
import { createAgentSession, vercelRunOutcome } from '@ably/ai-transport/vercel';
import { Invocation, type InvocationData } from '@ably/ai-transport';
import { appendMessages, loadMessages } from './message-store';

const invocation = Invocation.fromJSON((await req.json()) as InvocationData);
const session = createAgentSession({ client: ably, channelName: invocation.sessionName });
await session.connect();
const run = session.createRun(invocation, { signal: req.signal });

// Seed from the store; the newest stored message is the seam. loadUntil pages
// run.view back to it and returns only the not-yet-stored tail (here, this
// invocation's new input). It drives the paging itself - which also folds in the
// triggering input, published to the channel before this per-request agent
// attached - so start() proceeds once that input is located.
const seed = loadMessages(invocation.sessionName);
const seamId = seed.at(-1)?.id;
const tail = await run.view.loadUntil((m) => m.message.id === seamId);
await run.start();

const conversation = [...seed, ...tail.map((m) => m.message)];

const result = streamText({
  model,
  messages: await convertToModelMessages(conversation),
  abortSignal: run.abortSignal,
});

const pipeResult = await run.pipe(result.toUIMessageStream());
const outcome = await vercelRunOutcome(pipeResult, result.finishReason);
await run.end(outcome);
// Persist after the run ends. Keyed by domain id, so re-persisting a turn is
// idempotent; only completed turns are stored.
if (outcome.reason === 'complete') await appendMessages(invocation.sessionName, run.messages);
```

`run.messages` is this run's own turn (its triggering input plus its streamed output) - the exact unit to persist. A turn the store hasn't caught up on yet is still read from the channel by the next reader, so nothing is dropped in the window between a run ending and its store write landing.

## Client side

The client renders the seed immediately and stitches the live tail on at the seam. Which hook you use depends on the integration path.

### useClientSession path

When you render messages yourself, [`useMessagesWithSeed`](../reference/react-hooks.md#usemessageswithseed-vercel) does the reconciliation and returns the composed list:

```tsx
import { useMessagesWithSeed } from '@ably/ai-transport/vercel/react';

function Chat({ seed }: { seed: UIMessage[] }) {
  const { session } = useClientSession();
  const messages = useMessagesWithSeed({ view: session.view, seed });

  return (
    <ul>
      {messages.map((m) => (
        <li key={m.id}>{/* render m */}</li>
      ))}
    </ul>
  );
}
```

Pass a **stable** `seed` reference (the page-load history) - a new reference re-runs the seam walk. While the seed is still loading from your store, pass `skip: true` rather than `[]`: an empty array is a loaded-but-empty conversation, which surfaces the live channel unchanged.

### useChat path

With Vercel's `useChat`, seed `useChat` itself and let [`useMessageSync`](../reference/react-hooks.md#usemessagesync) reconcile via its `messages` option:

```tsx
import { useChat } from '@ai-sdk/react';
import { useChatTransport, useMessageSync } from '@ably/ai-transport/vercel/react';

function Chat({ chatId, seed }: { chatId: string; seed: UIMessage[] }) {
  const { chatTransport } = useChatTransport();
  const { messages, setMessages } = useChat({ id: chatId, transport: chatTransport, messages: seed });

  // Pass the stable `seed`, not useChat's live `messages`: useMessageSync writes
  // the reconciled result back through setMessages, so feeding `messages` back in
  // would churn the seam reference on every push.
  useMessageSync({ messages: seed, setMessages });

  return <>{/* render messages */}</>;
}
```

## The single-pager precondition

Reconciliation drops the one overlapping message at the seam, on the assumption that the seam walk is the **only** thing paging that view. Point a second paginator (e.g. [`useView`](../reference/react-hooks.md#useview)) at the same `session.view` and page it past the seam, and you can reintroduce a duplicate. Render the seeded conversation from the composed result instead of mixing pagers over one view.

This is also why the seeded UI stays linear: cancel a still-active response before starting a new turn, so the seam reconciliation only ever meets complete (or cancelled) turns.

## Edge cases

| Situation                    | What happens                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------- |
| Empty seed (`[]`, loaded)    | No seam; `loadUntil` hydrates the whole channel - identical to plain [history replay](history.md) |
| Seam absent from the channel | The predicate never matches; the whole window is returned, so the conversation still hydrates     |
| Seed still loading           | Pass `skip: true` (the hooks) so the walk holds until the seam id is known                        |
| Store behind the channel     | The missing turns are read from the channel; the store catches up on the next agent write         |

See [History and replay](history.md) for the underlying pagination, [Runs](../concepts/runs.md) for `run.messages` and `run.view`, and the [React hooks reference](../reference/react-hooks.md#usemessageswithseed) for the hook signatures.
