import type { AnyCodec, CodecMessage } from './codec.js';
import type { MessageNode } from './message-node.js';
import type { AgentRun, ClientRun } from './run.js';

export type {
  Accumulator,
  AnyCodec,
  Codec,
  CodecEvent,
  CodecMessage,
  CodecPart,
  DecodedValue,
  Decoder,
  EncodeEventOptions,
  Encoder,
} from './codec.js';
export type { ControlSignal, ControlSignalType } from './control-signal.js';
export { ErrorCode } from './errors.js';
// `Invocation` is a merged symbol — a `const` (the `InvocationConstructor`
// static namespace exposing `Invocation.fromJSON`) and an `interface` of the
// same name (the instance shape). A single value re-export carries both
// sides through to consumers, who can use `Invocation` in type position and
// call `Invocation.fromJSON(data)` in value position.
export type { InvocationConstructor, InvocationData } from './invocation.js';
export { Invocation } from './invocation.js';
export type { MessageNode } from './message-node.js';

/** Pre-bound {@link MessageNode} variant for {@link ClientRun} sessions. */
export type ClientMessageNode<C extends AnyCodec> = MessageNode<CodecMessage<C>, ClientRun<C>>;

/** Pre-bound {@link MessageNode} variant for {@link AgentRun} sessions. */
export type AgentMessageNode<C extends AnyCodec> = MessageNode<CodecMessage<C>, AgentRun<C>>;

export type { AgentRun, ClientRun, Run, RunEndStatus, RunStatus, SendEventsTarget, SuspendReason } from './run.js';
export type { AgentSession, ClientSession, SessionOptions } from './session.js';
export { createAgentSession, createClientSession } from './session.js';
export type { Step, StepEndStatus, StepStartOptions, StepState, StepStatus } from './step.js';
export type { StorageReader, StorageWriter } from './storage.js';
export type { Tree } from './tree.js';
export type { AgentView, ClientView, CreateForkOptions, CreateViewOptions, View } from './view.js';
export type {
  AbortOptions,
  ClientRunAbortOptions,
  ClientRunPauseOptions,
  ClientRunResumeOptions,
  ClientRunRetryOptions,
  EndRunOptions,
  EndStepOptions,
  PauseOptions,
  ResumeOptions,
  RetryOptions,
  SendEventsOptions,
  SendMessagesOptions,
  SendPartsOptions,
  SessionWriter,
  StartRunOptions,
  StartRunResult,
  StartStepOptions,
  StartStepResult,
  SuspendRunOptions,
} from './writer.js';
