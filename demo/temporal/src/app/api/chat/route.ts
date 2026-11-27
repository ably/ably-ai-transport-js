/**
 * Where the useChat transport posts each turn. The route hands the turn to
 * the chat's workflow, starting it if it is not running, and answers at once:
 * the reply reaches the page over the channel, from the relay.
 */

import { Client, Connection } from '@temporalio/client';
import { convertToModelMessages, type UIMessage } from 'ai';

import type { chatWorkflow } from '../../../temporal/workflows';
import { channelNameOf, TASK_QUEUE, type Turn, TURN_SIGNAL } from '../../../shared/chat';

/** What the transport posts: the chat's id and the whole conversation, among other fields. */
interface ChatRequest {
  chatId: string;
  messages: UIMessage[];
}

export async function POST(req: Request) {
  const { chatId, messages } = (await req.json()) as ChatRequest;
  const turn: Turn = { messageId: crypto.randomUUID(), messages: await convertToModelMessages(messages) };

  const connection = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233' });
  try {
    // One workflow per chat. Signal-with-start delivers the turn to the
    // running workflow, or starts it with the turn as its first signal.
    await new Client({ connection }).workflow.signalWithStart<typeof chatWorkflow, [Turn]>('chatWorkflow', {
      workflowId: `chat-${chatId}`,
      taskQueue: TASK_QUEUE,
      args: [{ channelName: channelNameOf(chatId) }],
      signal: TURN_SIGNAL,
      signalArgs: [turn],
    });
  } finally {
    await connection.close();
  }
  return new Response(null, { status: 202 });
}
