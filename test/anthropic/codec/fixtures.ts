/**
 * Messages API streams for a two-turn conversation: Claude thinks and calls a
 * tool, then searches the web and answers with a citation. Shared by the
 * Anthropic codec's unit and integration suites.
 */

import type * as Anthropic from '@anthropic-ai/sdk/resources/messages';

import type { AnthropicEvent } from '../../../src/anthropic/index.js';

// eslint-disable-next-line unicorn/no-null -- the SDK types an absent field as null, as the API sends it
const absent = null;

const usage: Anthropic.Usage = {
  cache_creation: absent,
  cache_creation_input_tokens: absent,
  cache_read_input_tokens: absent,
  inference_geo: absent,
  input_tokens: 12,
  output_tokens: 1,
  output_tokens_details: absent,
  server_tool_use: absent,
  service_tier: 'standard',
  speed: absent,
};

/**
 * A Message as `message_start` opens it, with no content yet.
 * @param id - The Message id.
 * @returns The Message.
 */
export const openedMessage = (id: string): Anthropic.Message => ({
  id,
  type: 'message',
  role: 'assistant',
  model: 'claude-sonnet-5-5',
  content: [],
  container: absent,
  diagnostics: absent,
  stop_details: absent,
  stop_reason: absent,
  stop_sequence: absent,
  usage,
});

/**
 * The `message_delta` that says how a Message stopped.
 * @param stopReason - Why the Message stopped.
 * @param outputTokens - The Message's output tokens.
 * @returns The event.
 */
const stopped = (stopReason: Anthropic.StopReason, outputTokens: number): AnthropicEvent => ({
  type: 'message_delta',
  delta: { container: absent, stop_details: absent, stop_reason: stopReason, stop_sequence: absent },
  usage: {
    cache_creation_input_tokens: absent,
    cache_read_input_tokens: absent,
    input_tokens: absent,
    output_tokens: outputTokens,
    output_tokens_details: absent,
    server_tool_use: absent,
  },
});

const direct: Anthropic.DirectCaller = { type: 'direct' };

/** A text block as its `content_block_start` opens it. */
export const emptyText: Anthropic.TextBlock = { type: 'text', text: '', citations: absent };

/**
 * Claude thinks, says what it will do and calls `get_weather`. The thinking
 * block ends with its signature, and the tool input starts with an empty
 * delta, as the API sends it.
 */
export const toolTurn: AnthropicEvent[] = [
  { type: 'message_start', message: openedMessage('msg_1') },
  { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'The user wants ' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'the weather.' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'EqQBCkYIBxgCKkA=' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: emptyText },
  { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Let me check ' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'London.' } },
  { type: 'content_block_stop', index: 1 },
  {
    type: 'content_block_start',
    index: 2,
    content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: {}, caller: direct },
  },
  { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '' } },
  { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"city":' } },
  { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: ' "London"}' } },
  { type: 'content_block_stop', index: 2 },
  stopped('tool_use', 42),
  { type: 'message_stop' },
];

/** The tool's result, as the client sends it back to start the next turn. */
export const toolResult: Anthropic.MessageParam[] = [
  {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '{"temperature_c":12}' }],
  },
];

/** The citation the search turn's answer carries. */
export const citation: Anthropic.CitationsWebSearchResultLocation = {
  type: 'web_search_result_location',
  cited_text: '12°C and cloudy',
  url: 'https://example.com/london',
  title: 'London weather',
  encrypted_index: 'Eo8C',
};

/**
 * Claude's thinking comes back redacted, it searches the web with a server
 * tool, and answers with a citation between two text deltas. The redacted
 * thinking and the search result do not stream: each arrives whole in its
 * `content_block_start`.
 */
export const searchTurn: AnthropicEvent[] = [
  { type: 'message_start', message: openedMessage('msg_2') },
  { type: 'content_block_start', index: 0, content_block: { type: 'redacted_thinking', data: 'EmwKAhgBEgy3va' } },
  { type: 'content_block_stop', index: 0 },
  {
    type: 'content_block_start',
    index: 1,
    content_block: { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: {}, caller: direct },
  },
  {
    type: 'content_block_delta',
    index: 1,
    delta: { type: 'input_json_delta', partial_json: '{"query": "London weather"}' },
  },
  { type: 'content_block_stop', index: 1 },
  {
    type: 'content_block_start',
    index: 2,
    content_block: {
      type: 'web_search_tool_result',
      tool_use_id: 'srvtoolu_1',
      caller: direct,
      content: [
        {
          type: 'web_search_result',
          title: 'London weather',
          url: 'https://example.com/london',
          encrypted_content: 'Eo8B',
          page_age: absent,
        },
      ],
    },
  },
  { type: 'content_block_stop', index: 2 },
  { type: 'content_block_start', index: 3, content_block: emptyText },
  { type: 'content_block_delta', index: 3, delta: { type: 'text_delta', text: 'It is 12°C ' } },
  { type: 'content_block_delta', index: 3, delta: { type: 'citations_delta', citation } },
  { type: 'content_block_delta', index: 3, delta: { type: 'text_delta', text: 'and cloudy.' } },
  { type: 'content_block_stop', index: 3 },
  stopped('end_turn', 30),
  { type: 'message_stop' },
];

/**
 * The event at `index`, for a fixture the suite knows the length of.
 * @param events - The events.
 * @param index - The position.
 * @returns The event.
 */
export const at = (events: AnthropicEvent[], index: number): AnthropicEvent => {
  const event = events[index];
  if (event === undefined) throw new Error(`no event at ${String(index)}`);

  return event;
};
