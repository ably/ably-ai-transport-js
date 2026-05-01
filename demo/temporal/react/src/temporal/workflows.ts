/**
 * Temporal workflow definitions. This module runs inside the workflow
 * sandbox, so it can only use deterministic APIs and may not import
 * Node-specific modules. The actual streaming work (Ably channel,
 * Anthropic call) lives in the activity invoked here.
 */

import { proxyActivities } from '@temporalio/workflow';

import type { InvocationData } from '@ably/ai-transport';

import type * as activities from './activities';

const { runAgentTurn } = proxyActivities<typeof activities>({
  startToCloseTimeout: '5 minutes',
});

/**
 * Drive a single agent turn for the supplied invocation. One workflow
 * execution = one run = one step, mirroring the request/response shape
 * of the Vercel demo's `/api/agent` handler.
 */
export async function chatTurn(data: InvocationData): Promise<void> {
  await runAgentTurn(data);
}
