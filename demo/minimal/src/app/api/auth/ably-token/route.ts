/**
 * Ably auth for the browser: a token request signed with the API key, scoped
 * to the `ai:*` channels the page uses, under a random client id.
 */

import Ably from 'ably';
import { NextResponse } from 'next/server';

export async function GET() {
  const apiKey = process.env.ABLY_API_KEY;
  if (apiKey === undefined) {
    return NextResponse.json({ error: 'ABLY_API_KEY is not set' }, { status: 500 });
  }
  const rest = new Ably.Rest({ key: apiKey });
  const tokenRequest = await rest.auth.createTokenRequest({
    clientId: `user-${crypto.randomUUID().slice(0, 8)}`,
    capability: { 'ai:*': ['publish', 'subscribe', 'history'] },
  });
  return NextResponse.json(tokenRequest);
}
