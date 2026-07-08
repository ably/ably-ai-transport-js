import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Unmount rendered components between tests so queries don't match leftover DOM
// from an earlier test (testing-library only auto-registers this when Vitest
// globals are enabled).
afterEach(() => {
  cleanup();
});
