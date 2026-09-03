// @vitest-environment jsdom

import { renderHook } from '@testing-library/react';
import * as Ably from 'ably';
import { createElement, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import type { ClientTransport } from '../../../src/core/transport/types.js';
import { ErrorCode } from '../../../src/errors.js';
import type { VercelInput, VercelOutput } from '../../../src/vercel/codec/events.js';
import type { ChatTransportSlot } from '../../../src/vercel/react/contexts/chat-transport-context.js';
import { ChatTransportContext } from '../../../src/vercel/react/contexts/chat-transport-context.js';
import { useChatTransport } from '../../../src/vercel/react/use-chat-transport.js';
import type { ChatTransport } from '../../../src/vercel/transport/chat-transport.js';

// Test stubs — identity comparison only, methods not exercised.
// CAST: test stubs satisfy the interfaces structurally; members are never called.
const createFakeChatTransport = (): ChatTransport => ({}) as unknown as ChatTransport;
const createFakeClientTransport = (): ClientTransport<VercelInput, VercelOutput> =>
  ({}) as unknown as ClientTransport<VercelInput, VercelOutput>;

const createSlot = (): ChatTransportSlot => ({
  transport: createFakeClientTransport(),
  chatTransport: createFakeChatTransport(),
  error: undefined,
});

// Wrap renderHook with a ChatTransportContext providing the given registry and nearest slot.
const withContext =
  (providers: Record<string, ChatTransportSlot>, nearest?: ChatTransportSlot) =>
  ({ children }: { children: ReactNode }) =>
    createElement(ChatTransportContext.Provider, { value: { nearest, providers } }, children);

describe('useChatTransport', () => {
  it('returns the pair registered under the given channelName', () => {
    const slot = createSlot();
    const { result } = renderHook(() => useChatTransport({ channelName: 'ai:test' }), {
      wrapper: withContext({ 'ai:test': slot }),
    });
    expect(result.current.chatTransport).toBe(slot.chatTransport);
    expect(result.current.transport).toBe(slot.transport);
    expect(result.current.error).toBeUndefined();
  });

  it('returns the nearest pair when channelName is omitted', () => {
    const outer = createSlot();
    const inner = createSlot();
    const { result } = renderHook(() => useChatTransport(), {
      wrapper: withContext({ 'ai:outer': outer, 'ai:inner': inner }, inner),
    });
    expect(result.current.chatTransport).toBe(inner.chatTransport);
  });

  it('surfaces the construction error on the handle', () => {
    const error = new Ably.ErrorInfo('unable to create client transport; boom', ErrorCode.InvalidArgument, 400);
    const slot: ChatTransportSlot = { transport: undefined, chatTransport: undefined, error };
    const { result } = renderHook(() => useChatTransport(), { wrapper: withContext({ 'ai:test': slot }, slot) });
    expect(result.current.chatTransport).toBeUndefined();
    expect(result.current.transport).toBeUndefined();
    expect(result.current.error).toBe(error);
  });

  it('throws when no matching provider encloses the caller', () => {
    expect(() => renderHook(() => useChatTransport(), { wrapper: withContext({}) })).toThrowErrorInfo({
      code: ErrorCode.InvalidArgument,
    });
    expect(() =>
      renderHook(() => useChatTransport({ channelName: 'ai:missing' }), {
        wrapper: withContext({ 'ai:test': createSlot() }),
      }),
    ).toThrowErrorInfo({ code: ErrorCode.InvalidArgument });
  });
});
