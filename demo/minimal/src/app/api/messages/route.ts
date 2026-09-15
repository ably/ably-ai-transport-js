/**
 * The stored conversation for a channel, as the page reads it on load: the
 * messages saved so far and the serial to read channel history from. A
 * channel with nothing saved gets an empty list and no serial, and the page
 * then reads the whole channel from history.
 */

import { NextResponse } from 'next/server';

import { loadConversation } from '../store';

export function GET(req: Request) {
  const channelName = new URL(req.url).searchParams.get('channel');
  if (channelName === null) {
    return new Response('channel is required', { status: 400 });
  }
  return NextResponse.json(loadConversation(channelName) ?? { messages: [] });
}
