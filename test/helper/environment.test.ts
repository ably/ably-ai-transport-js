import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { localSandboxRouting, localSandboxURL, recordLocalSandboxRouting } from './environment.js';

// The env vars these helpers read/write. Snapshotted and restored around each
// test so manipulating them here can't leak into other suites.
const VARS = [
  'ABLY_LOCAL_SANDBOX_URL',
  'ABLY_LOCAL_SANDBOX_ENDPOINT',
  'ABLY_LOCAL_SANDBOX_PORT',
  'ABLY_LOCAL_SANDBOX_TLS',
] as const;

describe('local sandbox environment helpers', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const v of VARS) {
      saved[v] = process.env[v];
      Reflect.deleteProperty(process.env, v);
    }
  });

  afterEach(() => {
    for (const v of VARS) {
      if (saved[v] === undefined) {
        Reflect.deleteProperty(process.env, v);
      } else {
        process.env[v] = saved[v];
      }
    }
  });

  describe('localSandboxURL', () => {
    it('is undefined when the env var is unset', () => {
      expect(localSandboxURL()).toBeUndefined();
    });

    it('is undefined when the env var is empty', () => {
      process.env.ABLY_LOCAL_SANDBOX_URL = '';
      expect(localSandboxURL()).toBeUndefined();
    });

    it('returns the configured URL when set', () => {
      process.env.ABLY_LOCAL_SANDBOX_URL = 'http://localhost:9010';
      expect(localSandboxURL()).toBe('http://localhost:9010');
    });
  });

  describe('localSandboxRouting', () => {
    it('is undefined when endpoint/port are not recorded', () => {
      expect(localSandboxRouting()).toBeUndefined();
    });

    it('is undefined when only the endpoint is recorded', () => {
      process.env.ABLY_LOCAL_SANDBOX_ENDPOINT = '127.0.0.1';
      expect(localSandboxRouting()).toBeUndefined();
    });

    it('parses the recorded routing, defaulting tls to false', () => {
      process.env.ABLY_LOCAL_SANDBOX_ENDPOINT = '127.0.0.1';
      process.env.ABLY_LOCAL_SANDBOX_PORT = '8081';
      expect(localSandboxRouting()).toEqual({ endpoint: '127.0.0.1', port: 8081, tls: false });
    });

    it('reports tls true only for the exact string "true"', () => {
      process.env.ABLY_LOCAL_SANDBOX_ENDPOINT = '127.0.0.1';
      process.env.ABLY_LOCAL_SANDBOX_PORT = '443';
      process.env.ABLY_LOCAL_SANDBOX_TLS = 'true';
      expect(localSandboxRouting()?.tls).toBe(true);

      process.env.ABLY_LOCAL_SANDBOX_TLS = 'TRUE';
      expect(localSandboxRouting()?.tls).toBe(false);
    });
  });

  describe('recordLocalSandboxRouting', () => {
    it('round-trips through localSandboxRouting', () => {
      recordLocalSandboxRouting({ endpoint: '127.0.0.1', port: 9200, tls: true });
      expect(localSandboxRouting()).toEqual({ endpoint: '127.0.0.1', port: 9200, tls: true });
    });
  });
});
