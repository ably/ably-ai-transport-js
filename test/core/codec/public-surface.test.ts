import { describe, expect, expectTypeOf, it } from 'vitest';

import type {
  AdoptedRun,
  BatchSpec,
  DataCodec,
  HeaderField,
  InputBuilder,
  InputDescriptor,
  InputEventSpec,
  LifecyclePolicy,
  OpenableRun,
  OutputBuilder,
  OutputDescriptor,
  OutputEventSpec,
  OutputStreamSpec,
  RunIdentity,
  RunStep,
  StepEndParams,
  StepEndReason,
  StepInfo,
  StepOptions,
} from '../../../src/index.js';
import * as pkg from '../../../src/index.js';

// The codec-authoring surface must be reachable from the package entry point:
// a codec author cannot deep-import internal modules of a published package.
describe('public codec-authoring surface', () => {
  it('exports the authoring functions', () => {
    expect(pkg.defineCodec).toBeTypeOf('function');
    expect(pkg.strField).toBeTypeOf('function');
    expect(pkg.boolField).toBeTypeOf('function');
    expect(pkg.jsonField).toBeTypeOf('function');
    expect(pkg.enumField).toBeTypeOf('function');
  });

  it('exports the authoring types', () => {
    // Type-only assertions: these fail typecheck (not runtime) if a name
    // disappears from the entry point or changes shape incompatibly.
    interface Output {
      type: 'note';
      text: string;
    }
    interface Input {
      kind: 'user-message';
      payload: { text: string };
    }

    expectTypeOf(pkg.strField('id')).toExtend<HeaderField<string | undefined>>();
    expectTypeOf<OutputDescriptor<Output>>().not.toBeNever();
    expectTypeOf<OutputEventSpec<Output>>().not.toBeNever();
    expectTypeOf<OutputStreamSpec<Output, 'note', 'note', 'note'>>().not.toBeNever();
    expectTypeOf<OutputBuilder<Output>>().not.toBeNever();
    expectTypeOf<InputDescriptor<Input>>().not.toBeNever();
    expectTypeOf<InputEventSpec<Input>>().not.toBeNever();
    expectTypeOf<BatchSpec<Input, { type: 'text' }>>().not.toBeNever();
    expectTypeOf<InputBuilder<Input>>().not.toBeNever();
    expectTypeOf<DataCodec<Output>>().not.toBeNever();
    expectTypeOf<LifecyclePolicy<Output>>().not.toBeNever();
  });

  // The step vocabulary is reachable on the public `Run.createStep` /
  // `RunNode.steps` surface, so its supporting types must be importable from the
  // entry point — a consumer cannot deep-import internal modules of a published
  // package.
  it('exports the step types', () => {
    interface Output {
      type: 'note';
      text: string;
    }
    expectTypeOf<RunStep<Output>>().not.toBeNever();
    expectTypeOf<StepOptions>().not.toBeNever();
    expectTypeOf<StepEndParams>().not.toBeNever();
    expectTypeOf<StepInfo>().not.toBeNever();
    expectTypeOf<StepEndReason>().toEqualTypeOf<'complete' | 'failed' | 'cancelled'>();
    // The client-identity scope is part of the read-model and the step-options
    // seam, so both must carry it on the public surface.
    expectTypeOf<StepInfo>().toHaveProperty('stepClientId').toEqualTypeOf<string | undefined>();
    expectTypeOf<StepOptions>().toHaveProperty('stepClientId').toEqualTypeOf<string | undefined>();
  });

  // The run-adoption surface (durable cross-process execution) is public too:
  // adoptRun returns an AdoptedRun, createRun an OpenableRun, and both take a
  // RunIdentity. All must be importable from the entry point, like the step
  // vocabulary above — an orchestration threading a run's identity across
  // processes must never have to redeclare the shape.
  it('exports the run-adoption types', () => {
    interface Output {
      type: 'note';
      text: string;
    }
    expectTypeOf<RunIdentity>().toEqualTypeOf<{ runId: string; invocationId: string }>();
    expectTypeOf<AdoptedRun<Output, unknown, unknown>>().not.toBeNever();
    expectTypeOf<OpenableRun<Output, unknown, unknown>>().not.toBeNever();
  });
});
