/**
 * Chat API route — support chat with sub-agent delegation.
 *
 * Flow:
 * 1. Every request creates an orchestrator turn that publishes user messages
 *    and streams the initial response.
 * 2. If the orchestrator calls any delegate tool (processReturnWorkflow,
 *    productResearch, getProductReviews) or planTasks, the route spawns
 *    independent sub-agent turns after the orchestrator finishes.
 * 3. Each sub-agent has its own turn, clientId, and streamed response.
 */

import { after } from 'next/server';
import { streamText, smoothStream, convertToModelMessages } from 'ai';
import type { UIMessage, UIMessageChunk } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { z } from 'zod';
import Ably from 'ably';
import { createServerTransport } from '@ably/ai-transport/vercel';
import type { EventNode, TreeNode } from '@ably/ai-transport';
import { tools, planTasksTool } from './tools.js';
import {
  type SummaryCallback,
  type PostSummaryCallback,
  buildWorkflowStream,
  returnsWorkflow,
  productResearchWorkflow,
  purchaseWorkflow,
} from './workflows.js';

interface ChatRequestBody {
  turnId: string;
  clientId: string;
  messages: TreeNode<UIMessage>[];
  history?: TreeNode<UIMessage>[];
  amendments?: EventNode<UIMessageChunk>[];
  id: string;
  forkOf?: string;
  parent?: string | null;
}

/** A sub-agent to spawn after the orchestrator finishes. */
interface SubAgentRequest {
  agentId: string;
  label: string;
  run: (transport: ReturnType<typeof createServerTransport>) => Promise<void>;
}

const ably = new Ably.Realtime({ key: process.env.ABLY_API_KEY! });

const ORCHESTRATOR_SYSTEM = `You are a friendly, helpful customer support agent for Acme Electronics, an electronics store.

You help customers with:
- Order tracking and status (use lookupOrder for a quick lookup)
- Product search and recommendations (use productResearch for a thorough research workflow, or searchProducts for a quick search)
- Returns and exchanges (use processReturnWorkflow to run the full return process)
- Finding nearby stores (use getLocation then getStoresNearLocation, or getStoresNearLocation directly with a place name)
- Product reviews (use getReviews with the product name and SKU)
- Purchasing products (use purchaseProduct with the SKU and product name)

Tool selection:
- processReturnWorkflow: Use when the user wants to return an order. Runs the complete return workflow.
- productResearch: Use when the user wants product recommendations or is browsing for something.
- purchaseProduct: Use when the user wants to buy a specific product. Runs the order workflow.
- getReviews: Use when the user asks for reviews of a specific product. Streams 3 markdown-formatted reviews.
- processRefund: Use when the customer confirms they want a refund. Pass the returnId, orderId, and amount.
- cancelReturn: Use when the customer wants to cancel a return. Pass the returnId and orderId.
- lookupOrder / searchProducts / processReturn: Quick single-operation tools for simple lookups.

When the customer says "near me" or "nearby" without a specific location, call getLocation first, then use the coordinates with getStoresNearLocation. When they specify a place (e.g. "stores near Portland"), call getStoresNearLocation directly with the location string.

When the customer's request involves multiple INDEPENDENT tasks that can be done simultaneously, use planTasks to delegate them to parallel sub-agents. For example:
- "Return my order and find a replacement" → planTasks with two tasks
- "Check my order status and find similar products" → planTasks with two tasks

When you use planTasks, your response will be shown to the customer while the sub-agents work. Keep it brief and reassuring, e.g. "I'll handle both tasks for you simultaneously."

Use conversation context to infer tool parameters whenever possible. If the user asks a follow-up like "show me reviews" after discussing a specific product, call the tool with that product — don't ask them to clarify what's already obvious from the conversation.

Be concise and helpful. Use a warm but professional tone.`;

export async function POST(req: Request) {
  const { messages, history, amendments, id, turnId, clientId, forkOf, parent } = (await req.json()) as ChatRequestBody;

  const channel = ably.channels.get(id);
  const transport = createServerTransport({ channel });
  const turn = transport.newTurn({ turnId, clientId, parent, forkOf });

  await turn.start();

  if (amendments && amendments.length > 0) {
    await turn.addEvents(amendments);
  }

  let lastUserMsgId: string | undefined;
  if (messages.length > 0) {
    const { msgIds } = await turn.addMessages(messages, { clientId });
    lastUserMsgId = msgIds.at(-1);
  }

  const historyMsgs = (history ?? []).map((h) => h.message);
  const newMsgs = (messages ?? []).map((m) => m.message);
  const allMessages = [...historyMsgs, ...newMsgs];

  // Collect sub-agent requests from delegate tools
  const subAgentRequests: SubAgentRequest[] = [];

  const orchestratorTools = {
    ...tools,
    // Override delegate tools to collect requests instead of executing immediately
    processReturnWorkflow: {
      ...tools.processReturnWorkflow,
      execute: async ({ orderId, reason }: { orderId: string; reason: string }) => {
        subAgentRequests.push({
          agentId: 'returns-agent',
          label: 'Returns',
          run: (t) => runWorkflowAgent(t, 'returns-agent', 'Returns', returnsWorkflow(orderId), {
            taskDescription: `Process return for order ${orderId}: ${reason}`,
            postSummary: (ctx, enqueue) => {
              const returnResult = ctx.toolOutputs['processReturn'] as { orderId: string; returnId: string } | undefined;
              enqueue({
                type: 'data-refund-confirmation',
                id: 'refund',
                data: {
                  orderId: returnResult?.orderId ?? orderId,
                  returnId: returnResult?.returnId ?? 'RET-UNKNOWN',
                  productName: 'Wireless Noise-Cancelling Headphones',
                  amount: 279.99,
                },
              } as unknown as UIMessageChunk);
            },
          }),
        });
        return { orderId, reason, delegated: true };
      },
    },
    productResearch: {
      ...tools.productResearch,
      execute: async ({ query }: { query: string }) => {
        subAgentRequests.push({
          agentId: 'research-agent',
          label: 'Product Research',
          run: (t) => runWorkflowAgent(t, 'research-agent', 'Product Research', productResearchWorkflow(query), {
            taskDescription: `Research products matching: ${query}`,
            postSummary: (ctx, enqueue) => {
              // Emit the searchProducts result as a structured data part
              const searchResult = ctx.toolOutputs['searchProducts'] as { results: unknown[] } | undefined;
              if (searchResult?.results) {
                enqueue({
                  type: 'data-product-recommendations',
                  id: 'recommendations',
                  data: searchResult,
                } as unknown as UIMessageChunk);
              }
            },
          }),
        });
        return { query, delegated: true };
      },
    },
    purchaseProduct: {
      ...tools.purchaseProduct,
      execute: async ({ sku, productName }: { sku: string; productName: string }) => {
        subAgentRequests.push({
          agentId: 'orders-agent',
          label: 'Order',
          run: (t) => runWorkflowAgent(t, 'orders-agent', 'Order', purchaseWorkflow(sku, productName), {
            taskDescription: `Purchase ${productName} (${sku}) for the customer`,
          }),
        });
        return { sku, productName, delegated: true };
      },
    },
    getReviews: {
      ...tools.getReviews,
      execute: async ({ productName, sku }: { productName: string; sku: string }) => {
        subAgentRequests.push({
          agentId: 'reviews',
          label: 'Reviews',
          run: (t) => runReviews(t, sku, productName),
        });
        return { productName, sku, delegated: true };
      },
    },
    planTasks: {
      ...planTasksTool,
      execute: async (input: { tasks: Array<{ agentId: string; agentLabel: string; task: string; tools: string[] }>; summary: string }) => {
        for (const task of input.tasks) {
          const agentId = normalizeAgentId(task.agentId, task.tools);
          const label = task.agentLabel;

          if (agentId === 'returns-agent') {
            const orderMatch = task.task.match(/#\d+/);
            const orderId = orderMatch?.[0] ?? '#4821';
            subAgentRequests.push({
              agentId,
              label,
              run: (t) => runWorkflowAgent(t, agentId, label, returnsWorkflow(orderId), {
                taskDescription: task.task,
                postSummary: (ctx, enqueue) => {
                  const returnResult = ctx.toolOutputs['processReturn'] as { orderId: string; returnId: string } | undefined;
                  enqueue({
                    type: 'data-refund-confirmation',
                    id: 'refund',
                    data: {
                      orderId: returnResult?.orderId ?? orderId,
                      returnId: returnResult?.returnId ?? 'RET-UNKNOWN',
                      productName: 'Wireless Noise-Cancelling Headphones',
                      amount: 279.99,
                    },
                  } as unknown as UIMessageChunk);
                },
              }),
            });
          } else if (agentId === 'research-agent') {
            const queryMatch = task.task.match(/(?:find|search|recommend|replacement)\s+(.+)/i);
            const query = queryMatch?.[1] ?? 'headphones';
            subAgentRequests.push({
              agentId,
              label,
              run: (t) => runWorkflowAgent(t, agentId, label, productResearchWorkflow(query), {
                taskDescription: task.task,
                postSummary: (ctx, enqueue) => {
                  const searchResult = ctx.toolOutputs['searchProducts'] as { results: unknown[] } | undefined;
                  if (searchResult?.results) {
                    enqueue({
                      type: 'data-product-recommendations',
                      id: 'recommendations',
                      data: searchResult,
                    } as unknown as UIMessageChunk);
                  }
                },
              }),
            });
          }
        }
        return { delegated: true, taskCount: input.tasks.length };
      },
    },
  };

  const result = streamText({
    model: anthropic('claude-sonnet-4-20250514'),
    system: ORCHESTRATOR_SYSTEM,
    messages: await convertToModelMessages(allMessages),
    tools: orchestratorTools,
    abortSignal: turn.abortSignal,
  });

  after(async () => {
    try {
      const { reason } = await turn.streamResponse(result.toUIMessageStream(), {
        parent: lastUserMsgId,
      });
      await turn.end(reason);

      // Spawn all collected sub-agents in parallel
      if (subAgentRequests.length > 0 && reason === 'complete') {
        await Promise.all(subAgentRequests.map((req) => req.run(transport)));
      }
    } finally {
      transport.close();
    }
  });

  return new Response(null, { status: 200 });
}

// ---------------------------------------------------------------------------
// Sub-agent runners
// ---------------------------------------------------------------------------

/**
 * Normalize LLM-generated agent IDs to known values.
 */
function normalizeAgentId(agentId: string, agentTools: string[]): string {
  const id = agentId.toLowerCase();
  if (id.includes('return') || agentTools.includes('processReturn') || agentTools.includes('processReturnWorkflow')) return 'returns-agent';
  if (id.includes('research') || id.includes('product') || id.includes('search') || agentTools.includes('searchProducts') || agentTools.includes('productResearch')) return 'research-agent';
  return agentId;
}

/**
 * Build a SummaryCallback that uses streamText with Haiku to generate
 * a contextual summary based on what the workflow accomplished.
 */
function makeSummaryCallback(taskDescription: string): SummaryCallback {
  return ({ agentLabel, completedSteps, toolOutputs }) => {
    const context = [
      `Agent: ${agentLabel}`,
      `Task: ${taskDescription}`,
      `Completed steps: ${completedSteps.join(', ')}`,
      ...Object.entries(toolOutputs).map(([name, output]) =>
        `Tool result (${name}): ${JSON.stringify(output)}`,
      ),
    ].join('\n');

    const result = streamText({
      model: anthropic('claude-3-haiku-20240307'),
      system: `You are a support agent sub-task that just completed a workflow. Write a brief, friendly summary (2-3 sentences) of what was accomplished for the customer. Be specific — reference order IDs, product names, return statuses, etc. from the tool results. Do not use bullet points. Do not repeat the task list.`,
      prompt: context,
    });

    return result.toUIMessageStream();
  };
}

/**
 * Run a workflow-based sub-agent (returns, product research, etc.).
 * Streams progress steps followed by an LLM-generated summary.
 */
async function runWorkflowAgent(
  transport: ReturnType<typeof createServerTransport>,
  agentId: string,
  label: string,
  steps: ReturnType<typeof returnsWorkflow>,
  opts: { taskDescription: string; postSummary?: PostSummaryCallback },
) {
  const turn = transport.newTurn({
    turnId: crypto.randomUUID(),
    clientId: agentId,
  });

  await turn.start();
  const stream = buildWorkflowStream(label, steps, {
    abortSignal: turn.abortSignal,
    summary: makeSummaryCallback(opts.taskDescription),
    postSummary: opts.postSummary,
  });
  const { reason } = await turn.streamResponse(stream);
  await turn.end(reason);
}

const REVIEW_PROMPT = `Write a single customer review for the given product. Use markdown formatting with emojis:

**⭐⭐⭐⭐⭐ "Review title here"**
*ReviewerName — Month Day, Year* · ✅ Verified Purchase

Review text. 4-6 sentences with specific details about usage, pros/cons, comparisons. Be authentic.

👍 N people found this helpful

Use the correct number of ⭐ for the rating. Date within last 2 months from April 2026. Just the review — no intro or extra text.`;

async function runReviews(
  transport: ReturnType<typeof createServerTransport>,
  sku: string,
  productName: string,
) {
  const turn = transport.newTurn({ turnId: crypto.randomUUID() });
  await turn.start();

  const ratings = ['a 5-star review from a happy daily commuter', 'a 4-star review from someone who loves the sound but has a minor complaint', 'a 3-star review from someone with mixed feelings'];

  for (const rating of ratings) {
    const result = streamText({
      model: anthropic('claude-3-haiku-20240307'),
      system: REVIEW_PROMPT,
      prompt: `${productName} (SKU: ${sku}) — write ${rating}`,
      abortSignal: turn.abortSignal,
      experimental_transform: smoothStream({ chunking: 'word', delayInMs: 80 }),
    });
    await turn.streamResponse(result.toUIMessageStream());
  }

  await turn.end('complete');
}

