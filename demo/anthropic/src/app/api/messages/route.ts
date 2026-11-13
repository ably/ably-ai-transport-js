/**
 * The stored conversation for a channel, as the page reads it on load: the
 * entries saved so far and the serial the channel rewinds to. A channel with
 * nothing saved gets an empty list and no serial, and the page attaches with
 * no rewind, since nothing has been published on it.
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
