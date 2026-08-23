import { describe, expect, it } from 'vitest';

import { createUIMessageCodec } from '../../../src/vercel/codec/index.js';

const UIMessageCodec = createUIMessageCodec();

describe('createUIMessageCodec', () => {
  it('carries the vercel adapterTag for Ably-Agent header registration', () => {
    expect(UIMessageCodec.adapterTag).toBe('vercel-ai-sdk-ui-message');
  });

  it('assembles a working encoder and decoder pair', () => {
    expect(UIMessageCodec.createDecoder()).toBeDefined();
    expect(typeof UIMessageCodec.createEncoder).toBe('function');
  });
});
