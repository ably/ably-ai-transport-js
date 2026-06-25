/**
 * AIT-870 — empirical confirmation that the Vercel `useChat` default transport
 * cannot consume a one-shot `generateText()` result / a whole `UIMessage`.
 *
 * Drives the REAL `Chat` engine from `@ai-sdk/react` (the exact class `useChat`
 * wraps — the hook only adds React state subscription) against the REAL
 * `DefaultChatTransport` / `TextStreamChatTransport`, talking to a REAL local
 * HTTP route. No browser, no mocking of the SDK internals.
 *
 * Each scenario answers: "if my server route returns <X>, what does useChat
 * render?" We look at the assistant message useChat materialises and any error
 * it surfaces.
 *
 * See the README in this directory for the full writeup.
 * Run:  pnpm exec tsx usechat-generatetext-investigation/repro.ts
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { DefaultChatTransport, TextStreamChatTransport, generateText, validateUIMessages } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { Chat } from '@ai-sdk/react';

// --- 1. Produce a GENUINE generateText() result -------------------------------
// A mock model so no network/LLM is needed; everything else (generateText,
// result assembly) runs for real.
const model = new MockLanguageModelV3({
  doGenerate: async () => ({
    content: [{ type: 'text', text: 'Hello from generateText().' }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: {
      inputTokens: { total: 8, noCache: 8, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 16, text: 16, reasoning: 0 },
    },
    warnings: [],
  }),
});

const gen = await generateText({ model, prompt: 'hi' });

console.log('=== What generateText() actually returns ===');
console.log('  top-level keys:', Object.keys(gen).sort().join(', '));
console.log('  typeof gen.text:', typeof gen.text, '->', JSON.stringify(gen.text));
console.log('  gen.response.messages roles:', gen.response.messages.map((m) => m.role).join(', '));
console.log('  has .role / .parts (UIMessage shape)?', 'role' in gen, '/', 'parts' in gen);
console.log('  has .toUIMessageStream?', typeof (gen as Record<string, unknown>).toUIMessageStream);

// The JSON a route would send if it "just returned the generateText result".
const generateTextJson = JSON.stringify({
  text: gen.text,
  content: gen.content,
  finishReason: gen.finishReason,
  response: { messages: gen.response.messages },
});

// A hand-built UIMessage — what Mike imagined you could "just return".
const uiMessage = {
  id: 'msg-assistant-1',
  role: 'assistant',
  parts: [{ type: 'text', text: 'Hello from a whole UIMessage.' }],
};
const uiMessageJson = JSON.stringify(uiMessage);

// Self-certify with the SDK's OWN validator that this is a legitimate
// UIMessage. Without this, the scenarios below would only show "the transport
// rejects this object we built" — we want "the transport rejects a *valid*
// UIMessage", so the rejection can't be dismissed as malformed input.
const [validated] = await validateUIMessages({ messages: [uiMessage] });
console.log('\n=== Sanity: the UIMessage we return is SDK-valid ===');
console.log(
  '  validateUIMessages accepted it:',
  JSON.stringify(validated) === uiMessageJson ? 'yes, unchanged' : 'yes, normalised',
);

// A CORRECT UIMessageChunk SSE stream (control — this is what the SDK expects).
const chunkSse = [
  { type: 'start' },
  { type: 'text-start', id: 't1' },
  { type: 'text-delta', id: 't1', delta: 'Hello from a chunk stream.' },
  { type: 'text-end', id: 't1' },
  { type: 'finish' },
]
  .map((e) => `data: ${JSON.stringify(e)}\n\n`)
  .join('');

// --- 2. A real local HTTP server with one route per scenario ------------------
const server = createServer((req, res) => {
  const path = (req.url ?? '').split('?')[0];
  switch (path) {
    case '/uimessage-json': // "just return a UIMessage in the HTTP response"
      res.setHeader('content-type', 'application/json');
      return res.end(uiMessageJson);
    case '/uimessage-sse': // "send a UIMessage on the SSE connection instead of chunks"
      res.setHeader('content-type', 'text/event-stream');
      return res.end(`data: ${uiMessageJson}\n\n`);
    case '/generatetext-json': // "return whatever generateText returns"
      res.setHeader('content-type', 'application/json');
      return res.end(generateTextJson);
    case '/chunks-sse': // control: the protocol the SDK actually expects
      res.setHeader('content-type', 'text/event-stream');
      res.setHeader('x-vercel-ai-ui-message-stream', 'v1');
      return res.end(chunkSse);
    case '/text-plain': // a UIMessage through the text-only transport
      res.setHeader('content-type', 'text/plain');
      return res.end(uiMessageJson);
    case '/generatetext-sse': // the generateText result SSE-framed as one event
      res.setHeader('content-type', 'text/event-stream');
      return res.end(`data: ${generateTextJson}\n\n`);
    case '/modelmessage-sse': // generateText's response.messages[0] SSE-framed
      res.setHeader('content-type', 'text/event-stream');
      return res.end(`data: ${JSON.stringify(gen.response.messages[0])}\n\n`);
    default:
      res.statusCode = 404;
      return res.end();
  }
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

// --- 3. Drive the real Chat engine per scenario -------------------------------
async function run(label: string, route: string, kind: 'data' | 'text'): Promise<void> {
  const api = `${base}${route}`;
  const transport = kind === 'text' ? new TextStreamChatTransport({ api }) : new DefaultChatTransport({ api });

  let captured: Error | undefined;
  const chat = new Chat({
    transport,
    onError: (e) => {
      captured = e;
    },
  });

  try {
    await chat.sendMessage({ text: 'hi' });
  } catch (e) {
    captured ??= e as Error;
  }

  const assistant = chat.messages.find((m) => m.role === 'assistant');
  const rendered =
    assistant?.parts
      ?.filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join('') ?? '(no assistant message)';

  console.log(`\n### ${label}`);
  console.log(
    `  route: ${route}  (transport: ${kind === 'text' ? 'TextStreamChatTransport' : 'DefaultChatTransport'})`,
  );
  console.log(`  error:    ${captured ? `${captured.name}: ${captured.message.split('\n')[0]}` : '(none)'}`);
  console.log(`  rendered: ${JSON.stringify(rendered)}`);

  // Surface the underlying zod issues so we can see *why* validation failed
  // (e.g. "no matching discriminator for `type`") rather than guessing.
  const cause = (captured as { cause?: unknown } | undefined)?.cause;
  const issues = (cause as { issues?: unknown[] } | undefined)?.issues;
  if (Array.isArray(issues)) {
    console.log(`  zod issues:`, JSON.stringify(issues.slice(0, 3)));
  }
}

console.log('\n=== Scenarios: what does useChat render for each server response? ===');
await run('A. Route returns a whole UIMessage as JSON', '/uimessage-json', 'data');
await run('B. Route sends a whole UIMessage as one SSE event', '/uimessage-sse', 'data');
await run('C. Route returns the generateText() result as JSON', '/generatetext-json', 'data');
await run('D. CONTROL: route streams correct UIMessageChunks (SSE)', '/chunks-sse', 'data');
await run('E. Whole UIMessage via TextStreamChatTransport', '/text-plain', 'text');
await run('F. generateText() result SSE-framed as one event', '/generatetext-sse', 'data');
await run("G. generateText() result's assistant ModelMessage, SSE-framed", '/modelmessage-sse', 'data');

await new Promise<void>((resolve) => server.close(() => resolve()));
console.log('\n=== done ===');
