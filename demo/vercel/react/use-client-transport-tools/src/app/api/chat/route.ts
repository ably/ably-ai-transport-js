/**
 * Chat API route — Wikipedia research assistant with tool calling.
 *
 * - searchWikipedia: auto-executes (no approval needed)
 * - getArticle: requires human approval (needsApproval: true)
 *
 * When a tool needs approval, the turn ends with an approval request.
 * The client sends a new turn with `toolApprovals` in the body to
 * continue — the server executes the approved tool, injects the result,
 * and calls streamText again.
 *
 * Known issue: after the approval turn, the client's conversation tree
 * still contains the stale `approval-requested` tool part (the server-side
 * patch is ephemeral). On subsequent turns, `convertToModelMessages` throws
 * `AI_MissingToolResultsError` because it sees a tool call without a result.
 * See: https://github.com/ably/ably-ai-transport-js/issues/XXX
 */

import { after } from 'next/server';
import { streamText, convertToModelMessages, jsonSchema } from 'ai';
import type { UIMessage } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import Ably from 'ably';
import { createServerTransport } from '@ably/ai-transport/vercel';
import type { MessageWithHeaders } from '@ably/ai-transport';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Shape of the POST body sent by the client transport. */
interface ChatRequestBody {
  turnId: string;
  clientId: string;
  messages: MessageWithHeaders<UIMessage>[];
  history?: MessageWithHeaders<UIMessage>[];
  id: string;
  forkOf?: string;
  parent?: string | null;
  toolApprovals?: ToolApproval[];
}

interface ToolApproval {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  approved: boolean;
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a research assistant with access to Wikipedia. When answering questions:
1. Use searchWikipedia to find relevant articles
2. Use getArticle to read the most relevant article(s)
3. Synthesize the information into a clear, well-sourced answer
4. Always cite which Wikipedia articles you used

Be concise but thorough. If the question doesn't need research, answer directly without tools.`;

// ---------------------------------------------------------------------------
// Wikipedia tools
// ---------------------------------------------------------------------------

function log(message: string, context?: Record<string, unknown>) {
  console.log(message, context ? JSON.stringify(context) : '');
}

const tools = {
  searchWikipedia: {
    description:
      'Search Wikipedia for articles matching a query. Returns a list of article titles and short snippets. Use this to find relevant articles before reading them.',
    inputSchema: jsonSchema<{ query: string }>({
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query' },
      },
      required: ['query'],
    }),
    execute: async ({ query }: { query: string }) => {
      log('[server] tool: searchWikipedia', { query });
      const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=5&origin=*`;
      const res = await fetch(url);
      const data = (await res.json()) as {
        query?: { search?: Array<{ title: string; snippet: string }> };
      };
      const results = (data.query?.search ?? []).map((item) => ({
        title: item.title,
        snippet: item.snippet.replace(/<[^>]*>/g, ''),
      }));
      log('[server] tool: searchWikipedia returned', { resultCount: results.length });
      return results;
    },
  },
  getArticle: {
    description:
      'Fetch the introductory text of a Wikipedia article by its exact title. Use this after searching to read the content of a specific article.',
    needsApproval: true as const,
    inputSchema: jsonSchema<{ title: string }>({
      type: 'object',
      properties: {
        title: { type: 'string', description: 'The exact Wikipedia article title' },
      },
      required: ['title'],
    }),
    execute: async ({ title }: { title: string }) => {
      log('[server] tool: getArticle', { title });
      const url = `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(title)}&prop=extracts&exintro=true&explaintext=true&format=json&origin=*&exchars=2000`;
      const res = await fetch(url);
      const data = (await res.json()) as {
        query?: { pages?: Record<string, { title: string; extract: string }> };
      };
      const pages = data.query?.pages ?? {};
      const page = Object.values(pages)[0];
      const result = {
        title: page?.title ?? title,
        extract: page?.extract ?? 'Article not found.',
      };
      log('[server] tool: getArticle returned', { title: result.title, extractLength: result.extract.length });
      return result;
    },
  },
};

// ---------------------------------------------------------------------------
// Helper: resolve approved tools by patching history in place
// ---------------------------------------------------------------------------

/**
 * Finds the `approval-requested` tool parts in the message history and
 * replaces them with `output-available` (if approved and executed) or
 * `output-denied` (if denied). This keeps tool call/result pairs together
 * in the same assistant message so `convertToModelMessages` can resolve them.
 */
async function resolveToolApprovals(
  allMessages: UIMessage[],
  approvals: ToolApproval[],
): Promise<void> {
  for (const approval of approvals) {
    // Find the message + part index that has this tool call
    for (const msg of allMessages) {
      const partIndex = msg.parts.findIndex(
        (p) =>
          // CAST: parts is a union — only dynamic-tool has toolCallId
          (p as { type: string; toolCallId?: string }).type === 'dynamic-tool' &&
          (p as { toolCallId: string }).toolCallId === approval.toolCallId,
      );
      if (partIndex === -1) continue;

      if (!approval.approved) {
        msg.parts[partIndex] = {
          type: 'dynamic-tool',
          toolCallId: approval.toolCallId,
          toolName: approval.toolName,
          state: 'output-denied',
          input: approval.input,
          approval: { id: crypto.randomUUID(), approved: false as const },
        };
        break;
      }

      // Execute the tool
      const toolDef = tools[approval.toolName as keyof typeof tools];
      if (!toolDef) break;

      try {
        // CAST: input is validated by the tool's jsonSchema on the original call;
        // the union of tool execute signatures can't be narrowed by string key lookup.
        const output = await toolDef.execute(approval.input as never);
        msg.parts[partIndex] = {
          type: 'dynamic-tool',
          toolCallId: approval.toolCallId,
          toolName: approval.toolName,
          state: 'output-available',
          input: approval.input,
          output,
        };
      } catch (err) {
        const errorText = err instanceof Error ? err.message : String(err);
        msg.parts[partIndex] = {
          type: 'dynamic-tool',
          toolCallId: approval.toolCallId,
          toolName: approval.toolName,
          state: 'output-error',
          input: approval.input,
          errorText,
        };
      }
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Server-side Ably client
// ---------------------------------------------------------------------------

const ably = new Ably.Realtime({ key: process.env.ABLY_API_KEY! });

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function POST(req: Request) {
  const { messages, history, id, turnId, clientId, forkOf, parent, toolApprovals } =
    (await req.json()) as ChatRequestBody;
  const channel = ably.channels.get(id);

  const transport = createServerTransport({ channel });
  const turn = transport.newTurn({ turnId, clientId, parent, forkOf });

  await turn.start();

  // Publish user messages (if any).
  let lastUserMsgId: string | undefined;
  if (messages.length > 0) {
    const { msgIds } = await turn.addMessages(messages, { clientId });
    lastUserMsgId = msgIds.at(-1);
  }

  // Reconstruct full conversation for the LLM
  const historyMsgs = (history ?? []).map((h) => h.message);
  const newMsgs = (messages ?? []).map((m) => m.message);
  const allMessages = [...historyMsgs, ...newMsgs];

  // If this is an approval response, patch the history in place so the
  // tool call and its result stay in the same assistant message. This
  // is required for convertToModelMessages to pair them correctly.
  if (toolApprovals && toolApprovals.length > 0) {
    log('[server] processing tool approvals', { count: toolApprovals.length });
    await resolveToolApprovals(allMessages, toolApprovals);
  }

  const result = streamText({
    model: anthropic('claude-sonnet-4-20250514'),
    system: SYSTEM_PROMPT,
    tools,
    messages: await convertToModelMessages(allMessages),
    abortSignal: turn.abortSignal,
  });

  // Stream the response over Ably in the background using after().
  after(async () => {
    const { reason } = await turn.streamResponse(result.toUIMessageStream(), {
      parent: lastUserMsgId,
    });
    await turn.end(reason);
    transport.close();
  });

  return new Response(null, { status: 200 });
}
