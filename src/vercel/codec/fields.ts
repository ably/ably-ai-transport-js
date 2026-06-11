/**
 * Shared Vercel codec header-field bindings.
 *
 * Each field binds a codec header key to its value type once (see
 * {@link HeaderField}); the output/input descriptors and escape hatches all
 * read and write through these bindings, so a header key cannot drift between
 * the encode and decode side. Domain field names live in the Vercel layer, not
 * core, per the header-discipline rule.
 */

import type * as AI from 'ai';

import { boolField, enumField, type HeaderField, jsonField, strField } from '../../core/codec/index.js';

/** Stream / message id (text & reasoning streams). */
export const fId = strField('id');
/**
 * Provider metadata envelope, typed to the AI SDK shape. Annotated explicitly:
 * the inferred type resolves to the AI SDK's internal `SharedV3ProviderMetadata`
 * alias, which isn't portably nameable across the package boundary.
 */
export const fMeta: HeaderField<AI.ProviderMetadata | undefined, 'providerMetadata'> = jsonField<
  AI.ProviderMetadata,
  'providerMetadata'
>('providerMetadata');
/** Tool call id — defaulted to total: an absent header reads as `''`. */
export const fToolCallId = strField('toolCallId', '');
/** Tool name — defaulted to total. */
export const fToolName = strField('toolName', '');
/** Whether the tool is a dynamic tool. */
export const fDynamic = boolField('dynamic');
/** Optional human-readable title. */
export const fTitle = strField('title');
/** Whether the provider executed the tool. */
export const fProviderExecuted = boolField('providerExecuted');
/** Media type for file / source-document parts — defaulted to total. */
export const fMediaType = strField('mediaType', '');
/** Source id for source-url / source-document parts — defaulted to total. */
export const fSourceId = strField('sourceId', '');

// --- input-side bindings (shared by the input descriptors' encode/decode) ---

/** Domain message id (`message.id`) stamped on every user-message part — distinct from the wire codec-message-id transport header. */
export const fMessageId = strField('messageId');
/** Whether the user approved a tool execution — defaulted to total so an absent header reads `false`. */
export const fApproved = boolField('approved', false);
/** Optional human-readable reason on a tool-approval response. */
export const fReason = strField('reason');

/**
 * Validated finish reason. Mirrors the AI SDK's `FinishReason` literals and
 * falls back to `'stop'` for an absent or unrecognized value.
 */
export const fFinishReason = enumField(
  'finishReason',
  ['stop', 'length', 'content-filter', 'tool-calls', 'error', 'other'] as const,
  'stop',
);
