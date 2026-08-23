import { expect, test } from '@playwright/test';

/**
 * A unique channel per test so runs never cross-talk on the shared sandbox app.
 * The mock LLM (`MOCK_LLM=1`, set by the e2e runner) scripts replies from the
 * prompt, so no LLM key is needed.
 */
function freshChannelUrl(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 24);
  const stamp = Date.now().toString(36);
  return `/?channel=ai:e2e-${slug}-${stamp}&clientId=e2e-user`;
}

test.describe('use-chat-wdk — durable text chat', () => {
  test('streams a reply produced by a Vercel Workflow', async ({ page }) => {
    await page.goto(freshChannelUrl('wdk-text'));

    // Send via a predefined prompt chip (tag + prompt): it fills the composer,
    // then Send publishes the input to Ably and starts the workflow, whose
    // activities open the run, stream the reply, and end it — all back over
    // the channel.
    await page.getByRole('button', { name: /Durable text/ }).click();
    await page.getByRole('button', { name: 'Send' }).click();

    // The assistant reply lands in an assistant bubble; the user echo quotes the
    // prompt too, so scope to the assistant side via its role.
    const assistant = page
      .locator('[data-testid="message"][data-role="assistant"]')
      .filter({ hasText: 'Hello from a durable Vercel Workflow!' });
    await expect(assistant).toBeVisible({ timeout: 60_000 });

    // The WDK processes panel visualized the turn: a plain text turn is an
    // open activity, an inference activity, and a terminal activity,
    // correlated under one workflow.
    const wdkPanel = page.locator('aside').filter({ hasText: 'WDK processes' });
    await expect(wdkPanel).toBeVisible();
    await expect(wdkPanel.getByText('open', { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(wdkPanel.getByText('inference', { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(wdkPanel.getByText('terminal', { exact: true })).toBeVisible({ timeout: 30_000 });

    // The run settled cleanly: the composer shows Send again, not Stop.
    await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();
  });

  test('a fail-once fault is retried by WDK and reconciled by AIT (no duplicate)', async ({ page }) => {
    await page.goto(freshChannelUrl('wdk-fault'));

    // Arm the fault so the inference activity throws on its first attempt, then send.
    await page.getByRole('button', { name: 'Fail once' }).click();
    await page.getByPlaceholder('Type a message...').fill('Say "Hello from a durable Vercel Workflow!"');
    await page.getByRole('button', { name: 'Send' }).click();

    // First wait until the retry has LANDED: the WDK processes panel renders a
    // second physical attempt of the inference step once WDK has retried it.
    const wdkPanel = page.locator('aside').filter({ hasText: 'WDK processes' });
    await expect(wdkPanel.getByText('attempt 2', { exact: true })).toBeVisible({ timeout: 90_000 });

    // The reply lands, exactly once: the retry re-entered the SAME run (pinned
    // run id) and the SAME step (stable step id) instead of opening a parallel
    // run beside the dead attempt.
    const assistant = page
      .locator('[data-testid="message"][data-role="assistant"]')
      .filter({ hasText: 'Hello from a durable Vercel Workflow!' });
    await expect(assistant).toBeVisible({ timeout: 60_000 });
    await expect(assistant).toHaveCount(1);

    // Settled cleanly back to the Send state.
    await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();
  });

  test('a fail-once fault on a client-tool turn recovers, and the fault does not leak into the continuation', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['geolocation']);
    await context.setGeolocation({ latitude: 51.5074, longitude: -0.1278 });
    await page.goto(freshChannelUrl('wdk-fault-tool'));

    await page.getByRole('button', { name: 'Fail once' }).click();
    await page.getByPlaceholder('Type a message...').fill("What's the weather like?");
    await page.getByRole('button', { name: 'Send' }).click();

    // The turn settles on the weather reply: the fault is one-shot (the
    // geolocation continuation runs unfaulted), and the retry gates on the
    // run's wire state before publishing, so it drives the turn on without
    // clobbering anything the client already did.
    await expect(
      page.locator('[data-testid="message"][data-role="assistant"]').filter({ hasText: '72°F at your location' }),
    ).toBeVisible({
      timeout: 90_000,
    });

    // The retry is visible in the WDK panel (the died attempt plus its retry),
    // and it clobbered nothing: no message ends in error.
    const wdkPanel = page.locator('aside').filter({ hasText: 'WDK processes' });
    await expect(wdkPanel.getByText('died', { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(wdkPanel.getByText('attempt 2', { exact: true })).toBeVisible();
    await expect(
      page.locator('[data-testid="message"][data-role="assistant"]').getByText('error', { exact: true }),
    ).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();
  });

  test('a server-side tool runs in its own activity and streams its result (over WDK)', async ({ page }) => {
    await page.goto(freshChannelUrl('wdk-server-tool'));

    await page.getByPlaceholder('Type a message...').fill("What's the weather in Tokyo?");
    await page.getByRole('button', { name: 'Send' }).click();

    // getWeather has a server execute, so the workflow runs it in its own tool
    // activity and publishes the result as a step; a follow-up inference then
    // summarises it. The tool activity appears in the WDK processes panel.
    const wdkPanel = page.locator('aside').filter({ hasText: 'WDK processes' });
    await expect(wdkPanel.getByText('tool', { exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(
      page.locator('[data-testid="message"][data-role="assistant"]').filter({ hasText: '72°F in Tokyo' }),
    ).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();
  });

  test('a server-tool approval suspends the run, then resumes on approve (over WDK)', async ({ page }) => {
    await page.goto(freshChannelUrl('wdk-approval'));

    await page.getByPlaceholder('Type a message...').fill("What's the weather forecast for Tokyo?");
    await page.getByRole('button', { name: 'Send' }).click();

    // The tool needs approval, so the run suspends (the terminal activity
    // publishes ai-run-suspend) and the approval card appears.
    const approve = page.getByRole('button', { name: 'Approve' });
    await expect(approve).toBeVisible({ timeout: 60_000 });
    await approve.click();

    // Approving publishes a tool-approval-response; the client's continuation
    // starts a fresh workflow that resumes the run (ai-run-resume), and the
    // forecast arrives over Ably.
    await expect(
      page.locator('[data-testid="message"][data-role="assistant"]').filter({ hasText: '5-day forecast for Tokyo' }),
    ).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();
  });

  test('a client-side tool suspends, executes in the browser, then resumes (over WDK)', async ({ page, context }) => {
    await context.grantPermissions(['geolocation']);
    await context.setGeolocation({ latitude: 51.5074, longitude: -0.1278 });
    await page.goto(freshChannelUrl('wdk-client-tool'));

    await page.getByPlaceholder('Type a message...').fill("What's the weather like?");
    await page.getByRole('button', { name: 'Send' }).click();

    // getLocation has no server execute, so the run suspends; the client runs
    // navigator.geolocation, sends the result, a fresh workflow resumes the run,
    // and the weather sentence (which the mock returns once the location is
    // known) arrives over Ably.
    await expect(
      page.locator('[data-testid="message"][data-role="assistant"]').filter({ hasText: '72°F at your location' }),
    ).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();
  });

  test('a cancel stops the in-flight run over WDK', async ({ page }) => {
    await page.goto(freshChannelUrl('wdk-cancel'));

    // A long, slowly-streamed reply gives time to cancel mid-stream (the mock
    // streams the dragon story in ~20-char deltas).
    await page.getByPlaceholder('Type a message...').fill('Tell me a long story about a dragon');
    await page.getByRole('button', { name: 'Send' }).click();

    // Wait until the story is genuinely streaming (its opening text is on the
    // assistant side) so the cancel lands on an in-flight step, not during setup.
    await expect(
      page.locator('[data-testid="message"][data-role="assistant"]').filter({ hasText: 'Once upon a time' }),
    ).toBeVisible({
      timeout: 60_000,
    });

    // Stop publishes ai-cancel; the in-flight inference's run abort signal
    // fires, the pipe returns cancelled, and the terminal activity ends the
    // run — the composer returns to Send.
    await page.getByRole('button', { name: 'Stop' }).click();
    await expect(page.getByRole('button', { name: 'Send' })).toBeVisible({ timeout: 60_000 });
  });
});
