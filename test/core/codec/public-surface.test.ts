import { describe, expect, expectTypeOf, it } from 'vitest';

import type {
  BatchSpec,
  CodecEvent,
  DataCodec,
  HeaderField,
  InputBuilder,
  InputDescriptor,
  InputEventSpec,
  LifecyclePolicy,
  OutputBuilder,
  OutputDescriptor,
  OutputEventSpec,
  OutputStreamSpec,
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
    expectTypeOf<CodecEvent<Input, Output>>().not.toBeNever();
  });
});
