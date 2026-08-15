/**
 * Optional local POST /chat. Needs ABLY_KEY to publish.
 *
 *   ABLY_KEY=... ABLY_HOST=127.0.0.1 ABLY_PORT=8081 pnpm exec tsx examples/linear-channel/dropin-server.ts
 */
import * as http from 'node:http';

import * as Ably from 'ably';

import { type ChatRequest, handleChatPost } from './dropin.ts';

const port = Number(process.env.PORT ?? 3456);

const rest = process.env.ABLY_KEY
  ? new Ably.Rest({
      key: process.env.ABLY_KEY,
      restHost: process.env.ABLY_HOST ?? '127.0.0.1',
      port: Number(process.env.ABLY_PORT ?? 8081),
      tls: false,
    })
  : undefined;

const channelName = process.env.ABLY_CHANNEL ?? `mutable:dropin-${String(Date.now())}`;

const server = http.createServer((req, res) => {
  void handleRequest(req, res);
});

const handleRequest = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
  if (req.method !== 'POST' || req.url !== '/chat') {
    res.writeHead(404);
    res.end();
    return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  let body: ChatRequest;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as ChatRequest;
  } catch {
    res.writeHead(400);
    res.end(JSON.stringify({ error: 'invalid json' }));
    return;
  }

  const result = handleChatPost(body);
  if (result.publish && rest) {
    const ch = rest.channels.get(channelName);
    for (const msg of result.publish) {
      await ch.publish({ name: 'chat', data: msg.data, extras: msg.extras });
    }
  }

  res.writeHead(result.status, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      ...result,
      channel: channelName,
      published: Boolean(rest && result.publish && result.publish.length > 0),
    }),
  );
};

server.listen(port, () => {
  console.log(`POST /chat on :${String(port)} channel=${channelName} publish=${String(Boolean(rest))}`);
});
