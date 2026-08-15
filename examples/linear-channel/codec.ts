/**
 * Thin codec. Maps AG-UI / Vercel names onto Pub/Sub stamps.
 * No tree. No extras.ai. Identity is stubbed until realtime POC D.
 */
import { HEADER_RETRY_IDENTITY, HEADER_SPANS, HEADER_STREAM_STATUS, type LinearMessage } from './linear.ts';

export type CodecSource = 'ag-ui' | 'vercel';

export interface CodecStamp {
  action: 'create' | 'append' | 'status';
  data?: string;
  streamStatus?: 'open' | 'complete' | 'stopped';
  retryIdentity?: string;
  spans?: string[];
}

/**
 * Map one vendor event onto stamps. Unknown names return undefined.
 * @param source Vendor event source.
 * @param name Event name.
 * @param payload Optional ids and token text.
 * @returns Stamp, or undefined if the name is unknown.
 */
export const mapEvent = (
  source: CodecSource,
  name: string,
  payload: Record<string, string> = {},
): CodecStamp | undefined => {
  if (source === 'vercel') {
    switch (name) {
      case 'text-start': {
        return {
          action: 'create',
          data: '',
          streamStatus: 'open',
          retryIdentity: payload.id,
          spans: spanList(payload),
        };
      }
      case 'text-delta': {
        return { action: 'append', data: payload.delta ?? '', streamStatus: 'open' };
      }
      case 'text-end':
      case 'finish': {
        return { action: 'status', streamStatus: 'complete' };
      }
      default: {
        return undefined;
      }
    }
  }

  switch (name) {
    case 'RUN_STARTED': {
      return { action: 'create', data: '', streamStatus: 'open', spans: spanList(payload) };
    }
    case 'TEXT_MESSAGE_CONTENT': {
      return { action: 'append', data: payload.delta ?? payload.content ?? '', streamStatus: 'open' };
    }
    case 'TEXT_MESSAGE_END':
    case 'RUN_FINISHED': {
      return { action: 'status', streamStatus: 'complete' };
    }
    case 'STEP_STARTED': {
      return { action: 'create', data: '', streamStatus: 'open', spans: spanList(payload) };
    }
    case 'RUN_ERROR': {
      return { action: 'status', streamStatus: 'stopped' };
    }
    default: {
      return undefined;
    }
  }
};

/**
 * Build extras.headers from a stamp.
 * @param stamp Codec stamp.
 * @returns Header map for extras.
 */
export const headersFromStamp = (stamp: CodecStamp): Record<string, string> => {
  const headers: Record<string, string> = {};
  if (stamp.streamStatus) {
    headers[HEADER_STREAM_STATUS] = stamp.streamStatus;
  }
  if (stamp.retryIdentity) {
    headers[HEADER_RETRY_IDENTITY] = stamp.retryIdentity;
  }
  if (stamp.spans && stamp.spans.length > 0) {
    headers[HEADER_SPANS] = stamp.spans.join(',');
  }
  return headers;
};

/**
 * Build a linear message from a stamp.
 * @param stamp Codec stamp.
 * @returns Linear message.
 */
export const messageFromStamp = (stamp: CodecStamp): LinearMessage => {
  const action = stamp.action === 'append' ? 'message.append' : 'message.create';
  return {
    data: stamp.data ?? '',
    action,
    extras: { headers: headersFromStamp(stamp) },
  };
};

/**
 * Collect run / step ids as overlapping spans.
 * @param payload Vendor payload.
 * @returns Span ids, if any.
 */
const spanList = (payload: Record<string, string>): string[] | undefined => {
  const spans = [payload.runId, payload.stepId, payload.span].filter(Boolean);
  return spans.length > 0 ? spans : undefined;
};
