/**
 * AgentView conversation-scope tests.
 *
 * `messages()` / `loadConversation()` reconstruct a run's history by walking the
 * Tree and projecting each node via `codec.getMessages`. For a continuation
 * run, the agent must scope the CURRENT run's projection to the continuation it
 * is generating (so it never reconstructs a concurrent responder's follow-up).
 * These tests use a recording codec to assert the `MessageSelector` is forwarded
 * to the current run's node only — ancestor nodes stay canonical.
 */

import type * as Ably from 'ably';
import { describe, expect, it, vi } from 'vitest';

import { HEADER_CODEC_MESSAGE_ID, HEADER_PARENT, HEADER_ROLE, HEADER_RUN_ID } from '../../../src/constants.js';
import type {
  Codec,
  CodecEvent,
  CodecInputEvent,
  CodecMessage,
  MessageSelector,
  ReducerMeta,
} from '../../../src/core/codec/types.js';
import { createAgentView } from '../../../src/core/transport/agent-view.js';
import type { WireApplier } from '../../../src/core/transport/decode-fold.js';
import { createTree, type TreeInternal } from '../../../src/core/transport/tree.js';
import { LogLevel, makeLogger } from '../../../src/logger.js';

interface RecMessage {
  id: string;
}

type RecInput = { kind: 'user-message'; message: RecMessage } & CodecInputEvent;
interface RecOutput {
  type: 'message';
  message: RecMessage;
}

interface RecProjection {
  /** First codec-message-id folded into this node — identifies the node in assertions. */
  tag: string;
  messages: CodecMessage<RecMessage>[];
}

/** One `getMessages` invocation: which node (by tag) and the selector it received. */
interface GetMessagesCall {
  tag: string;
  selector: MessageSelector | undefined;
}

const recordingCodec = (calls: GetMessagesCall[]): Codec<RecInput, RecOutput, RecProjection, RecMessage> => ({
  init: () => ({ tag: '', messages: [] }),
  fold: (state: RecProjection, codecEvent: CodecEvent<RecInput, RecOutput>, meta: ReducerMeta) => {
    if (state.tag === '' && meta.messageId !== undefined) state.tag = meta.messageId;
    const message = codecEvent.event.message;
    state.messages.push({ codecMessageId: meta.messageId ?? message.id, message });
    return state;
  },
  getMessages: (projection: RecProjection, selector?: MessageSelector) => {
    calls.push({ tag: projection.tag, selector });
    return projection.messages;
  },
  createEncoder: () => {
    throw new Error('not used');
  },
  createDecoder: () => ({ decode: () => ({ inputs: [], outputs: [] }) }),
  createUserMessage: (message: RecMessage) => ({ kind: 'user-message', message }),
  createRegenerate: () => {
    throw new Error('not used');
  },
});

// CAST: messages() reads only the Tree; the channel is never exercised here.
const stubChannel = {} as unknown as Ably.RealtimeChannel;
// messages() never applies wires, so apply is never called.
const stubApplier: WireApplier = { apply: vi.fn() };
const silentLogger = makeLogger({ logLevel: LogLevel.Silent });

// Populate the Tree with a user input node `U` and a reply run `R` under it,
// each carrying one message, via the codec fold.
const buildTree = (calls: GetMessagesCall[]): TreeInternal<RecInput, RecOutput, RecProjection> => {
  const tree = createTree(recordingCodec(calls), silentLogger);
  tree.applyMessage(
    { inputs: [{ kind: 'user-message', message: { id: 'U' } }], outputs: [] },
    { [HEADER_CODEC_MESSAGE_ID]: 'U', [HEADER_ROLE]: 'user' },
    's1',
    undefined,
    's1',
  );
  tree.applyMessage(
    { inputs: [], outputs: [{ type: 'message', message: { id: 'cm_tc' } }] },
    { [HEADER_RUN_ID]: 'R', [HEADER_CODEC_MESSAGE_ID]: 'cm_tc', [HEADER_PARENT]: 'U', [HEADER_ROLE]: 'assistant' },
    's2',
    undefined,
    's2',
  );
  return tree;
};

// Build a Tree + AgentView sharing the `calls` recorder.
const makeView = (calls: GetMessagesCall[]) =>
  createAgentView({
    tree: buildTree(calls),
    channel: stubChannel,
    codec: recordingCodec(calls),
    applier: stubApplier,
    inputEventLookbackMs: 0,
  });

describe('AgentView conversation scope', () => {
  it('scopes the current run to its continuation; ancestors stay canonical', () => {
    const calls: GetMessagesCall[] = [];
    const view = makeView(calls);

    view.messages('R', 'U', undefined, 'E1');

    const runCall = calls.find((c) => c.tag === 'cm_tc');
    const ancestorCall = calls.find((c) => c.tag === 'U');
    expect(runCall?.selector).toEqual({ continuationEventId: 'E1' });
    expect(ancestorCall?.selector).toBeUndefined();
  });

  it('passes no selector when the run is not a continuation', () => {
    const calls: GetMessagesCall[] = [];
    const view = makeView(calls);

    view.messages('R', 'U');

    for (const call of calls) expect(call.selector).toBeUndefined();
  });
});
