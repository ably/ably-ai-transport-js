/**
 * Custom codec for structured AI agent responses.
 *
 * A codec implements the Codec<TEvent, TMessage> interface and provides
 * three factories:
 *
 *   createEncoder  — maps domain events to Ably channel operations
 *   createDecoder  — maps Ably messages back to domain events
 *   createAccumulator — assembles domain events into complete messages
 *
 * You don't implement the Ably wire protocol yourself. Instead, you use
 * two building blocks provided by the SDK:
 *
 *   createEncoderCore(channel) — handles message append lifecycle
 *     (publish, append, close, abort, flush, recovery)
 *
 *   createDecoderCore(hooks) — handles Ably action dispatch
 *     (message.create, message.append, message.update, message.delete)
 *     and serial tracking
 *
 * Your encoder tells the core *what* to do (stream this, publish that).
 * Your decoder provides hooks that say *how* to interpret what arrived.
 * The cores handle the *how* of the wire protocol.
 */

import * as Ably from 'ably';

import {
  type ChannelWriter,
  type Codec,
  createDecoderCore,
  createEncoderCore,
  type DecoderOutput,
  type EncoderCoreOptions,
  type EncoderOptions,
  ErrorCode,
  headerReader,
  headerWriter,
  type MessageAccumulator,
  type MessagePayload,
  type StreamDecoder,
  type StreamEncoder,
  type WriteOptions,
} from '../../src/index.js';
import type { AgentEvent, AgentMessage } from './types.js';

// Shorthand for the decoder output type parameterized to our domain.
type Out = DecoderOutput<AgentEvent, AgentMessage>;

// ---------------------------------------------------------------------------
// Encoder
// ---------------------------------------------------------------------------
//
// The encoder implements StreamEncoder<TEvent, TMessage>, which extends
// DiscreteEncoder<TEvent, TMessage>. The interface has six methods. Only
// three are called by the transport:
//
//   appendEvent(event)      — the hot path: the server transport calls
//                             this for each chunk from the model's
//                             streaming response. This is where you map
//                             events to streamed or discrete operations.
//   writeMessages(messages) — the server transport calls this to publish
//                             user messages (the prompt) atomically. All
//                             messages share one x-ably-msg-id and form
//                             one node in the conversation tree. Decompose
//                             each TMessage into MessagePayloads.
//   abort(reason?)          — called when a turn is cancelled. Close all
//                             open streams with "aborted" status and
//                             publish an abort signal.
//
// The remaining two:
//
//   writeEvent(event)       — public API for consumers to publish a
//                             standalone discrete event outside the
//                             streaming flow. Not called by the transport.
//   close()                 — called when encoding is done. Flushes
//                             pending appends and runs recovery for any
//                             that failed. Always call this.
//
// The core building blocks you delegate to (via createEncoderCore):
//
//   Streamed content → startStream / appendStream / closeStream
//     Opens a message stream, appends text deltas to it, then
//     closes it. The core tracks the stream state, handles recovery if
//     an append fails, and manages the x-ably-status lifecycle headers.
//
//   Discrete events → publishDiscrete / publishDiscreteBatch
//     Publishes standalone Ably messages. Used for tool calls (which
//     arrive complete) and lifecycle signals (start, finish).
//
// Both accept a MessagePayload — a codec-agnostic description of what
// to publish:
//
//   { name: string,     — Ably message name (e.g. "text", "tool-call")
//     data: unknown,    — payload body (strings, objects, arrays — Ably
//                         serializes natively)
//     headers?: {},     — key-value metadata attached to message extras
//     ephemeral?: bool  — if true, not persisted in channel history }
//
// For streamed content, startStream and closeStream take a StreamPayload
// instead — same shape but `data` must be a string (because appends use
// text concatenation semantics).
//
// WriteOptions (the optional `perWrite` parameter on every method) lets
// the transport pass per-publish metadata like a message ID or client ID
// override. Your encoder passes it through to every core call unchanged —
// you don't need to inspect or modify it.
//
// Domain headers carry codec-specific metadata (e.g. toolCallId, toolName).
// Use headerWriter() to build these — it prefixes keys with "x-domain-"
// automatically, so .str('toolCallId', 'tc-1') becomes the header
// 'x-domain-toolCallId: tc-1' on the wire. The decoder reads them back
// with headerReader(). The x-domain- prefix is an SDK convention that
// separates your codec's headers from the transport's x-ably-* headers.
//

// Stream ID for the text content stream. This codec uses a single text
// stream, but the encoder core supports multiple concurrent streams — each
// identified by a unique streamId. For example, a codec that streams both
// "reasoning" and "text" concurrently would use different IDs for each
// (e.g. 'reasoning-1' and 'text-1') and track their open/closed state
// independently.
const TEXT_STREAM_ID = 'text';

class AgentEncoder implements StreamEncoder<AgentEvent, AgentMessage> {
  private readonly _core;
  private _textStreamOpen = false;

  // The constructor receives a ChannelWriter (Ably.RealtimeChannel satisfies
  // this directly — it has publish, appendMessage, and updateMessage) and
  // EncoderCoreOptions. The Codec.createEncoder factory receives the broader
  // EncoderOptions type — both are the same shape (clientId, extras, onMessage
  // hook) but EncoderCoreOptions adds an optional logger. Your factory can
  // pass options straight through.
  constructor(writer: ChannelWriter, options: EncoderCoreOptions = {}) {
    this._core = createEncoderCore(writer, options);
  }

  // appendEvent is the hot path — called once per streaming chunk from
  // the model. Each event type maps to exactly one encoder core operation.
  async appendEvent(event: AgentEvent, perWrite?: WriteOptions): Promise<void> {
    switch (event.type) {
      case 'start': {
        // Our codec: 'start' is a lifecycle signal — publish it as a
        // discrete message so the accumulator knows a new response began.
        await this._core.publishDiscrete({ name: 'start', data: '' }, perWrite);
        break;
      }

      case 'text-delta': {
        // Our codec: text-delta is the streamable event type. We use the
        // message append lifecycle to deliver tokens incrementally.
        //
        // Core behaviour: startStream opens a new Ably message stream.
        // Pass empty data because the core only accumulates text from
        // appends, not from the initial create — the create establishes
        // the message serial, and appends extend it.
        if (!this._textStreamOpen) {
          await this._core.startStream(TEXT_STREAM_ID, { name: 'text', data: '' }, perWrite);
          this._textStreamOpen = true;
        }
        // Core behaviour: appendStream is fire-and-forget — it queues
        // the append and returns synchronously. Failed appends are
        // recovered automatically when the stream is closed.
        this._core.appendStream(TEXT_STREAM_ID, event.delta);
        break;
      }

      case 'text-end': {
        // Our codec: text-end signals the end of the text stream.
        //
        // Core behaviour: closeStream flushes any pending appends and
        // sets x-ably-status: finished on the wire.
        await this._core.closeStream(TEXT_STREAM_ID, { name: 'text', data: '' });
        this._textStreamOpen = false;
        break;
      }

      case 'tool-call': {
        // Our codec: tool-call is a discrete event — the tool call
        // arrives complete from the model, so no streaming is needed.
        // We carry the tool metadata in domain headers (x-domain-*)
        // and the tool arguments in the message data.
        //
        // Core behaviour: headerWriter() prefixes keys with "x-domain-"
        // automatically, so .str('toolCallId', '...') becomes the header
        // 'x-domain-toolCallId' on the wire. The decoder reads them back
        // with headerReader(). The data field accepts any JSON-serializable
        // value — Ably handles serialization natively.
        const h = headerWriter()
          .str('toolCallId', event.toolCallId)
          .str('toolName', event.toolName)
          .build();
        await this._core.publishDiscrete(
          { name: 'tool-call', data: event.args, headers: h },
          perWrite,
        );
        break;
      }

      case 'finish': {
        // Our codec: 'finish' is a lifecycle signal — publish discretely
        // so the accumulator and transport know the response is complete.
        await this._core.publishDiscrete({ name: 'finish', data: '' }, perWrite);
        break;
      }
    }
  }

  // Required by the DiscreteEncoder interface but not called by the
  // transport. Available for consumers who need to publish a standalone
  // event outside the streaming flow. Not implemented in this example.
  async writeEvent(): Promise<Ably.PublishResult> {
    return await Promise.reject(
      new Ably.ErrorInfo('writeEvent is not implemented', ErrorCode.InvalidArgument, 400),
    );
  }

  // Called by the server transport to publish user messages (the prompt)
  // to the channel atomically. All messages share the encoder's transport
  // headers (including x-ably-msg-id) and form one node in the conversation
  // tree. Decompose each TMessage into MessagePayloads — one per logical
  // part — and publish them all in a single channel publish.
  async writeMessages(messages: AgentMessage[], perWrite?: WriteOptions): Promise<Ably.PublishResult> {
    const payloads = messages.flatMap((msg) => {
      const p: MessagePayload[] = [];
      if (msg.text) p.push({ name: 'text', data: msg.text });
      for (const tc of msg.toolCalls) {
        const h = headerWriter().str('toolCallId', tc.toolCallId).str('toolName', tc.toolName).build();
        p.push({ name: 'tool-call', data: tc.args, headers: h });
      }
      return p.length > 0 ? p : [{ name: 'text', data: '' }];
    });
    return this._core.publishDiscreteBatch(payloads, perWrite);
  }

  // abort is called by the transport when a turn is cancelled. It closes
  // all open streams with x-ably-status: aborted (so subscribers know the
  // stream was interrupted, not completed) and publishes an abort signal.
  async abort(reason?: string): Promise<void> {
    await this._core.abortAllStreams();
    await this._core.publishDiscrete({ name: 'abort', data: reason ?? '' });
  }

  async close(): Promise<void> {
    // Flushes pending appends and clears internal state. Always call
    // this when you're done encoding — it ensures recovery runs for
    // any appends that failed.
    await this._core.close();
  }
}

// ---------------------------------------------------------------------------
// Decoder
// ---------------------------------------------------------------------------
//
// The decoder's job: provide four hooks to the decoder core, which tell
// it how to convert Ably messages back into domain events.
//
// The decoder core handles all the complexity:
//   - Dispatching on Ably message action (create, append, update, delete)
//   - Tracking message serials and accumulated text
//   - Detecting whether a message is streamed or discrete
//   - Handling mid-stream joins (first-contact updates)
//
// Your hooks only deal with domain types — you never see Ably.Message:
//
//   buildStartEvents(tracker)  → called when a new stream opens
//   buildDeltaEvents(tracker, delta) → called on each text append
//   buildEndEvents(tracker, closingHeaders) → called when a stream closes
//   decodeDiscrete(payload)    → called for non-streamed messages
//
// The `tracker` parameter (StreamTrackerState) gives you the running
// state of a message stream:
//
//   tracker.name        — the stream name from startStream (e.g. "text")
//   tracker.streamId    — the stream ID (e.g. "text", or a tool call ID)
//   tracker.accumulated — all text received so far (grows with each delta)
//   tracker.headers     — headers from the initial create message
//   tracker.closed      — whether this stream has been closed
//
// This is useful when your codec has multiple stream types (e.g. text
// and reasoning) and the hooks need to dispatch on tracker.name to emit
// different event types.
//
// The `payload` parameter (MessagePayload) in decodeDiscrete gives you:
//
//   payload.name    — the Ably message name (e.g. "tool-call", "start")
//   payload.data    — the payload body (unknown — cast after checking name)
//   payload.headers — headers from the message extras (read with headerReader)
//

class AgentDecoder implements StreamDecoder<AgentEvent, AgentMessage> {
  private readonly _core;

  constructor() {
    this._core = createDecoderCore<AgentEvent, AgentMessage>({
      // Core behaviour: called when a new message stream is created on
      // the channel (i.e. the encoder called startStream).
      //
      // Our codec: we don't emit a domain event here — the meaningful
      // content arrives in the delta appends that follow. A codec with
      // a "text-start" event in its TEvent union could emit it here.
      buildStartEvents: (): Out[] => [],

      // Core behaviour: called on each message append.
      // `delta` is the new text fragment. The `tracker` has the full
      // accumulated text so far (tracker.accumulated) if you need it.
      //
      // Our codec: emit a text-delta event with just the new fragment.
      buildDeltaEvents: (_tracker, delta): Out[] => [
        { kind: 'event', event: { type: 'text-delta', delta } },
      ],

      // Core behaviour: called when a stream closes with x-ably-status:
      // finished. `closingHeaders` may carry updated headers from the
      // closing append. Only called for finished streams — aborted
      // streams are closed silently (tracker.closed becomes true)
      // without calling this hook. The abort signal itself arrives as
      // a discrete "abort" message via decodeDiscrete.
      //
      // Our codec: emit a text-end event so the accumulator knows the
      // text stream is complete.
      buildEndEvents: (): Out[] => [
        { kind: 'event', event: { type: 'text-end' } },
      ],

      // Core behaviour: called for every non-streamed Ably message
      // (message.create where x-ably-stream is "false"). The payload
      // gives you the message name, data, and headers.
      //
      // Our codec: dispatch on payload.name to reconstruct the domain
      // event. Each name corresponds to a discrete event the encoder
      // published via publishDiscrete.
      decodeDiscrete: (payload: MessagePayload): Out[] => {
        switch (payload.name) {
          case 'start': {
            return [{ kind: 'event', event: { type: 'start' } }];
          }

          case 'tool-call': {
            // Core behaviour: headerReader() mirrors headerWriter() —
            // reads x-domain-prefixed keys by unprefixed name.
            const h = payload.headers ?? {};
            const r = headerReader(h);
            // CAST: Trust boundary — the encoder serialized args as a JSON object.
            const args = (payload.data ?? {}) as Record<string, unknown>;
            return [
              {
                kind: 'event',
                event: {
                  type: 'tool-call',
                  toolCallId: r.strOr('toolCallId', ''),
                  toolName: r.strOr('toolName', ''),
                  args,
                },
              },
            ];
          }

          case 'finish': {
            return [{ kind: 'event', event: { type: 'finish' } }];
          }

          default: {
            // Our codec: unknown message names are silently ignored.
            // This makes the codec forward-compatible — new event
            // types won't break old decoders.
            return [];
          }
        }
      },
    });
  }

  decode(message: Ably.InboundMessage): Out[] {
    return this._core.decode(message);
  }
}

// ---------------------------------------------------------------------------
// Accumulator
// ---------------------------------------------------------------------------
//
// The accumulator's job: consume decoded events and build TMessage objects.
//
// It receives DecoderOutput[], which is a union of:
//   { kind: 'event', event: TEvent, messageId?: string }
//   { kind: 'message', message: TMessage }
//
// 'event' outputs come from streaming — your accumulator assembles them.
// 'message' outputs come from decodeDiscrete when the decoder recognizes
// a complete message published by writeMessages (e.g. user messages,
// history entries). The accumulator inserts these directly without
// assembly. Your decoder's decodeDiscrete hook decides when to return
// { kind: 'message' } vs { kind: 'event' } — typically based on whether
// the Ably message represents a complete domain message or a streaming
// lifecycle event.
//
// The messageId on event outputs comes from the x-ably-msg-id header
// (stamped by the transport or the onMessage hook). The accumulator uses
// it to group events that belong to the same response.
//
// The accumulator is where your TMessage comes to life. For each event
// type, decide how it mutates the in-progress message.
//

class AgentAccumulator implements MessageAccumulator<AgentEvent, AgentMessage> {
  private readonly _messages: AgentMessage[] = [];
  private _current: AgentMessage | undefined;

  /**
   * All messages — both in-progress and completed.
   * @returns The full message list.
   */
  get messages(): AgentMessage[] {
    return this._messages;
  }

  /**
   * Only messages whose streams have finished.
   * @returns Messages that are no longer being streamed.
   */
  get completedMessages(): AgentMessage[] {
    return this._messages.filter((m) => m !== this._current);
  }

  /**
   * Whether any message is still actively being streamed.
   * @returns True if a message is in progress.
   */
  get hasActiveStream(): boolean {
    return this._current !== undefined;
  }

  processOutputs(outputs: Out[]): void {
    for (const output of outputs) {
      // Complete messages from writeMessages — insert directly.
      if (output.kind === 'message') {
        this._messages.push(output.message);
        continue;
      }

      // Streaming events — assemble into the current message.
      const event = output.event;

      switch (event.type) {
        case 'start': {
          // Our codec: create a new in-progress message. We initialize
          // text as empty and toolCalls as an empty array — both will
          // be populated incrementally by subsequent events.
          //
          // Core behaviour: output.messageId comes from the x-ably-msg-id
          // header that the transport stamps on every outgoing Ably message.
          this._current = {
            id: output.messageId ?? crypto.randomUUID(),
            role: 'assistant',
            text: '',
            toolCalls: [],
          };
          this._messages.push(this._current);
          break;
        }

        case 'text-delta': {
          // Our codec: append the text fragment to the in-progress
          // message. The UI can read message.text at any point to get
          // the text accumulated so far.
          if (!this._current) break;
          this._current.text += event.delta;
          break;
        }

        case 'text-end': {
          // Our codec: text stream closed — nothing to do since text
          // is already accumulated. A more complex codec could use this
          // to trigger a UI update or mark the text as "final".
          break;
        }

        case 'tool-call': {
          // Our codec: tool calls arrive complete as discrete events.
          // Push them onto the toolCalls array — the UI can render
          // them immediately.
          if (!this._current) break;
          this._current.toolCalls.push({
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            args: event.args,
          });
          break;
        }

        case 'finish': {
          // Our codec: message complete. Clear the current pointer so
          // hasActiveStream returns false and completedMessages includes
          // this message.
          this._current = undefined;
          break;
        }
      }
    }
  }

  /**
   * Replace a message by ID (e.g. from an external update callback).
   * @param message - The replacement message (matched by ID).
   */
  updateMessage(message: AgentMessage): void {
    const idx = this._messages.findIndex((m) => m.id === message.id);
    if (idx !== -1) {
      this._messages[idx] = message;
    }
  }
}

// ---------------------------------------------------------------------------
// Codec — the composite entry point
// ---------------------------------------------------------------------------
//
// The Codec object wires everything together. It provides factory methods
// for the transport to create encoders, decoders, and accumulators, plus
// two helpers:
//
//   isTerminal(event) — tells the transport when a response stream ends
//   getMessageKey(message) — returns a stable ID for message deduplication
//

/**
 * A custom codec for structured AI agent responses.
 *
 * Implements `Codec<AgentEvent, AgentMessage>` — the same interface used by
 * the transport layer. Plug this into `createClientTransport` or
 * `createServerTransport` to stream structured AI responses over Ably.
 *
 * ```ts
 * import { createServerTransport } from '@ably/ai-transport';
 * import { AgentCodec } from './codec.js';
 *
 * const transport = createServerTransport(channel, { codec: AgentCodec });
 * ```
 */
export const AgentCodec: Codec<AgentEvent, AgentMessage> = {
  createEncoder: (writer: ChannelWriter, options?: EncoderOptions) => new AgentEncoder(writer, options),
  createDecoder: () => new AgentDecoder(),
  createAccumulator: () => new AgentAccumulator(),

  // Core behaviour: the transport reads response streams until it sees a
  // terminal event. Return true for events that signal "this response is done."
  //
  // Our codec: only 'finish' is terminal.
  isTerminal: (event: AgentEvent) => event.type === 'finish',

  // Core behaviour: used by the transport's message store for upsert/dedup.
  // Return a stable identifier — typically the message ID.
  getMessageKey: (message: AgentMessage) => message.id,
};
