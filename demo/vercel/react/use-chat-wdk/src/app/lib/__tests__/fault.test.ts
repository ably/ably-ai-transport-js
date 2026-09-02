import { describe, expect, it } from 'vitest';

import { CLEAR_FAULT_COOKIE, FAULT_COOKIE, parseFaultCookie } from '../fault';

describe('parseFaultCookie', () => {
  it('reads the armed fault out of a Cookie header', () => {
    expect(parseFaultCookie(`${FAULT_COOKIE}=fail-once`)).toBe('fail-once');
    expect(parseFaultCookie(`theme=dark; ${FAULT_COOKIE}=crash; other=1`)).toBe('crash');
  });

  it('returns undefined for a missing header, a missing cookie, or an unknown mode', () => {
    expect(parseFaultCookie(null)).toBeUndefined();
    expect(parseFaultCookie('theme=dark')).toBeUndefined();
    expect(parseFaultCookie(`${FAULT_COOKIE}=explode`)).toBeUndefined();
  });
});

describe('CLEAR_FAULT_COOKIE', () => {
  it('expires the fault cookie', () => {
    expect(CLEAR_FAULT_COOKIE).toContain(`${FAULT_COOKIE}=;`);
    expect(CLEAR_FAULT_COOKIE).toContain('Max-Age=0');
  });
});
