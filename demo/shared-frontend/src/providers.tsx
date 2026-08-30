'use client';

import { createSessionHooks } from '@ably/ai-transport/react';
import type { VercelOutput, VercelProjection, VercelSessionInput } from '@ably/ai-transport/vercel';
import type * as AI from 'ai';

/**
 * The session hooks the shared UI is built against, bound to the Vercel codec's
 * types. A demo on another codec builds its own hooks from its own codec types
 * and pairs them with the codec-agnostic `Providers` in `./ably-provider` and
 * `ThemeProvider` in `./theme-provider`.
 */
export const SessionHooks = createSessionHooks<VercelSessionInput, VercelOutput, VercelProjection, AI.UIMessage>();
