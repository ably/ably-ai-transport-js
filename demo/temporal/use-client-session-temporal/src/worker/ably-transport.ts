/**
 * The configured SDK plugin, in its own module so both halves of the worker can
 * import it.
 *
 * `index.ts` needs it for `Worker.create({ plugins })`, and `activities.ts` needs
 * it for `ablyTransport.activity(...)`. `index.ts` already imports
 * `activities.ts`, so building the plugin there would make the dependency
 * circular. Here it is a leaf.
 *
 * One plugin means one codec and one pool of Ably connections shared by every
 * activity on this worker, the SDK's framing activities included.
 */

import { createAblyTransportPlugin } from '@ably/ai-transport/temporal';
import { createUIMessageCodec } from '@ably/ai-transport/vercel';

import { logger, makeAbly } from './ably.js';

export const ablyTransport = createAblyTransportPlugin({
  codec: createUIMessageCodec(),
  createClient: makeAbly,
  logger,
});
