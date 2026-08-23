import { describe, it, expect, vi, afterEach } from 'vitest';

import { clientTools, hasClientTool, runClientTool } from '../use-client-tools';
import type { ClientToolLogEntry } from '../../components/debug-pane';

afterEach(() => {
  vi.unstubAllGlobals();
  // Tests register throwaway executors; remove everything but the built-ins.
  for (const name of Object.keys(clientTools)) {
    if (name !== 'getLocation') delete clientTools[name];
  }
});

describe('hasClientTool', () => {
  it('reports registered tools', () => {
    expect(hasClientTool('getLocation')).toBe(true);
  });

  it('reports unregistered tools as absent', () => {
    expect(hasClientTool('getWeather')).toBe(false);
  });

  it('does not treat Object prototype keys as tools', () => {
    expect(hasClientTool('toString')).toBe(false);
  });
});

describe('runClientTool', () => {
  it('returns an errorText for an unregistered tool without logging', async () => {
    const onExecute = vi.fn();
    const result = await runClientTool('nope', 'call-0', {}, onExecute);
    expect(result).toEqual({ errorText: 'no client tool registered for nope' });
    expect(onExecute).not.toHaveBeenCalled();
  });

  it('executes the tool and reports executing then done with the output', async () => {
    clientTools.echo = async (input) => ({ echoed: input });

    const entries: ClientToolLogEntry[] = [];
    const result = await runClientTool('echo', 'call-1', { text: 'hi' }, (entry) => entries.push(entry));

    expect(result).toEqual({ output: { echoed: { text: 'hi' } } });
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      toolName: 'echo',
      toolCallId: 'call-1',
      input: { text: 'hi' },
      status: 'executing',
    });
    expect(entries[1]).toMatchObject({
      toolName: 'echo',
      toolCallId: 'call-1',
      status: 'done',
      output: { echoed: { text: 'hi' } },
    });
    // The done entry replaces the executing one in a keyed log, so both carry
    // the same start time.
    expect(entries[1].time).toBe(entries[0].time);
  });

  it('returns an errorText and reports an error entry when the executor throws', async () => {
    clientTools.boom = async () => {
      throw new Error('kaboom');
    };

    const entries: ClientToolLogEntry[] = [];
    const result = await runClientTool('boom', 'call-2', {}, (entry) => entries.push(entry));

    expect(result).toEqual({ errorText: 'kaboom' });
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ status: 'executing' });
    expect(entries[1]).toMatchObject({ status: 'error', error: 'kaboom' });
  });

  it('falls back to a generic message when the executor throws a non-Error', async () => {
    clientTools.boomString = () => Promise.reject('not-an-error');

    const result = await runClientTool('boomString', 'call-3', {});
    expect(result).toEqual({ errorText: 'Client tool execution failed' });
  });

  it('resolves getLocation with coordinates from the browser geolocation API', async () => {
    vi.stubGlobal('navigator', {
      geolocation: {
        getCurrentPosition: (success: (position: { coords: { latitude: number; longitude: number } }) => void) => {
          success({ coords: { latitude: 51.5, longitude: -0.1 } });
        },
      },
    });

    const result = await runClientTool('getLocation', 'call-4', {});
    expect(result).toEqual({ output: { latitude: 51.5, longitude: -0.1 } });
  });
});
