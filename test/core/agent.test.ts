import type * as Ably from 'ably';
import { describe, expect, it } from 'vitest';

import { registerAgent } from '../../src/core/agent.js';
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

describe('registerAgent', () => {
  it('sets the ai-transport-js agent on a client with no prior agents', () => {
    const client = fakeClient();
    registerAgent(client);
    expect(agentsOf(client)).toEqual({ 'ai-transport-js': VERSION });
  });

  it('preserves existing agents when registering', () => {
    const client = fakeClient({ 'some-other-sdk': '1.2.3' });
    registerAgent(client);
    expect(agentsOf(client)).toEqual({
      'some-other-sdk': '1.2.3',
      'ai-transport-js': VERSION,
    });
  });

  it('is idempotent across repeated calls', () => {
    const client = fakeClient();
    registerAgent(client);
    registerAgent(client);
    registerAgent(client);
    expect(agentsOf(client)).toEqual({ 'ai-transport-js': VERSION });
  });

  it('overwrites a stale prior version of itself', () => {
    const client = fakeClient({ 'ai-transport-js': '0.0.0' });
    registerAgent(client);
    expect(agentsOf(client)?.['ai-transport-js']).toBe(VERSION);
  });

  it('returns channel options carrying the agent identifier on params', () => {
    const client = fakeClient();
    const channelOptions = registerAgent(client);
    expect(channelOptions).toEqual({ params: { agent: `ai-transport-js/${VERSION}` } });
  });
});
