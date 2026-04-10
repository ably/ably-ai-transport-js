import jwt from 'jsonwebtoken';
import { NextResponse } from 'next/server';

export async function GET() {
  const apiKey = process.env.ABLY_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: 'ABLY_API_KEY not set' }, { status: 500 });
  }

  const [keyName, keySecret] = apiKey.split(':');
  const clientId = `user-${crypto.randomUUID().slice(0, 8)}`;

  const token = jwt.sign(
    {
      'x-ably-clientId': clientId,
      'x-ably-capability': JSON.stringify({ '*': ['publish', 'subscribe', 'history'] }),
    },
    keySecret,
    { algorithm: 'HS256', keyid: keyName, expiresIn: '1h' },
  );

  return new NextResponse(token, {
    headers: { 'Content-Type': 'application/jwt' },
  });
}
