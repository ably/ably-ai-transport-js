/**
 * The stored conversation for a channel, as the page reads it on load: the
 * entries saved so far and the serial to read channel history from. Until a
 * reply has landed there is no serial, and the page then reads the whole
 * channel from history.
 */

import { NextResponse } from 'next/server';

import { loadConversation } from '../store';

export function GET(req: Request) {
  const channelName = new URL(req.url).searchParams.get('channel');
  if (channelName === null || !channelName.startsWith('ai:')) {
    return new Response('channel must name an ai: channel', { status: 400 });
  }

  return NextResponse.json(loadConversation(channelName) ?? { entries: [] });
}
