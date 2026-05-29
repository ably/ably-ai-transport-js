import { describe, expectTypeOf, it } from 'vitest';

import type { CodecInputEvent, EditInput, RegenerateInput, UserMessageInput } from '../../../src/core/codec/types.js';

// Surrogate domain message shape used to verify TMessage passes through the
// generic well-known variants.
interface FakeMessage {
  id: string;
  body: string;
}

type ExampleInput = UserMessageInput<FakeMessage> | RegenerateInput | EditInput<FakeMessage>;

const dispatchByKind = (event: ExampleInput): string => {
  switch (event.kind) {
    case 'user-message': {
      expectTypeOf(event).toEqualTypeOf<UserMessageInput<FakeMessage>>();
      return event.message.id;
    }
    case 'regenerate': {
      expectTypeOf(event).toEqualTypeOf<RegenerateInput>();
      return `${event.target}<-${event.parent}`;
    }
    case 'edit': {
      expectTypeOf(event).toEqualTypeOf<EditInput<FakeMessage>>();
      return event.message.id;
    }
  }
};

describe('Codec input event well-known shapes', () => {
  // -------------------------------------------------------------------------
  // CodecInputEvent base
  // -------------------------------------------------------------------------

  describe('CodecInputEvent', () => {
    it('requires a kind discriminator', () => {
      expectTypeOf<CodecInputEvent>().toHaveProperty('kind').toEqualTypeOf<string>();
    });

    it('exposes the transport routing fields as optional', () => {
      expectTypeOf<CodecInputEvent>().toHaveProperty('parent').toEqualTypeOf<string | undefined>();
      expectTypeOf<CodecInputEvent>().toHaveProperty('target').toEqualTypeOf<string | undefined>();
      expectTypeOf<CodecInputEvent>().toHaveProperty('codecMessageId').toEqualTypeOf<string | undefined>();
    });
  });

  // -------------------------------------------------------------------------
  // UserMessageInput
  // -------------------------------------------------------------------------

  describe('UserMessageInput', () => {
    it('pins the kind literal to "user-message"', () => {
      expectTypeOf<UserMessageInput<FakeMessage>>().toHaveProperty('kind').toEqualTypeOf<'user-message'>();
    });

    it('carries the TMessage payload via `message`', () => {
      expectTypeOf<UserMessageInput<FakeMessage>>().toHaveProperty('message').toEqualTypeOf<FakeMessage>();
    });

    it('is assignable to the CodecInputEvent base', () => {
      expectTypeOf<UserMessageInput<FakeMessage>>().toExtend<CodecInputEvent>();
    });
  });

  // -------------------------------------------------------------------------
  // RegenerateInput
  // -------------------------------------------------------------------------

  describe('RegenerateInput', () => {
    it('pins the kind literal to "regenerate"', () => {
      expectTypeOf<RegenerateInput>().toHaveProperty('kind').toEqualTypeOf<'regenerate'>();
    });

    it('requires `target` as a string (not optional)', () => {
      expectTypeOf<RegenerateInput>().toHaveProperty('target').toEqualTypeOf<string>();
    });

    it('requires `parent` as a string (not optional)', () => {
      expectTypeOf<RegenerateInput>().toHaveProperty('parent').toEqualTypeOf<string>();
    });

    it('is assignable to the CodecInputEvent base', () => {
      expectTypeOf<RegenerateInput>().toExtend<CodecInputEvent>();
    });

    it('rejects values that omit `target` or `parent`', () => {
      // @ts-expect-error — missing required `target` and `parent`.
      const _missingBoth: RegenerateInput = { kind: 'regenerate' };
      // @ts-expect-error — missing required `parent`.
      const _missingParent: RegenerateInput = { kind: 'regenerate', target: 'a' };
      // @ts-expect-error — missing required `target`.
      const _missingTarget: RegenerateInput = { kind: 'regenerate', parent: 'u' };
      const _ok: RegenerateInput = { kind: 'regenerate', target: 'a', parent: 'u' };
      void _missingBoth;
      void _missingParent;
      void _missingTarget;
      void _ok;
    });
  });

  // -------------------------------------------------------------------------
  // EditInput
  // -------------------------------------------------------------------------

  describe('EditInput', () => {
    it('pins the kind literal to "edit"', () => {
      expectTypeOf<EditInput<FakeMessage>>().toHaveProperty('kind').toEqualTypeOf<'edit'>();
    });

    it('requires `target` and `parent` as strings (not optional)', () => {
      expectTypeOf<EditInput<FakeMessage>>().toHaveProperty('target').toEqualTypeOf<string>();
      expectTypeOf<EditInput<FakeMessage>>().toHaveProperty('parent').toEqualTypeOf<string>();
    });

    it('carries the TMessage payload via `message`', () => {
      expectTypeOf<EditInput<FakeMessage>>().toHaveProperty('message').toEqualTypeOf<FakeMessage>();
    });

    it('is assignable to the CodecInputEvent base', () => {
      expectTypeOf<EditInput<FakeMessage>>().toExtend<CodecInputEvent>();
    });

    it('rejects values that omit `target`, `parent`, or `message`', () => {
      // @ts-expect-error — missing required `target`, `parent`, `message`.
      const _empty: EditInput<FakeMessage> = { kind: 'edit' };
      // @ts-expect-error — missing required `message`.
      const _noMessage: EditInput<FakeMessage> = { kind: 'edit', target: 'a', parent: 'u' };
      const _ok: EditInput<FakeMessage> = {
        kind: 'edit',
        target: 'a',
        parent: 'u',
        message: { id: 'x', body: 'edited' },
      };
      void _empty;
      void _noMessage;
      void _ok;
    });
  });

  // -------------------------------------------------------------------------
  // Discriminated-union narrowing
  // -------------------------------------------------------------------------

  describe('discriminated-union narrowing', () => {
    it('narrows each well-known variant by `kind`', () => {
      // dispatchByKind is defined at module scope; calling it exercises the
      // type-level assertions in each branch.
      void dispatchByKind;
    });
  });
});
