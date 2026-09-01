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

// MessageBubble renders its root with data-testid="message-bubble" and the
// message's role on data-role, so bubbles are identified by role directly.
function userBubbles(page: Page): Locator {
  return page.locator('[data-testid="message-bubble"][data-role="user"]');
}
function assistantBubbles(page: Page): Locator {
  return page.locator('[data-testid="message-bubble"][data-role="assistant"]');
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

async function bubbleText(bubble: Locator): Promise<string> {
  // The bubble body carries a stable data-slot; targeting it excludes the
  // badge footer, which a class-name selector plus an innerText fallback used
  // to let through — making "has text" assertions pass on badge text alone.
  return (await bubble.locator('[data-slot="bubble-content"]').first().innerText()).trim();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('openai responses-transport demo - text chat behaviour', () => {
  test('fresh send: response streams and renders', async ({ page }, testInfo) => {
    await page.goto(channelUrl(freshChannel(testInfo.title)));

    const input = page.getByPlaceholder('Type a message...');
    await input.waitFor({ state: 'visible' });
    const sentinel = 'PROMPT-XYZZY-42';
    await input.fill(`Reply with one short sentence acknowledging the marker ${sentinel}.`);
    await input.press('Enter');

    // The user bubble carries the marker (an assistant echo must not double-match).
    await expect.poll(async () => bubbleText(userBubbles(page).first()), { timeout: 10_000 }).toContain(sentinel);

    await waitForAssistantSettled(page);
    const text = await bubbleText(assistantBubbles(page).last());
    expect(text.length).toBeGreaterThan(0);
  });

  test('reasoning: a reasoning prompt streams a thinking summary before the reply', async ({ page }, testInfo) => {
    await page.goto(channelUrl(freshChannel(testInfo.title)));

    const input = page.getByPlaceholder('Type a message...');
    await input.waitFor({ state: 'visible' });
    await input.fill('think through the 12-ball puzzle');
    await input.press('Enter');

    await waitForAssistantSettled(page);
    // The mock streams a reasoning summary as a reasoning item; the bubble shows
    // it as a muted "thinking" block, distinct from the answer text.
    const assistant = assistantBubbles(page).last();
    await expect(assistant).toContainText('💭 thinking');
    await expect(assistant).toContainText('Split the 12 balls');
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

    // A tool run publishes three messages, each merged as its own assistant
    // bubble: the model turn carrying the getWeather call (where the WeatherCard
    // renders its structured output — humidity/wind are distinctive to it), the
    // tool output (hidden — it renders on the call's bubble), then the trailing
    // text reply. The card lands on the call bubble; the reply naming the
    // location lands on the last bubble.
    await expect(assistantBubbles(page).filter({ hasText: 'Humidity:' })).toBeVisible({ timeout: 30_000 });
    await expect(assistantBubbles(page).last()).toContainText('London');
  });

  test('approval-gated tool: approving runs the tool server-side and the reply lands', async ({ page }, testInfo) => {
    await page.goto(channelUrl(freshChannel(testInfo.title)));

    // A forecast prompt calls the gated getWeatherForecast, so the agent publishes
    // an approval request on the call's own message and suspends the run.
    await sendPrompt(page, "what's the weather forecast for Paris?");
    const approve = page.getByRole('button', { name: 'Approve' });
    await expect(approve).toHaveCount(1);

    // Approving publishes the decision and wakes the run. The agent runs the
    // approved call server-side on resume, so the ForecastCard renders its output
    // (the 5-day rows) and the model's reply follows.
    await approve.click();
    await waitForAssistantSettled(page);
    await expect(page.getByText('5-day forecast', { exact: true })).toBeVisible();
    await expect(assistantBubbles(page).last()).toContainText('Paris');
    // The approval card is answered, so the prompt is gone.
    await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);
  });

  test('approval-gated tool: denying resolves the call without running it', async ({ page }, testInfo) => {
    await page.goto(channelUrl(freshChannel(testInfo.title)));

    await sendPrompt(page, "what's the weather forecast for Paris?");
    const deny = page.getByRole('button', { name: 'Deny' });
    await expect(deny).toHaveCount(1);

    // A denial publishes the decision plus a rejection output rather than
    // running the tool, so the run still resumes — the model acknowledges
    // instead of forecasting, and no forecast card is rendered.
    await deny.click();
    await waitForAssistantSettled(page);
    await expect(page.getByText(/getWeatherForecast\s*—\s*denied/)).toBeVisible();
    await expect(page.getByText('5-day forecast', { exact: true })).toHaveCount(0);
    await expect(assistantBubbles(page).last()).toContainText('not fetch the forecast');
  });

  test('client-side tool: getLocation runs in the browser and its result resumes the run', async ({
    browser,
  }, testInfo) => {
    // The client tool needs real browser geolocation, so grant it and pin the
    // coordinates the LocationCard should render.
    const context = await browser.newContext({
      permissions: ['geolocation'],
      geolocation: { latitude: 51.5074, longitude: -0.1278 },
    });
    const page = await context.newPage();

    try {
      await page.goto(channelUrl(freshChannel(testInfo.title)));

      // getLocation has no server executor, so the agent suspends the run and
      // waits for the browser. useClientTools sees the unresolved call on a
      // suspended run it initiated, runs geolocation, and publishes the result.
      await sendPrompt(page, 'where am I?');
      await expect(page.getByText(/Location:\s*51\.5074, -0\.1278/)).toBeVisible({ timeout: 60_000 });

      // The published result answers the run's only call, so the continuation
      // goes out and the model replies.
      await waitForAssistantSettled(page);
      await expect(assistantBubbles(page).last()).toContainText('current location');

      // The resolved call is merged into channel history, so a fresh load rebuilds
      // it — and the tool must not re-execute or sit unresolved.
      await page.reload();
      await expect(page.getByText(/Location:\s*51\.5074, -0\.1278/)).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText(/Calling getLocation/)).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test('two gated calls in one turn: the run resumes only after both are decided', async ({ page }, testInfo) => {
    await page.goto(channelUrl(freshChannel(testInfo.title)));

    // A forecast prompt naming two places emits two approval-gated calls on one
    // model turn, so the run suspends holding two undecided calls.
    await sendPrompt(page, "what's the weather forecast for Paris and London?");
    await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(2);

    // Deciding one call must NOT wake the agent: resuming now would hand the
    // model a function_call with no output, which the provider rejects. Give the
    // agent time to respond if it were woken, then assert it was not.
    await page.getByRole('button', { name: 'Approve' }).first().click();
    await page.waitForTimeout(3000);
    await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(1);
    await expect(page.getByText(/5-day forecast/i)).toHaveCount(0);

    // The second decision answers the run's last call, so the continuation goes
    // out, both approved calls run server-side, and the reply covers both places.
    await page.getByRole('button', { name: 'Approve' }).click();
    await waitForAssistantSettled(page);
    await expect(assistantBubbles(page).last()).toContainText('Paris and London');
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
    // The WeatherCard renders on the bubble carrying the getWeather call, not
    // the trailing reply bubble.
    await expect(assistantBubbles(page).filter({ hasText: 'Humidity:' })).toBeVisible({ timeout: 30_000 });

    // The completed step drops off the chip row.
    await expect(chip).toHaveCount(0);
  });

  test('cancelling a streaming response cleans up and re-enables the Send button', async ({ page }, testInfo) => {
    await page.goto(channelUrl(freshChannel(testInfo.title)));
    const input = page.getByPlaceholder('Type a message...');
    await input.waitFor({ state: 'visible' });
    await input.fill('Reply with a very long story about a dragon');
    await input.press('Enter');

    // Wait until the assistant has produced some streamed output before Stop —
    // cancelling the instant Stop appears races the agent's abort listeners.
    const assistantBubble = assistantBubbles(page).first();
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

    // Reload: nothing is held in app state, so the client must page channel
    // history and remerge the thread. Scope to the assistant bubble — the
    // prompt echoes the same word, so a plain text match is ambiguous.
    await page.goto(channelUrl(channel));
    await expect(assistantBubbles(page).filter({ hasText: 'remembered' })).toBeVisible({ timeout: 30_000 });
  });

  test('mid-run reload: hydrated history and the live continuation merge to one message', async ({
    page,
  }, testInfo) => {
    const channel = freshChannel(testInfo.title);
    await page.goto(channelUrl(channel));
    const input = page.getByPlaceholder('Type a message...');
    await input.waitFor({ state: 'visible' });
    // The mock streams the dragon story slowly, so the reload lands mid-stream.
    await input.fill('Reply with a very long story about a dragon');
    await input.press('Enter');

    // Wait for some streamed output, then reload while the run is in flight.
    const streaming = assistantBubbles(page).first();
    await expect(streaming).toBeVisible({ timeout: 30_000 });
    await expect(streaming).toHaveText(/.{40,}/, { timeout: 30_000 });
    await page.reload();

    // The reloaded page hydrates the partial history and merges the live
    // continuation into the SAME message: exactly one assistant bubble, which
    // grows to the full story with no duplicated prefix. Wait on the story's
    // closing sentence rather than the settle helper alone — right after the
    // reload the run state has not merged yet, so a settle check can slip
    // through on the hydrated partial while the live half is still streaming.
    await expect(assistantBubbles(page).last()).toContainText('her patience grew as steadily as her wings.', {
      timeout: 60_000,
    });
    await waitForAssistantSettled(page);
    await expect(assistantBubbles(page)).toHaveCount(1);
    const text = await bubbleText(assistantBubbles(page).last());
    expect(text).toContain('Once upon a time');
    expect(text).toContain('her patience grew as steadily as her wings.');
    // The opening words appear exactly once — the history half and the live
    // half were merged, not concatenated as duplicates.
    expect(text.indexOf('Once upon a time')).toBe(text.lastIndexOf('Once upon a time'));
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
