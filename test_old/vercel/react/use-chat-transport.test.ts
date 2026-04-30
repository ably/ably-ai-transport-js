// @vitest-environment jsdom

import { renderHook } from '@testing-library/react';
import * as Ably from 'ably';
import type * as AI from 'ai';
import { createElement, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import type { ClientTransport } from '../../../src/core/transport/types.js';
import { ErrorCode } from '../../../src/errors.js';
import type { ChatTransportSlot } from '../../../src/vercel/react/contexts/chat-transport-context.js';
import { ChatTransportContext } from '../../../src/vercel/react/contexts/chat-transport-context.js';
import { useChatTransport } from '../../../src/vercel/react/use-chat-transport.js';
import type { ChatTransport } from '../../../src/vercel/transport/chat-transport.js';

// eslint-disable-next-line @typescript-eslint/no-empty-function -- no-op stub
const noop = (): void => {};

const createFakeChatTransport = (): ChatTransport => ({
  // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
  sendMessages: () => Promise.resolve(new ReadableStream()),
  // eslint-disable-next-line @typescript-eslint/promise-function-async, unicorn/no-null -- mock; null required by ChatTransport contract
  reconnectToStream: () => Promise.resolve(null),
  // eslint-disable-next-line @typescript-eslint/promise-function-async -- mock
  close: () => Promise.resolve(),
  streaming: false,
  onStreamingChange: () => noop,
});

// Test stub — identity comparison only, methods not exercised.
// CAST: test stub satisfies ClientTransport structurally; methods are never called.
const createFakeClientTransport = (): ClientTransport<AI.UIMessageChunk, AI.UIMessage> =>
  ({}) as unknown as ClientTransport<AI.UIMessageChunk, AI.UIMessage>;

const createFakeChatTransportSlot = (): ChatTransportSlot => ({
  transport: createFakeClientTransport(),
  transportError: undefined,
  chatTransport: createFakeChatTransport(),
});

// Wrap renderHook with a ChatTransportContext providing the given registry and nearest slot.
const withChatTransportContext =
  (providers: Record<string, ChatTransportSlot>, nearest?: ChatTransportSlot) =>
  ({ children }: { children: ReactNode }) =>
    createElement(ChatTransportContext.Provider, { value: { nearest, providers } }, children);

describe('useChatTransport', () => {
  it('returns the transport handle registered under the given channelName', () => {
    const slot = createFakeChatTransportSlot();
    const { result } = renderHook(() => useChatTransport({ channelName: 'ai:test' }), {
      wrapper: withChatTransportContext({ 'ai:test': slot }),
    });
    expect(result.current.chatTransport).toBe(slot.chatTransport);
    expect(result.current.transport).toBe(slot.transport);
  });

  it('returns the transport handle registered under a different channelName', () => {
    const slot = createFakeChatTransportSlot();
    const { result } = renderHook(() => useChatTransport({ channelName: 'ai:secondary' }), {
      wrapper: withChatTransportContext({ 'ai:secondary': slot }),
    });
    expect(result.current.chatTransport).toBe(slot.chatTransport);
    expect(result.current.transport).toBe(slot.transport);
  });

  it('returns the nearest transport handle when no channelName is given', () => {
    const slot = createFakeChatTransportSlot();
    const { result } = renderHook(() => useChatTransport(), {
      wrapper: withChatTransportContext({}, slot),
    });
    expect(result.current.chatTransport).toBe(slot.chatTransport);
    expect(result.current.transport).toBe(slot.transport);
  });

  it('surfaces slot transportError via chatTransportError', () => {
    const slot: ChatTransportSlot = {
      ...createFakeChatTransportSlot(),
      transportError: new Ably.ErrorInfo('construction failed', ErrorCode.BadRequest, 400),
    };
    const { result } = renderHook(() => useChatTransport({ channelName: 'ai:test' }), {
      wrapper: withChatTransportContext({ 'ai:test': slot }),
    });
    expect(result.current.transportError).toBe(slot.transportError);
  });

  it('sets chatTransportError with BadRequest when channelName given but no matching ChatTransportProvider', () => {
    const { result } = renderHook(() => useChatTransport({ channelName: 'ai:test' }), {
      wrapper: withChatTransportContext({}),
    });
    expect(result.current.chatTransportError).toMatchObject({ code: ErrorCode.BadRequest, statusCode: 400 });
    expect(result.current.chatTransportError?.message).toContain('no ChatTransportProvider found');
  });

  it('includes the channelName in the error message', () => {
    const { result } = renderHook(() => useChatTransport({ channelName: 'ai:primary' }), {
      wrapper: withChatTransportContext({}),
    });
    expect(result.current.chatTransportError).toMatchObject({ code: ErrorCode.BadRequest });
    expect(result.current.chatTransportError?.message).toContain('"ai:primary"');
  });

  it('sets chatTransportError with BadRequest when no channelName and no nearest provider', () => {
    const { result } = renderHook(() => useChatTransport());
    expect(result.current.chatTransportError).toMatchObject({ code: ErrorCode.BadRequest, statusCode: 400 });
    expect(result.current.chatTransportError?.message).toContain('no ChatTransportProvider found');
  });

  describe('skip', () => {
    it('returns a handle without throwing when skip is true', () => {
      const { result } = renderHook(() => useChatTransport({ skip: true }));
      expect(result.current).toBeDefined();
      expect(result.current.chatTransport).toBeDefined();
      expect(result.current.transport).toBeDefined();
    });

    it('stub sendMessages throws ErrorInfo with InvalidArgument', () => {
      const { result } = renderHook(() => useChatTransport({ skip: true }));
      // eslint-disable-next-line @typescript-eslint/promise-function-async -- stub throws synchronously; never returns a promise
      expect(() => result.current.chatTransport.sendMessages({} as never)).toThrow(
        expect.objectContaining({ code: ErrorCode.InvalidArgument, statusCode: 400 }),
      );
    });

    it('stub reconnectToStream throws ErrorInfo with InvalidArgument', () => {
      const { result } = renderHook(() => useChatTransport({ skip: true }));
      // eslint-disable-next-line @typescript-eslint/promise-function-async -- stub throws synchronously; never returns a promise
      expect(() => result.current.chatTransport.reconnectToStream({} as never)).toThrow(
        expect.objectContaining({ code: ErrorCode.InvalidArgument, statusCode: 400 }),
      );
    });

    it('stub chatTransport.close throws ErrorInfo with InvalidArgument', () => {
      const { result } = renderHook(() => useChatTransport({ skip: true }));
      expect(() => {
        void result.current.chatTransport.close();
      }).toThrow(expect.objectContaining({ code: ErrorCode.InvalidArgument, statusCode: 400 }));
    });

    it('stub streaming getter throws ErrorInfo with InvalidArgument', () => {
      const { result } = renderHook(() => useChatTransport({ skip: true }));
      expect(() => result.current.chatTransport.streaming).toThrow(
        expect.objectContaining({ code: ErrorCode.InvalidArgument, statusCode: 400 }),
      );
    });

    it('stub onStreamingChange throws ErrorInfo with InvalidArgument', () => {
      const { result } = renderHook(() => useChatTransport({ skip: true }));
      expect(() => result.current.chatTransport.onStreamingChange(noop)).toThrow(
        expect.objectContaining({ code: ErrorCode.InvalidArgument, statusCode: 400 }),
      );
    });

    it('stub error messages are descriptive', () => {
      const { result } = renderHook(() => useChatTransport({ skip: true }));
      // eslint-disable-next-line @typescript-eslint/promise-function-async -- stub throws synchronously; never returns a promise
      expect(() => result.current.chatTransport.sendMessages({} as never)).toThrow(
        expect.objectContaining({ message: 'unable to send messages; hook is skipped' }),
      );
    });

    it('stub transport.tree getter throws ErrorInfo with InvalidArgument', () => {
      const { result } = renderHook(() => useChatTransport({ skip: true }));
      expect(() => result.current.transport.tree).toThrow(
        expect.objectContaining({ code: ErrorCode.InvalidArgument, statusCode: 400 }),
      );
    });
  });
});
