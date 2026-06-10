import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.PORT ?? 3010);
const BASE_URL = `http://localhost:${String(PORT)}`;

// The webServer below inherits its env from the runner: scripts/run-e2e.mjs
// (`test:e2e`) sets the sandbox key, endpoints and MOCK_LLM; `test:e2e:live`
// uses .env.local.
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  // Retry in CI to absorb transient sandbox/history-hydration flakes.
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `pnpm exec next dev -p ${String(PORT)}`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
