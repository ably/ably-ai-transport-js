import { describe, it, expect, afterEach, vi } from 'vitest';

import { createResponseStream } from '../model';
import { userInput } from './stream-helpers';

describe('createResponseStream', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('throws when neither MOCK_LLM nor OPENAI_API_KEY is configured', async () => {
    vi.stubEnv('MOCK_LLM', undefined);
    vi.stubEnv('OPENAI_API_KEY', undefined);
    await expect(
      createResponseStream({ input: userInput('hi'), signal: new AbortController().signal }),
    ).rejects.toThrow('No model configured');
  });
});
