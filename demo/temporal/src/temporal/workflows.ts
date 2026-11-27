/**
 * The agent, as a Temporal workflow: one per chat, which answers each turn
 * the API route signals to it.
 *
 * The model call runs as the AI SDK plugin's streaming model Activity, which
 * publishes each part of the model's stream to the `model` topic of the
 * workflow's stream as it arrives. The workflow publishes what opens and
 * ends each reply, `start` and `finish`, to the `turn` topic. The relay reads
 * both topics, in stream order, and the AI Transport Vercel adaptor writes
 * them to the chat's channel as one reply's `UIMessageChunk`s.
 */

import { startAblyRelay } from '@ably/pubsub-server/temporal/workflow';
import { TemporalProvider } from '@temporalio/vercel-ai-sdk/workflow';
import { condition, defineSignal, setHandler } from '@temporalio/workflow';
import { WorkflowStream } from '@temporalio/workflow-streams/workflow';
import { streamText, type UIMessageChunk } from 'ai';

import { type ChatInput, type Turn, TURN_SIGNAL } from '../shared/chat';

export { ablyRelayWorkflow } from '@ably/pubsub-server/temporal/workflow';

const turnSignal = defineSignal<[Turn]>(TURN_SIGNAL);

/** How long a chat waits for its next turn before the workflow ends. */
const IDLE_TIMEOUT = '10 minutes';

export async function chatWorkflow({ channelName }: ChatInput): Promise<void> {
  const stream = new WorkflowStream();
  const relay = await startAblyRelay(stream, {
    routes: [{ topics: ['turn', 'model'], adaptor: 'vercel', channel: channelName }],
  });
  // One model call runs at a time, so one topic carries every call's parts.
  const model = new TemporalProvider({ languageModel: { streamingTopic: 'model' } }).languageModel('chat');
  const reply = stream.topic('turn');
  const publish = (chunk: UIMessageChunk) => reply.publish(chunk);

  const turns: Turn[] = [];
  setHandler(turnSignal, (turn) => {
    turns.push(turn);
  });

  // Turns run one at a time, as the useChat transport needs: each ends with
  // its `finish`, or an `error`, before the next one's `start`.
  while (await condition(() => turns.length > 0, IDLE_TIMEOUT)) {
    const turn = turns.shift();
    if (turn === undefined) continue;
    publish({ type: 'start', messageId: turn.messageId });
    let failed = false;
    const result = streamText({
      model,
      messages: turn.messages,
      onError: () => {
        failed = true;
      },
    });
    await result.consumeStream();
    publish(failed ? { type: 'error', errorText: 'The agent failed.' } : { type: 'finish', finishReason: await result.finishReason });
  }

  // Waits until the relay has put everything above on the channel.
  await relay.complete();
}
