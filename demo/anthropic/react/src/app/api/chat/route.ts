/**
 * Chat API route — receives messages from the client transport's HTTP POST,
 * streams the AI response back over Ably using the Anthropic Agent SDK.
 *
 * The Agent SDK's query() function produces an AsyncGenerator<SDKMessage>.
 * We filter to conversation-relevant types (AgentCodecEvent) and pipe them
 * through the Anthropic transport's encoder to the Ably channel.
 */

import { after } from 'next/server';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import Ably from 'ably';
import { createServerTransport } from '@ably/ai-transport/anthropic';
import type { AgentCodecEvent, AgentMessage } from '@ably/ai-transport/anthropic';
import type { MessageNode } from '@ably/ai-transport';

/** Shape of the POST body sent by the client transport. */
interface ChatRequestBody {
  turnId: string;
  clientId: string;
  messages: MessageNode<AgentMessage>[];
  history?: MessageNode<AgentMessage>[];
  id: string;
  forkOf?: string;
  parent?: string | null;
}

/** Check if an SDKMessage is a conversation-relevant AgentCodecEvent. */
function isAgentCodecEvent(msg: SDKMessage): msg is AgentCodecEvent {
  return ['stream_event', 'assistant', 'user', 'result', 'tool_progress'].includes(msg.type);
}

/** Convert the Agent SDK's async generator into a ReadableStream<AgentCodecEvent>. */
function sdkMessageStream(queryResult: AsyncIterable<SDKMessage>): ReadableStream<AgentCodecEvent> {
  return new ReadableStream({
    async start(controller) {
      try {
        for await (const message of queryResult) {
          if (isAgentCodecEvent(message)) {
            controller.enqueue(message);
          }
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });
}

/** Extract the user's prompt text from the conversation messages. */
function extractPrompt(messages: MessageNode<AgentMessage>[], history: MessageNode<AgentMessage>[]): string {
  // Get the latest user message text
  const allMsgs = [...history, ...messages];
  const lastUser = allMsgs.filter((m) => m.message.type === 'user').at(-1);
  if (!lastUser) return '';

  const content = lastUser.message.message.content;
  if (typeof content === 'string') return content;

  // Content is an array of content blocks — extract text
  if (Array.isArray(content)) {
    return content
      .filter(
        (block): block is { type: 'text'; text: string } =>
          typeof block === 'object' && block !== null && 'type' in block && block.type === 'text',
      )
      .map((block) => block.text)
      .join('\n');
  }

  return '';
}

// Server-side Ably client — uses API key directly (trusted environment).
const ably = new Ably.Realtime({ key: process.env.ABLY_API_KEY! });

export async function POST(req: Request) {
  const { messages, history = [], id, turnId, clientId, forkOf, parent } = (await req.json()) as ChatRequestBody;
  const channel = ably.channels.get(id);

  const transport = createServerTransport({ channel });
  const turn = transport.newTurn({ turnId, clientId, parent: parent ?? undefined, forkOf });

  await turn.start();

  // Publish user messages to the channel so all clients see them
  let lastUserMsgId: string | undefined;
  if (messages.length > 0) {
    const { msgIds } = await turn.addMessages(messages, { clientId });
    lastUserMsgId = msgIds.at(-1);
  }

  // Extract the user's prompt for the Agent SDK
  const prompt = extractPrompt(messages, history);

  // Bridge the transport's abort signal to an AbortController for the Agent SDK.
  // When the client cancels a turn, the transport fires turn.abortSignal, which
  // propagates to the Agent SDK to stop the LLM call.
  const abortController = new AbortController();
  turn.abortSignal.addEventListener('abort', () => abortController.abort(), { once: true });

  // Call the Agent SDK — this spawns a Claude Code process that calls the
  // Anthropic API with the ANTHROPIC_API_KEY environment variable.
  const conversation = query({
    prompt,
    options: {
      includePartialMessages: true,
      maxTurns: 1,
      systemPrompt: 'You are a helpful assistant.',
      abortController,
    },
  });

  // Stream the response over Ably in the background using after().
  after(async () => {
    const stream = sdkMessageStream(conversation);
    const { reason } = await turn.streamResponse(stream, {
      parent: lastUserMsgId,
    });
    await turn.end(reason);
    transport.close();
  });

  return new Response(null, { status: 200 });
}
