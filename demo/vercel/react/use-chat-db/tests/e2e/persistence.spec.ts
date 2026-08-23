import { expect, test, type Locator, type Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Database persistence over the SDK's chat transport
// ---------------------------------------------------------------------------
//
// The demo drives the UI exclusively through `useChat` over the SDK's
// ChatTransport: sends publish to the channel and the run's output chunks
// stream back off the subscription, while the agent route on
// `createAgentTransport` streams each run. The client persists each completed
// turn to the in-memory store from useChat's `onFinish`. Hydration happens
// before the chat mounts: the REST seed plus the channel-history gap back to
// the newest stored message seed `useChat({ messages })` in one shot, and the
// same gap events seed the adapter's wire indices. These tests prove the
// send/stream loop, the two-part hydration across a page reload, and the
// suspend/resume continuations for a client-executed tool and an approval —
// including a continuation issued after a reload, where the suspended run
// lives only in the history gap.

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

test.describe('use-chat-db - useChat persistence over the chat transport', () => {
  test('send/stream: a user message streams the assistant reply through the chat transport', async ({
    page,
  }, testInfo) => {
    const url = seededChannelUrl(testInfo.title);
    await page.goto(url);

    // The transport publishes the user message, POSTs the invocation pointer,
    // and the agent's streamed reply arrives back over the channel.
    await send(page, 'Say "ZULU"');
    await expect(assistantWith(page, 'ZULU')).toHaveCount(1, { timeout: 60_000 });
    await expect(messages(page)).toHaveCount(2);
  });

  test('reload hydration: the REST seed plus the history gap reconstruct the conversation once', async ({
    page,
  }, testInfo) => {
    const url = seededChannelUrl(testInfo.title);
    await page.goto(url);

    await send(page, 'Say "ZULU"');
    await expect(assistantWith(page, 'ZULU')).toHaveCount(1, { timeout: 60_000 });

    // Let the streamed turn settle so channel history is durably persisted and
    // the client's store write has landed before the reload reconstructs.
    await page.waitForTimeout(3000);

    // Reload: hydration fetches the store seed over REST, pages the channel
    // gap back to the newest stored message, and seeds useChat with the merge.
    await page.goto(url);
    await expect(messages(page)).toHaveCount(2, { timeout: 60_000 });
    await page.waitForTimeout(3000);
    await expect(messages(page)).toHaveCount(2);
    await expect(userWith(page, 'ZULU')).toHaveCount(1);
    await expect(assistantWith(page, 'ZULU')).toHaveCount(1);

    // A new turn after the reload appends correctly — the transport keeps
    // driving useChat with no duplicate from the seed/gap overlap.
    await send(page, 'Say "YANKEE"');
    await expect(assistantWith(page, 'YANKEE')).toHaveCount(1, { timeout: 60_000 });
    await expect(messages(page)).toHaveCount(4);
    await expect(assistantWith(page, 'ZULU')).toHaveCount(1);
  });

  test('client-tool suspend/resume: getLocation suspends the run and the continuation streams the answer', async ({
    browser,
  }, testInfo) => {
    // "what's the weather like?" makes the agent call getLocation (a
    // client-executed tool). The run SUSPENDS; the browser resolves
    // geolocation, useChat auto-submits, and the transport publishes the tool
    // result under the suspended run's id and POSTs the continuation.
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

      await expect(userWith(page, "what's the weather like?")).toHaveCount(1);
      const countBeforeReload = await messages(page).count();
      expect(countBeforeReload).toBeGreaterThanOrEqual(2);

      // Let the store write and channel history settle before reloading.
      await page.waitForTimeout(3000);

      // Reload: the completed turn was persisted whole, so the seed + gap
      // merge reconstructs it once — question, tool call, and answer.
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

  test('approval continuation: approving the forecast tool resumes the suspended run', async ({ page }, testInfo) => {
    const url = seededChannelUrl(testInfo.title);
    await page.goto(url);

    // The run suspends at approval-requested; approving publishes the
    // approval-decision body under the run's id and POSTs the continuation.
    await send(page, "what's the weather forecast for London?");
    const approveButton = page.getByRole('button', { name: /Approve/i }).first();
    await expect(approveButton).toBeVisible({ timeout: 60_000 });
    await approveButton.click();

    await expect(page.locator('text=/5-day forecast/i').first()).toBeVisible({ timeout: 60_000 });
    await awaitStreamingQuiesce(page);
    await expect(userWith(page, 'forecast for London')).toHaveCount(1);
    const countBeforeReload = await messages(page).count();

    await page.waitForTimeout(3000);

    // Reload: the completed turn seeds from the store; the tool-call message
    // is shown as approved (the forecast card), with no fresh Approve prompt.
    await page.goto(url);
    await expect(userWith(page, 'forecast for London')).toHaveCount(1, { timeout: 60_000 });
    await expect(page.locator('text=/5-day forecast/i').first()).toBeVisible({ timeout: 60_000 });
    await page.waitForTimeout(3000);
    await expect(page.getByRole('button', { name: /Approve/i })).toHaveCount(0);
    await expect(messages(page)).toHaveCount(countBeforeReload);
  });

  test('continuation across a reload: a run suspended at approval resumes after the page reloads', async ({
    page,
  }, testInfo) => {
    const url = seededChannelUrl(testInfo.title);
    await page.goto(url);

    // Suspend the run at approval-requested, then reload before answering. A
    // suspended run is never persisted, so on reload it lives only in the
    // channel-history gap — hydration folds it and seeds the transport's wire
    // indices with the suspended run's id.
    await send(page, "what's the weather forecast for London?");
    await expect(page.getByRole('button', { name: /Approve/i }).first()).toBeVisible({ timeout: 60_000 });
    await page.waitForTimeout(3000);

    await page.goto(url);

    // The approval prompt is reconstructed from the gap; approving publishes
    // the decision under the suspended run's id (recovered from the gap seed)
    // and the continuation streams the forecast.
    const approveButton = page.getByRole('button', { name: /Approve/i }).first();
    await expect(approveButton).toBeVisible({ timeout: 60_000 });
    await approveButton.click();

    await expect(page.locator('text=/5-day forecast/i').first()).toBeVisible({ timeout: 60_000 });
    await awaitStreamingQuiesce(page);
    await expect(userWith(page, 'forecast for London')).toHaveCount(1);
    await expect(page.getByRole('button', { name: /Approve/i })).toHaveCount(0);
  });
});
