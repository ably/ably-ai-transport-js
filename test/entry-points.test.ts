/**
 * Guards what each public entry point publishes.
 *
 * The package ships three entry points and each one's `index.ts` is the
 * authoritative list of its public API. The codec suites cannot catch a
 * mis-wired barrel because they import the internal modules directly and never
 * exercise the entry points, so an export that goes missing surfaces only in a
 * consumer's build.
 *
 * The type-level assertions here are checked by `pnpm run typecheck` (which
 * includes `test/`), not by `pnpm test`: each one names a public type on a
 * local, so dropping a type export fails the typecheck rather than a consumer's
 * build. The runtime assertions keep the cases live under `pnpm test`.
 *
 * The codec assertion is deliberately an exact key set rather than a deny-list.
 * A wire codec exposes encode and decode and nothing else; anything more means
 * message assembly moved back inside the SDK, which is the boundary this design
 * exists to hold. A deny-list would only catch the names we thought of.
 *
 * These import the source barrels, not the package specifier, so they run
 * without a build. They therefore do not guard the `exports` map itself — that
 * is `pnpm run build`'s job, which fails if a declared subpath has no bundle.
 */

import type * as AI from 'ai';
import { describe, expect, it } from 'vitest';

import type { TransportEvent, WireMeta } from '../src/index.js';
import {
  channelAgent,
  createAgentTransport,
  createClientTransport,
  OBJECT_MODES,
  resolveChannelModes,
} from '../src/index.js';
import type { OpenAIInput, OpenAIMessage, OpenAIOutput } from '../src/openai/index.js';
import { ResponsesCodec } from '../src/openai/index.js';
import type { ClientTransportHandle, UseClientTransportOptions } from '../src/react/index.js';
import {
  ClientTransportProvider,
  useAblyMessages,
  useClientTransport,
  useTransportEvents,
} from '../src/react/index.js';
import type { VercelInput, VercelOutput } from '../src/vercel/index.js';
import { createUIMessageCodec } from '../src/vercel/index.js';

/**
 * Every key a wire codec may carry. An allowlist rather than a denylist: a
 * codec that grew a surface nobody anticipated still fails here, where a list
 * of names we thought of would not.
 */
const WIRE_CODEC_KEYS = new Set(['adapterTag', 'createDecoder', 'createEncoder']);

describe('@ably/ai-transport', () => {
  it('publishes the two transport factories', () => {
    expect(createClientTransport).toBeTypeOf('function');
    expect(createAgentTransport).toBeTypeOf('function');
  });

  it('publishes the channel-mode recipe a caller needs', () => {
    // A caller resolves its own channel, and setting any mode replaces the
    // server default rather than adding to it, so asking for object access
    // means asking for the base set too. resolveChannelModes does that union
    // in a fixed order, so two resolutions compare equal and ably-js sees no
    // mode change to reattach for.
    expect(resolveChannelModes(OBJECT_MODES)).toEqual([
      'PUBLISH',
      'SUBSCRIBE',
      'PRESENCE',
      'PRESENCE_SUBSCRIBE',
      'OBJECT_PUBLISH',
      'OBJECT_SUBSCRIBE',
      'ANNOTATION_PUBLISH',
    ]);
    // No extras means no mode flags on the wire, so the server default applies.
    expect(resolveChannelModes()).toBeUndefined();
  });

  it('publishes the agent string a caller stamps on its channel', () => {
    expect(channelAgent()).toMatch(/^ai-transport-js\/\d+\.\d+\.\d+$/);
  });

  it('publishes the types a consumer needs to merge the event stream itself', () => {
    // Spelled in full, with no cast: a new required field on WireMeta should
    // fail the typecheck here rather than pass silently.
    const meta: WireMeta = {
      transport: {},
      codec: {},
      headers: {},
      serial: 's-1',
      transportMessageId: 'tmid-1',
      runId: 'run-1',
      stepId: undefined,
      stepStartSerial: undefined,
      timestamp: 1,
      role: 'assistant',
      clientId: 'agent-1',
      messageName: 'ai-output',
      versionSerial: 'v-1',
      versionTimestamp: 1,
      inputTransportMessageId: undefined,
      inputTransportMessageIds: undefined,
      steerTransportMessageIds: undefined,
    };
    const event: TransportEvent<VercelInput, VercelOutput> = { kind: 'message', meta, inputs: [], outputs: [] };

    expect(event.meta.versionSerial).toBe('v-1');
  });
});

describe.each([
  ['@ably/ai-transport/vercel', () => createUIMessageCodec()],
  ['@ably/ai-transport/openai', () => ResponsesCodec],
])('%s', (_name, build) => {
  it('publishes a wire codec that encodes and decodes, and nothing more', () => {
    const codec = build();

    // Subset plus required, because adapterTag is optional: a codec that opts
    // out of agent registration carries only the two functions.
    const unexpected = Object.keys(codec).filter((key) => !WIRE_CODEC_KEYS.has(key));

    expect(unexpected, 'a wire codec carries encode, decode, and its adapter tag').toEqual([]);
    expect(codec.createDecoder()).toBeDefined();
    expect(typeof codec.createEncoder).toBe('function');
  });
});

describe('@ably/ai-transport/react', () => {
  it('publishes the provider and the three hooks', () => {
    // The codec suites never import this barrel, so a dropped export would
    // otherwise surface only in a consumer's build.
    expect(ClientTransportProvider).toBeTypeOf('function');
    expect(useClientTransport).toBeTypeOf('function');
    expect(useTransportEvents).toBeTypeOf('function');
    expect(useAblyMessages).toBeTypeOf('function');
  });

  it("publishes the types a caller needs to name a hook's options and handle", () => {
    // Spelled on locals: dropping a type export fails the typecheck here
    // rather than in a consumer's build.
    const options: UseClientTransportOptions = {};
    const handle: ClientTransportHandle = { transport: undefined, error: undefined };

    expect(options).toEqual({});
    expect(handle.transport).toBeUndefined();
  });
});

describe('@ably/ai-transport/vercel', () => {
  it('publishes the input and output unions a caller names', () => {
    const message: AI.UIMessage = { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] };
    const input: VercelInput = { kind: 'message', payload: message };
    const output: VercelOutput = { type: 'start', messageId: 'a1' };

    expect(input.kind).toBe('message');
    expect(output.type).toBe('start');
  });
});

describe('@ably/ai-transport/openai', () => {
  it('publishes the input and output unions a caller names', () => {
    const message: OpenAIMessage = { role: 'user', items: [] };
    const input: OpenAIInput = { kind: 'message', payload: message };
    const output: OpenAIOutput = { type: 'tool-approval-request', call_id: 'c1', name: 'getWeather', arguments: '{}' };

    expect(input.kind).toBe('message');
    expect(output.type).toBe('tool-approval-request');
  });
});
