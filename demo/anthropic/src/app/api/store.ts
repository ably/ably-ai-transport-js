/**
 * The demo's stand-in for the application's database: one conversation per
 * channel, in the memory of the server process. Each entry is a message in
 * the Messages API's own param type, so the route hands the list to the model
 * as it is, under the id the page gives the same message when it reads it off
 * the channel: an input under the request id it was published with, and a
 * reply under the id of the Message the model streamed. The page reads
 * channel history from the stored serial forward when it loads, and merges
 * what it reads by those ids.
 */

import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';

export interface StoredEntry {
  /** `<requestId>:<n>` for the nth message of a client's input; the Message id for a reply. */
  id: string;
  /** The message, as the model takes it. */
  param: MessageParam;
}

export interface StoredConversation {
  /** The conversation so far, in the order the entries were recorded. */
  entries: StoredEntry[];
  /** The serial the latest reply's `pipe` resolved with; absent until a reply has landed. */
  serial?: string;
}

// Held on globalThis so the entries outlive `next dev` re-evaluating the
// route modules that import this file.
const key = '__ablyAiTransportAnthropicDemoStore';
const holder = globalThis as { [key]?: Map<string, StoredConversation> };
const store = (holder[key] ??= new Map<string, StoredConversation>());

/**
 * Record entries against a channel. An entry the conversation already holds
 * is replaced in place and a new one goes on the end. The stored serial only
 * moves forward: serials sort as strings.
 */
export const recordEntries = (channelName: string, entries: StoredEntry[], serial?: string): void => {
  const current = store.get(channelName) ?? { entries: [] };
  const merged = [...current.entries];
  for (const entry of entries) {
    const at = merged.findIndex((e) => e.id === entry.id);
    if (at === -1) merged.push(entry);
    else merged[at] = entry;
  }

  const latest =
    serial !== undefined && (current.serial === undefined || serial > current.serial) ? serial : current.serial;
  store.set(channelName, latest === undefined ? { entries: merged } : { entries: merged, serial: latest });
};

export const loadConversation = (channelName: string): StoredConversation | undefined => store.get(channelName);
