import { describe, expect, it } from 'vitest';

import { headersFromStamp, mapEvent, messageFromStamp } from './codec.ts';
import { HEADER_RETRY_IDENTITY, HEADER_SPANS, HEADER_STREAM_STATUS } from './linear.ts';

describe('thin codec', () => {
  it('maps Vercel stream events onto stamps', () => {
    expect(mapEvent('vercel', 'text-start', { id: 'asst-1' })).toMatchObject({
      action: 'create',
      streamStatus: 'open',
      retryIdentity: 'asst-1',
    });
    expect(mapEvent('vercel', 'text-delta', { delta: 'Hi' })?.data).toBe('Hi');
    expect(mapEvent('vercel', 'finish')?.streamStatus).toBe('complete');
    expect(mapEvent('vercel', 'unknown')).toBeUndefined();
  });

  it('maps AG-UI run/step onto overlapping spans', () => {
    const started = mapEvent('ag-ui', 'RUN_STARTED', { runId: 'run-1' });
    expect(started?.spans).toEqual(['run-1']);
    const step = mapEvent('ag-ui', 'STEP_STARTED', { runId: 'run-1', stepId: 'step-9' });
    expect(step?.spans).toEqual(['run-1', 'step-9']);
    expect(mapEvent('ag-ui', 'RUN_ERROR')?.streamStatus).toBe('stopped');
  });

  it('does not emit extras.ai or tree headers', () => {
    const msg = messageFromStamp({
      action: 'create',
      streamStatus: 'open',
      retryIdentity: 'asst-1',
      spans: ['run-1', 'step-9'],
    });
    const headers = headersFromStamp({
      action: 'create',
      streamStatus: 'open',
      retryIdentity: 'asst-1',
      spans: ['run-1', 'step-9'],
    });
    expect(headers).toEqual({
      [HEADER_STREAM_STATUS]: 'open',
      [HEADER_RETRY_IDENTITY]: 'asst-1',
      [HEADER_SPANS]: 'run-1,step-9',
    });
    expect(JSON.stringify(msg)).not.toMatch(/extras\.ai|parent|fork-of|supersedes/);
  });
});
