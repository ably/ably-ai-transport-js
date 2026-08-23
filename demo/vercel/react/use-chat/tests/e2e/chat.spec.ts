import { expect, test, type Locator, type Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Each test gets its own pinned channel so a flaky LLM run can't poison the
 * shared "auto-generated channel" path. The `?channel=` query param is
 * honoured by the page.tsx demo entry point.
 */
function freshChannelUrl(testTitle: string): string {
  const slug = testTitle
    .replaceAll(/[^a-z0-9]+/gi, '-')
    .replaceAll(/^-|-$/g, '')
    .toLowerCase();
  const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  // The `ai:` prefix matches the Ably channel namespace where the
  // mutableMessages feature is enabled — required for streaming appends.
  return `/?channel=ai:e2e-${slug}-${stamp}`;
}

// The linear transcript wraps each message in a `[data-testid="message"]`
// element carrying `data-role` and (while streaming) `data-state`.
function userMessages(page: Page): Locator {
  return page.locator('[data-testid="message"][data-role="user"]');
}
function assistantMessages(page: Page): Locator {
  return page.locator('[data-testid="message"][data-role="assistant"]');
}
function streamingMessages(page: Page): Locator {
  return page.locator('[data-testid="message"][data-state="streaming"]');
}

async function messageText(message: Locator): Promise<string> {
  // The bubble body is the shadcn BubbleContent (data-slot="bubble-content").
  const body = message.locator('[data-slot="bubble-content"]').first();
  if ((await body.count()) === 0) return (await message.innerText()).trim();
  return (await body.innerText()).trim();
}

async function waitForAssistantSettled(page: Page, timeoutMs = 60_000): Promise<void> {
  // Wait until: (1) no run is in flight (the Stop button is gone), (2) no
  // message still renders in the streaming state, and (3) the latest
  // assistant message has rendered text.
  await expect(page.getByRole('button', { name: /Stop/i })).toHaveCount(0, { timeout: timeoutMs });
  await expect(streamingMessages(page)).toHaveCount(0, { timeout: timeoutMs });
  await expect
    .poll(
      async () => {
        const count = await assistantMessages(page).count();
        if (count === 0) return 0;
        const txt = await messageText(assistantMessages(page).last());
        return txt.length;
      },
      { timeout: timeoutMs },
    )
    .toBeGreaterThan(0);
  await page.waitForTimeout(500);
}

async function sendPrompt(page: Page, text: string): Promise<void> {
  const input = page.getByPlaceholder('Type a message...');
  await input.waitFor({ state: 'visible' });
  await input.fill(text);
  await input.press('Enter');
  await waitForAssistantSettled(page);
}

// Poll body text length until it stops changing for 3 successive 1-second
// intervals, so a suspended run's continuation has time to fully publish
// before assertions.
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('use-chat demo - chat behaviour', () => {
  // checks: a fresh send streams a reply and renders both turns.
  test('fresh send: response streams and renders', async ({ page }, testInfo) => {
    await page.goto(freshChannelUrl(testInfo.title));

    const input = page.getByPlaceholder('Type a message...');
    await input.waitFor({ state: 'visible' });
    const sentinel = 'PROMPT-XYZZY-42';
    await input.fill(`Reply with one short sentence acknowledging the marker ${sentinel}.`);
    await input.press('Enter');

    await expect.poll(async () => messageText(userMessages(page).first()), { timeout: 10_000 }).toContain(sentinel);

    await waitForAssistantSettled(page);
    const text = await messageText(assistantMessages(page).last());
    expect(text.length).toBeGreaterThan(0);
  });

  // checks: the agent maintains a LiveObjects checklist; the widget renders the
  // steps and their live progress, and restores them from object sync on reload.
  test('checklist: agent progress renders live and survives reload', async ({ page }, testInfo) => {
    await page.goto(freshChannelUrl(testInfo.title));
    await sendPrompt(page, 'Plan and work through a short checklist for me.');

    // Scope assertions to the checklist widget (a labelled region) so a chat
    // bubble echoing the step text (e.g. the tool-call args) can't satisfy them.
    const widget = page.getByRole('region', { name: 'Agent tasks' });
    await expect(widget.getByText('Gather the requirements')).toBeVisible({ timeout: 15_000 });
    await expect(widget.getByText('Draft the outline')).toBeVisible();
    await expect(widget.getByText('Write the summary')).toBeVisible();
    // The agent flips every step to done, so progress reaches 3 / 3.
    await expect(widget.getByText('3 / 3')).toBeVisible({ timeout: 15_000 });

    // Reload: the checklist comes back from LiveObjects sync on attach.
    await page.reload();
    await expect(widget.getByText('Write the summary')).toBeVisible({ timeout: 15_000 });
    await expect(widget.getByText('3 / 3')).toBeVisible();
  });

  // checks: "weather like?" -> getLocation runs in the browser -> Location card
  // -> continuation weather reply -> the run finishes.
  test('client-side tool: getLocation executes and the continuation completes', async ({ browser }, testInfo) => {
    const context = await browser.newContext({
      permissions: ['geolocation'],
      geolocation: { latitude: 51.5074, longitude: -0.1278 },
    });
    const page = await context.newPage();
    try {
      await page.goto(freshChannelUrl(testInfo.title));

      const input = page.getByPlaceholder('Type a message...');
      await input.waitFor({ state: 'visible' });
      await input.fill("what's the weather like?");
      await input.press('Enter');

      // useChat's onToolCall runs the browser tool with the mocked coordinates,
      // addToolOutput records the result, and the auto-submitted continuation
      // resumes the suspended run — the resolved Location card renders on the
      // assistant's tool part.
      await expect(page.locator('text=/Location:\\s*51\\./').first()).toBeVisible({ timeout: 60_000 });

      // The continuation streams the weather reply and the run finishes: no
      // message stuck streaming, and the composer shows Send again.
      await awaitStreamingQuiesce(page);
      await expect(streamingMessages(page)).toHaveCount(0, { timeout: 30_000 });
      await expect(page.getByRole('button', { name: /Stop/i })).toHaveCount(0);
      await expect(page.getByRole('button', { name: /Send/i })).toBeVisible();

      // Both turns are still rendered after the continuation lands.
      await expect(userMessages(page).first()).toContainText("what's the weather like?");
      await expect(page.locator('text=/Location:\\s*51\\./').first()).toBeVisible();
    } finally {
      await context.close();
    }
  });

  // checks: approval-gated tool; Approve resumes the run and it finishes.
  test('approval-gated tool: approving resumes the run to completion', async ({ page }, testInfo) => {
    await page.goto(freshChannelUrl(testInfo.title));
    const input = page.getByPlaceholder('Type a message...');
    await input.waitFor({ state: 'visible' });
    await input.fill("what's the weather forecast for London?");
    await input.press('Enter');

    // The agent requests approval before executing the forecast tool.
    const approveButton = page.getByRole('button', { name: /Approve/i }).first();
    await expect(approveButton).toBeVisible({ timeout: 60_000 });

    // While the run is suspended awaiting the decision there is no stream to
    // stop, so the composer shows Send.
    await expect(page.getByRole('button', { name: /Send/i })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: /Stop/i })).toHaveCount(0);

    // Approving publishes the decision and auto-submits the continuation; the
    // agent executes the tool and streams the forecast reply to completion.
    await approveButton.click();
    await awaitStreamingQuiesce(page);
    await expect(streamingMessages(page)).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByRole('button', { name: /Stop/i })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Send/i })).toBeVisible();
    await expect(userMessages(page).first()).toContainText("what's the weather forecast for London?");
  });

  // checks: denying an approval-gated tool keeps the conversation alive and
  // lets the run finish without executing the tool.
  test('approval-gated tool: denying completes the run without executing', async ({ page }, testInfo) => {
    await page.goto(freshChannelUrl(testInfo.title));
    const input = page.getByPlaceholder('Type a message...');
    await input.waitFor({ state: 'visible' });
    await input.fill("what's the weather forecast for London?");
    await input.press('Enter');

    const denyButton = page.getByRole('button', { name: /Deny/i }).first();
    await expect(denyButton).toBeVisible({ timeout: 60_000 });
    await denyButton.click();
    await awaitStreamingQuiesce(page);

    await expect(userMessages(page).first()).toContainText("what's the weather forecast for London?");
    await expect(streamingMessages(page)).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByRole('button', { name: /Stop/i })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Send/i })).toBeVisible();
  });

  // checks: Stop mid-stream cancels the run over Ably and re-enables Send.
  test('cancel: stopping a streaming response cleans up and re-enables Send', async ({ page }, testInfo) => {
    await page.goto(freshChannelUrl(testInfo.title));
    const input = page.getByPlaceholder('Type a message...');
    await input.waitFor({ state: 'visible' });
    await input.fill('Tell me a long story about a dragon.');
    await input.press('Enter');

    // Wait until the assistant has actually produced some streamed output
    // before pressing Stop — cancelling the very instant the Stop button
    // appears races the agent's abort listeners.
    const stopButton = page.getByRole('button', { name: /Stop/i });
    await expect(stopButton).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(
        async () => {
          if ((await assistantMessages(page).count()) === 0) return 0;
          return (await messageText(assistantMessages(page).last())).length;
        },
        { timeout: 30_000 },
      )
      .toBeGreaterThan(0);
    await stopButton.click();

    // After cancellation, Send must reappear and nothing stays on streaming.
    await expect(page.getByRole('button', { name: /Send/i })).toBeVisible({ timeout: 30_000 });
    await expect(streamingMessages(page)).toHaveCount(0, { timeout: 30_000 });
  });

  // checks: reloading mid-stream resumes the live run (useChat `resume: true`
  // drives the adapter's reconnectToStream) and the reply completes.
  test('resume: reloading mid-stream reconnects to the live run', async ({ page }, testInfo) => {
    await page.goto(freshChannelUrl(testInfo.title));
    const input = page.getByPlaceholder('Type a message...');
    await input.waitFor({ state: 'visible' });
    await input.fill('Tell me a long story about a dragon.');
    await input.press('Enter');

    // Let the stream start, then reload while the agent is still publishing.
    await expect
      .poll(
        async () => {
          if ((await assistantMessages(page).count()) === 0) return 0;
          return (await messageText(assistantMessages(page).last())).length;
        },
        { timeout: 30_000 },
      )
      .toBeGreaterThan(0);
    await page.reload();

    // The fresh page reconnects to the open run: the assistant reply rebuilds
    // from the run's replay plus the still-live stream, and completes with the
    // story's closing words.
    await expect(page.locator('text=/finish just one of them/').first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('button', { name: /Stop/i })).toHaveCount(0, { timeout: 30_000 });
    await expect(streamingMessages(page)).toHaveCount(0);
  });
});
