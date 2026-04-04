/**
 * Simulated multi-step agent workflows.
 *
 * Each workflow produces a ReadableStream<UIMessageChunk> that emits
 * structured progress updates (`data-agent-progress`) with delays between
 * steps. The client renders these as a live task list card.
 *
 * Tool results are emitted as real dynamic-tool / tool-output-available
 * chunks so the existing tool UI cards render inline.
 *
 * After all steps complete, an optional `summary` callback is invoked to
 * produce a final streamed text response (typically via an LLM call).
 */

import type { UIMessageChunk } from 'ai';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TaskStatus = 'pending' | 'working' | 'done';

export interface TaskItem {
  label: string;
  status: TaskStatus;
}

/** Payload for the data-agent-progress chunk. */
export interface AgentProgressData {
  agentLabel: string;
  tasks: TaskItem[];
}

interface TextStep {
  kind: 'progress';
  label: string;
  delayMs: number;
}

interface ToolStep {
  kind: 'tool';
  label: string;
  toolName: string;
  toolCallId: string;
  input: Record<string, unknown>;
  output: unknown;
  delayMs: number;
}

type WorkflowStep = TextStep | ToolStep;

/**
 * Callback that produces a ReadableStream of UIMessageChunks for the
 * summary text at the end of a workflow. Receives the workflow context
 * (step labels and tool outputs) so it can generate a contextual response.
 */
export interface WorkflowContext {
  agentLabel: string;
  completedSteps: string[];
  toolOutputs: Record<string, unknown>;
}

export type SummaryCallback = (context: WorkflowContext) => ReadableStream<UIMessageChunk>;

/**
 * Callback invoked after the summary text, to emit additional data chunks
 * (e.g. structured product recommendations as generative UI).
 */
export type PostSummaryCallback = (
  context: WorkflowContext,
  enqueue: (chunk: UIMessageChunk) => void,
) => void;

// ---------------------------------------------------------------------------
// Stream builder
// ---------------------------------------------------------------------------

// CAST: UIMessageChunk is a large discriminated union — TS can't narrow partial
// object literals to the correct variant. Cast through unknown.
function chunk(obj: Record<string, unknown>): UIMessageChunk {
  return obj as unknown as UIMessageChunk;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}

/**
 * Build a ReadableStream<UIMessageChunk> from a list of workflow steps.
 * Emits `data-agent-progress` chunks with the full task list at each state
 * transition, plus tool-call/tool-result chunks for tool steps.
 *
 * If a `summary` callback is provided, it is called after all steps complete
 * and its output is piped through as the final streamed text.
 */
export function buildWorkflowStream(
  agentLabel: string,
  steps: WorkflowStep[],
  options?: {
    abortSignal?: AbortSignal;
    summary?: SummaryCallback;
    postSummary?: PostSummaryCallback;
  },
): ReadableStream<UIMessageChunk> {
  const abortSignal = options?.abortSignal;
  const summaryCallback = options?.summary;
  const postSummaryCallback = options?.postSummary;

  // Collect all progress labels upfront for the task list
  const allLabels = steps.map((s) => s.label);

  return new ReadableStream<UIMessageChunk>({
    async start(controller) {
      const completedSteps: string[] = [];
      const toolOutputs: Record<string, unknown> = {};

      try {
        // Emit start chunk with a unique messageId — required by the codec
        // encoder to assign an x-ably-msg-id to the message.
        controller.enqueue(chunk({
          type: 'start',
          messageId: crypto.randomUUID(),
        }));

        let completedCount = 0;

        for (const step of steps) {
          if (abortSignal?.aborted) break;

          if (step.kind === 'progress') {
            // Mark this step as working
            const tasks = buildTaskList(allLabels, completedCount, completedCount);
            emitProgress(controller, agentLabel, tasks);

            await sleep(step.delayMs, abortSignal);

            // Mark this step as done
            completedCount++;
            completedSteps.push(step.label);
            const updatedTasks = buildTaskList(allLabels, completedCount, completedCount);
            emitProgress(controller, agentLabel, updatedTasks);
          } else if (step.kind === 'tool') {
            // Mark tool step as working
            const tasks = buildTaskList(allLabels, completedCount, completedCount);
            emitProgress(controller, agentLabel, tasks);

            // Emit tool call
            controller.enqueue(chunk({
              type: 'dynamic-tool',
              toolCallId: step.toolCallId,
              toolName: step.toolName,
              input: step.input,
              state: 'input-available',
            }));

            await sleep(step.delayMs, abortSignal);

            // Emit tool result
            controller.enqueue(chunk({
              type: 'tool-output-available',
              toolCallId: step.toolCallId,
              output: step.output,
            }));

            // Mark tool step as done
            completedCount++;
            completedSteps.push(step.label);
            toolOutputs[step.toolName] = step.output;
            const updatedTasks = buildTaskList(allLabels, completedCount, completedCount);
            emitProgress(controller, agentLabel, updatedTasks);
          }
        }

        const ctx: WorkflowContext = { agentLabel, completedSteps, toolOutputs };

        // Stream LLM-generated summary if callback provided
        if (summaryCallback && !abortSignal?.aborted) {
          const summaryStream = summaryCallback(ctx);
          const reader = summaryStream.getReader();
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- intentional loop
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value);
          }
        }

        // Emit structured data after summary (e.g. product recommendations)
        if (postSummaryCallback && !abortSignal?.aborted) {
          postSummaryCallback(ctx, (c) => controller.enqueue(c));
        }

        // Emit finish
        controller.enqueue(chunk({
          type: 'finish',
          finishReason: abortSignal?.aborted ? 'stop' : 'stop',
        }));
      } catch {
        // Aborted — emit finish with stop reason
        controller.enqueue(chunk({
          type: 'finish',
          finishReason: 'stop',
        }));
      } finally {
        controller.close();
      }
    },
  });
}

function buildTaskList(labels: string[], completedCount: number, workingIndex: number): TaskItem[] {
  return labels.map((label, i) => ({
    label,
    status: i < completedCount ? 'done' as const
      : i === workingIndex ? 'working' as const
      : 'pending' as const,
  }));
}

function emitProgress(
  controller: ReadableStreamDefaultController<UIMessageChunk>,
  agentLabel: string,
  tasks: TaskItem[],
) {
  controller.enqueue(chunk({
    type: 'data-agent-progress',
    data: { agentLabel, tasks } satisfies AgentProgressData,
  }));
}

// ---------------------------------------------------------------------------
// Pre-built workflows
// ---------------------------------------------------------------------------

export function returnsWorkflow(orderId: string): WorkflowStep[] {
  const normalized = orderId.startsWith('#') ? orderId : `#${orderId}`;
  return [
    { kind: 'progress', label: `Look up order ${normalized}`, delayMs: 2000 },
    { kind: 'progress', label: 'Check return eligibility', delayMs: 2500 },
    { kind: 'progress', label: 'Verify item condition policy', delayMs: 2000 },
    {
      kind: 'tool',
      label: 'Process return request',
      toolName: 'processReturn',
      toolCallId: `call-ret-${Date.now()}`,
      input: { orderId: normalized, reason: 'Customer requested return and replacement' },
      output: {
        returnId: `RET-${Date.now().toString(36).toUpperCase()}`,
        orderId: normalized,
        status: 'approved',
        reason: 'Customer requested return and replacement',
        instructions: 'A prepaid shipping label has been sent to your email. Pack the item in its original packaging and drop it off at any UPS location.',
        refundEstimate: '5-7 business days after we receive the item',
      },
      delayMs: 2500,
    },
    { kind: 'progress', label: 'Generate prepaid shipping label', delayMs: 2000 },
    { kind: 'progress', label: 'Send confirmation email', delayMs: 1500 },
  ];
}

export function productResearchWorkflow(query: string): WorkflowStep[] {
  const matchingProducts = [
    { name: 'Wireless Noise-Cancelling Headphones', sku: 'WH-1000', price: 279.99, colors: ['black', 'silver', 'blue'], rating: 4.7, reviews: 2341 },
    { name: 'Wireless Earbuds Pro', sku: 'WE-500', price: 199.99, colors: ['white', 'black'], rating: 4.5, reviews: 1892 },
    { name: 'Over-Ear Studio Headphones', sku: 'SH-300', price: 349.99, colors: ['black', 'red'], rating: 4.8, reviews: 567 },
    { name: 'Sport Bluetooth Earbuds', sku: 'SE-200', price: 89.99, colors: ['black', 'blue', 'green'], rating: 4.3, reviews: 3210 },
  ];

  return [
    {
      kind: 'tool',
      label: 'Search product catalog',
      toolName: 'searchProducts',
      toolCallId: `call-search-${Date.now()}`,
      input: { query },
      output: { query, results: matchingProducts, totalResults: matchingProducts.length },
      delayMs: 2500,
    },
    { kind: 'progress', label: 'Compare specifications', delayMs: 2500 },
    { kind: 'progress', label: 'Analyze customer reviews', delayMs: 2000 },
    { kind: 'progress', label: 'Check stock availability', delayMs: 1500 },
    { kind: 'progress', label: 'Prepare recommendation', delayMs: 2000 },
  ];
}

export function purchaseWorkflow(sku: string, productName: string): WorkflowStep[] {
  return [
    { kind: 'progress', label: 'Checking stock availability', delayMs: 1500 },
    { kind: 'progress', label: 'Reserving item', delayMs: 2000 },
    { kind: 'progress', label: 'Processing payment', delayMs: 2500 },
    { kind: 'progress', label: 'Generating order confirmation', delayMs: 1500 },
    {
      kind: 'tool',
      label: 'Create order',
      toolName: 'createOrder',
      toolCallId: `call-order-${Date.now()}`,
      input: { sku, productName },
      output: {
        orderId: `#${(10000 + Math.floor(Math.random() * 90000)).toString()}`,
        sku,
        productName,
        status: 'confirmed',
        eta: 'April 11, 2026',
        tracking: `USP-${Date.now().toString().slice(-10)}`,
        carrier: 'UPS',
      },
      delayMs: 2000,
    },
    { kind: 'progress', label: 'Sending confirmation email', delayMs: 1500 },
  ];
}
