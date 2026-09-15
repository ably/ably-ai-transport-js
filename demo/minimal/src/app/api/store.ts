/**
 * The demo's stand-in for the application's database: one conversation per
 * channel, in the memory of the server process. The chat route records the
 * user's message and an empty placeholder for its reply when the request
 * arrives, and the reply itself once its pipe has resolved, with the serial
 * of the last message the pipe published. The page reads channel history
 * from that serial forward when it loads.
 */

import type { UIMessage } from 'ai';

export interface StoredConversation {
  /** The conversation so far, in the order the messages were recorded. */
  messages: UIMessage[];
  /** The serial the latest reply's `pipe` resolved with; absent until a reply has landed. */
  serial?: string;
}

// Held on globalThis so the entries outlive `next dev` re-evaluating the
// route modules that import this file.
const key = '__ablyAiTransportMinimalDemoStore';
const holder = globalThis as { [key]?: Map<string, StoredConversation> };
const store = (holder[key] ??= new Map<string, StoredConversation>());

/**
 * Record messages against a channel. A message the conversation already
 * holds is replaced in place and a new one goes on the end, so a reply fills
 * the placeholder recorded for it and two turns in flight at once each keep
 * their own place. The stored serial only moves forward: serials sort as
 * strings.
 */
export const recordMessages = (channelName: string, messages: UIMessage[], serial?: string): void => {
  const current = store.get(channelName) ?? { messages: [] };
  const merged = [...current.messages];
  for (const message of messages) {
    const at = merged.findIndex((m) => m.id === message.id);
    if (at === -1) merged.push(message);
    else merged[at] = message;
  }
  const latest = serial !== undefined && (current.serial === undefined || serial > current.serial) ? serial : current.serial;
  store.set(channelName, latest === undefined ? { messages: merged } : { messages: merged, serial: latest });
};

export const loadConversation = (channelName: string): StoredConversation | undefined => store.get(channelName);
