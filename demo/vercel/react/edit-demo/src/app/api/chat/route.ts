import { streamText, convertToModelMessages } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';

export async function POST(req: Request) {
  const body = await req.json();

  // Log what the default transport sends — this is what our ChatTransport
  // would receive via sendMessages(). Look for `messageId` here.
  console.log('--- POST /api/chat ---');
  console.log(
    'messages:',
    JSON.stringify(
      body.messages?.map((m: { role: string; id: string }) => ({ role: m.role, id: m.id })),
      null,
      2,
    ),
  );
  console.log('---');

  // The default transport sends UIMessages (with `parts`), but streamText
  // expects ModelMessages (with `content`). Convert before passing to the model.
  const result = streamText({
    model: anthropic('claude-haiku-4-5-20251001'),
    system: 'You are a helpful assistant. Keep responses to one or two sentences.',
    messages: await convertToModelMessages(body.messages),
  });

  return result.toUIMessageStreamResponse();
}
