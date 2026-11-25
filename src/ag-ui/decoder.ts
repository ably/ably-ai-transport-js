import type * as AGUI from '@ag-ui/core';

import { createDecoder, type Decoder, type DecoderOptions } from '../core/decoder/index.js';
import { agui } from './codec/index.js';

/**
 * Create a decoder for what an agent published through the AG-UI codec. Merge
 * the events it delivers with AG-UI's own reducer.
 * @param options - See {@link DecoderOptions}.
 * @returns The decoder.
 */
export const agUiDecoder = (options?: DecoderOptions): Decoder<AGUI.Event> => createDecoder(agui, options);
