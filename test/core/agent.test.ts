import type * as Ably from 'ably';
import { describe, expect, it } from 'vitest';

import { channelAgent, registerAgent } from '../../src/core/agent.js';
import { VERSION } from '../../src/version.js';

interface RealtimeWithAgents {
  options: { agents?: Record<string, string | undefined> };
}

const fakeClient = (initial?: Record<string, string | undefined>): Ably.Realtime => {
  const client: RealtimeWithAgents = {
    options: initial ? { agents: { ...initial } } : {},
  };
  // CAST: minimal stub used purely to exercise registerAgent's mutation.
  return client as unknown as Ably.Realtime;
};

const agentsOf = (client: Ably.Realtime): Record<string, string | undefined> | undefined =>
  (client as unknown as RealtimeWithAgents).options.agents;

const streaming = { layer: 'streaming' } as const;
const durable = { layer: 'durable-sessions' } as const;
const durableTemporal = { layer: 'durable-sessions', runtime: 'temporal' } as const;
const vercelCodec = { adapterTag: 'vercel-ai-sdk-ui-message' };

describe('registerAgent', () => {
  it('sets the SDK and layer agents on a client with no prior agents', () => {
    const client = fakeClient();
    registerAgent(client, streaming);
    expect(agentsOf(client)).toEqual({ 'ai-transport-js': VERSION, streaming: VERSION });
  });

  it('preserves existing agents when registering', () => {
    const client = fakeClient({ 'some-other-sdk': '1.2.3' });
    registerAgent(client, streaming);
    expect(agentsOf(client)).toEqual({
      'some-other-sdk': '1.2.3',
      'ai-transport-js': VERSION,
      streaming: VERSION,
    });
  });

  it('is idempotent across repeated calls', () => {
    const client = fakeClient();
    registerAgent(client, streaming);
    registerAgent(client, streaming);
    registerAgent(client, streaming);
    expect(agentsOf(client)).toEqual({ 'ai-transport-js': VERSION, streaming: VERSION });
  });

  it('overwrites a stale prior version of itself', () => {
    const client = fakeClient({ 'ai-transport-js': '0.0.0' });
    registerAgent(client, streaming);
    expect(agentsOf(client)?.['ai-transport-js']).toBe(VERSION);
  });

  it('returns channel options carrying the agent identifier on params', () => {
    const client = fakeClient();
    const channelOptions = registerAgent(client, streaming);
    expect(channelOptions).toEqual({ params: { agent: `ai-transport-js/${VERSION} streaming` } });
  });

  describe('with a codec carrying adapterTag', () => {
    it('registers the codec entry alongside the SDK and layer entries', () => {
      const client = fakeClient();
      registerAgent(client, streaming, vercelCodec);
      expect(agentsOf(client)).toEqual({
        'ai-transport-js': VERSION,
        streaming: VERSION,
        'vercel-ai-sdk-ui-message': VERSION,
      });
    });

    it('orders params.agent as SDK, layer, then codec', () => {
      const client = fakeClient();
      const channelOptions = registerAgent(client, streaming, vercelCodec);
      expect(channelOptions).toEqual({
        params: { agent: `ai-transport-js/${VERSION} streaming vercel-ai-sdk-ui-message/${VERSION}` },
      });
    });

    it('is idempotent when called repeatedly with the same codec', () => {
      const client = fakeClient();
      registerAgent(client, streaming, vercelCodec);
      registerAgent(client, streaming, vercelCodec);
      expect(agentsOf(client)).toEqual({
        'ai-transport-js': VERSION,
        streaming: VERSION,
        'vercel-ai-sdk-ui-message': VERSION,
      });
    });

    it('preserves existing agents when registering with a codec', () => {
      const client = fakeClient({ 'some-other-sdk': '1.2.3' });
      registerAgent(client, streaming, vercelCodec);
      expect(agentsOf(client)).toEqual({
        'some-other-sdk': '1.2.3',
        'ai-transport-js': VERSION,
        streaming: VERSION,
        'vercel-ai-sdk-ui-message': VERSION,
      });
    });

    it('ignores a codec with no adapterTag', () => {
      const client = fakeClient();
      registerAgent(client, streaming, {});
      expect(agentsOf(client)).toEqual({ 'ai-transport-js': VERSION, streaming: VERSION });
    });
  });

  describe('layer and runtime tokens', () => {
    it('renders the layer and runtime bare on ATTACH and versioned on the connection', () => {
      // ably-js formats every options.agents entry as `name/value` with no
      // branch for a missing value, so an unversioned token is not expressible
      // there. The two paths therefore disagree by design.
      const client = fakeClient();
      const channelOptions = registerAgent(client, durableTemporal, vercelCodec);
      expect(channelOptions.params.agent).toBe(
        `ai-transport-js/${VERSION} durable-sessions temporal vercel-ai-sdk-ui-message/${VERSION}`,
      );
      expect(agentsOf(client)).toEqual({
        'ai-transport-js': VERSION,
        'durable-sessions': VERSION,
        temporal: VERSION,
        'vercel-ai-sdk-ui-message': VERSION,
      });
    });

    it('omits the runtime token when no runtime is named', () => {
      const client = fakeClient();
      const channelOptions = registerAgent(client, durable, vercelCodec);
      expect(channelOptions.params.agent).toBe(
        `ai-transport-js/${VERSION} durable-sessions vercel-ai-sdk-ui-message/${VERSION}`,
      );
      expect(agentsOf(client)).not.toHaveProperty('temporal');
    });

    it('orders params.agent as SDK, layer, then runtime when there is no codec tag', () => {
      const client = fakeClient();
      expect(registerAgent(client, durableTemporal).params.agent).toBe(
        `ai-transport-js/${VERSION} durable-sessions temporal`,
      );
    });

    it('accumulates both layer keys on a client that opened sessions on each', () => {
      // One client can back a client session and a durable session. The map
      // merges, so it ends up with both layer keys, while each channel's
      // params.agent still names only its own layer.
      const client = fakeClient();
      const streamingOptions = registerAgent(client, streaming);
      const durableOptions = registerAgent(client, durable);
      expect(agentsOf(client)).toEqual({
        'ai-transport-js': VERSION,
        streaming: VERSION,
        'durable-sessions': VERSION,
      });
      expect(streamingOptions.params.agent).toBe(`ai-transport-js/${VERSION} streaming`);
      expect(durableOptions.params.agent).toBe(`ai-transport-js/${VERSION} durable-sessions`);
    });
  });
});

describe('channelAgent', () => {
  it('returns the same string registerAgent puts on params.agent', () => {
    const client = fakeClient();
    expect(channelAgent(durableTemporal, vercelCodec)).toBe(
      registerAgent(client, durableTemporal, vercelCodec).params.agent,
    );
  });

  it('does not mutate the client, so the provider can seed options without registering', () => {
    const client = fakeClient();
    channelAgent(streaming, vercelCodec);
    expect(agentsOf(client)).toBeUndefined();
  });

  it('renders the SDK and layer with no codec supplied', () => {
    expect(channelAgent(streaming)).toBe(`ai-transport-js/${VERSION} streaming`);
  });
});
