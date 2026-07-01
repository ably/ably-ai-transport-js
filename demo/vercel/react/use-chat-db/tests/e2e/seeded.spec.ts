import { expect, test, type Locator, type Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Database hydration — DB seed ⧺ live channel reconciliation (useMessageSync)
// ---------------------------------------------------------------------------
//
// The agent persists each completed run's whole turn to the in-memory store,
// and the demo seeds `useChat({ messages })` from it on load. `useMessageSync`
// then walks the live channel back to the seam (the newest seed message) and
// composes seed ⧺ live with no duplicate. These tests prove the reconciliation
// over real Ably history across a page reload, including runs that suspend and
// resume for a client-executed tool or an approval — where `run.messages` spans
// the whole run so a single persist at completion is lossless.

function seededChannelUrl(testTitle: string): string {
  const slug = testTitle
    .replaceAll(/[^a-z0-9]+/gi, '-')
    .replaceAll(/^-|-$/g, '')
    .toLowerCase();
  const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  // The `ai:` prefix matches the sandbox namespace with mutableMessages +
  // persistence enabled (see demo/e2e/run-e2e.mjs).
  return `/?channel=ai:e2e-${slug}-${stamp}`;
}

function messages(page: Page): Locator {
  return page.getByTestId('message');
}

function assistantWith(page: Page, text: string): Locator {
  return page.locator('[data-testid="message"][data-role="assistant"]').filter({ hasText: text });
}

function userWith(page: Page, text: string): Locator {
  return page.locator('[data-testid="message"][data-role="user"]').filter({ hasText: text });
}

async function send(page: Page, text: string): Promise<void> {
  const input = page.getByPlaceholder('Type a message...');
  await input.waitFor({ state: 'visible' });
  await input.fill(text);
  await input.press('Enter');
}

// Poll the page's total text length until it stops changing for three
// successive intervals — the agent's stream finishes emitting well before the
// run-end wire lands, so this lets a suspend/resume continuation fully publish
// before assertions run.
async function awaitStreamingQuiesce(page: Page): Promise<void> {
  let lastLen = -1;
  let stable = 0;
  for (let i = 0; i < 40; i++) {
    const len = await page.evaluate(() => document.body.innerText.length);
    if (len === lastLen) stable++;
    else stable = 0;
    lastLen = len;
    if (stable >= 3) return;
    await page.waitForTimeout(1000);
  }
}

test.describe('use-chat database hydration - DB seed reconciliation', () => {
  test('reload convergence: a persisted turn reconciles with the live channel without duplication', async ({
    page,
  }, testInfo) => {
    const url = seededChannelUrl(testInfo.title);
    await page.goto(url);

    // First turn on a fresh channel — the store is empty, so this is the plain
    // live path. The mock LLM replies with the quoted word, and the agent
    // persists the completed turn.
    await send(page, 'Say "ZULU"');
    await expect(assistantWith(page, 'ZULU')).toHaveCount(1, { timeout: 60_000 });
    await expect(messages(page)).toHaveCount(2);

    // Let the streamed turn settle so channel history is durably persisted and
    // the agent's store write has landed before the reload reconstructs.
    await page.waitForTimeout(3000);

    // Reload: useChat re-seeds from the store (/api/messages) and useMessageSync
    // walks the live channel back to the seam and composes seed ⧺ live.
    await page.goto(url);

    // The conversation comes back — the persisted prefix plus the live tail —
    // with the seam (the assistant reply) shown exactly once. Allow time for
    // channel history to hydrate so a duplicate would have surfaced.
    await expect(messages(page)).toHaveCount(2, { timeout: 60_000 });
    await page.waitForTimeout(3000);
    await expect(messages(page)).toHaveCount(2);
    await expect(userWith(page, 'ZULU')).toHaveCount(1);
    await expect(assistantWith(page, 'ZULU')).toHaveCount(1);

    // A new turn after the reload appends correctly, and the reconciled seam
    // stays single (no duplicate crept in from the seed/live overlap).
    await send(page, 'Say "YANKEE"');
    await expect(assistantWith(page, 'YANKEE')).toHaveCount(1, { timeout: 60_000 });
    await expect(messages(page)).toHaveCount(4);
    await expect(assistantWith(page, 'ZULU')).toHaveCount(1);
  });

  test('client-tool suspend/resume: a run that suspends for getLocation persists whole and reloads without duplication', async ({
    browser,
  }, testInfo) => {
    // "what's the weather like?" makes the agent call getLocation (a
    // client-executed tool). The run SUSPENDS after the tool call; the browser
    // resolves geolocation and the client resumes the run under the same runId.
    // Because run.messages spans the whole suspend/resume run, the single
    // persist at completion captures the question, the tool call, and the final
    // answer — so a reload reconstructs the turn once, with no duplication.
    const context = await browser.newContext({
      permissions: ['geolocation'],
      geolocation: { latitude: 51.5074, longitude: -0.1278 },
    });
    const page = await context.newPage();
    try {
      const url = seededChannelUrl(testInfo.title);
      await page.goto(url);

      await send(page, "what's the weather like?");

      // The location card renders once the client tool resolves and the run
      // resumes; then the continuation streams the weather answer.
      const locationCard = page.locator('text=/Location:\\s*51\\./').first();
      await expect(locationCard).toBeVisible({ timeout: 60_000 });
      await awaitStreamingQuiesce(page);

      // The completed turn: the user question, the assistant tool-call bubble,
      // and the assistant answer. Snapshot the count so the reload can match it.
      await expect(userWith(page, "what's the weather like?")).toHaveCount(1);
      const countBeforeReload = await messages(page).count();
      expect(countBeforeReload).toBeGreaterThanOrEqual(2);

      // Let the store write and channel history settle before reloading.
      await page.waitForTimeout(3000);

      // Reload: the persisted whole run seeds useChat and reconciles with the
      // live channel at the seam. The reconstructed conversation shows the
      // original question, the tool call, and the final answer with no
      // duplication.
      await page.goto(url);
      await expect(userWith(page, "what's the weather like?")).toHaveCount(1, { timeout: 60_000 });
      await expect(page.locator('text=/Location:\\s*51\\./').first()).toBeVisible({ timeout: 60_000 });
      await page.waitForTimeout(3000);
      await expect(userWith(page, "what's the weather like?")).toHaveCount(1);
      await expect(messages(page)).toHaveCount(countBeforeReload);
    } finally {
      await context.close();
    }
  });

  test('approval-gated tool: an approved forecast run reloads with the tool-call message still shown as approved', async ({
    page,
  }, testInfo) => {
    // "what's the weather forecast for London?" makes the agent call
    // getWeatherForecast, gated on approval. The run SUSPENDS at
    // approval-requested; approving resumes it under the same runId, the tool
    // executes, and the whole run persists at completion. After a reload the
    // approved tool-call message stays mutable — it shows the forecast result,
    // not a fresh Approve/Deny prompt.
    const url = seededChannelUrl(testInfo.title);
    await page.goto(url);

    await send(page, "what's the weather forecast for London?");

    const approveButton = page.getByRole('button', { name: /Approve/i }).first();
    await expect(approveButton).toBeVisible({ timeout: 60_000 });
    await approveButton.click();

    // After approval the forecast card renders and the run completes.
    await expect(page.locator('text=/5-Day Forecast/').first()).toBeVisible({ timeout: 60_000 });
    await awaitStreamingQuiesce(page);
    await expect(userWith(page, 'forecast for London')).toHaveCount(1);
    const countBeforeReload = await messages(page).count();

    await page.waitForTimeout(3000);

    // Reload: the completed run seeds from the store and reconciles with the
    // channel. The tool-call message is shown as approved (the forecast card),
    // and no Approve/Deny prompt reappears.
    await page.goto(url);
    await expect(userWith(page, 'forecast for London')).toHaveCount(1, { timeout: 60_000 });
    await expect(page.locator('text=/5-Day Forecast/').first()).toBeVisible({ timeout: 60_000 });
    await page.waitForTimeout(3000);
    await expect(page.getByRole('button', { name: /Approve/i })).toHaveCount(0);
    await expect(messages(page)).toHaveCount(countBeforeReload);
  });
});
