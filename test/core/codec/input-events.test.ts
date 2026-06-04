import type * as AI from 'ai';
import { describe, expectTypeOf, it } from 'vitest';

import type {
  CodecInputEvent,
  CodecOutputEvent,
  Edit,
  Regenerate,
  ToolApprovalResponse,
  ToolApprovalResponsePayloadOf,
  ToolResult,
  ToolResultError,
  ToolResultErrorPayloadOf,
  ToolResultPayloadOf,
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
  // ToolResult — domain payload parameterized, no tool fields on the core type
  // -------------------------------------------------------------------------

  describe('ToolResult', () => {
    interface FakeResultPayload {
      toolCallId: string;
      output: unknown;
    }

    it('pins the kind literal to "tool-result"', () => {
      expectTypeOf<ToolResult<FakeResultPayload>>().toHaveProperty('kind').toEqualTypeOf<'tool-result'>();
    });

    it('requires `codecMessageId` (string) and carries the domain `payload`', () => {
      expectTypeOf<ToolResult<FakeResultPayload>>().toHaveProperty('codecMessageId').toEqualTypeOf<string>();
      expectTypeOf<ToolResult<FakeResultPayload>>().toHaveProperty('payload').toEqualTypeOf<FakeResultPayload>();
    });

    it('does not expose domain tool fields on the core type', () => {
      // @ts-expect-error — `toolCallId` is a domain field, carried in `payload`, not on the core variant.
      expectTypeOf<ToolResult<FakeResultPayload>>().toHaveProperty('toolCallId');
      // @ts-expect-error — `output` is a domain field, carried in `payload`, not on the core variant.
      expectTypeOf<ToolResult<FakeResultPayload>>().toHaveProperty('output');
    });

    it('is assignable to the CodecInputEvent base', () => {
      expectTypeOf<ToolResult<FakeResultPayload>>().toExtend<CodecInputEvent>();
    });

    it('rejects values that omit `codecMessageId` or `payload`', () => {
      // @ts-expect-error — missing required `codecMessageId`, `payload`.
      const _empty: ToolResult<FakeResultPayload> = { kind: 'tool-result' };
      // @ts-expect-error — missing required `payload`.
      const _noPayload: ToolResult<FakeResultPayload> = { kind: 'tool-result', codecMessageId: 'a' };
      const _ok: ToolResult<FakeResultPayload> = {
        kind: 'tool-result',
        codecMessageId: 'a',
        payload: { toolCallId: 't', output: { v: 1 } },
      };
      void _empty;
      void _noPayload;
      void _ok;
    });
  });

  // -------------------------------------------------------------------------
  // ToolResultError
  // -------------------------------------------------------------------------

  describe('ToolResultError', () => {
    interface FakeErrorPayload {
      toolCallId: string;
      message: string;
    }

    it('pins the kind literal to "tool-result-error"', () => {
      expectTypeOf<ToolResultError<FakeErrorPayload>>().toHaveProperty('kind').toEqualTypeOf<'tool-result-error'>();
    });

    it('requires `codecMessageId` (string) and carries the domain `payload`', () => {
      expectTypeOf<ToolResultError<FakeErrorPayload>>().toHaveProperty('codecMessageId').toEqualTypeOf<string>();
      expectTypeOf<ToolResultError<FakeErrorPayload>>().toHaveProperty('payload').toEqualTypeOf<FakeErrorPayload>();
    });

    it('does not expose domain tool fields on the core type', () => {
      // @ts-expect-error — `toolCallId` is carried in `payload`, not on the core variant.
      expectTypeOf<ToolResultError<FakeErrorPayload>>().toHaveProperty('toolCallId');
    });

    it('is assignable to the CodecInputEvent base', () => {
      expectTypeOf<ToolResultError<FakeErrorPayload>>().toExtend<CodecInputEvent>();
    });

    it('rejects values that omit `codecMessageId` or `payload`', () => {
      // @ts-expect-error — missing required fields.
      const _empty: ToolResultError<FakeErrorPayload> = { kind: 'tool-result-error' };
      const _ok: ToolResultError<FakeErrorPayload> = {
        kind: 'tool-result-error',
        codecMessageId: 'a',
        payload: { toolCallId: 't', message: 'failure' },
      };
      void _empty;
      void _ok;
    });
  });

  // -------------------------------------------------------------------------
  // ToolApprovalResponse
  // -------------------------------------------------------------------------

  describe('ToolApprovalResponse', () => {
    interface FakeApprovalPayload {
      toolCallId: string;
      approved: boolean;
      reason?: string;
    }

    it('pins the kind literal to "tool-approval-response"', () => {
      expectTypeOf<ToolApprovalResponse<FakeApprovalPayload>>()
        .toHaveProperty('kind')
        .toEqualTypeOf<'tool-approval-response'>();
    });

    it('requires `codecMessageId` (string) and carries the domain `payload`', () => {
      expectTypeOf<ToolApprovalResponse<FakeApprovalPayload>>()
        .toHaveProperty('codecMessageId')
        .toEqualTypeOf<string>();
      expectTypeOf<ToolApprovalResponse<FakeApprovalPayload>>()
        .toHaveProperty('payload')
        .toEqualTypeOf<FakeApprovalPayload>();
    });

    it('does not expose domain tool fields on the core type', () => {
      // @ts-expect-error — `approved` is carried in `payload`, not on the core variant.
      expectTypeOf<ToolApprovalResponse<FakeApprovalPayload>>().toHaveProperty('approved');
    });

    it('is assignable to the CodecInputEvent base', () => {
      expectTypeOf<ToolApprovalResponse<FakeApprovalPayload>>().toExtend<CodecInputEvent>();
    });

    it('rejects values that omit `codecMessageId` or `payload`', () => {
      // @ts-expect-error — missing required fields.
      const _empty: ToolApprovalResponse<FakeApprovalPayload> = { kind: 'tool-approval-response' };
      const _ok: ToolApprovalResponse<FakeApprovalPayload> = {
        kind: 'tool-approval-response',
        codecMessageId: 'a',
        payload: { toolCallId: 't', approved: false, reason: 'nope' },
      };
      void _empty;
      void _ok;
    });
  });

  // -------------------------------------------------------------------------
  // Payload extractor helpers (used to type Codec.createTool* without extra
  // type parameters)
  // -------------------------------------------------------------------------

  describe('payload extractor helpers', () => {
    interface ResultPayload {
      toolCallId: string;
      output: unknown;
    }
    interface ErrorPayload {
      toolCallId: string;
      message: string;
    }
    interface ApprovalPayload {
      toolCallId: string;
      approved: boolean;
    }
    type FullInput =
      | UserMessage<FakeMessage>
      | Regenerate
      | ToolResult<ResultPayload>
      | ToolResultError<ErrorPayload>
      | ToolApprovalResponse<ApprovalPayload>;
    // A codec union that supports none of the tool variants.
    type ToollessInput = UserMessage<FakeMessage> | Regenerate;

    it('extracts each tool payload from a codec input union that includes the variant', () => {
      expectTypeOf<ToolResultPayloadOf<FullInput>>().toEqualTypeOf<ResultPayload>();
      expectTypeOf<ToolResultErrorPayloadOf<FullInput>>().toEqualTypeOf<ErrorPayload>();
      expectTypeOf<ToolApprovalResponsePayloadOf<FullInput>>().toEqualTypeOf<ApprovalPayload>();
    });

    it('resolves to never when the union omits the variant', () => {
      expectTypeOf<ToolResultPayloadOf<ToollessInput>>().toEqualTypeOf<never>();
      expectTypeOf<ToolResultErrorPayloadOf<ToollessInput>>().toEqualTypeOf<never>();
      expectTypeOf<ToolApprovalResponsePayloadOf<ToollessInput>>().toEqualTypeOf<never>();
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
