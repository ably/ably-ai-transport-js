/**
 * One reply handed to `useChat`: the chunks of one turn, from its `start`
 * chunk to its terminal chunk, as the stream `useChat` reads.
 */

import type * as Ably from 'ably';
import type * as AI from 'ai';

/**
 * Whether a chunk ends a turn: `finish` when the model finished, `abort` when
 * the agent was stopped, `error` when it failed.
 * @param chunk - The chunk.
 * @returns True for a terminal chunk.
 */
export const isTerminal = (chunk: AI.UIMessageChunk): boolean =>
  chunk.type === 'finish' || chunk.type === 'abort' || chunk.type === 'error';

/**
 * The stream of one turn. It waits for the turn's `start` chunk, then reads
 * until the terminal chunk, which closes it. The reader decides which chunks
 * reach it; the stream only tracks where it is and settles once.
 */
export class TurnStream {
  /** The stream `useChat` reads. */
  readonly readable: ReadableStream<AI.UIMessageChunk>;
  private _controller: ReadableStreamDefaultController<AI.UIMessageChunk> | undefined;
  private _state: 'waiting' | 'reading' | 'ended' = 'waiting';
  private readonly _onEnd: () => void;

  /**
   * @param onEnd - Called once when the stream ends, however it ends: its terminal chunk, {@link TurnStream.close}, {@link TurnStream.fail}, or the consumer cancelling it.
   */
  constructor(onEnd: () => void) {
    this._onEnd = onEnd;
    this.readable = new ReadableStream<AI.UIMessageChunk>({
      start: (controller) => {
        this._controller = controller;
      },
      cancel: () => {
        this._end();
      },
    });
  }

  /**
   * Whether the stream has its turn's `start` chunk and is reading the turn.
   * @returns True once the `start` chunk has been written, until the stream ends.
   */
  get reading(): boolean {
    return this._state === 'reading';
  }

  /**
   * Whether the stream has ended.
   * @returns True once it has closed, errored or been cancelled.
   */
  get ended(): boolean {
    return this._state === 'ended';
  }

  /**
   * Hand one chunk to `useChat`. A `start` chunk begins the turn and a
   * terminal chunk closes the stream after it. Ignored once the stream has
   * ended.
   * @param chunk - The chunk.
   */
  write(chunk: AI.UIMessageChunk): void {
    if (this._state === 'ended') return;
    if (chunk.type === 'start') this._state = 'reading';
    this._controller?.enqueue(chunk);
    if (isTerminal(chunk)) this.close();
  }

  /**
   * End the stream without a terminal chunk, for a turn that ended without
   * one. `useChat` reads it as the end of the reply. Ignored once the stream
   * has ended.
   */
  close(): void {
    if (this._state === 'ended') return;
    this._end();
    this._controller?.close();
  }

  /**
   * End the stream with an error. Chunks `useChat` has not read yet are
   * dropped with it, as an errored stream does. Ignored once the stream has
   * ended.
   * @param error - The error `useChat` reads.
   */
  fail(error: Ably.ErrorInfo): void {
    if (this._state === 'ended') return;
    this._end();
    this._controller?.error(error);
  }

  private _end(): void {
    if (this._state === 'ended') return;
    this._state = 'ended';
    this._onEnd();
  }
}
