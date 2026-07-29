'use client';

import { createSessionHooks } from '@ably/ai-transport/react';
import type { OpenAIInput, OpenAIOutput, OpenAIProjection, OpenAIMessage } from '@ably/ai-transport/openai';

/**
 * The session hooks this demo is built against, bound to the OpenAI Responses
 * codec's types. The Ably client and provider they run under are codec-agnostic,
 * so they come from the shared frontend's `Providers`.
 */
export const SessionHooks = createSessionHooks<OpenAIInput, OpenAIOutput, OpenAIProjection, OpenAIMessage>();
