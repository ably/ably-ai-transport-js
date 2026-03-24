/**
 * Ably JWT token endpoint.
 *
 * Issues short-lived JWTs signed with the Ably API key secret.
 * The client connects to Ably with `authUrl` pointing here.
 *
 * See: https://ably.com/docs/ai-transport/sessions-identity/identifying-users-and-agents
 */

import jwt from 'jsonwebtoken';
import { NextResponse } from 'next/server';

export async function GET(req: Request) {
  const apiKey = process.env.ABLY_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: 'ABLY_API_KEY not set' }, { status: 500 });
  }

  const [keyName, keySecret] = apiKey.split(':');

  // Use clientId from query param, or generate a random one.
  const url = new URL(req.url);
  const clientId = url.searchParams.get('clientId') ?? `user-${crypto.randomUUID().slice(0, 8)}`;

  const token = jwt.sign(
    {
      'x-ably-clientId': clientId,
      'x-ably-capability': JSON.stringify({ '*': ['publish', 'subscribe', 'history'] }),
    },
    keySecret,
    {
      algorithm: 'HS256',
      keyid: keyName,
      expiresIn: '1h',
    },
  );

  return new NextResponse(token, {
    headers: { 'Content-Type': 'application/jwt' },
  });
}
