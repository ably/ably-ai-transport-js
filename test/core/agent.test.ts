/**
 * Unit tests for the Ably-Agent string this SDK stamps on a channel.
 *
 * Covers: the SDK's own agent and the streaming layer always being present, a
 * codec's adapter tag being appended when it carries one, the opt-out when it
 * does not, repeat-call stability, and the registration on the client's
 * `options.agents`, where every entry carries a version.
 */

import type * as Ably from 'ably';
import { describe, expect, it } from 'vitest';

import pkg from '../../package.json' with { type: 'json' };
import { channelAgent, registerAgent } from '../../src/core/agent.js';
import { VERSION } from '../../src/version.js';

/**
 * A client with only the options the registration writes to.
 * @param agents - The agents already registered.
 * @returns The client.
 */
const clientWith = (agents?: Record<string, string>): Ably.Realtime =>
  // CAST: a minimal stub; registerAgent reads and writes only `options.agents`.
  ({ options: agents === undefined ? {} : { agents } }) as unknown as Ably.Realtime;

const agentsOf = (client: Ably.Realtime): unknown =>
  (client as unknown as { options: { agents?: unknown } }).options.agents;

describe('VERSION', () => {
  it('matches the published package version', () => {
    // The agent string is how Ably attributes traffic, so a release that bumps
    // package.json and forgets this constant would report a version the
    // package does not have. Failing here beats relying on release discipline.
    expect(VERSION).toBe(pkg.version);
  });
});

describe('channelAgent', () => {
  it('names this SDK at its current version and the streaming layer', () => {
    expect(channelAgent()).toBe(`ai-transport-js/${VERSION} streaming`);
  });

  it('appends a codec that carries an adapter tag, after the layer', () => {
    expect(channelAgent({ adapterTag: 'some-codec' })).toBe(
      `ai-transport-js/${VERSION} streaming some-codec/${VERSION}`,
    );
  });

  it('omits a codec that opts out by carrying no tag', () => {
    expect(channelAgent({})).toBe(`ai-transport-js/${VERSION} streaming`);
  });

  it('omits a codec whose tag is an empty string', () => {
    // An empty tag would render as a bare `/version` entry, which is not a
    // valid agent. Treated as an opt-out rather than stamped.
    expect(channelAgent({ adapterTag: '' })).toBe(`ai-transport-js/${VERSION} streaming`);
  });

  it('returns the same string every call for the same codec', () => {
    // The transport passes this as a channel option. ably-js compares options
    // to decide whether an attached channel needs reattaching, so an unstable
    // string would churn the channel.
    const codec = { adapterTag: 'some-codec' };

    expect(channelAgent(codec)).toBe(channelAgent(codec));
  });
});

describe('registerAgent', () => {
  it('gives every entry a version, the layer the SDK version, since ably-js writes each as name/value', () => {
    const client = clientWith();
    registerAgent(client, { adapterTag: 'some-codec' });
    expect(agentsOf(client)).toEqual({ 'ai-transport-js': VERSION, streaming: VERSION, 'some-codec': VERSION });
  });

  it('keeps the entries another library registered', () => {
    const client = clientWith({ 'ably-chat-js': '1.0.0' });
    registerAgent(client);
    expect(agentsOf(client)).toEqual({ 'ably-chat-js': '1.0.0', 'ai-transport-js': VERSION, streaming: VERSION });
  });

  it('writes the same entries when called again', () => {
    const client = clientWith();
    registerAgent(client, { adapterTag: 'some-codec' });
    const first = agentsOf(client);
    registerAgent(client, { adapterTag: 'some-codec' });
    expect(agentsOf(client)).toEqual(first);
  });
});
