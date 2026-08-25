/**
 * Deterministic mock model for the e2e tests — no API key, no network.
 *
 * Produces a hand-built `ResponseStreamEvent` stream scripted from the
 * conversation input, in the same event shape a real `/responses` stream uses.
 * A text reply streams as `output_item.added` (message) → `content_part.added`
 * → `output_text.delta`* → `output_text.done` → `output_item.done`. A weather
 * prompt instead emits a `getWeather` function call as `output_item.added`
 * (function_call, args empty) → `function_call_arguments.delta`* → `.done` →
 * `output_item.done` (function_call, full args): the agentic loop runs the tool
 * and calls the mock again, now with the tool result in the input, so the second
 * turn returns a text reply. A location prompt emits the client-executed
 * `getLocation` call (the run suspends until the browser answers) and a forecast
 * prompt emits the approval-gated `getWeatherForecast` call (the run suspends for
 * the user's decision) — each replies with a sentence on the loop's second turn,
 * a forecast prompt acknowledging instead when the call was denied. A forecast
 * prompt naming two places ("Paris and London") emits one gated call per place, so
 * a single turn suspends on two decisions. A
 * "think"/"reason" prompt streams a reasoning item
 * (its summary) first — ahead of a text reply, or ahead of the getWeather call
 * when the prompt is also about weather — which is the case that exercises the
 * loop feeding reasoning items back alongside the call. Response-lifecycle
 * events (`response.created` / `response.completed`) are omitted: the codec
 * drops them from the wire and the stream's terminal is the item-done.
 *
 * Wired in by `createResponseStream()` (model.ts) behind `MOCK_LLM`.
 */

import type { Responses } from 'openai/resources/responses/responses';

import type { ResponseStreamRequest } from './model';

type ResponseStreamEvent = Responses.ResponseStreamEvent;

/** A long, multi-sentence reply streamed slowly so the cancel test can interrupt it. */
const LONG_STORY =
  'Once upon a time, in a valley wrapped in morning mist, there lived a young dragon who had never learned to ' +
  'breathe fire. Every dawn she climbed the tallest pine and practised, huffing little clouds of warm air that ' +
  'drifted away on the breeze. The other dragons laughed, but she kept climbing, kept trying, and kept believing ' +
  'that one day a spark would catch. And so the seasons turned, and her patience grew as steadily as her wings.';

type ReplyPlan =
  | {
      /** A streamed text reply. */
      kind: 'text';
      /** The full reply text. */
      text: string;
      /** Whether to stream it slowly in many deltas (abort-aware) for the cancel scenario. */
      slow: boolean;
      /** Optional reasoning-summary "thinking" streamed as a reasoning item before the reply. */
      reasoning?: string;
    }
  | {
      /** One or more function calls emitted in a single turn. */
      kind: 'tool';
      /** The calls to emit, in order. A turn may call the same tool more than once. */
      calls: { name: string; args: Record<string, unknown> }[];
      /** Optional reasoning-summary "thinking" streamed as a reasoning item before the calls. */
      reasoning?: string;
    };

/** Read the most recent user message's text from the model input. */
function lastUserText(input: Responses.ResponseInputItem[]): string {
  for (let i = input.length - 1; i >= 0; i--) {
    const item = input[i];
    if (item.type !== 'message' || item.role !== 'user') continue;
    const content = item.content;
    if (typeof content === 'string') return content;
    let text = '';
    for (const part of content) {
      if (part.type === 'input_text') text += part.text;
    }
    return text;
  }
  return '';
}

/**
 * The outputs of every answered call to the named tool — the
 * `function_call_output` text of each `function_call` with that name whose output
 * is present — in call order. Empty when the tool has not been called, or has been
 * called but not answered. Lets the mock tell which tool's results drive the
 * loop's second turn (a conversation can hold several tools, and one turn can call
 * the same tool for several locations) and read each output.
 */
function answeredCallOutputs(input: Responses.ResponseInputItem[], name: string): string[] {
  const callIds: string[] = [];
  for (const item of input) {
    if (item.type === 'function_call' && item.name === name) callIds.push(item.call_id);
  }
  const outputs = new Map<string, string>();
  for (const item of input) {
    if (item.type !== 'function_call_output' || !callIds.includes(item.call_id)) continue;
    outputs.set(item.call_id, typeof item.output === 'string' ? item.output : JSON.stringify(item.output));
  }
  return callIds.flatMap((callId) => {
    const output = outputs.get(callId);
    return output === undefined ? [] : [output];
  });
}

/** Pull a place name out of a "weather in/for <place>?" prompt, defaulting to London. */
function extractLocation(text: string): string {
  const match = /\b(?:in|for|at)\s+([A-Za-z][A-Za-z .,'-]*?)\s*[?.!]?$/.exec(text.trim());
  return match ? match[1].trim() : 'London, UK';
}

/**
 * The place names in a prompt, splitting an "X and Y" phrase into one entry each.
 * A prompt naming two places is how the demo drives a turn that emits two calls.
 */
function extractLocations(text: string): string[] {
  return extractLocation(text)
    .split(/\s+and\s+/i)
    .map((place) => place.trim())
    .filter((place) => place.length > 0);
}

/** The `location` a forecast tool result was for, or undefined if the output isn't one. */
function forecastLocation(output: string): string | undefined {
  try {
    // CAST: trust boundary — the tool output is parsed JSON.
    const parsed = JSON.parse(output) as { location?: unknown; forecast?: unknown };
    if (!Array.isArray(parsed.forecast)) return undefined;
    return typeof parsed.location === 'string' ? parsed.location : undefined;
  } catch {
    return undefined;
  }
}

/** Script the reply from the conversation, mirroring the prompts the e2e suite sends. */
function planReply(input: Responses.ResponseInputItem[]): ReplyPlan {
  const prompt = lastUserText(input);

  const say = /say\s+"([^"]+)"/i.exec(prompt);
  if (say) return { kind: 'text', text: say[1], slow: false };

  const word = /\bword\s+([A-Za-z]+)/i.exec(prompt);
  if (word) return { kind: 'text', text: word[1], slow: false };

  // Forecast (approval-gated server tool): call getWeatherForecast for each place
  // named, then suspend for the user's decisions. A prompt naming two places emits
  // two gated calls in one turn, and the client only resumes the run once both are
  // decided. On the loop's second turn the outputs are present — the tool's JSON
  // forecast for each approved call (the ForecastCard renders it), or a rejection
  // string for a denied one (acknowledge instead). Checked before plain weather,
  // since a forecast prompt also says "weather".
  if (/\bforecast\b/i.test(prompt)) {
    const outputs = answeredCallOutputs(input, 'getWeatherForecast');
    if (outputs.length > 0) {
      const places = outputs.flatMap((output) => {
        const place = forecastLocation(output);
        return place === undefined ? [] : [place];
      });
      return places.length === 0
        ? { kind: 'text', text: 'No problem, I will not fetch the forecast.', slow: false }
        : { kind: 'text', text: `Here is the 5-day forecast for ${places.join(' and ')}.`, slow: false };
    }
    return {
      kind: 'tool',
      calls: extractLocations(prompt).map((location) => ({ name: 'getWeatherForecast', args: { location } })),
    };
  }

  // Location (client-executed tool): call getLocation first; the run suspends
  // while the browser resolves geolocation. Once the client's result is in the
  // input (the loop's second turn), reply with a sentence.
  if (/\b(location|where\s+am\s+i|where\s+i\s+am)\b/i.test(prompt)) {
    if (answeredCallOutputs(input, 'getLocation').length > 0) {
      return { kind: 'text', text: 'Here is your current location.', slow: false };
    }
    return { kind: 'tool', calls: [{ name: 'getLocation', args: { highAccuracy: false } }] };
  }

  // Weather: call getWeather first; once its result is in the input (the loop's
  // second turn), reply with a sentence. The WeatherCard renders the structured
  // tool output alongside this text.
  if (/\bweather\b/i.test(prompt)) {
    if (answeredCallOutputs(input, 'getWeather').length > 0) {
      return { kind: 'text', text: `Here is the current weather for ${extractLocation(prompt)}.`, slow: false };
    }
    // A "think"/"reason" weather prompt streams a reasoning item before the
    // function_call, mirroring a reasoning model that "thinks" then calls a
    // tool. This is the case that exercises the agent loop feeding reasoning
    // items back alongside the call on the next turn.
    const reasoning = /\b(think|reason)\b/i.test(prompt)
      ? 'The answer needs current conditions, so I should call the weather tool for that location.'
      : undefined;
    return {
      kind: 'tool',
      calls: [{ name: 'getWeather', args: { location: extractLocation(prompt) } }],
      ...(reasoning === undefined ? {} : { reasoning }),
    };
  }

  if (/\b(story|dragon)\b/i.test(prompt) || /\blong\b/i.test(prompt)) {
    return { kind: 'text', text: LONG_STORY, slow: true };
  }

  // A "think"/"reason" prompt streams a reasoning summary before the reply, so
  // the demo shows the model's "thinking". Always on for the mock — it burns no
  // real tokens; the real model gates the same behaviour behind SHOW_REASONING
  // (and needs no keyword).
  if (/\b(think|reason)\b/i.test(prompt)) {
    return {
      kind: 'text',
      text: 'Weighing three groups of four narrows it to one suspect in three moves.',
      slow: false,
      reasoning: 'Split the 12 balls into three groups of four and compare two groups on the balance.',
    };
  }

  const marker = /marker\s+([^\s.]+)/i.exec(prompt);
  if (marker) return { kind: 'text', text: `Acknowledged the marker ${marker[1]}.`, slow: false };

  return { kind: 'text', text: `Mock reply to: ${prompt || '(empty prompt)'}`, slow: false };
}

/** Split text into ~2-word delta pieces, preserving the original spacing. */
function chunkWords(text: string): string[] {
  const words = text.split(' ');
  const pieces: string[] = [];
  for (let i = 0; i < words.length; i += 2) {
    const trailingSpace = i + 2 < words.length ? ' ' : '';
    pieces.push(words.slice(i, i + 2).join(' ') + trailingSpace);
  }
  return pieces;
}

/**
 * Yield a reasoning item ahead of a reply — its `output_item.added`, the
 * summary stream (part.added → text.delta* → text.done), then the
 * `output_item.done` carrying the complete summary. Used before both a text
 * reply and a function_call, so the mock can stream "thinking" ahead of either.
 * @param text - The reasoning summary text to stream.
 * @param next - The stream's sequence-number allocator.
 */
function* reasoningEvents(text: string, next: () => number): Generator<ResponseStreamEvent> {
  const reasoningId = crypto.randomUUID();
  const reasoning = (summary: Responses.ResponseReasoningItem['summary']): Responses.ResponseReasoningItem => ({
    id: reasoningId,
    type: 'reasoning',
    summary,
  });
  yield {
    type: 'response.output_item.added',
    item: reasoning([]),
    output_index: 0,
    sequence_number: next(),
  };
  yield {
    type: 'response.reasoning_summary_part.added',
    item_id: reasoningId,
    output_index: 0,
    summary_index: 0,
    part: { type: 'summary_text', text: '' },
    sequence_number: next(),
  };
  for (const delta of chunkWords(text)) {
    yield {
      type: 'response.reasoning_summary_text.delta',
      item_id: reasoningId,
      output_index: 0,
      summary_index: 0,
      delta,
      sequence_number: next(),
    };
  }
  yield {
    type: 'response.reasoning_summary_text.done',
    item_id: reasoningId,
    output_index: 0,
    summary_index: 0,
    text,
    sequence_number: next(),
  };
  yield {
    type: 'response.output_item.done',
    item: reasoning([{ type: 'summary_text', text }]),
    output_index: 0,
    sequence_number: next(),
  };
}

/** Resolve after `ms`, or immediately once `signal` aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * The mock `ResponseStreamEvent` stream for a request, as an async generator.
 * Streams the reply as a single assistant message item; returns early (a clean
 * end) if the run's signal aborts mid-stream, which the cancel test relies on.
 */
export async function* createMockResponseStream(req: ResponseStreamRequest): AsyncGenerator<ResponseStreamEvent> {
  const plan = planReply(req.input);
  const { signal } = req;
  const itemId = crypto.randomUUID();
  let seq = 0;
  const next = (): number => seq++;

  const message = (
    status: Responses.ResponseOutputMessage['status'],
    content: Responses.ResponseOutputMessage['content'],
  ): Responses.ResponseOutputMessage => ({ id: itemId, type: 'message', role: 'assistant', status, content });

  if (plan.kind === 'tool') {
    // A reasoning model may "think" before deciding to call a tool: stream the
    // reasoning item first, then the function_call. The agent loop must feed this
    // reasoning item back alongside the call on the next turn.
    if (plan.reasoning !== undefined) yield* reasoningEvents(plan.reasoning, next);

    // Each call is its own output item, with its own id and output_index — the
    // shape a real turn calling one tool for two locations produces.
    for (const [index, planned] of plan.calls.entries()) {
      const callItemId = `${itemId}-${index}`;
      const call = (
        status: Responses.ResponseFunctionToolCall['status'],
        args: string,
      ): Responses.ResponseFunctionToolCall => ({
        id: callItemId,
        type: 'function_call',
        call_id: `call-${callItemId}`,
        name: planned.name,
        arguments: args,
        status,
      });
      const argsJson = JSON.stringify(planned.args);
      // Split the arguments into a couple of fragments so the mock streams them the
      // way a real model does (output_item.added → arg deltas → arg done → item done).
      const mid = Math.ceil(argsJson.length / 2);
      const argFragments = [argsJson.slice(0, mid), argsJson.slice(mid)];
      // output_item.added opens the function_call_arguments stream (args empty);
      // the deltas stream the arguments; the done finalises them; output_item.done
      // carries the complete item. The agentic loop reads the call off `done`.
      yield {
        type: 'response.output_item.added',
        item: call('in_progress', ''),
        output_index: index,
        sequence_number: next(),
      };
      for (const delta of argFragments) {
        yield {
          type: 'response.function_call_arguments.delta',
          item_id: callItemId,
          output_index: index,
          delta,
          sequence_number: next(),
        };
      }
      yield {
        type: 'response.function_call_arguments.done',
        item_id: callItemId,
        output_index: index,
        arguments: argsJson,
        name: planned.name,
        sequence_number: next(),
      };
      yield {
        type: 'response.output_item.done',
        item: call('completed', argsJson),
        output_index: index,
        sequence_number: next(),
      };
    }
    return;
  }

  // Optional reasoning summary streamed as a reasoning item before the reply
  // (its own item id, so it merges beside the message).
  if (plan.reasoning !== undefined) yield* reasoningEvents(plan.reasoning, next);

  yield {
    type: 'response.output_item.added',
    item: message('in_progress', []),
    output_index: 0,
    sequence_number: next(),
  };
  yield {
    type: 'response.content_part.added',
    item_id: itemId,
    output_index: 0,
    content_index: 0,
    part: { type: 'output_text', text: '', annotations: [] },
    sequence_number: next(),
  };

  const pieces = plan.slow ? chunkWords(plan.text) : [plan.text];
  for (const delta of pieces) {
    if (signal.aborted) return;
    yield {
      type: 'response.output_text.delta',
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      delta,
      logprobs: [],
      sequence_number: next(),
    };
    if (plan.slow) await sleep(120, signal);
  }

  if (signal.aborted) return;
  yield {
    type: 'response.output_text.done',
    item_id: itemId,
    output_index: 0,
    content_index: 0,
    text: plan.text,
    logprobs: [],
    sequence_number: next(),
  };
  yield {
    type: 'response.output_item.done',
    item: message('completed', [{ type: 'output_text', text: plan.text, annotations: [] }]),
    output_index: 0,
    sequence_number: next(),
  };
}
