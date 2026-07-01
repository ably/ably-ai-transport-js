import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Each test gets its own pinned channel so a flaky run can't poison the shared
 * "auto-generated channel" path. The `?channel=` query param is honoured by the
 * page.tsx demo entry point. The `ai:` prefix matches the Ably channel
 * namespace where the mutableMessages feature is enabled — required for
 * streaming appends.
 */
function freshChannel(testTitle: string): string {
  const slug = testTitle
    .replaceAll(/[^a-z0-9]+/gi, '-')
    .replaceAll(/^-|-$/g, '')
    .toLowerCase();
  const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  return `ai:e2e-${slug}-${stamp}`;
}

function channelUrl(channel: string, clientId?: string): string {
  const params = new URLSearchParams({ channel });
  if (clientId) params.set('clientId', clientId);
  return `/?${params.toString().replaceAll('%3A', ':')}`;
}

// `MessageBubble` always renders a `.max-w-[75%]` wrapper containing the bubble
// body and (when not streaming) an action bar with role-specific buttons.
function allBubbles(page: Page): Locator {
  return page.locator('div.max-w-\\[75\\%\\]');
}

// Edit button is rendered only on user bubbles; Regenerate only on assistant
// bubbles. Both are hidden during streaming. Identifying bubbles by the buttons
// they expose is robust to badge / structure changes.
function userBubbles(page: Page): Locator {
  return allBubbles(page).filter({ has: page.locator('button[title="Edit message"]') });
}
function assistantBubbles(page: Page): Locator {
  return allBubbles(page).filter({ has: page.locator('button[title="Regenerate response"]') });
}

async function waitForAssistantSettled(page: Page, timeoutMs = 60_000): Promise<void> {
  // Wait until no run is in flight (Stop is gone), no bubble's StatusBadge
  // still says "streaming", and the latest assistant bubble has text.
  await expect(page.getByRole('button', { name: /Stop/i })).toHaveCount(0, { timeout: timeoutMs });
  await expect(page.locator('span:has(span:text-is("status")):has(span:text-is("streaming"))')).toHaveCount(0, {
    timeout: timeoutMs,
  });
  await expect
    .poll(
      async () => {
        const count = await assistantBubbles(page).count();
        if (count === 0) return 0;
        return (await bubbleText(assistantBubbles(page).last())).length;
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

async function branchCounter(bubble: Locator): Promise<string | null> {
  const counter = bubble.locator('span.tabular-nums');
  if ((await counter.count()) === 0) return null;
  return (await counter.first().innerText()).trim();
}

async function bubbleText(bubble: Locator): Promise<string> {
  // The bubble body div has class beginning with "rounded-lg".
  const body = bubble.locator('div.rounded-lg').first();
  if ((await body.count()) === 0) return (await bubble.innerText()).trim();
  return (await body.innerText()).trim();
}

// Click Edit on a user bubble and submit a replacement. The Edit button is
// replaced by a textarea + Save/Cancel during edit mode, so pull the textarea
// off the page itself.
async function editAndSubmit(page: Page, userBubble: Locator, newText: string): Promise<void> {
  await userBubble.locator('button[title="Edit message"]').click();
  const ta = page.locator('textarea').first();
  await ta.fill(newText);
  await ta.press('Enter');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('openai use-client-session demo - text chat behaviour', () => {
  test('fresh send: response streams and renders', async ({ page }, testInfo) => {
    await page.goto(channelUrl(freshChannel(testInfo.title)));

    const input = page.getByPlaceholder('Type a message...');
    await input.waitFor({ state: 'visible' });
    const sentinel = 'PROMPT-XYZZY-42';
    await input.fill(`Reply with one short sentence acknowledging the marker ${sentinel}.`);
    await input.press('Enter');

    // The FIRST bubble in DOM order is the user prompt; assert it carries the
    // marker (an assistant echo must not double-match).
    await expect.poll(async () => bubbleText(allBubbles(page).first()), { timeout: 10_000 }).toContain(sentinel);

    await waitForAssistantSettled(page);
    const text = await bubbleText(assistantBubbles(page).last());
    expect(text.length).toBeGreaterThan(0);
  });

  test('server-side tool: a weather prompt renders the weather card and a reply', async ({ page }, testInfo) => {
    await page.goto(channelUrl(freshChannel(testInfo.title)));

    const input = page.getByPlaceholder('Type a message...');
    await input.waitFor({ state: 'visible' });
    await input.fill("what's the weather in London?");
    await input.press('Enter');

    // The agent runs getWeather server-side within the run, streams the result
    // back as a weather card, then the model replies — no suspend.
    await waitForAssistantSettled(page);

    // The WeatherCard renders the structured tool output (humidity/wind are
    // distinctive to it); the trailing text reply names the location.
    const assistant = assistantBubbles(page).last();
    await expect(assistant).toContainText('Humidity:', { timeout: 30_000 });
    await expect(assistant).toContainText('London');
  });

  test('suggestion chip: prefills the weather prompt, and the step drops off once demonstrated', async ({
    page,
  }, testInfo) => {
    await page.goto(channelUrl(freshChannel(testInfo.title)));

    const input = page.getByPlaceholder('Type a message...');
    await input.waitFor({ state: 'visible' });

    // The "Server tool" chip is offered until the getWeather tool has run.
    const chip = page.getByRole('button', { name: /Server tool/ });
    await expect(chip).toBeVisible();

    // Clicking it prefills the input (it does not auto-send).
    await chip.click();
    await expect(input).toHaveValue("what's the weather in Tokyo?");

    await input.press('Enter');
    await waitForAssistantSettled(page);
    await expect(assistantBubbles(page).last()).toContainText('Humidity:', { timeout: 30_000 });

    // The completed step drops off the chip row.
    await expect(chip).toHaveCount(0);
  });

  test('regenerate: original user prompt stays visible and the assistant shows branch nav (N / 2)', async ({
    page,
  }, testInfo) => {
    await page.goto(channelUrl(freshChannel(testInfo.title)));
    await sendPrompt(page, 'Say "first" as your entire reply.');

    await expect(userBubbles(page)).toHaveCount(1);
    await expect(assistantBubbles(page)).toHaveCount(1);

    await assistantBubbles(page)
      .last()
      .getByRole('button', { name: /regenerate/i })
      .click();
    await page.waitForTimeout(1000);
    await waitForAssistantSettled(page);

    // The original user prompt must still be on the visible chain.
    await expect(userBubbles(page), 'user prompt must remain visible after regenerate').toHaveCount(1);
    expect(await bubbleText(userBubbles(page).first())).toContain('first');

    // The assistant must show a branch counter with denominator 2; the user
    // prompt (not the branch anchor for a regenerate) must not.
    expect(await branchCounter(assistantBubbles(page).last())).toMatch(/^\d+ \/ 2$/);
    expect(await branchCounter(userBubbles(page).first())).toBeNull();
  });

  test('edit: user prompt shows branch nav and only the edited branch is visible', async ({ page }, testInfo) => {
    await page.goto(channelUrl(freshChannel(testInfo.title)));
    await sendPrompt(page, 'Say "alpha" as your entire reply.');

    const userBubbleStable = allBubbles(page).first();
    expect(await bubbleText(userBubbleStable)).toContain('alpha');

    await editAndSubmit(page, userBubbleStable, 'Say "bravo" as your entire reply.');
    await page.waitForTimeout(1000);
    await waitForAssistantSettled(page);

    await expect(userBubbles(page)).toHaveCount(1);
    await expect(assistantBubbles(page)).toHaveCount(1);

    const editedUserText = await bubbleText(userBubbles(page).first());
    expect(editedUserText).toContain('bravo');
    expect(editedUserText).not.toContain('alpha');

    // The user bubble is the branch anchor for an edit (2/2); the assistant is not.
    expect(await branchCounter(userBubbles(page).first())).toMatch(/^\d+ \/ 2$/);
    expect(await branchCounter(assistantBubbles(page).first())).toBeNull();
  });

  test('three-prompt edit chain P1 -> P2 -> P3 navigates correctly', async ({ page }, testInfo) => {
    await page.goto(channelUrl(freshChannel(testInfo.title)));
    await sendPrompt(page, 'Say "alpha" as your entire reply.');

    const userBubbleStable = allBubbles(page).first();
    await editAndSubmit(page, userBubbleStable, 'Say "bravo" as your entire reply.');
    await page.waitForTimeout(1000);
    await waitForAssistantSettled(page);
    await expect.poll(async () => branchCounter(userBubbles(page).first())).toBe('2 / 2');

    await editAndSubmit(page, userBubbleStable, 'Say "charlie" as your entire reply.');
    await page.waitForTimeout(1000);
    await waitForAssistantSettled(page);
    await expect.poll(async () => bubbleText(userBubbles(page).first())).toContain('charlie');
    await expect.poll(async () => branchCounter(userBubbles(page).first())).toBe('3 / 3');

    // Navigate back through the chain.
    await userBubbles(page).first().locator('button[title="Previous branch"]').click();
    await expect.poll(async () => bubbleText(userBubbles(page).first())).toContain('bravo');
    await expect.poll(async () => branchCounter(userBubbles(page).first())).toBe('2 / 3');

    await userBubbles(page).first().locator('button[title="Previous branch"]').click();
    await expect.poll(async () => bubbleText(userBubbles(page).first())).toContain('alpha');
    await expect.poll(async () => branchCounter(userBubbles(page).first())).toBe('1 / 3');
  });

  test('multiple regen on different prompts: each prompt has its own independent regen group', async ({
    page,
  }, testInfo) => {
    await page.goto(channelUrl(freshChannel(testInfo.title)));
    await sendPrompt(page, 'Say "first-one" as your entire reply.');

    await assistantBubbles(page)
      .last()
      .getByRole('button', { name: /regenerate/i })
      .click();
    await page.waitForTimeout(1000);
    await waitForAssistantSettled(page);
    await expect.poll(async () => branchCounter(assistantBubbles(page).last())).toBe('2 / 2');

    await sendPrompt(page, 'Say "second-one" as your entire reply.');
    await expect.poll(async () => userBubbles(page).count()).toBe(2);
    await expect.poll(async () => assistantBubbles(page).count()).toBe(2);

    // The first prompt's assistant still shows 2/2; the second has no regen yet.
    await expect(branchCounter(assistantBubbles(page).first())).resolves.toBe('2 / 2');
    await expect(branchCounter(assistantBubbles(page).last())).resolves.toBeNull();

    await assistantBubbles(page)
      .last()
      .getByRole('button', { name: /regenerate/i })
      .click();
    await page.waitForTimeout(1000);
    await waitForAssistantSettled(page);
    await expect.poll(async () => branchCounter(assistantBubbles(page).last())).toBe('2 / 2');
    await expect(branchCounter(assistantBubbles(page).first())).resolves.toBe('2 / 2');
  });

  test('interleaved edit and regenerate keep independent branch groups', async ({ page }, testInfo) => {
    await page.goto(channelUrl(freshChannel(testInfo.title)));
    await sendPrompt(page, 'Say "RED" as your entire reply.');

    await assistantBubbles(page).first().locator('button[title="Regenerate response"]').click();
    await waitForAssistantSettled(page);
    await expect.poll(async () => branchCounter(assistantBubbles(page).first())).toBe('2 / 2');

    await editAndSubmit(page, userBubbles(page).first(), 'Say "GREEN" as your entire reply.');
    await waitForAssistantSettled(page);
    await expect.poll(async () => branchCounter(userBubbles(page).last())).toBe('2 / 2');
    await expect.poll(async () => branchCounter(assistantBubbles(page).last())).toBeNull();

    await assistantBubbles(page).last().locator('button[title="Regenerate response"]').click();
    await waitForAssistantSettled(page);
    await expect.poll(async () => branchCounter(userBubbles(page).last())).toBe('2 / 2');
    await expect.poll(async () => branchCounter(assistantBubbles(page).last())).toBe('2 / 2');
  });

  test('cancelling a streaming response cleans up and re-enables the Send button', async ({ page }, testInfo) => {
    await page.goto(channelUrl(freshChannel(testInfo.title)));
    const input = page.getByPlaceholder('Type a message...');
    await input.waitFor({ state: 'visible' });
    await input.fill('Reply with a very long story about a dragon');
    await input.press('Enter');

    // Wait until the assistant has produced some streamed output before Stop —
    // cancelling the instant Stop appears races the agent's abort listeners.
    const assistantBubble = allBubbles(page).filter({ hasText: /./ }).nth(1);
    await expect(assistantBubble).toBeVisible({ timeout: 30_000 });
    await expect(assistantBubble).toHaveText(/.{40,}/, { timeout: 30_000 });

    const stopButton = page.getByRole('button', { name: /Stop/i });
    await expect(stopButton).toBeVisible();
    await stopButton.click();

    await expect(page.getByRole('button', { name: /Send/i })).toBeVisible({ timeout: 30_000 });
    const streamingBadges = page.locator('span:has(span:text-is("status")):has(span:text-is("streaming"))');
    await expect(streamingBadges).toHaveCount(0, { timeout: 30_000 });
  });

  test('history: a fresh page load rebuilds the conversation from the channel', async ({ page }, testInfo) => {
    const channel = freshChannel(testInfo.title);
    await page.goto(channelUrl(channel));
    await sendPrompt(page, 'Say "remembered" as your entire reply.');
    expect(await bubbleText(assistantBubbles(page).last())).toContain('remembered');

    // Reload: nothing is held in app state, so the session must replay channel
    // history and reconstruct the conversation. Scope to the assistant bubble —
    // the prompt echoes the same word, so a plain text match is ambiguous.
    await page.goto(channelUrl(channel));
    await expect(assistantBubbles(page).filter({ hasText: 'remembered' })).toBeVisible({ timeout: 30_000 });
  });

  test('multi-client sync: a second client on the same channel sees the streamed reply', async ({
    browser,
  }, testInfo) => {
    const channel = freshChannel(testInfo.title);
    const a = await openClient(browser, channel, 'client-a');
    const b = await openClient(browser, channel, 'client-b');
    try {
      await sendPrompt(a.page, 'Say "synced" as your entire reply.');
      // Client B, which never sent anything, must see the assistant reply arrive
      // over the shared channel. Scope to the assistant bubble — the prompt
      // (also synced over) echoes the same word, so a plain text match is ambiguous.
      await expect(assistantBubbles(b.page).filter({ hasText: 'synced' })).toBeVisible({ timeout: 30_000 });
    } finally {
      await a.context.close();
      await b.context.close();
    }
  });
});

async function openClient(browser: Browser, channel: string, clientId: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(channelUrl(channel, clientId));
  await page.getByPlaceholder('Type a message...').waitFor({ state: 'visible' });
  return { context, page };
}
