/**
 * The tools Claude can call. `web_search` is a server tool: Anthropic runs it
 * inside the request, and its results arrive in the reply. The others are
 * this app's own: Claude only asks for them, and the route runs them once the
 * user has approved the call. A reply that calls one ends the turn, the page
 * shows the call with Approve and Deny, and the user's answers come back to
 * the route, which runs the approved calls and sends Claude every result.
 */

import type {
  MessageParam,
  Tool,
  ToolResultBlockParam,
  ToolUnion,
  ToolUseBlockParam,
} from '@anthropic-ai/sdk/resources/messages';

/** One of the app's own tools: what Claude is told about it, and the code that runs it. */
interface AppTool {
  definition: Tool;
  run: (input: unknown) => string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** The demo's stand-in for a weather service: a made-up reading, so the demo needs no weather API. */
const weatherFor = (input: unknown): string => {
  const city = isRecord(input) && typeof input.city === 'string' ? input.city : 'unknown';

  return JSON.stringify({ city, temperature_c: 12 + (city.length % 12), conditions: 'partly cloudy' });
};

const appTools: AppTool[] = [
  {
    definition: {
      name: 'get_weather',
      description: 'Get the current weather for a city.',
      input_schema: {
        type: 'object',
        properties: { city: { type: 'string', description: 'The city name' } },
        required: ['city'],
      },
    },
    run: weatherFor,
  },
];

/** What every request tells Claude it may call. */
export const tools: ToolUnion[] = [
  { type: 'web_search_20260318', name: 'web_search', max_uses: 3 },
  ...appTools.map((tool) => tool.definition),
];

/**
 * The calls waiting for the user: the `tool_use` blocks of the last message
 * in the conversation, when it is a reply. A call in any earlier message has
 * already been answered, since the Messages API needs every `tool_use`
 * answered in the next message.
 * @param last - The last message of the stored conversation.
 * @returns The calls waiting for an answer, empty when there are none.
 */
export const pendingCalls = (last: MessageParam | undefined): ToolUseBlockParam[] =>
  last?.role === 'assistant' && Array.isArray(last.content)
    ? last.content.filter((block) => block.type === 'tool_use')
    : [];

/**
 * The result of one call, as Claude reads it: the tool's output when the
 * user approved the call, or an error result when they refused it, the app
 * has no such tool, or the tool threw, so Claude knows it did not run.
 * @param call - The call to answer.
 * @param approved - Whether the user approved it.
 * @returns The call's `tool_result` block.
 */
const resultFor = (call: ToolUseBlockParam, approved: boolean): ToolResultBlockParam => {
  const error = (content: string): ToolResultBlockParam => ({
    type: 'tool_result',
    tool_use_id: call.id,
    content,
    is_error: true,
  });

  if (!approved) return error('The user declined this tool call.');

  const tool = appTools.find((t) => t.definition.name === call.name);
  if (tool === undefined) return error(`There is no tool named ${call.name}.`);

  try {
    return { type: 'tool_result', tool_use_id: call.id, content: tool.run(call.input) };
  } catch (cause) {
    return error(`The tool failed: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
};

/**
 * Answer every pending call with the user's decision. The answers come from
 * the browser, so a set that misses a pending call, or answers one with
 * anything but a boolean, is refused rather than guessed at.
 * @param calls - The calls waiting for the user.
 * @param approvals - The user's answer to each call, by tool use id, as the browser sent it.
 * @returns One result per call, in call order, or `undefined` when there is
 * nothing to answer or an answer is missing.
 */
export const answerCalls = (calls: ToolUseBlockParam[], approvals: unknown): ToolResultBlockParam[] | undefined => {
  if (calls.length === 0 || !isRecord(approvals)) return undefined;

  const results: ToolResultBlockParam[] = [];
  for (const call of calls) {
    const approved = approvals[call.id];
    if (typeof approved !== 'boolean') return undefined;

    results.push(resultFor(call, approved));
  }

  return results;
};
