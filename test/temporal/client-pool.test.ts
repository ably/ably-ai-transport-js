/**
 * Client pool tests.
 *
 * The pool exists to reuse a connection across activities, and the interesting
 * behaviour is when it refuses to. Two properties of ably-js drive that refusal,
 * and both are modelled by `createPoolableMockClient`: `channels.release` drops
 * the channel synchronously only when it is already detached, and a connection
 * that is not connected makes the next attach either reject or hang. A client
 * failing either gate is closed, so the fallback costs one handshake.
 */

import '../helper/expectations.js';

import type * as Ably from 'ably';
import { beforeEach, describe, expect, it } from 'vitest';

import { ErrorCode } from '../../src/errors.js';
import { createClientPool } from '../../src/temporal/client-pool.js';
import { createPoolableMockClient, type PoolableMockClient } from '../helper/mock-client.js';

const CHANNEL = 'ai:room-7';

let built: PoolableMockClient[];

/**
 * Build a client and record it, so a test can assert which of them the pool
 * reused and which it closed. Pass as `createClient`.
 * @returns The new client.
 */
const trackedClient = (): Ably.Realtime => {
  const stub = createPoolableMockClient();
  built.push(stub);
  return stub.client;
};

beforeEach(() => {
  built = [];
});

describe('createClientPool', () => {
  it('rejects a maxIdle that is not a non-negative integer', () => {
    expect(() => createClientPool({ createClient: trackedClient, maxIdle: -1 })).toThrowErrorInfoWithCode(
      ErrorCode.InvalidArgument,
    );
    expect(() => createClientPool({ createClient: trackedClient, maxIdle: 1.5 })).toThrowErrorInfoWithCode(
      ErrorCode.InvalidArgument,
    );
  });

  it('opens no connection until the first lease', () => {
    createClientPool({ createClient: trackedClient });

    expect(built).toHaveLength(0);
  });
});

describe('acquire', () => {
  it('builds a client when none is idle', () => {
    const pool = createClientPool({ createClient: trackedClient });

    const lease = pool.acquire(CHANNEL);

    expect(built).toHaveLength(1);
    expect(lease.client).toBe(built[0]?.client);
  });

  it('hands concurrent leases distinct clients, so two sessions never share a channel object', () => {
    const pool = createClientPool({ createClient: trackedClient });

    const first = pool.acquire(CHANNEL);
    const second = pool.acquire(CHANNEL);

    expect(first.client).not.toBe(second.client);
    expect(built).toHaveLength(2);
  });

  it('reuses a released client rather than building another', () => {
    const pool = createClientPool({ createClient: trackedClient });

    pool.acquire(CHANNEL).release();
    const second = pool.acquire(CHANNEL);

    expect(built).toHaveLength(1);
    expect(second.client).toBe(built[0]?.client);
  });

  it('refuses to lease once the pool is closed', async () => {
    const pool = createClientPool({ createClient: trackedClient });
    await pool.close();

    expect(() => pool.acquire(CHANNEL)).toThrowErrorInfoWithCode(ErrorCode.SessionClosed);
  });

  it('discards a parked client whose connection dropped while nobody held it', () => {
    const pool = createClientPool({ createClient: trackedClient });
    pool.acquire(CHANNEL).release();
    // A blip between turns: the release-time gate passed, and the connection went
    // away afterwards. Handing this out would leave the next attach rejecting or
    // pending with no timeout.
    built[0]?.setConnectionState('suspended');

    const lease = pool.acquire(CHANNEL);

    expect(built[0]?.closed).toBe(true);
    expect(lease.client).toBe(built[1]?.client);
  });

  it('walks past several dead parked clients to reach a live one', () => {
    const pool = createClientPool({ createClient: trackedClient });
    const leases = [pool.acquire(CHANNEL), pool.acquire('ai:room-8'), pool.acquire('ai:room-9')];
    for (const lease of leases) lease.release();
    // The first two parked are the ones a later `pop()` reaches last.
    built[2]?.setConnectionState('failed');
    built[1]?.setConnectionState('disconnected');

    const lease = pool.acquire(CHANNEL);

    expect(lease.client).toBe(built[0]?.client);
    expect(built[1]?.closed).toBe(true);
    expect(built[2]?.closed).toBe(true);
    expect(built).toHaveLength(3);
  });
});

describe('release', () => {
  it('drops the leased channel so the next lease starts clean', () => {
    const pool = createClientPool({ createClient: trackedClient });

    pool.acquire(CHANNEL).release();

    expect(built[0]?.releasedChannels).toEqual([CHANNEL]);
  });

  it('pools a connected client whose channel was dropped', () => {
    const pool = createClientPool({ createClient: trackedClient });

    pool.acquire(CHANNEL).release();

    expect(built[0]?.closed).toBe(false);
  });

  it('closes rather than pools when the channel survived the release', () => {
    const pool = createClientPool({ createClient: trackedClient });
    const lease = pool.acquire(CHANNEL);
    // ably-js defers the drop for a channel that is not yet DETACHED. Re-leasing
    // inside that window would hand the next session a channel object that is
    // about to be removed from `channels.all`, after which inbound messages for
    // it are silently dropped.
    built[0]?.deferReleaseOf(CHANNEL);

    lease.release();

    expect(built[0]?.closed).toBe(true);
    expect(pool.acquire(CHANNEL).client).not.toBe(built[0]?.client);
  });

  it.each(['disconnected', 'suspended', 'closed', 'failed', 'connecting'] as const)(
    'closes rather than pools a client whose connection is %s',
    (state) => {
      const pool = createClientPool({ createClient: trackedClient });
      const lease = pool.acquire(CHANNEL);
      built[0]?.setConnectionState(state);

      lease.release();

      expect(built[0]?.closed).toBe(true);
    },
  );

  it('closes the client once maxIdle connections are already parked', () => {
    const pool = createClientPool({ createClient: trackedClient, maxIdle: 1 });
    const first = pool.acquire(CHANNEL);
    const second = pool.acquire(CHANNEL);

    first.release();
    second.release();

    expect(built[0]?.closed).toBe(false);
    expect(built[1]?.closed).toBe(true);
  });

  it('closes every client when maxIdle is zero, which disables reuse', () => {
    const pool = createClientPool({ createClient: trackedClient, maxIdle: 0 });

    pool.acquire(CHANNEL).release();

    expect(built[0]?.closed).toBe(true);
    expect(built).toHaveLength(1);
  });

  it('closes a client returned after the pool closed', async () => {
    const pool = createClientPool({ createClient: trackedClient });
    const lease = pool.acquire(CHANNEL);
    await pool.close();

    lease.release();

    expect(built[0]?.closed).toBe(true);
  });

  it('throws on a second release, because the client may already be leased elsewhere', () => {
    const pool = createClientPool({ createClient: trackedClient });
    const lease = pool.acquire(CHANNEL);
    lease.release();

    expect(() => {
      lease.release();
    }).toThrowErrorInfoWithCode(ErrorCode.InvalidArgument);
  });
});

describe('close', () => {
  it('closes every parked client', async () => {
    const pool = createClientPool({ createClient: trackedClient });
    // Concurrent leases, so both clients exist and both park on release.
    const first = pool.acquire(CHANNEL);
    const second = pool.acquire('ai:room-8');
    first.release();
    second.release();
    expect(built.map((stub) => stub.closed)).toEqual([false, false]);

    await pool.close();

    expect(built.map((stub) => stub.closed)).toEqual([true, true]);
  });

  it('closes a client that is still leased, so a wedged activity cannot stop the process exiting', async () => {
    const pool = createClientPool({ createClient: trackedClient });
    pool.acquire(CHANNEL);

    await pool.close();

    expect(built[0]?.closed).toBe(true);
  });

  it('is idempotent', async () => {
    const pool = createClientPool({ createClient: trackedClient });
    pool.acquire(CHANNEL).release();

    await pool.close();
    await pool.close();

    expect(built[0]?.closeCalls).toBe(1);
  });
});
