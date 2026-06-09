/**
 * Shared Vercel codec header-field bindings.
 *
 * Each field binds a codec header key to its value type once (see PR-1
 * {@link HeaderField}); the output/input descriptors and escape hatches all
 * read and write through these bindings, so a header key cannot drift between
 * the encode and decode side. Domain field names live in the Vercel layer, not
 * core, per the header-discipline rule.
 */

import type * as AI from 'ai';

import { boolField, enumField, type HeaderField, jsonField, strField } from '../../core/codec/fields.js';

/** Stream / message id (text & reasoning streams). */
export const fId = strField('id');
/**
 * Provider metadata envelope, typed to the AI SDK shape. Annotated explicitly:
 * the inferred type resolves to the AI SDK's internal `SharedV3ProviderMetadata`
 * alias, which isn't portably nameable across the package boundary.
 */
export const fMeta: HeaderField<AI.ProviderMetadata | undefined> = jsonField<AI.ProviderMetadata>('providerMetadata');
/** Tool call id — defaulted to total so reads mirror the codec's `strOr(key, '')`. */
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

/**
 * Validated finish reason. Mirrors the AI SDK's `FinishReason` literals and
 * falls back to `'stop'` for an absent or unrecognized value — preserving the
 * decoder's `parseFinishReason` behaviour.
 */
export const fFinishReason = enumField(
  'finishReason',
  ['stop', 'length', 'content-filter', 'tool-calls', 'error', 'other'] as const,
  'stop',
);
