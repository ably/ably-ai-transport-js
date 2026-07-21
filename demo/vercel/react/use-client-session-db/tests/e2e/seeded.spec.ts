import { expect, test, type Locator, type Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Database hydration — DB seed ⧺ live channel reconciliation (core seam walk)
// ---------------------------------------------------------------------------
//
// The agent persists each completed run's whole turn to the in-memory store and
// the demo fetches it as a seed on load. `useMessagesWithSeed` then walks the
// live channel back to the seam (the newest seed message) and composes seed ⧺
// live with no duplicate. Because `run.messages` spans a whole suspend/resume
// run, the single persist at completion is lossless — a client-tool or approval
// turn (tool call + result) comes back as one unit after a reload. This proves
// the "compose a database with the channel" recipe over real Ably history
// across a page reload, including tool turns that suspend and resume.

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

// The linear chat renders each message through the shadcn Message primitive,
// tagged with data-testid="message-bubble".
function bubbleContaining(page: Page, text: string | RegExp): Locator {
  return page.locator('[data-testid="message-bubble"]').filter({ hasText: text });
}

function messages(page: Page): Locator {
  return page.locator('[data-testid="message-bubble"]');
}

async function send(page: Page, text: string): Promise<void> {
  const input = page.getByPlaceholder('Type a message...');
  await input.waitFor({ state: 'visible' });
  await input.fill(text);
  await input.press('Enter');
}

// Poll body text length until it stops changing for 3 successive 1-second
// intervals. The agent's streamText pipeline finishes emitting chunks well
// before the run-end wire lands; this gives a continuation a chance to fully
// publish before we measure.
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

test.describe('use-client-session-db database hydration - DB seed reconciliation', () => {
  test('reload convergence: a persisted turn reconciles with the live channel without duplication', async ({
    page,
  }, testInfo) => {
    const url = seededChannelUrl(testInfo.title);
    await page.goto(url);

    // First turn on a fresh channel — the store is empty, so this is the plain
    // live path. The mock LLM replies with the quoted word, and the agent
    // persists the completed turn.
    await send(page, 'Say "ZULU"');
    await expect(bubbleContaining(page, 'ZULU')).toHaveCount(1, { timeout: 60_000 });
    await expect(messages(page)).toHaveCount(2);

    // Let the streamed turn settle so channel history is durably persisted and
    // the agent's store write has landed before the reload reconstructs.
    await page.waitForTimeout(3000);

    // Reload: the demo re-seeds from the store (/api/messages) and
    // useMessagesWithSeed walks the live channel back to the seam and composes
    // seed ⧺ live.
    await page.goto(url);

    // The conversation comes back — the persisted prefix plus the live tail —
    // with the seam (the assistant reply) shown exactly once. Allow time for
    // channel history to hydrate so a duplicate would have surfaced.
    await expect(messages(page)).toHaveCount(2, { timeout: 60_000 });
    await page.waitForTimeout(3000);
    await expect(messages(page)).toHaveCount(2);
    await expect(bubbleContaining(page, 'ZULU')).toHaveCount(2);

    // A new turn after the reload appends correctly, and the reconciled seam
    // stays single (no duplicate crept in from the seed/live overlap).
    await send(page, 'Say "YANKEE"');
    await expect(bubbleContaining(page, 'YANKEE')).toHaveCount(2, { timeout: 60_000 });
    await expect(messages(page)).toHaveCount(4);
  });

  test('client-tool suspend/resume persists as one turn and reconciles on reload without duplication', async ({
    browser,
  }, testInfo) => {
    // "what's the weather like?" → the agent calls getLocation (client tool).
    // The run SUSPENDS; the client runs browser geolocation, publishes the
    // result, and sends a continuation that RESUMES the same run, which then
    // streams the weather answer and completes. The whole suspend/resume turn
    // (tool call + result + final text) persists as one unit — so after a
    // reload the conversation rebuilds with the original question, the tool
    // call, and the final answer, each shown exactly once.
    const context = await browser.newContext({
      permissions: ['geolocation'],
      geolocation: { latitude: 51.5074, longitude: -0.1278 },
    });
    const page = await context.newPage();
    try {
      const url = seededChannelUrl(testInfo.title);
      await page.goto(url);

      await send(page, "what's the weather like?");

      // The client tool resolves and its output appears as the Location card.
      await expect(page.locator('text=/Location:\\s*51\\./').first()).toBeVisible({ timeout: 60_000 });

      // The resumed run streams the weather sentence and completes. Match on
      // "sunny" — unique to the answer bubble; "weather" would also match the
      // user question and "location" the Location card (strict-mode violation).
      await expect(bubbleContaining(page, /sunny/i)).toBeVisible({ timeout: 60_000 });
      await awaitStreamingQuiesce(page);

      // Let the completed run's store write land, then reload and reconcile.
      await page.waitForTimeout(3000);
      const countBeforeReload = await messages(page).count();
      await page.goto(url);

      // The whole turn rebuilds from the DB seed ⧺ live channel: the original
      // question and the Location card each appear exactly once (the tool turn
      // was persisted as one lossless unit — no duplication at the seam).
      await expect(bubbleContaining(page, "what's the weather like?")).toHaveCount(1, { timeout: 60_000 });
      await page.waitForTimeout(3000);
      await expect(page.locator('text=/Location:\\s*51\\./')).toHaveCount(1);
      await expect(messages(page)).toHaveCount(countBeforeReload);
    } finally {
      await context.close();
    }
  });

  test('approval-gated tool: approved tool-call message still shows approved after reload', async ({
    page,
  }, testInfo) => {
    // "what's the weather forecast for London?" → the agent calls
    // getWeatherForecast, which pauses at approval-requested and SUSPENDS the
    // run. Approving publishes a tool-approval-response; the agent RESUMES,
    // executes the tool, and folds the forecast output onto the original
    // assistant message. That whole approval turn persists as one unit — so
    // after a reload the tool-call message is rehydrated from the DB still
    // showing the approved forecast (the Approve/Deny card does NOT reappear).
    const url = seededChannelUrl(testInfo.title);
    await page.goto(url);

    await send(page, "what's the weather forecast for London?");

    const approveButton = page.getByRole('button', { name: /Approve/i }).first();
    await expect(approveButton).toBeVisible({ timeout: 60_000 });
    await approveButton.click();

    // The forecast card renders once the resumed run executes the tool.
    await expect(page.locator('text=/5-Day Forecast/i').first()).toBeVisible({ timeout: 60_000 });
    await awaitStreamingQuiesce(page);
    // The approval card is gone once approved.
    await expect(page.getByRole('button', { name: /Approve/i })).toHaveCount(0);

    // Let the completed run persist, then reload and reconcile.
    await page.waitForTimeout(3000);
    await page.goto(url);

    // After reload the approved tool-call message is rehydrated from the DB:
    // the forecast card is shown and no fresh approval is requested.
    await expect(bubbleContaining(page, "what's the weather forecast for London?")).toHaveCount(1, { timeout: 60_000 });
    await expect(page.locator('text=/5-Day Forecast/i').first()).toBeVisible({ timeout: 60_000 });
    await page.waitForTimeout(3000);
    await expect(page.getByRole('button', { name: /Approve/i })).toHaveCount(0);
  });

  test('steer during approval suspension: the tool resolves and the steer is answered', async ({ page }, testInfo) => {
    // "what's the weather forecast for London?" → the agent calls
    // getWeatherForecast and SUSPENDS at approval-requested. While suspended the
    // user steers the run with `/steer Say "STEERED"` — a follow-up user message
    // that folds into the SAME run. Approving then resumes it.
    //
    // On resume the run owes a tool_result for the approved call, but the SDK
    // defers the unresponded steer to the tail of getMessages(). Feeding that
    // straight to the model would sit a user message after an open tool_use with
    // no tool_result between them — the model rejects it and the run errors. The
    // route resolves the approved tool first (on a conversation trimmed to the
    // last assistant), then a later steering-loop pass answers the steer. So the
    // forecast card renders AND the steered reply appears, with no error.
    const url = seededChannelUrl(testInfo.title);
    await page.goto(url);

    await send(page, "what's the weather forecast for London?");

    const approveButton = page.getByRole('button', { name: /Approve/i }).first();
    await expect(approveButton).toBeVisible({ timeout: 60_000 });

    // Steer while the run is suspended for approval.
    await send(page, '/steer Say "STEERED"');

    // Approve: resume, resolve the tool, then answer the steer.
    await approveButton.click();

    // The approved tool executes (forecast card) AND the steered reply lands.
    await expect(page.locator('text=/5-Day Forecast/i').first()).toBeVisible({ timeout: 60_000 });
    await expect(bubbleContaining(page, 'STEERED')).toBeVisible({ timeout: 60_000 });
    await awaitStreamingQuiesce(page);
    // The run reached completion cleanly — no stuck approval card.
    await expect(page.getByRole('button', { name: /Approve/i })).toHaveCount(0);
  });
});
