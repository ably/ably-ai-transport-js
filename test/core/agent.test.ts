/**
 * Unit tests for the Ably-Agent string this SDK stamps on a channel.
 *
 * Covers: the SDK's own agent always being present, a codec's adapter tag
 * being appended when it carries one, the opt-out when it does not, and
 * repeat-call stability — the property a caller relies on when it resolves the
 * channel itself and compares options between renders.
 */

import { describe, expect, it } from 'vitest';

import pkg from '../../package.json' with { type: 'json' };
import { channelAgent } from '../../src/core/agent.js';
import { VERSION } from '../../src/version.js';

describe('VERSION', () => {
  it('matches the published package version', () => {
    // The agent string is how Ably attributes traffic, so a release that bumps
    // package.json and forgets this constant would report a version the
    // package does not have. Failing here beats relying on release discipline.
    expect(VERSION).toBe(pkg.version);
  });
});

describe('channelAgent', () => {
  it('always names this SDK at its current version', () => {
    expect(channelAgent()).toBe(`ai-transport-js/${VERSION}`);
  });

  it('appends a codec that carries an adapter tag', () => {
    expect(channelAgent({ adapterTag: 'some-codec' })).toBe(`ai-transport-js/${VERSION} some-codec/${VERSION}`);
  });

  it('omits a codec that opts out by carrying no tag', () => {
    expect(channelAgent({})).toBe(`ai-transport-js/${VERSION}`);
  });

  it('omits a codec whose tag is an empty string', () => {
    // An empty tag would render as a bare `/version` entry, which is not a
    // valid agent. Treated as an opt-out rather than stamped.
    expect(channelAgent({ adapterTag: '' })).toBe(`ai-transport-js/${VERSION}`);
  });

  it('returns the same string every call for the same codec', () => {
    // A caller passes this as a channel option. ably-js compares options to
    // decide whether an attached channel needs reattaching, so an unstable
    // string would churn the channel on every render.
    const codec = { adapterTag: 'some-codec' };

    expect(channelAgent(codec)).toBe(channelAgent(codec));
  });
});
