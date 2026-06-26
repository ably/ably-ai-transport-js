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

import { generateClientName } from '../../../lib/channel-name';

export async function GET(req: Request) {
  const apiKey = process.env.ABLY_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: 'ABLY_API_KEY not set' }, { status: 500 });
  }

  const [keyName, keySecret] = apiKey.split(':');

  // Use clientId from query param, or generate a random one.
  const url = new URL(req.url);
  const clientId = url.searchParams.get('clientId') ?? generateClientName();

  // Scope the token to the configured channel namespace (default `ai:`) rather
  // than every channel in the app. The browser only ever opens `<namespace><slug>`
  // channels, so `<namespace>*` is sufficient and keeps the token least-privilege.
  // Pinned `?channel=` names must sit within this namespace to be authorised.
  const namespace = process.env.NEXT_PUBLIC_ABLY_CHANNEL_NAMESPACE ?? 'ai:';

  const token = jwt.sign(
    {
      'x-ably-clientId': clientId,
      'x-ably-capability': JSON.stringify({ [`${namespace}*`]: ['publish', 'subscribe', 'presence', 'history'] }),
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
