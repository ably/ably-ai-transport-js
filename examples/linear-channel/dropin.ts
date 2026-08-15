/**
 * Drop-in request path. Their POST. Channel write only after accept.
 */
import { acceptAndPublish, HEADER_STREAM_STATUS, HEADER_TURN_ID, type LinearMessage } from './linear.ts';

export interface ChatRequest {
  text?: string;
  /** Test hook. Real servers use their own auth. */
  accepted?: boolean;
  /** REST idempotency key for the user bubble. Not retry identity. */
  id?: string;
}

export interface ChatResult {
  status: number;
  error?: string;
  /** Messages the server would publish. Undefined if the POST was rejected. */
  publish?: LinearMessage[];
}

const seenUserIds = new Set<string>();

/** Reset ingress dedup. Tests only. */
export const resetDropin = (): void => {
  seenUserIds.clear();
};

/**
 * Handle their POST /chat. Rejected or empty bodies do not publish.
 * @param body Chat request body.
 * @returns Status and optional publish plan.
 */
export const handleChatPost = (body: ChatRequest): ChatResult => {
  const text = (body.text ?? '').trim();
  if (!text) {
    return { status: 400, error: 'empty' };
  }
  if (body.accepted === false) {
    return { status: 401, error: 'rejected' };
  }

  if (body.id) {
    if (seenUserIds.has(body.id)) {
      return { status: 200, publish: [] };
    }
    seenUserIds.add(body.id);
  }

  const user = acceptAndPublish(true, { data: text, turnId: 'user' });
  if (!user) {
    return { status: 401, error: 'rejected' };
  }
  if (body.id) {
    user.id = body.id;
  }

  const assistant: LinearMessage = {
    data: '',
    action: 'message.create',
    extras: { headers: { [HEADER_TURN_ID]: 'assistant', [HEADER_STREAM_STATUS]: 'open' } },
  };

  return { status: 200, publish: [user, assistant] };
};
