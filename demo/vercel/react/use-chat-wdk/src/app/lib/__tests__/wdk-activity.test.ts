import { describe, expect, it } from 'vitest';

import { wdkActivityChannel, WDK_ACTIVITY_EVENT } from '../wdk-activity';

describe('wdkActivityChannel', () => {
  it('derives a :wdk sidecar channel from the session channel', () => {
    expect(wdkActivityChannel('ai:otter-nebula-quartz')).toBe('ai:otter-nebula-quartz:wdk');
  });

  it('keeps the sidecar within the session namespace so one token capability covers both', () => {
    expect(wdkActivityChannel('ai:demo')).toMatch(/^ai:/);
  });
});

describe('WDK_ACTIVITY_EVENT', () => {
  it('is the event name activities publish and the panel subscribes to', () => {
    expect(WDK_ACTIVITY_EVENT).toBe('activity');
  });
});
