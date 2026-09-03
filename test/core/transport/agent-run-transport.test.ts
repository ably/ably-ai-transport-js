/**
 * RunGate unit tests — the run's publish gate and produced-output flag.
 *
 * The gate is split out of the run handle because the run's step writer reads
 * it too, so it owns the "may this verb publish" policy and the message a
 * blocked verb rejects with. The handle that drives it is covered end to end
 * in agent-transport.test.ts, against the real writer and a mock channel.
 */

import { describe, expect, it } from 'vitest';

import { RunGate } from '../../../src/core/transport/agent-run-transport.js';
import { ErrorCode } from '../../../src/errors.js';

describe('RunGate', () => {
  it('starts open, having produced nothing', () => {
    const gate = new RunGate();

    expect(gate.state).toBe('open');
    expect(gate.hasProducedOutput).toBe(false);
    expect(() => {
      gate.assertPublishable('pipe', 'run-1');
    }).not.toThrow();
  });

  it('latches produced output', () => {
    const gate = new RunGate();

    gate.markOutputProduced();
    expect(gate.hasProducedOutput).toBe(true);

    // Idempotent: a second step attempt does not unset it.
    gate.markOutputProduced();
    expect(gate.hasProducedOutput).toBe(true);
  });

  it('blocks a suspended run, naming the run and the verb', () => {
    const gate = new RunGate();
    gate.moveTo('suspended');

    expect(() => {
      gate.assertPublishable('pipe', 'run-1');
    }).toThrowErrorInfo({
      code: ErrorCode.InvalidArgument,
      statusCode: 400,
      message: 'unable to pipe stream; run run-1 is suspended',
    });
    expect(() => {
      gate.assertPublishable('step', 'run-1');
    }).toThrowErrorInfo({ message: 'unable to run step; run run-1 is suspended' });
    expect(() => {
      gate.assertPublishable('send', 'run-1');
    }).toThrowErrorInfo({ message: 'unable to send output; run run-1 is suspended' });
  });

  it('blocks an ended run with its own reason', () => {
    const gate = new RunGate();
    gate.moveTo('ended');

    expect(() => {
      gate.assertPublishable('send', 'run-1');
    }).toThrowErrorInfo({
      code: ErrorCode.InvalidArgument,
      message: 'unable to send output; run run-1 has already ended',
    });
  });

  it('re-opens on resume, so output flows again', () => {
    const gate = new RunGate();
    gate.moveTo('suspended');
    gate.moveTo('open');

    expect(gate.state).toBe('open');
    expect(() => {
      gate.assertPublishable('pipe', 'run-1');
    }).not.toThrow();
  });
});
