/**
 * The agent. The browser POSTs one of two things here. The user's message,
 * which it has already published on the channel. Or the user's answers to the
 * tool calls the last reply ended with: the route runs each approved call,
 * refuses each declined one, and publishes the results on the channel itself,
 * as the input of the next request. Either way the route records the input in
 * the conversation the store holds for the channel, and streams Claude's
 * reply back over the same channel, one Message at a time: a reply that
 * pauses mid-turn (`pause_turn`, a server tool's loop reaching its limit) is
 * continued with another request. Each Message is recorded with the pipe's
 * last serial once it has landed. A reply that calls one of the app's tools
 * ends the turn and waits for the user (see `./tools.ts`).
 */

import { createTransport, ErrorCode } from '@ably/ai-transport';
import { anthropic } from '@ably/ai-transport/anthropic';
import Anthropic from '@anthropic-ai/sdk';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';
import Ably from 'ably';

import { loadConversation, recordEntries } from '../store';
import { answerCalls, pendingCalls, tools } from './tools';

/**
 * What the page POSTs. Anyone can send this request, so every field is
 * checked, and the route builds each message the model sees itself: the
 * browser sends plain text, or a yes or no for each pending call.
 */
interface ChatRequest {
  /** The channel the conversation lives on; only `ai:` channels, as the browser's token allows. */
  channelName?: unknown;
  /** The id this turn's messages carry, as the `requestId` header and in their stored ids. */
  requestId?: unknown;
  /** The user's message, already published on the channel. */
  text?: unknown;
  /** The user's answer to each pending tool call, by tool use id: `true` runs it, `false` refuses it. */
  approvals?: unknown;
}

export async function POST(req: Request) {
  const { channelName, requestId, text, approvals } = (await req.json()) as ChatRequest;
  if (typeof channelName !== 'string' || !channelName.startsWith('ai:') || typeof requestId !== 'string') {
    return new Response('channelName must name an ai: channel, and requestId is required', { status: 400 });
  }

  // Answers become the tool results here, from the calls the store holds, so
  // the browser decides only whether each call runs, never what it runs with.
  // Nothing is awaited between reading the calls and recording the input, so
  // a second request for the same calls, from another tab, finds them
  // answered.
  const calls = pendingCalls(loadConversation(channelName)?.entries.at(-1)?.param);
  let input: MessageParam;
  if (approvals === undefined) {
    if (typeof text !== 'string') {
      return new Response('text is required', { status: 400 });
    }

    // The Messages API rejects a conversation where a tool call is not
    // answered in the next message.
    if (calls.length > 0) {
      return new Response('unable to send a message; the last reply has tool calls waiting for an answer', {
        status: 409,
      });
    }

    input = { role: 'user', content: text };
  } else {
    const results = answerCalls(calls, approvals);
    if (results === undefined) {
      return new Response('unable to run tools; the answers do not match the pending calls', { status: 409 });
    }

    input = { role: 'user', content: results };
  }

  const apiKey = process.env.ABLY_API_KEY;
  if (apiKey === undefined) {
    return new Response('ABLY_API_KEY is not set', { status: 500 });
  }

  recordEntries(channelName, [{ id: `${requestId}:0`, param: input }]);

  // Both clients are made per request, inside the handler: the agent is
  // short-lived, and `next build` loads this module without either key.
  // Ably rolls the appends a connection publishes within 40ms into one
  // delivery; a window of 0 delivers every delta as its own message.
  const claude = new Anthropic();
  const ably = new Ably.Realtime({ key: apiKey, transportParams: { appendRollupWindow: 0 } });
  const transport = createTransport({ client: ably, channelName, codec: anthropic });
  // The input's own id tags every message of the turn, so the page can tell
  // one turn's Messages from another's.
  const headers = { requestId };

  try {
    // The browser published its own message; tool results exist only here.
    if (approvals !== undefined) await transport.send({ type: 'input', messages: [input] }, { headers });

    for (;;) {
      const messages = (loadConversation(channelName)?.entries ?? []).map((entry) => entry.param);
      // The stream goes straight into `pipe`: `MessageStream` starts its
      // request when it is created and queues events only once a reader is
      // attached. A closed browser tab aborts the pipe through the request's
      // signal, and the pipe then rejects OperationCancelled once it has
      // flushed what it wrote.
      const stream = claude.messages.stream(
        {
          model: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5-5',
          max_tokens: 16000,
          thinking: { type: 'adaptive', display: 'summarized' },
          tools,
          messages,
        },
        { signal: req.signal },
      );
      const { serial } = await transport.pipe(stream, { signal: req.signal, headers });
      // A stream that fails part-way can end its iteration without an error,
      // so the pipe resolves; `finalMessage` is what rejects.
      const reply = await stream.finalMessage();

      // The reply goes back to the model as it came, thinking signatures and
      // server tool results included; the rest of the Message is not a param.
      if (serial !== undefined) {
        recordEntries(channelName, [{ id: reply.id, param: { role: 'assistant', content: reply.content } }], serial);
      }

      if (reply.stop_reason !== 'pause_turn') break;
    }

    return new Response(null, { status: 204 });
  } catch (error) {
    // A cancelled or failed reply never gets its `message_stop`, and every
    // page shows a reply as streaming until one arrives, so the route sends
    // it. The reply itself is not recorded: what landed of it stays on the
    // channel.
    try {
      await transport.send({ type: 'message_stop' }, { headers });
    } catch (sendError) {
      console.error('unable to end the reply', sendError);
    }

    if (error instanceof Ably.ErrorInfo && error.code === ErrorCode.OperationCancelled) {
      return new Response(null, { status: 204 });
    }

    console.error('turn failed', error);
    return new Response(error instanceof Error ? error.message : 'turn failed', { status: 500 });
  } finally {
    await transport.close();
    ably.close();
  }
}
