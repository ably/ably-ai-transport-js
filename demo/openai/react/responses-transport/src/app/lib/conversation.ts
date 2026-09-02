/**
 * The agent's view of one conversation: read from the store, updated by the
 * turn it is running, written back.
 *
 * **The channel is never read for history.** The store is the conversation,
 * and everything that has happened since the last write is the input that woke
 * this invocation — which `locateInput` already hands over. So the model
 * context is the stored messages plus that one input, and no history paging
 * happens anywhere in this demo.
 *
 * What the run publishes is recorded as it goes. Each `run.pipe` is one
 * channel message, so {@link Conversation.record} takes one batch of published
 * events and merges them as one message, through the same
 * {@link createThreadMerge} the frontend renders with — so the messages the
 * store ends up holding are the ones a client would have built from the wire.
 *
 * Two writes per turn. The first lands as the run opens, so a page loading
 * mid-run sees the prompt that started it. The second lands when the run is
 * over and carries the assistant's messages.
 */

import type { LocatedInput, WireMeta } from '@ably/ai-transport';
import type { OpenAIOutput } from '@ably/ai-transport/openai';

import { createThreadMerge, type RunSummary, type ThreadMessage } from './merge-thread';
import { loadConversation, saveConversation } from './message-store';
import type { OpenAIInput } from './openai-thread';

/**
 * The metadata for a message this process is recording rather than receiving.
 * The wire fields are absent because these events never came off the channel —
 * `WireMeta` documents `undefined` as exactly that case — and the identity
 * fields are what the merge buckets on.
 * @param transportMessageId - The message's own id.
 * @param runId - The run publishing it.
 * @returns The metadata.
 */
const recordedMeta = (transportMessageId: string, runId: string): WireMeta => ({
  transport: {},
  codec: {},
  headers: {},
  serial: undefined,
  transportMessageId,
  runId,
  stepId: undefined,
  stepStartSerial: undefined,
  timestamp: undefined,
  role: 'assistant',
  clientId: undefined,
  messageName: undefined,
  versionSerial: undefined,
  versionTimestamp: undefined,
  inputTransportMessageId: undefined,
  inputTransportMessageIds: undefined,
  steerTransportMessageIds: undefined,
});

/** The agent's conversation for one turn. */
export interface Conversation {
  /** The conversation as it stands, oldest message first — the model's context. */
  messages(): ThreadMessage[];
  /**
   * Record one batch of published output as one message, under a fresh id.
   * Call it once per `run.pipe`, since each pipe is one channel message.
   * @param events - The events that batch published, in wire order.
   */
  record(events: OpenAIOutput[]): void;
  /**
   * Record how the run ended, so a hydrating client knows its status without
   * reading the channel.
   * @param status - The run's lifecycle status.
   */
  noteRun(status: RunSummary['status']): void;
  /**
   * Write the conversation to the store. Called as the run opens and again
   * when it is over.
   * @returns A promise that resolves once the write is durable.
   */
  save(): Promise<void>;
}

/**
 * Open the conversation for a turn: the stored messages with the triggering
 * input applied.
 * @param channelName - The conversation key (the channel name).
 * @param runId - The run this turn publishes under.
 * @param located - The input that woke this invocation.
 * @returns The conversation.
 */
export const openConversation = (
  channelName: string,
  runId: string,
  located: LocatedInput<OpenAIInput>,
): Conversation => {
  const merge = createThreadMerge();
  merge.seed(loadConversation(channelName));
  // The triggering input is a wire message like any other, so it merges as
  // one — under its own transport-message-id, which is what a later
  // resolution addressed to the same message joins on.
  merge.apply({ kind: 'message', meta: located.meta, inputs: located.inputs, outputs: [] });

  const runs = new Map<string, RunSummary>(loadConversation(channelName).runs);

  return {
    messages: () => merge.messages(),
    record(events) {
      if (events.length === 0) return;
      merge.apply({
        kind: 'message',
        meta: recordedMeta(crypto.randomUUID(), runId),
        inputs: [],
        outputs: events,
      });
    },
    noteRun(status) {
      runs.set(runId, { status });
    },
    async save() {
      await saveConversation(channelName, { messages: merge.messages(), runs: [...runs] });
    },
  };
};
