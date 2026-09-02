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
import { AIT_BASE_MODES, createAgentTransport, createClientTransport, OBJECT_MODES } from '../src/index.js';
import type { OpenAIInput, OpenAIMessage, OpenAIOutput } from '../src/openai/index.js';
import { ResponsesCodec } from '../src/openai/index.js';
import type { VercelInput, VercelOutput } from '../src/vercel/index.js';
import { createUIMessageCodec } from '../src/vercel/index.js';

/** The complete surface of a wire codec. Anything else is message assembly. */
const WIRE_CODEC_KEYS = ['createDecoder', 'createEncoder'];

describe('@ably/ai-transport', () => {
  it('publishes the two transport factories', () => {
    expect(createClientTransport).toBeTypeOf('function');
    expect(createAgentTransport).toBeTypeOf('function');
  });

  it('publishes both halves of the channel-mode recipe a caller needs', () => {
    // A caller resolves its own channel, and setting any mode replaces the
    // server default rather than adding to it — so requesting object access
    // means naming the base set too. Both constants have to be reachable.
    expect([...AIT_BASE_MODES, ...OBJECT_MODES]).toEqual([
      'PUBLISH',
      'SUBSCRIBE',
      'PRESENCE',
      'PRESENCE_SUBSCRIBE',
      'ANNOTATION_PUBLISH',
      'OBJECT_SUBSCRIBE',
      'OBJECT_PUBLISH',
    ]);
  });

  it('publishes the types a consumer needs to fold the event stream itself', () => {
    // Spelled in full, with no cast: a new required field on WireMeta should
    // fail the typecheck here rather than pass silently.
    const meta: WireMeta = {
      transport: {},
      codec: {},
      headers: {},
      serial: 's-1',
      codecMessageId: 'cmid-1',
      runId: 'run-1',
      stepId: undefined,
      stepStartSerial: undefined,
      timestamp: 1,
      role: 'assistant',
      clientId: 'agent-1',
      messageName: 'ai-output',
      versionSerial: 'v-1',
      versionTimestamp: 1,
      parent: undefined,
      forkOf: undefined,
      regenerates: undefined,
      inputCodecMessageId: undefined,
      inputCodecMessageIds: undefined,
      steerCodecMessageIds: undefined,
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

    expect(Object.keys(codec).toSorted()).toEqual(WIRE_CODEC_KEYS);
    expect(codec.createDecoder()).toBeDefined();
    expect(typeof codec.createEncoder).toBe('function');
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
