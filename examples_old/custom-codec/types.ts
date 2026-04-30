/**
 * Domain types for a custom AI agent codec.
 *
 * A codec is parameterized by two generic types:
 *
 *   Codec<TEvent, TMessage>
 *
 * - TEvent: the individual streaming chunks your server produces (text
 *   deltas, tool calls, lifecycle signals). These are transient — the
 *   encoder maps each one to an Ably operation, and the decoder
 *   reconstructs them on the other side.
 *
 * - TMessage: the complete structured objects your UI consumes. The
 *   accumulator builds these incrementally from the stream of TEvents.
 *
 * When designing your own codec, start here: define what your events
 * and messages look like. The codec machinery handles the rest.
 */

// ---------------------------------------------------------------------------
// TEvent — the streaming chunks the server produces
// ---------------------------------------------------------------------------
//
// Each event type maps to a different Ably operation in the encoder:
//
//   Streamable events (text-delta) → message appends
//     Ably delivers these incrementally. Multiple deltas extend the
//     same Ably message, and the decoder accumulates them.
//
//   Discrete events (tool-call, start, finish) → standalone publishes
//     Each becomes its own Ably message. Complete on arrival.
//
// This split is the core design decision in any codec. Ask yourself:
// "Does this event represent a fragment of something larger (stream it)
//  or a complete unit on its own (publish it discretely)?"
//

/** Start of a new agent response. Discrete — signals the accumulator to create a new message. */
export interface StartEvent {
  type: 'start';
}

/** Incremental text content from the agent. Streamable — appended to an Ably message via message appends. */
export interface TextDeltaEvent {
  type: 'text-delta';
  /** The text fragment to append. */
  delta: string;
}

/** The agent's text stream has finished. Discrete — closes the message stream. */
export interface TextEndEvent {
  type: 'text-end';
}

/**
 * A complete tool call the agent wants to execute. Discrete — published
 * as a standalone Ably message because it arrives complete (not streamed).
 */
export interface ToolCallEvent {
  type: 'tool-call';
  /** Unique identifier for this tool call. */
  toolCallId: string;
  /** Name of the tool to invoke. */
  toolName: string;
  /** Arguments to pass to the tool (parsed JSON). */
  args: Record<string, unknown>;
}

/** The agent response is complete. Discrete — signals the accumulator to finalize the message. */
export interface FinishEvent {
  type: 'finish';
}

/** Union of all streaming events — this is the TEvent for our codec. */
export type AgentEvent = StartEvent | TextDeltaEvent | TextEndEvent | ToolCallEvent | FinishEvent;

// ---------------------------------------------------------------------------
// TMessage — the complete structured objects the UI consumes
// ---------------------------------------------------------------------------
//
// This is what your application works with. The accumulator builds this
// incrementally as events arrive:
//
//   start        → creates a new AgentMessage { text: '', toolCalls: [] }
//   text-delta   → appends delta to message.text
//   tool-call    → pushes a ToolCall to message.toolCalls
//   finish       → marks the message as complete
//
// The key insight: your message type can be as complex as you need.
// Text and tool calls live side by side in a single object — the codec
// handles streaming the text part while delivering tool calls discretely.
//

/** A tool call within a completed agent message. */
export interface ToolCall {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
}

/**
 * A complete agent message containing both text and tool calls.
 *
 * This is the structured object that the UI renders. The codec's
 * accumulator builds it incrementally as streaming events arrive —
 * text grows as deltas are appended, tool calls appear as discrete
 * events are received.
 */
export interface AgentMessage {
  /** Unique message identifier. */
  id: string;
  /** Role of the message sender. */
  role: 'user' | 'assistant';
  /** The agent's text response (accumulated from text-delta events). */
  text: string;
  /** Tool calls the agent requested (accumulated from tool-call events). */
  toolCalls: ToolCall[];
}
