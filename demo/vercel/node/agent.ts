/**
 * Basic chat — node agent.
 *
 * Inspired by `rfc/types/examples/vercel-serverless/basic-chat/agent.ts`.
 * Runs a long-lived HTTP server (so the AgentSession can subscribe to the
 * channel before the client publishes — without history hydration, late
 * subscribers miss earlier publishes). One invocation = one run = one step.
 */

import * as http from 'node:http';

import { anthropic } from '@ai-sdk/anthropic';
import * as Ably from 'ably';
import { convertToModelMessages, jsonSchema, stepCountIs, streamText, tool } from 'ai';

import { Invocation, type InvocationData, createAgentSession } from '../../../src/index.js';
import { UIMessageCodec } from '../../../src/vercel/index.js';

const PORT = Number(process.env.PORT ?? 8787);
const MODEL = process.env.MODEL ?? 'claude-haiku-4-5';

// The codec's streaming path uses `message.append` / `message.update`, which
// require the channel to be in a namespace with mutable messages enabled.
// Prepend `ABLY_NAMESPACE` (when set) to the session name so the underlying
// channel lands in that namespace — e.g. `ABLY_NAMESPACE=mutable` →
// channel `mutable:demo-session`.
const NAMESPACE = process.env.ABLY_NAMESPACE;
const BASE_SESSION = process.env.SESSION_NAME ?? 'demo-session';
const SESSION_NAME = NAMESPACE !== undefined && NAMESPACE.length > 0 ? `${NAMESPACE}:${BASE_SESSION}` : BASE_SESSION;

const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} must be set`);
  }
  return value;
};

const readBody = async (req: http.IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    // CAST: Node types `for await` on IncomingMessage as `any`; runtime is Buffer.
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
};

const ably = new Ably.Realtime({
  key: requireEnv('ABLY_API_KEY'),
  clientId: 'agent',
});

const session = createAgentSession({
  client: ably,
  sessionName: SESSION_NAME,
  codec: UIMessageCodec,
});

// Demo tool — fake weather lookup. Returns deterministic data so the demo
// runs without hitting an external API. The model decides when to call it
// based on the user's prompt; the AI SDK executes the `execute` function
// and emits `tool-input-*` / `tool-output-*` chunks that the codec
// transports to subscribers.
const getWeather = tool({
  description: 'Get the current weather for a city.',
  inputSchema: jsonSchema<{ city: string }>({
    type: 'object',
    properties: { city: { type: 'string', description: 'City name' } },
    required: ['city'],
  }),
  execute: ({ city }) =>
    Promise.resolve({
      city,
      temperatureC: 22,
      condition: 'sunny',
      humidity: 0.45,
    }),
});

const handleInvocation = async (data: InvocationData, signal: AbortSignal): Promise<void> => {
  const invocation = Invocation.fromJSON(data);
  if (invocation.sessionName !== SESSION_NAME) {
    throw new Error(`unexpected sessionName ${invocation.sessionName}; agent is bound to ${SESSION_NAME}`);
  }

  await using run = await session.createRun(invocation, { signal });
  await using step = run.createStep();
  await step.start({ signal, timeoutMs: 60_000 });

  try {
    const messages = await convertToModelMessages(run.view.messages.map((node) => node.message));
    const result = streamText({
      model: anthropic(MODEL),
      messages,
      abortSignal: step.signal,
      tools: { getWeather },
      // streamText's default `stopWhen` is `stepCountIs(1)`, which stops
      // after the first model call — meaning the model emits the tool
      // call, the SDK runs the tool, and the stream ends with no final
      // assistant text. Bump to 5 so the model gets a chance to use the
      // tool result to compose a reply.
      stopWhen: stepCountIs(5),
    });
    await step.pipe(result.toUIMessageStream());
    await step.end();
    await run.end();
  } catch (error) {
    await step.end(error);
    await run.end(error);
    if (!step.signal.aborted) throw error;
  }
};

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/api/agent') {
    res.writeHead(404).end();
    return;
  }

  // `req.on('close')` fires on every successful request (the IncomingMessage
  // auto-destroys after the body is read), so the abort source has to track
  // the *response* — `res` only emits `close` with `writableFinished === false`
  // when the client disconnects before we've finished writing.
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) controller.abort();
  });

  void (async () => {
    try {
      const body = await readBody(req);
      const data = JSON.parse(body) as InvocationData;
      await handleInvocation(data, controller.signal);
      res.writeHead(202).end();
    } catch (error) {
      console.error('agent error:', error);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'text/plain' });
      }
      if (!res.writableEnded) {
        res.end(error instanceof Error ? error.message : String(error));
      }
    }
  })();
});

const main = async (): Promise<void> => {
  await session.connect();
  console.log(`agent: subscribed to session "${SESSION_NAME}"`);

  await new Promise<void>((resolve) => {
    server.listen(PORT, () => resolve());
  });
  console.log(`agent: listening on http://localhost:${String(PORT)}/api/agent`);
};

const shutdown = async (): Promise<void> => {
  console.log('\nagent: shutting down');
  server.close();
  await session.close();
  ably.close();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

main().catch((error: unknown) => {
  console.error('agent failed to start:', error);
  process.exit(1);
});
