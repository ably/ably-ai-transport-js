import type * as AI from 'ai';
import { describe, expectTypeOf, it } from 'vitest';

import type {
  CodecInputEvent,
  CodecOutputEvent,
  Edit,
  Regenerate,
  ToolApprovalResponse,
  ToolResult,
  ToolResultError,
  UserMessage,
} from '../../../src/core/codec/types.js';

// Surrogate domain message shape used to verify TMessage passes through the
// generic well-known variants.
interface FakeMessage {
  id: string;
  body: string;
}

type ExampleInput = UserMessage<FakeMessage> | Regenerate | Edit<FakeMessage>;

const dispatchByKind = (event: ExampleInput): string => {
  switch (event.kind) {
    case 'user-message': {
      expectTypeOf(event).toEqualTypeOf<UserMessage<FakeMessage>>();
      return event.message.id;
    }
    case 'regenerate': {
      expectTypeOf(event).toEqualTypeOf<Regenerate>();
      return `${event.target}<-${event.parent}`;
    }
    case 'edit': {
      expectTypeOf(event).toEqualTypeOf<Edit<FakeMessage>>();
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
  // CodecOutputEvent base
  // -------------------------------------------------------------------------

  describe('CodecOutputEvent', () => {
    it('requires a type discriminator', () => {
      expectTypeOf<CodecOutputEvent>().toHaveProperty('type').toEqualTypeOf<string>();
    });

    it('is satisfied by AI.UIMessageChunk (Vercel codec output)', () => {
      expectTypeOf<AI.UIMessageChunk>().toExtend<CodecOutputEvent>();
    });

    it('rejects values that omit `type`', () => {
      // @ts-expect-error — missing required `type` discriminator.
      const _missing: CodecOutputEvent = {};
      const _ok: CodecOutputEvent = { type: 'some-output' };
      void _missing;
      void _ok;
    });
  });

  // -------------------------------------------------------------------------
  // UserMessage
  // -------------------------------------------------------------------------

  describe('UserMessage', () => {
    it('pins the kind literal to "user-message"', () => {
      expectTypeOf<UserMessage<FakeMessage>>().toHaveProperty('kind').toEqualTypeOf<'user-message'>();
    });

    it('carries the TMessage payload via `message`', () => {
      expectTypeOf<UserMessage<FakeMessage>>().toHaveProperty('message').toEqualTypeOf<FakeMessage>();
    });

    it('is assignable to the CodecInputEvent base', () => {
      expectTypeOf<UserMessage<FakeMessage>>().toExtend<CodecInputEvent>();
    });
  });

  // -------------------------------------------------------------------------
  // Regenerate
  // -------------------------------------------------------------------------

  describe('Regenerate', () => {
    it('pins the kind literal to "regenerate"', () => {
      expectTypeOf<Regenerate>().toHaveProperty('kind').toEqualTypeOf<'regenerate'>();
    });

    it('requires `target` as a string (not optional)', () => {
      expectTypeOf<Regenerate>().toHaveProperty('target').toEqualTypeOf<string>();
    });

    it('requires `parent` as a string (not optional)', () => {
      expectTypeOf<Regenerate>().toHaveProperty('parent').toEqualTypeOf<string>();
    });

    it('is assignable to the CodecInputEvent base', () => {
      expectTypeOf<Regenerate>().toExtend<CodecInputEvent>();
    });

    it('rejects values that omit `target` or `parent`', () => {
      // @ts-expect-error — missing required `target` and `parent`.
      const _missingBoth: Regenerate = { kind: 'regenerate' };
      // @ts-expect-error — missing required `parent`.
      const _missingParent: Regenerate = { kind: 'regenerate', target: 'a' };
      // @ts-expect-error — missing required `target`.
      const _missingTarget: Regenerate = { kind: 'regenerate', parent: 'u' };
      const _ok: Regenerate = { kind: 'regenerate', target: 'a', parent: 'u' };
      void _missingBoth;
      void _missingParent;
      void _missingTarget;
      void _ok;
    });
  });

  // -------------------------------------------------------------------------
  // Edit
  // -------------------------------------------------------------------------

  describe('Edit', () => {
    it('pins the kind literal to "edit"', () => {
      expectTypeOf<Edit<FakeMessage>>().toHaveProperty('kind').toEqualTypeOf<'edit'>();
    });

    it('requires `target` and `parent` as strings (not optional)', () => {
      expectTypeOf<Edit<FakeMessage>>().toHaveProperty('target').toEqualTypeOf<string>();
      expectTypeOf<Edit<FakeMessage>>().toHaveProperty('parent').toEqualTypeOf<string>();
    });

    it('carries the TMessage payload via `message`', () => {
      expectTypeOf<Edit<FakeMessage>>().toHaveProperty('message').toEqualTypeOf<FakeMessage>();
    });

    it('is assignable to the CodecInputEvent base', () => {
      expectTypeOf<Edit<FakeMessage>>().toExtend<CodecInputEvent>();
    });

    it('rejects values that omit `target`, `parent`, or `message`', () => {
      // @ts-expect-error — missing required `target`, `parent`, `message`.
      const _empty: Edit<FakeMessage> = { kind: 'edit' };
      // @ts-expect-error — missing required `message`.
      const _noMessage: Edit<FakeMessage> = { kind: 'edit', target: 'a', parent: 'u' };
      const _ok: Edit<FakeMessage> = {
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
  // ToolResult
  // -------------------------------------------------------------------------

  describe('ToolResult', () => {
    it('pins the kind literal to "tool-result"', () => {
      expectTypeOf<ToolResult>().toHaveProperty('kind').toEqualTypeOf<'tool-result'>();
    });

    it('requires `codecMessageId` and `toolCallId` as strings (not optional)', () => {
      expectTypeOf<ToolResult>().toHaveProperty('codecMessageId').toEqualTypeOf<string>();
      expectTypeOf<ToolResult>().toHaveProperty('toolCallId').toEqualTypeOf<string>();
    });

    it('carries the tool output as `unknown`', () => {
      expectTypeOf<ToolResult>().toHaveProperty('output').toEqualTypeOf<unknown>();
    });

    it('is assignable to the CodecInputEvent base', () => {
      expectTypeOf<ToolResult>().toExtend<CodecInputEvent>();
    });

    it('rejects values that omit `codecMessageId`, `toolCallId`, or `output`', () => {
      // @ts-expect-error — missing required `codecMessageId`, `toolCallId`, `output`.
      const _empty: ToolResult = { kind: 'tool-result' };
      // @ts-expect-error — missing required `output`.
      const _noOutput: ToolResult = { kind: 'tool-result', codecMessageId: 'a', toolCallId: 't' };
      const _ok: ToolResult = { kind: 'tool-result', codecMessageId: 'a', toolCallId: 't', output: { v: 1 } };
      void _empty;
      void _noOutput;
      void _ok;
    });
  });

  // -------------------------------------------------------------------------
  // ToolResultError
  // -------------------------------------------------------------------------

  describe('ToolResultError', () => {
    it('pins the kind literal to "tool-result-error"', () => {
      expectTypeOf<ToolResultError>().toHaveProperty('kind').toEqualTypeOf<'tool-result-error'>();
    });

    it('requires `codecMessageId`, `toolCallId`, and `message` as strings', () => {
      expectTypeOf<ToolResultError>().toHaveProperty('codecMessageId').toEqualTypeOf<string>();
      expectTypeOf<ToolResultError>().toHaveProperty('toolCallId').toEqualTypeOf<string>();
      expectTypeOf<ToolResultError>().toHaveProperty('message').toEqualTypeOf<string>();
    });

    it('is assignable to the CodecInputEvent base', () => {
      expectTypeOf<ToolResultError>().toExtend<CodecInputEvent>();
    });

    it('rejects values that omit any of `codecMessageId`, `toolCallId`, `message`', () => {
      // @ts-expect-error — missing required fields.
      const _empty: ToolResultError = { kind: 'tool-result-error' };
      // @ts-expect-error — missing required `message`.
      const _noMessage: ToolResultError = { kind: 'tool-result-error', codecMessageId: 'a', toolCallId: 't' };
      const _ok: ToolResultError = {
        kind: 'tool-result-error',
        codecMessageId: 'a',
        toolCallId: 't',
        message: 'failure',
      };
      void _empty;
      void _noMessage;
      void _ok;
    });
  });

  // -------------------------------------------------------------------------
  // ToolApprovalResponse
  // -------------------------------------------------------------------------

  describe('ToolApprovalResponse', () => {
    it('pins the kind literal to "tool-approval-response"', () => {
      expectTypeOf<ToolApprovalResponse>().toHaveProperty('kind').toEqualTypeOf<'tool-approval-response'>();
    });

    it('requires `codecMessageId`, `toolCallId`, and `approved`', () => {
      expectTypeOf<ToolApprovalResponse>().toHaveProperty('codecMessageId').toEqualTypeOf<string>();
      expectTypeOf<ToolApprovalResponse>().toHaveProperty('toolCallId').toEqualTypeOf<string>();
      expectTypeOf<ToolApprovalResponse>().toHaveProperty('approved').toEqualTypeOf<boolean>();
    });

    it('exposes `reason` as optional', () => {
      expectTypeOf<ToolApprovalResponse>().toHaveProperty('reason').toEqualTypeOf<string | undefined>();
    });

    it('is assignable to the CodecInputEvent base', () => {
      expectTypeOf<ToolApprovalResponse>().toExtend<CodecInputEvent>();
    });

    it('rejects values that omit `approved` or the routing fields', () => {
      // @ts-expect-error — missing required fields.
      const _empty: ToolApprovalResponse = { kind: 'tool-approval-response' };
      // @ts-expect-error — missing required `approved`.
      const _noApproved: ToolApprovalResponse = {
        kind: 'tool-approval-response',
        codecMessageId: 'a',
        toolCallId: 't',
      };
      const _ok: ToolApprovalResponse = {
        kind: 'tool-approval-response',
        codecMessageId: 'a',
        toolCallId: 't',
        approved: false,
        reason: 'nope',
      };
      void _empty;
      void _noApproved;
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
