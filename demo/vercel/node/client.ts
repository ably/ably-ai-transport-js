/**
 * Basic chat — node client.
 *
 * Inspired by `rfc/types/examples/vercel-serverless/basic-chat/client.ts`.
 * Connects to a `ClientSession`, opens a run with the user's message via
 * `view.send`, then POSTs the resulting invocation to the agent endpoint.
 * Streams the assistant's reply incrementally to stdout and exits when the
 * agent publishes `x-ably-run-end`.
 */

import * as Ably from 'ably';
import type * as AI from 'ai';
import { isTextUIPart } from 'ai';

import { createClientSession } from '../../../src/index.js';
import { Headers, WireMessages } from '../../../src/headers.js';
import { UIMessageCodec } from '../../../src/vercel/index.js';

const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} must be set`);
  }
  return value;
};

const AGENT_URL = process.env.AGENT_URL ?? 'http://localhost:8787/api/agent';

// The codec's streaming path uses `message.append` / `message.update`, which
// require the channel to be in a namespace with mutable messages enabled.
// Prepend `ABLY_NAMESPACE` (when set) to the session name so the underlying
// channel lands in that namespace — must match the agent's setting.
const NAMESPACE = process.env.ABLY_NAMESPACE;
const BASE_SESSION = process.env.SESSION_NAME ?? 'demo-session';
const SESSION_NAME = NAMESPACE !== undefined && NAMESPACE.length > 0 ? `${NAMESPACE}:${BASE_SESSION}` : BASE_SESSION;

const messageText = (message: AI.UIMessage): string =>
  message.parts
    .filter((part) => isTextUIPart(part))
    .map((part) => part.text)
    .join('');

const main = async (): Promise<void> => {
  const text = process.argv.slice(2).join(' ').trim();
  if (text.length === 0) {
    console.error('usage: tsx client.ts "<your message>"');
    process.exit(1);
  }

  const ably = new Ably.Realtime({
    key: requireEnv('ABLY_API_KEY'),
    clientId: `user-${crypto.randomUUID().slice(0, 8)}`,
  });

  const session = createClientSession({
    client: ably,
    sessionName: SESSION_NAME,
    codec: UIMessageCodec,
  });
  await session.connect();

  const view = session.createView();

  // Track how much of each assistant message we've already printed so each
  // tree update only writes the new tail to stdout.
  const printed = new Map<string, number>();
  view.subscribe(() => {
    for (const node of view.messages) {
      if (node.role !== 'assistant') continue;
      const full = messageText(node.message);
      const previous = printed.get(node.id) ?? 0;
      if (full.length > previous) {
        process.stdout.write(full.slice(previous));
        printed.set(node.id, full.length);
      }
    }
  });

  // Resolve when this run's `x-ably-run-end` lands. Subscribed before
  // `view.send` so a fast agent can't publish run-end before the listener
  // registers.
  const channel = ably.channels.get(SESSION_NAME);
  let resolveRunEnd: ((status: string | undefined) => void) | undefined;
  const runEndPromise = new Promise<string | undefined>((resolve) => {
    resolveRunEnd = resolve;
  });
  await channel.subscribe(WireMessages.RunEnd, (message: Ably.InboundMessage) => {
    // CAST: Ably types `extras` as `any`; narrow to read `x-ably-status`.
    const headers = (message.extras as { headers?: Record<string, unknown> } | undefined)?.headers;
    const value = headers?.[Headers.Status];
    resolveRunEnd?.(typeof value === 'string' ? value : undefined);
  });

  process.stdout.write(`> ${text}\n`);
  const run = await view.send({
    id: crypto.randomUUID(),
    role: 'user',
    parts: [{ type: 'text', text }],
  });

  const response = await fetch(AGENT_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(run.toInvocation().toJSON()),
  });
  if (!response.ok) {
    throw new Error(`agent endpoint ${AGENT_URL} returned HTTP ${String(response.status)}`);
  }

  const status = await runEndPromise;
  process.stdout.write(`\n[run ended: ${status ?? 'unknown'}]\n`);

  await session.close();
  ably.close();
};

main().catch((error: unknown) => {
  console.error('client error:', error);
  process.exit(1);
});
