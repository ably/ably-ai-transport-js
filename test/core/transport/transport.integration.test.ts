/**
 * Transport-level integration: send → stream → receive over real Ably.
 *
 * A client publishes an input, the agent observes it on its own live stream,
 * opens a run naming it, streams a fixture response, and ends the run. The
 * client's event stream carries the optimistic echo, the wire echo, the run
 * and step brackets, and the streamed output — and the client learns the
 * agent-minted run-id from the `ai-run-start` its own input triggered. This
 * needs real Ably: message appends and serial allocation have no mock
 * equivalent.
 *
 * Every await is an event, never a clock; recorders attach when an endpoint
 * is created, before any publish, so nothing can be missed.
 */

import type * as AI from 'ai';
import { afterEach, describe, expect, it } from 'vitest';

import { EVENT_AI_INPUT } from '../../../src/constants.js';
import type { VercelInput, VercelOutput } from '../../../src/vercel/codec/index.js';
import { createUIMessageCodec } from '../../../src/vercel/codec/index.js';
import { uniqueChannelName } from '../../helper/identifier.js';
import { closeAllClients } from '../../helper/realtime-client.js';
import { eventShape, isInputFor, isRunLifecycle, outputsOf, recordEvents } from '../../helper/transport-events.js';
import { closeAllTransports, createAgentEndpoint, createClientEndpoint } from '../../helper/transport-pair.js';
import { foldUIMessage, textOfChunks, textOfUIMessage, textResponseChunks } from '../../helper/vercel-chunks.js';

describe('transport send → stream → receive', () => {
  afterEach(() => {
    closeAllTransports();
    closeAllClients();
  });

  it('streams a run end-to-end, correlating the run-id back to the triggering input', async () => {
    const channelName = uniqueChannelName('transport-send-stream');
    const agent = await createAgentEndpoint<VercelInput, VercelOutput>(channelName, {
      codec: createUIMessageCodec(),
    });
    const client = await createClientEndpoint<VercelInput, VercelOutput>(channelName, {
      codec: createUIMessageCodec(),
    });
    const agentEvents = recordEvents(agent.transport);
    const clientEvents = recordEvents(client.transport);

    const userMessage: AI.UIMessage = {
      id: 'user-1',
      role: 'user',
      parts: [{ type: 'text', text: 'what is the weather' }],
    };
    const sent = await client.transport.publishInput({ kind: 'message', payload: userMessage });

    // The agent's own read of the wire is what tells it a turn arrived.
    const inbound = await agentEvents.next(isInputFor(sent.codecMessageId));

    // No runId pin: with no located input, pinning one means "continue this
    // run" and publishes ai-run-resume, which carries no input correlation.
    const run = agent.transport.openRun({ inputCodecMessageId: sent.codecMessageId });
    const piped = await run.pipe(textResponseChunks('asst-1', 'text-1', 'Sunny with a light breeze'));
    await run.end({ reason: 'complete' });

    const observed = await clientEvents.until(isRunLifecycle('end', run.runId));

    // The pipe completed, and the client learned the agent-minted run-id off
    // the channel via the input-codec-message-id header on ai-run-start.
    expect(piped.reason).toBe('complete');
    await expect(sent.runId).resolves.toBe(run.runId);

    // The agent decoded the client's input, attributed to its publisher.
    expect(inbound.kind).toBe('message');
    if (inbound.kind !== 'message') throw new Error('expected message event');
    expect(inbound.meta.clientId).toBe(client.clientId);
    expect(inbound.inputs).toEqual([{ kind: 'message', payload: userMessage }]);

    // Both input echoes, distinguished by serial: the optimistic local echo
    // (before the publish resolves) then the wire echo.
    const echoes = observed.filter(
      (event) => event.kind === 'message' && event.meta.codecMessageId === sent.codecMessageId,
    );
    expect(echoes).toHaveLength(2);
    const [optimistic, wire] = echoes;
    if (optimistic?.kind !== 'message' || wire?.kind !== 'message') throw new Error('expected message echoes');
    expect(optimistic.meta.serial).toBeUndefined();
    expect(optimistic.meta.versionSerial).toBeUndefined();
    expect(wire.meta.serial).toBeDefined();
    expect(wire.meta.messageName).toBe(EVENT_AI_INPUT);
    expect(optimistic.inputs).toEqual(wire.inputs);

    // The lifecycle sequence, in wire order.
    const lifecycle = observed.filter((event) => event.kind !== 'message');
    expect(lifecycle.map((event) => eventShape(event))).toEqual([
      'run:start',
      'step:step-start',
      'step:step-end',
      'run:end',
    ]);
    const start = lifecycle[0];
    if (start?.kind !== 'run-lifecycle' || start.event.type !== 'start') throw new Error('expected run-start');
    expect(start.event.inputCodecMessageId).toBe(sent.codecMessageId);
    expect(start.event.clientId).toBe(agent.clientId);
    const end = lifecycle[3];
    if (end?.kind !== 'run-lifecycle' || end.event.type !== 'end') throw new Error('expected run-end');
    expect(end.event.reason).toBe('complete');

    // Output content: the non-delta chunk types in order, and the reassembled
    // text. Deliberately no assertion on delta count — two appends may arrive
    // as one delta or two, and the contract is the reassembled text.
    const outputs = outputsOf(observed);
    expect(outputs.filter((chunk) => chunk.type !== 'text-delta').map((chunk) => chunk.type)).toEqual([
      'start',
      'start-step',
      'text-start',
      'text-end',
      'finish',
    ]);
    expect(textOfChunks(outputs)).toBe('Sunny with a light breeze');

    // The end-user's view: the provider's own reducer accepts the sequence
    // and reassembles the full message.
    const folded = await foldUIMessage(outputs);
    expect(textOfUIMessage(folded)).toBe('Sunny with a light breeze');
  });
});
