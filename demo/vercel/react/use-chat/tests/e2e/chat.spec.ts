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

// `MessageBubble` renders a `[data-testid="message-bubble"]` wrapper (the
// shadcn Message row) containing the bubble body and (when not streaming) an
// action bar with role-specific buttons.
function allBubbles(page: Page): Locator {
  return page.locator('[data-testid="message-bubble"]');
}

// Edit button is rendered only on user bubbles; Regenerate only on
// assistant bubbles. Both are hidden during streaming. Identifying bubbles
// by the buttons they expose is robust to badge / structure changes.
function userBubbles(page: Page): Locator {
  return allBubbles(page).filter({ has: page.locator('button[title="Edit message"]') });
}
function assistantBubbles(page: Page): Locator {
  return allBubbles(page).filter({ has: page.locator('button[title="Regenerate response"]') });
}

// Bubble matched by its rendered text content (any bubble, including
// streaming ones with no action bar yet).
function bubbleContaining(page: Page, text: string): Locator {
  return allBubbles(page).filter({ hasText: text });
}

async function waitForAssistantSettled(page: Page, timeoutMs = 60_000): Promise<void> {
  // Wait until: (1) no run is in flight (Stop button is gone),
  // (2) no message bubble's StatusBadge still says "streaming"
  // (status badges and the active-runs map can update on slightly
  // different ticks, so check both), and (3) the latest assistant
  // bubble has rendered text. The earlier version only checked that
  // some assistant bubble had text — that returned immediately in
  // multi-prompt scenarios where an earlier turn's assistant
  // already had text while the current turn was still streaming.
  await expect(page.getByRole('button', { name: /Stop/i })).toHaveCount(0, { timeout: timeoutMs });
  await expect(page.locator('span:has(span:text-is("status")):has(span:text-is("streaming"))')).toHaveCount(0, {
    timeout: timeoutMs,
  });
  await expect
    .poll(
      async () => {
        const count = await assistantBubbles(page).count();
        if (count === 0) return 0;
        const txt = await bubbleText(assistantBubbles(page).last());
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

async function branchCounter(bubble: Locator): Promise<string | null> {
  const counter = bubble.locator('span.tabular-nums');
  if ((await counter.count()) === 0) return null;
  return (await counter.first().innerText()).trim();
}

async function bubbleText(bubble: Locator): Promise<string> {
  // The bubble body is the shadcn BubbleContent (data-slot="bubble-content").
  const body = bubble.locator('[data-slot="bubble-content"]').first();
  if ((await body.count()) === 0) return (await bubble.innerText()).trim();
  return (await body.innerText()).trim();
}

// Click Edit on a user bubble and submit a replacement. The Edit
// button is replaced by a textarea + Save/Cancel during edit mode, so
// the bubble locator that filtered by Edit-button presence stops
// matching mid-flow — pull the textarea off the page itself.
async function editAndSubmit(page: Page, userBubble: Locator, newText: string): Promise<void> {
  await userBubble.locator('button[title="Edit message"]').click();
  // The edit field carries data-testid="edit-input"; the message composer is
  // also a textarea, so target the edit field specifically.
  const ta = page.getByTestId('edit-input');
  await ta.fill(newText);
  await ta.press('Enter');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('use-chat demo - chat behaviour', () => {
  // checks: P1 -> R1 streams and renders.
  test('fresh send: response streams and renders', async ({ page }, testInfo) => {
    await page.goto(freshChannelUrl(testInfo.title));

    const input = page.getByPlaceholder('Type a message...');
    await input.waitFor({ state: 'visible' });
    const sentinel = 'PROMPT-XYZZY-42';
    await input.fill(`Reply with one short sentence acknowledging the marker ${sentinel}.`);
    await input.press('Enter');

    // Wait for the user prompt bubble. We look at the FIRST bubble in DOM
    // order so an assistant echo of the sentinel doesn't double-match.
    await expect.poll(async () => bubbleText(allBubbles(page).first()), { timeout: 10_000 }).toContain(sentinel);

    // Wait for the assistant to finish streaming and expose the Regenerate
    // button. Then assert the bubble has non-trivial content.
    await waitForAssistantSettled(page);
    const assistant = assistantBubbles(page).last();
    const text = await bubbleText(assistant);
    expect(text.length).toBeGreaterThan(0);
  });

  // checks: agent maintains a LiveObjects checklist; the panel renders the
  // steps and their live progress, and restores them from object sync on
  // reload (before history loads).
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

  // checks: regen R1 -> R1'; P1 stays visible, R shows N/2, P1 has no counter.
  test('regenerate: original user prompt stays visible AND assistant shows branch nav (1|2 / 2)', async ({
    page,
  }, testInfo) => {
    await page.goto(freshChannelUrl(testInfo.title));
    await sendPrompt(page, 'Say "first" as your entire reply.');

    // Confirm user message and one assistant message are present.
    await expect(userBubbles(page)).toHaveCount(1);
    await expect(assistantBubbles(page)).toHaveCount(1);

    // Trigger regenerate.
    await assistantBubbles(page)
      .last()
      .getByRole('button', { name: /regenerate/i })
      .click();

    // Wait until a NEW assistant bubble has finished streaming. The visible
    // chain still shows only ONE assistant bubble (the selected sibling),
    // but it will have branch nav with denominator >= 2.
    await page.waitForTimeout(1000);
    await waitForAssistantSettled(page);

    // CRITICAL: the original user prompt must still be on the visible chain.
    const userAfter = userBubbles(page);
    await expect(userAfter, 'user prompt must remain visible after regenerate').toHaveCount(1);
    const userText = await bubbleText(userAfter.first());
    expect(userText).toContain('first');

    // CRITICAL: the assistant must have a branch counter with denominator 2.
    const assistant = assistantBubbles(page).last();
    const counter = await branchCounter(assistant);
    expect(counter, 'assistant must show "N / 2" branch nav after regenerate').toMatch(/^\d+ \/ 2$/);

    // CRITICAL: the user prompt must NOT show branch nav after regenerate.
    // Regenerate changes "what the agent answered" (AITRFC-014), so the
    // branch point is anchored at the assistant msg-id — the user prompt
    // bubble is not a branch anchor and must not surface arrows.
    const userCounter = await branchCounter(userAfter.first());
    expect(userCounter, 'user prompt must not show branch nav after regenerate').toBeNull();
  });

  // checks: edit P1 -> P2; P shows 2/2, only the edited branch visible, R has no counter.
  test('edit: user prompt shows branch nav and only the edited branch is visible', async ({ page }, testInfo) => {
    await page.goto(freshChannelUrl(testInfo.title));
    await sendPrompt(page, 'Say "alpha" as your entire reply.');

    // Snapshot original prompt; this is the FIRST bubble in DOM order.
    const userBubbleStable = allBubbles(page).first();
    const original = await bubbleText(userBubbleStable);
    expect(original).toContain('alpha');

    // Click Edit on the user bubble. After this, the bubble's body is
    // replaced with the EditForm and the Edit button is gone — so we hold
    // on to the position-based locator (first bubble) for the rest of the
    // edit flow.
    await userBubbleStable.getByRole('button', { name: /edit/i }).click();

    // EditForm appears in place of the bubble body.
    const editTextarea = userBubbleStable.locator('textarea');
    await editTextarea.waitFor({ state: 'visible', timeout: 5000 });
    await editTextarea.fill('Say "bravo" as your entire reply.');
    await userBubbleStable.getByRole('button', { name: /save/i }).click();

    // Wait for the new assistant response.
    await page.waitForTimeout(1000);
    await waitForAssistantSettled(page);

    // CRITICAL: visible chain should contain EXACTLY one user bubble and
    // one assistant bubble (the selected branch).
    await expect(userBubbles(page)).toHaveCount(1);
    await expect(assistantBubbles(page)).toHaveCount(1);

    // CRITICAL: the visible user bubble shows the EDITED text.
    const editedUserText = await bubbleText(userBubbles(page).first());
    expect(editedUserText).toContain('bravo');
    expect(editedUserText).not.toContain('alpha');

    // CRITICAL: the user bubble shows branch nav (the original "alpha"
    // prompt is the alternative sibling at this fork point).
    const counter = await branchCounter(userBubbles(page).first());
    expect(counter, 'user must show "N / 2" branch nav after edit').toMatch(/^\d+ \/ 2$/);

    // CRITICAL: the assistant bubble must NOT show branch nav after edit.
    // Edit changes "what the user said" (AITRFC-014), so the branch point
    // is anchored at the user prompt msg-id — the assistant bubble is
    // carried along by the Run swap but is not the branch anchor.
    const asstCounter = await branchCounter(assistantBubbles(page).first());
    expect(asstCounter, 'assistant must not show branch nav after edit').toBeNull();
  });

  // checks: regen then edit then navigate; assistant nav stays within its own group.
  test('regenerate + edit interleaved: assistant nav stays within its own group after navigating back to the original prompt', async ({
    page,
  }, testInfo) => {
    // Scenario reproducing the runId-vs-msg-id dispatch ambiguity:
    //   1. Send P1 → R1.
    //   2. Regenerate R1 → R1'. The R1 Run is now anchor of a regen group {R1, R_regen}.
    //   3. Edit P1 → P2 / R2. The R1 Run is also anchor of a fork-of group {R1, R_edit}.
    //   4. Navigate prompt back to P1 (`<` on the user bubble).
    //   5. Navigate assistant back to R1 (`<` on the asst bubble) — within the regen group.
    //   6. Navigate assistant forward (`>` on the asst bubble) — should return to R1', NOT switch to the edit branch.
    //
    // The bug: R1 is in both groups; clicking the assistant's `>` button
    // accidentally drives the fork-of group instead of the regen group,
    // which silently switches the user prompt back to P2.
    await page.goto(freshChannelUrl(testInfo.title));
    await sendPrompt(page, 'Say "first" as your entire reply.');

    // 2. Regenerate.
    await assistantBubbles(page)
      .last()
      .getByRole('button', { name: /regenerate/i })
      .click();
    await page.waitForTimeout(1000);
    await waitForAssistantSettled(page);
    await expect.poll(async () => branchCounter(assistantBubbles(page).last())).toMatch(/^\d+ \/ 2$/);

    // 3. Edit the user prompt.
    const userBubbleStable = allBubbles(page).first();
    await userBubbleStable.getByRole('button', { name: /edit/i }).click();
    const editTextarea = userBubbleStable.locator('textarea');
    await editTextarea.waitFor({ state: 'visible', timeout: 5000 });
    await editTextarea.fill('Say "second" as your entire reply.');
    await userBubbleStable.getByRole('button', { name: /save/i }).click();
    await page.waitForTimeout(1000);
    await waitForAssistantSettled(page);
    // After edit, the user prompt has fork-of nav (2/2) and the visible
    // chain shows the edited branch.
    await expect.poll(async () => branchCounter(userBubbles(page).first())).toBe('2 / 2');
    expect(await bubbleText(userBubbles(page).first())).toContain('second');

    // 4. Navigate prompt back to P1. Branch nav buttons are matched by
    // their `title` attribute since the visible text is just "<"/">".
    await userBubbles(page).first().locator('button[title="Previous branch"]').click();
    await expect.poll(async () => bubbleText(userBubbles(page).first())).toContain('first');
    // The asst bubble must now show the regen counter ("2 / 2" — latest
    // member of the regen group selected by default).
    await expect.poll(async () => branchCounter(assistantBubbles(page).first())).toBe('2 / 2');

    // 5. Click `<` on the asst bubble to switch to the original (R1).
    await assistantBubbles(page).first().locator('button[title="Previous branch"]').click();
    await expect.poll(async () => branchCounter(assistantBubbles(page).first())).toBe('1 / 2');
    // The user prompt must still be P1 ("first") — switching members of
    // the regen group must not affect the fork-of selection on the user
    // prompt.
    expect(await bubbleText(userBubbles(page).first())).toContain('first');

    // 6. Click `>` on the asst bubble to navigate forward.
    await assistantBubbles(page).first().locator('button[title="Next branch"]').click();

    // CRITICAL: the user prompt MUST stay on P1 ("first"), not switch to
    // P2 ("second"). Bug repro: clicking `>` on the asst bubble drives
    // the fork-of group on R1's runId (because R1 is in BOTH groups) and
    // ends up selecting the edit branch.
    await expect.poll(async () => bubbleText(userBubbles(page).first()), { timeout: 5000 }).toContain('first');
    expect(
      await bubbleText(userBubbles(page).first()),
      'user prompt must remain "first" after navigating the assistant regen group',
    ).not.toContain('second');

    // CRITICAL: the assistant must show "2 / 2" (the regen alternative).
    await expect(branchCounter(assistantBubbles(page).first())).resolves.toBe('2 / 2');
  });

  // checks: regen R1 -> 2/2, regen again -> 3/3 (history ends on the user prompt).
  test('regenerate of an already-regenerated assistant succeeds (LLM receives history ending with user prompt)', async ({
    page,
  }, testInfo) => {
    // Bug repro: clicking Regenerate on a regen-content assistant used to
    // resolve the wire `x-ably-parent` to the (hidden) original
    // assistant. The HTTP POST body's `history` then ended with an
    // assistant message and Anthropic rejected with "This model does
    // not support assistant message prefill". After the fix,
    // _findParentMsgId consults the visible chain so the parent is the
    // user prompt that the regen is responding to.
    await page.goto(freshChannelUrl(testInfo.title));
    await sendPrompt(page, 'Say "alpha" as your entire reply.');

    // First regenerate.
    await assistantBubbles(page)
      .last()
      .getByRole('button', { name: /regenerate/i })
      .click();
    await page.waitForTimeout(1000);
    await waitForAssistantSettled(page);
    await expect.poll(async () => branchCounter(assistantBubbles(page).last())).toBe('2 / 2');

    const firstRegenText = await bubbleText(assistantBubbles(page).last());
    expect(firstRegenText.length).toBeGreaterThan(0);

    // Second regenerate — used to fail before the fix.
    await assistantBubbles(page)
      .last()
      .getByRole('button', { name: /regenerate/i })
      .click();
    await page.waitForTimeout(1000);
    await waitForAssistantSettled(page);
    // The counter must advance to "3 / 3" (or at least show 3 alternatives).
    await expect.poll(async () => branchCounter(assistantBubbles(page).last())).toMatch(/^\d+ \/ 3$/);
  });

  // checks: edit P1 -> P2 -> P3; counter 3/3, navigate back 2/3 -> 1/3.
  test('three-prompt edit chain P1 -> P2 -> P3 navigates correctly', async ({ page }, testInfo) => {
    await page.goto(freshChannelUrl(testInfo.title));
    await sendPrompt(page, 'Say "alpha" as your entire reply.');

    // Edit P1 -> P2.
    const userBubbleStable = allBubbles(page).first();
    await userBubbleStable.getByRole('button', { name: /edit/i }).click();
    let editTextarea = userBubbleStable.locator('textarea');
    await editTextarea.waitFor({ state: 'visible', timeout: 5000 });
    await editTextarea.fill('Say "bravo" as your entire reply.');
    await userBubbleStable.getByRole('button', { name: /save/i }).click();
    await page.waitForTimeout(1000);
    await waitForAssistantSettled(page);
    await expect.poll(async () => bubbleText(userBubbles(page).first())).toContain('bravo');
    await expect.poll(async () => branchCounter(userBubbles(page).first())).toBe('2 / 2');

    // Edit P2 -> P3.
    await userBubbleStable.getByRole('button', { name: /edit/i }).click();
    editTextarea = userBubbleStable.locator('textarea');
    await editTextarea.waitFor({ state: 'visible', timeout: 5000 });
    await editTextarea.fill('Say "charlie" as your entire reply.');
    await userBubbleStable.getByRole('button', { name: /save/i }).click();
    await page.waitForTimeout(1000);
    await waitForAssistantSettled(page);
    await expect.poll(async () => bubbleText(userBubbles(page).first())).toContain('charlie');
    // 3 prompts in the fork-of group now.
    await expect.poll(async () => branchCounter(userBubbles(page).first())).toBe('3 / 3');

    // Navigate back through the chain.
    await userBubbles(page).first().locator('button[title="Previous branch"]').click();
    await expect.poll(async () => bubbleText(userBubbles(page).first())).toContain('bravo');
    await expect.poll(async () => branchCounter(userBubbles(page).first())).toBe('2 / 3');

    await userBubbles(page).first().locator('button[title="Previous branch"]').click();
    await expect.poll(async () => bubbleText(userBubbles(page).first())).toContain('alpha');
    await expect.poll(async () => branchCounter(userBubbles(page).first())).toBe('1 / 3');
  });

  // checks: P1 regen 2/2, send P2, P2 regen 2/2; each prompt's group is independent.
  test('multiple regen on different prompts: each prompt has its own independent regen group', async ({
    page,
  }, testInfo) => {
    await page.goto(freshChannelUrl(testInfo.title));
    await sendPrompt(page, 'Say "first-one" as your entire reply.');

    // Regenerate the first prompt's reply.
    await assistantBubbles(page)
      .last()
      .getByRole('button', { name: /regenerate/i })
      .click();
    await page.waitForTimeout(1000);
    await waitForAssistantSettled(page);
    await expect.poll(async () => branchCounter(assistantBubbles(page).last())).toBe('2 / 2');

    // Send a second prompt.
    await sendPrompt(page, 'Say "second-one" as your entire reply.');
    await expect.poll(async () => userBubbles(page).count()).toBe(2);
    await expect.poll(async () => assistantBubbles(page).count()).toBe(2);

    // The first prompt's assistant still shows "2 / 2".
    await expect(branchCounter(assistantBubbles(page).first())).resolves.toBe('2 / 2');
    // The second prompt's assistant has no regen yet — no nav.
    await expect(branchCounter(assistantBubbles(page).last())).resolves.toBeNull();

    // Regenerate the second prompt's reply.
    await assistantBubbles(page)
      .last()
      .getByRole('button', { name: /regenerate/i })
      .click();
    await page.waitForTimeout(1000);
    await waitForAssistantSettled(page);
    await expect.poll(async () => branchCounter(assistantBubbles(page).last())).toBe('2 / 2');
    // The first prompt's regen group is unaffected.
    await expect(branchCounter(assistantBubbles(page).first())).resolves.toBe('2 / 2');
  });

  // checks: getLocation flow; the run reaches status=finished live.
  test('client-side tool continuation: run reaches status=finished live', async ({ browser }, testInfo) => {
    // Bug repro: after the client-side tool (getLocation) resolves and
    // the agent's continuation streams a weather response, the Run stays
    // pinned at status=active in the live client. Refresh reconstructs
    // the same channel state and shows status=finished, so the bug is in
    // the live run-end handling path, not the channel record.
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

      // Wait for the tool resolution to land and the continuation to stream.
      await expect(page.locator('text=/Location:\\s*51\\./').first()).toBeVisible({ timeout: 60_000 });
      await awaitStreamingQuiesce(page);

      // Every assistant bubble must reach status=finished.
      const streamingBadges = page.locator('span:has(span:text-is("status")):has(span:text-is("streaming"))');
      await expect(streamingBadges).toHaveCount(0, { timeout: 30_000 });

      // InputBar shows Send (not Stop) — Send button is type=submit.
      const stopButton = page.getByRole('button', { name: /Stop/i });
      await expect(stopButton).toHaveCount(0);
      const sendButton = page.getByRole('button', { name: /Send/i });
      await expect(sendButton).toBeVisible();
    } finally {
      await context.close();
    }
  });

  // checks: approval flow; the run reaches status=finished live.
  test('approval-gated tool continuation: run reaches status=finished live', async ({ page }, testInfo) => {
    // Mirror of the client-tool variant for the approval-gated path.
    await page.goto(freshChannelUrl(testInfo.title));
    const input = page.getByPlaceholder('Type a message...');
    await input.waitFor({ state: 'visible' });
    await input.fill("what's the weather forecast for London?");
    await input.press('Enter');

    const approveButton = page.getByRole('button', { name: /Approve/i }).first();
    await expect(approveButton).toBeVisible({ timeout: 60_000 });
    await approveButton.click();

    await awaitStreamingQuiesce(page);

    const streamingBadges = page.locator('span:has(span:text-is("status")):has(span:text-is("streaming"))');
    await expect(streamingBadges).toHaveCount(0, { timeout: 30_000 });

    const stopButton = page.getByRole('button', { name: /Stop/i });
    await expect(stopButton).toHaveCount(0);
    const sendButton = page.getByRole('button', { name: /Send/i });
    await expect(sendButton).toBeVisible();
  });

  // checks: "weather like?" -> getLocation (client) -> Location card -> continuation; persists on refresh.
  test('client-side tool: getLocation executes and its output appears in the visible bubble', async ({
    browser,
  }, testInfo) => {
    // Drives the same flow that surfaced the original user-reported
    // regression: the assistant calls getLocation (client-side), and the
    // client tool runner (`useClientTools`) must observe the
    // tool part transition to `input-available` via a View
    // update so it can execute the browser API and publish the result.
    // Pre-fix the View suppressed streaming chunk updates, so the runner
    // never fired and the bubble stayed at "Calling getLocation".
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

      // Intermediate check: the "Calling getLocation" rendering proves
      // the assistant's `tool-input-available` part landed in the View's
      // message list. If the View's update emission for streaming chunks
      // is broken this never appears.
      const callingTool = page.locator('text=/Calling getLocation/').first();
      await expect(callingTool).toBeVisible({ timeout: 60_000 });

      // The bubble must transition past `input-available`. Granting
      // geolocation means the client tool runner resolves with the
      // mocked coordinates, publishes a tool-output-available wire, and
      // the tool part flips to `output-available` — at which
      // point the LocationResult card renders with the lat/lng.
      const locationCard = page.locator('text=/Location:\\s*51\\./').first();
      await expect(locationCard).toBeVisible({ timeout: 60_000 });

      // After the tool resolution the agent must continue with a weather
      // response. The user-reported regression is that the continuation
      // wires arrive and BOTH the user prompt and the assistant bubble
      // vanish from the visible list. Hold for 20s so the continuation's
      // run-start (which previously triggered the self-parent cycle in
      // the tree) has time to land, then re-assert that both bubbles —
      // and the Location card — are still rendered.
      await page.waitForTimeout(20_000);
      await expect(bubbleContaining(page, "what's the weather like?")).toBeVisible();
      await expect(locationCard).toBeVisible();

      // A fresh page load must rebuild the same conversation from the
      // channel history. The bug repros even after refresh, which means
      // the published continuation state itself is unrenderable.
      const url = page.url();
      await page.goto(url);
      await expect(bubbleContaining(page, "what's the weather like?")).toBeVisible({ timeout: 30_000 });
      await expect(page.locator('text=/Location:\\s*51\\./').first()).toBeVisible({ timeout: 30_000 });
    } finally {
      await context.close();
    }
  });

  // checks: "forecast?" -> approval -> Approve -> continuation; prompt and reply survive.
  test('approval-gated tool: getWeatherForecast survives approval continuation', async ({ page }, testInfo) => {
    // The approval path mirrors the client-tool path: after the user
    // approves, useChat fires sendAutomaticallyWhen with
    // lastAssistantMessageIsCompleteWithApprovalResponses, which routes
    // through chat-transport as a continuation. The user-reported
    // regression: clicking Approve makes both the user prompt and the
    // assistant approval bubble vanish.
    await page.goto(freshChannelUrl(testInfo.title));

    const input = page.getByPlaceholder('Type a message...');
    await input.waitFor({ state: 'visible' });
    await input.fill("what's the weather forecast for London?");
    await input.press('Enter');

    // The agent should request approval before executing the forecast tool.
    const approveButton = page.getByRole('button', { name: /Approve/i }).first();
    await expect(approveButton).toBeVisible({ timeout: 60_000 });

    await approveButton.click();

    // After approval the agent continues. The user-reported regression
    // is that clicking Approve makes both the user prompt and the
    // assistant approval bubble vanish (the run's parentRunId got
    // backfilled to itself by the continuation run-start, which then
    // filtered the run out of flattenNodes as unreachable). Hold for
    // 20s so the continuation's run-start has time to land, then
    // re-assert that the user prompt is still rendered — its
    // disappearance is the user-visible symptom.
    await page.waitForTimeout(20_000);
    await expect(bubbleContaining(page, "what's the weather forecast for London?")).toBeVisible();

    // Refresh: the conversation must rebuild from channel history.
    const url = page.url();
    await page.goto(url);
    await expect(bubbleContaining(page, "what's the weather forecast for London?")).toBeVisible({ timeout: 30_000 });
  });

  // -------------------------------------------------------------------------
  // Status reaches 'finished' live
  // -------------------------------------------------------------------------
  //
  // After a tool-approval continuation completes, the live Run must reach
  // status=finished so:
  //   - Bubble StatusBadge says "status finished" (currently stuck on "streaming")
  //   - Regenerate / Edit action buttons render
  //   - InputBar shows Send instead of Stop
  // A page refresh that reconstructs from channel history reaches the
  // correct state — only the live processing path is broken.

  async function awaitStreamingQuiesce(page: Page): Promise<void> {
    // Poll body text length until it stops changing for 3 successive
    // 1-second intervals. The agent's streamText pipeline finishes
    // emitting chunks well before the run-end wire lands; this gives the
    // continuation a chance to fully publish before we measure status.
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

  // -------------------------------------------------------------------------
  // Regenerate on tool-call bubble
  // -------------------------------------------------------------------------
  //
  // The approval flow produces two assistant bubbles: (a) a tool-call
  // bubble whose part holds the tool widget, and (b) a follow-up text
  // bubble that describes the result. Regenerating the FIRST bubble
  // currently leaves the original text bubble (b) visible and appends
  // the new tool-call + new text as fresh bubbles, producing a 3-bubble
  // layout. Main's behaviour: both originals hidden, only the new pair
  // visible, with the 2/2 navigator on the tool-call bubble.

  // checks: forecast TC+TT; regen the TC bubble -> still 2 bubbles, TC shows 2/2.
  test('regenerate on tool-call bubble hides the original follow-up text bubble', async ({ page }, testInfo) => {
    await page.goto(freshChannelUrl(testInfo.title));
    const input = page.getByPlaceholder('Type a message...');
    await input.waitFor({ state: 'visible' });
    await input.fill("what's the weather forecast for London?");
    await input.press('Enter');

    // First approval cycle.
    const firstApprove = page.getByRole('button', { name: /Approve/i }).first();
    await expect(firstApprove).toBeVisible({ timeout: 60_000 });
    await firstApprove.click();
    await awaitStreamingQuiesce(page);

    // After the first continuation, we expect 2 assistant bubbles: the
    // tool-call bubble (with the widget) and the LLM text bubble.
    const assistantsAfterFirst = await assistantBubbles(page).count();
    expect(assistantsAfterFirst).toBe(2);

    // Click regenerate on the FIRST assistant bubble (the tool-call one).
    const firstAssistant = assistantBubbles(page).first();
    await firstAssistant.locator('button[title="Regenerate response"]').click();

    // A new approval request must appear for the regenerated tool call.
    const secondApprove = page.getByRole('button', { name: /Approve/i }).first();
    await expect(secondApprove).toBeVisible({ timeout: 60_000 });
    await secondApprove.click();
    await awaitStreamingQuiesce(page);

    // After regenerating the tool-call bubble, the visible chain should
    // still be 2 assistant bubbles (new tool-call + new text), NOT 3.
    // The original text bubble must be hidden because it followed the
    // original tool-call within the same Run and was implicitly
    // superseded when the tool call was regenerated.
    const assistantsAfterRegen = await assistantBubbles(page).count();
    expect(assistantsAfterRegen).toBe(2);

    // The 2/2 navigator should be on the (new) tool-call bubble — the
    // first assistant — not the follow-up text.
    const firstCounter = await branchCounter(assistantBubbles(page).first());
    const secondCounter = await branchCounter(assistantBubbles(page).last());
    expect(firstCounter).toBe('2 / 2');
    expect(secondCounter).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Nested regen of the follow-up text (Bug A)
  // -------------------------------------------------------------------------
  //
  // After regenerating the tool-call bubble (TC1 → TC2 + TT2), the user
  // expects to be able to regenerate JUST the follow-up text bubble
  // (TT2) to produce TT2' as a new variant — without re-running the
  // tool call. Pre-fix the regen rebase logic in view.regenerate maps
  // any regen of a trailing message inside a regenerator Run back to
  // that Run's group anchor (TC1), producing a new full Run that
  // contains both a fresh tool call AND a fresh text. The user sees a
  // "TC3" bubble with `3 / 3` navigation (counting TC1, TC2, TC3),
  // which is jarring and wrong — the navigation should be local to the
  // bubble the user clicked.

  // test.fixme: SDK View regenerate/ordering gap - the pre-fix behaviour
  // described above. Remove `.fixme` once the View logic is fixed.
  // checks: after a TC regen, regen the follow-up text; nav anchors at the text, not the TC group.
  test.fixme('regenerate on the follow-up text after a tool-call regen anchors at the text, not at the tool-call group', async ({
    browser,
  }, testInfo) => {
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

      // Wait for the full initial response — both TC1 and TT1.
      await expect(page.locator('text=/Location:\\s*51\\./').first()).toBeVisible({ timeout: 60_000 });
      await awaitStreamingQuiesce(page);
      expect(await assistantBubbles(page).count()).toBe(2);

      // Regenerate TC1 → produces TC2 + TT2 (2/2 on TC2).
      await assistantBubbles(page).first().locator('button[title="Regenerate response"]').click();
      await expect(page.locator('text=/Location:\\s*51\\./').first()).toBeVisible({ timeout: 60_000 });
      await awaitStreamingQuiesce(page);
      expect(await assistantBubbles(page).count()).toBe(2);
      expect(await branchCounter(assistantBubbles(page).first())).toBe('2 / 2');
      expect(await branchCounter(assistantBubbles(page).last())).toBeNull();

      // Regenerate the FOLLOW-UP text bubble (the second assistant).
      await assistantBubbles(page).last().locator('button[title="Regenerate response"]').click();
      await awaitStreamingQuiesce(page);

      // Expected: TWO bubbles — TC2 (2/2 navigating TC1 ↔ TC2) and
      // TT2' (2/2 navigating TT2 ↔ TT2'). The tool-call bubble's
      // counter must stay at 2/2, NOT roll over to 3/3.
      expect(await assistantBubbles(page).count()).toBe(2);
      expect(await branchCounter(assistantBubbles(page).first())).toBe('2 / 2');
      expect(await branchCounter(assistantBubbles(page).last())).toBe('2 / 2');
    } finally {
      await context.close();
    }
  });

  // -------------------------------------------------------------------------
  // Tool-call regen invalidates prior text regen (Bug B)
  // -------------------------------------------------------------------------
  //
  // Sequence: send → TC1, TT1 → regen TT1 → TT1' (2/2). Then regen TC1.
  // Pre-fix this leaves TT1' visible alongside the new TC2 + TT2,
  // producing a 3-bubble layout. Once TC1 is replaced, its trailing
  // follow-ups (including the alternative TT1' selected for the TT1
  // group) belong to a timeline that's no longer in the visible chain.
  // The view must hide the orphaned TT1 regenerator.

  // test.fixme: SDK View leaves the orphaned text regenerator visible
  // (count 3 vs 2). Remove `.fixme` once the View logic is fixed.
  // checks: after a TT regen, regen the TC; the orphaned text regenerator is hidden.
  test.fixme('regenerate on tool-call after regenerating the follow-up text hides the orphaned text regenerator', async ({
    browser,
  }, testInfo) => {
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

      await expect(page.locator('text=/Location:\\s*51\\./').first()).toBeVisible({ timeout: 60_000 });
      await awaitStreamingQuiesce(page);
      expect(await assistantBubbles(page).count()).toBe(2);

      // Regenerate TT1 first → produces TT1' (with TC1 unchanged).
      await assistantBubbles(page).last().locator('button[title="Regenerate response"]').click();
      await awaitStreamingQuiesce(page);
      expect(await assistantBubbles(page).count()).toBe(2);
      expect(await branchCounter(assistantBubbles(page).first())).toBeNull();
      expect(await branchCounter(assistantBubbles(page).last())).toBe('2 / 2');

      // Now regenerate TC1 → produces TC2 + TT2. The prior TT1'
      // regenerator must be hidden — its anchor (TT1) was replaced by
      // TC1's regen which truncated R1 at TC1.
      await assistantBubbles(page).first().locator('button[title="Regenerate response"]').click();
      await expect(page.locator('text=/Location:\\s*51\\./').first()).toBeVisible({ timeout: 60_000 });
      await awaitStreamingQuiesce(page);

      // Expected: TWO bubbles — TC2 (2/2 on tool-call) and TT2 (no nav).
      // Pre-fix the count is 3 because TT1' lingers between u1 and TC2.
      expect(await assistantBubbles(page).count()).toBe(2);
      expect(await branchCounter(assistantBubbles(page).first())).toBe('2 / 2');
      expect(await branchCounter(assistantBubbles(page).last())).toBeNull();
    } finally {
      await context.close();
    }
  });

  // =========================================================================
  // Exploratory scenarios — combined edit / regen / tool / refresh flows
  // =========================================================================
  //
  // These cover combinations that the smaller targeted regressions don't
  // hit. Each test states the expected behaviour as the user sees it
  // (bubble count, branch counters, status badges, refresh recovery)
  // rather than poking at internal state, so a failure means a real
  // user-visible bug.

  // checks: edit a P that produced a tool call; still gets a fresh streamed reply.
  test('editing a user prompt that produced a tool-call response still gets a fresh streamed reply', async ({
    browser,
  }, testInfo) => {
    // Regression for the malformed-history bug: an edit forwards the
    // pre-edit conversation as `history` to the agent. If any assistant
    // message in that history contains a tool part with no
    // `input`, `convertToModelMessages` produces a `tool_use` block
    // without an `input` field and Anthropic rejects with 400.
    const context = await browser.newContext({
      permissions: ['geolocation'],
      geolocation: { latitude: 51.5074, longitude: -0.1278 },
    });
    const page = await context.newPage();
    try {
      await page.goto(freshChannelUrl(testInfo.title));
      await sendPrompt(page, "what's the weather like?");
      await expect(page.locator('text=/Location:\\s*51\\./').first()).toBeVisible({ timeout: 60_000 });
      await awaitStreamingQuiesce(page);

      await editAndSubmit(page, userBubbles(page).first(), 'Reply with just the word OMEGA and nothing else');
      await waitForAssistantSettled(page);

      // The edited prompt must produce its own assistant text reply.
      // Pre-fix, the agent's call to Anthropic returned 400 and no
      // assistant bubble ever rendered.
      const lastAssistantText = await bubbleText(assistantBubbles(page).last());
      expect(lastAssistantText).toMatch(/OMEGA/);
    } finally {
      await context.close();
    }
  });

  // checks: edit a P that had a tool call; both original assistant bubbles are hidden.
  test('exploratory: editing a user prompt that had a tool-call response hides both original assistant bubbles', async ({
    browser,
  }, testInfo) => {
    // R1 = [u1, TC1, TT1] (user + tool-call bubble + LLM text). Editing
    // u1 creates R2 forked at u1 with its own [u2, TC2, TT2]. The view
    // must hide R1's content entirely (R1 is not the selected fork
    // sibling); pre-fix bugs sometimes leak R1's trailing tool-call /
    // text bubbles into the edited branch's display.
    const context = await browser.newContext({
      permissions: ['geolocation'],
      geolocation: { latitude: 51.5074, longitude: -0.1278 },
    });
    const page = await context.newPage();
    try {
      await page.goto(freshChannelUrl(testInfo.title));
      await sendPrompt(page, "what's the weather like?");
      await expect(page.locator('text=/Location:\\s*51\\./').first()).toBeVisible({ timeout: 60_000 });
      await awaitStreamingQuiesce(page);

      // Edit the user prompt to ask something completely different.
      await editAndSubmit(page, userBubbles(page).first(), 'reply with just the word ALPHA');
      await awaitStreamingQuiesce(page);

      // After the edit lands, the user prompt should show 2/2 (original
      // vs edited). The original TC1 + TT1 bubbles must NOT be visible.
      // Pre-fix scenarios sometimes left them in place.
      const lastUser = userBubbles(page).last();
      expect(await branchCounter(lastUser)).toBe('2 / 2');
      // Only ONE user bubble should be in the visible chain (the edited
      // sibling). The replaced prompt's bubble belongs to the hidden
      // R1 fork and must not render.
      expect(await userBubbles(page).count()).toBe(1);
      const visibleUserText = await bubbleText(userBubbles(page).first());
      expect(visibleUserText).toMatch(/ALPHA/);
      expect(visibleUserText).not.toMatch(/what's the weather like\?/);
      // The Location card from R1 should also be gone (R1 is the hidden fork).
      await expect(page.locator('text=/Location:\\s*51\\./')).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  // checks: deny an approval-gated tool; conversation stays alive and the run finishes.
  test('exploratory: denying an approval-gated tool call keeps the conversation alive and lets the run finish', async ({
    page,
  }, testInfo) => {
    await page.goto(freshChannelUrl(testInfo.title));
    const input = page.getByPlaceholder('Type a message...');
    await input.waitFor({ state: 'visible' });
    await input.fill("what's the weather forecast for London?");
    await input.press('Enter');

    const denyButton = page.getByRole('button', { name: /Deny/i }).first();
    await expect(denyButton).toBeVisible({ timeout: 60_000 });
    await denyButton.click();
    await awaitStreamingQuiesce(page);

    // The prompt must stay visible, and every assistant bubble's
    // status badge must reach `finished` (no "stuck streaming").
    await expect(bubbleContaining(page, "what's the weather forecast for London?")).toBeVisible();
    const streamingBadges = page.locator('span:has(span:text-is("status")):has(span:text-is("streaming"))');
    await expect(streamingBadges).toHaveCount(0, { timeout: 30_000 });
    // The input bar should be back to Send (not Stop).
    await expect(page.getByRole('button', { name: /Stop/i })).toHaveCount(0);
  });

  // checks: interleaved edit + regen; each operation keeps its own local 2/2 group.
  test('exploratory: interleaved edit and regenerate keep independent branch groups', async ({ page }, testInfo) => {
    await page.goto(freshChannelUrl(testInfo.title));
    await sendPrompt(page, 'Reply with the word RED and nothing else');

    // Regenerate the original reply -> the assistant gets a 2/2 regen group.
    await assistantBubbles(page).first().locator('button[title="Regenerate response"]').click();
    await waitForAssistantSettled(page);
    expect(await branchCounter(assistantBubbles(page).first())).toBe('2 / 2');

    // Edit the prompt -> the user gets a 2/2 fork group, and the edited
    // branch's assistant starts fresh with no regen counter.
    await editAndSubmit(page, userBubbles(page).first(), 'Reply with the word GREEN and nothing else');
    await waitForAssistantSettled(page);
    expect(await branchCounter(userBubbles(page).last())).toBe('2 / 2');
    expect(await branchCounter(assistantBubbles(page).last())).toBeNull();

    // Regenerate on the edited branch -> its assistant gets its OWN 2/2 group,
    // local to this fork (not 3/3, which would leak the original branch's regen).
    await assistantBubbles(page).last().locator('button[title="Regenerate response"]').click();
    await waitForAssistantSettled(page);
    expect(await branchCounter(userBubbles(page).last())).toBe('2 / 2');
    expect(await branchCounter(assistantBubbles(page).last())).toBe('2 / 2');
  });

  // checks: refresh after edit+regen of a tool-call reply rebuilds the same visible chain.
  test('exploratory: refreshing after edit + regen of a tool-call response rebuilds the same visible chain', async ({
    browser,
  }, testInfo) => {
    const context = await browser.newContext({
      permissions: ['geolocation'],
      geolocation: { latitude: 51.5074, longitude: -0.1278 },
    });
    const page = await context.newPage();
    try {
      await page.goto(freshChannelUrl(testInfo.title));
      await sendPrompt(page, "what's the weather like?");
      await expect(page.locator('text=/Location:\\s*51\\./').first()).toBeVisible({ timeout: 60_000 });
      await awaitStreamingQuiesce(page);

      // Regenerate the tool-call response.
      await assistantBubbles(page).first().locator('button[title="Regenerate response"]').click();
      await expect(page.locator('text=/Location:\\s*51\\./').first()).toBeVisible({ timeout: 60_000 });
      await awaitStreamingQuiesce(page);

      const counterBeforeRefresh = await branchCounter(assistantBubbles(page).first());
      const bubblesBeforeRefresh = await assistantBubbles(page).count();

      // Refresh and check the rebuild matches.
      const url = page.url();
      await page.goto(url);
      await awaitStreamingQuiesce(page);

      expect(await assistantBubbles(page).count()).toBe(bubblesBeforeRefresh);
      expect(await branchCounter(assistantBubbles(page).first())).toBe(counterBeforeRefresh);
    } finally {
      await context.close();
    }
  });

  // checks: navigate back to an earlier regen sibling, then regen again -> 3/3.
  test('exploratory: navigating back to a prior regen sibling then regenerating again grows the group counter', async ({
    browser,
  }, testInfo) => {
    const context = await browser.newContext({
      permissions: ['geolocation'],
      geolocation: { latitude: 51.5074, longitude: -0.1278 },
    });
    const page = await context.newPage();
    try {
      await page.goto(freshChannelUrl(testInfo.title));
      await sendPrompt(page, "what's the weather like?");
      await expect(page.locator('text=/Location:\\s*51\\./').first()).toBeVisible({ timeout: 60_000 });
      await awaitStreamingQuiesce(page);

      // First regen → 2/2.
      await assistantBubbles(page).first().locator('button[title="Regenerate response"]').click();
      await expect(page.locator('text=/Location:\\s*51\\./').first()).toBeVisible({ timeout: 60_000 });
      await awaitStreamingQuiesce(page);
      expect(await branchCounter(assistantBubbles(page).first())).toBe('2 / 2');

      // Navigate back to the original sibling.
      await assistantBubbles(page).first().locator('button[title="Previous branch"]').click();
      await expect.poll(async () => branchCounter(assistantBubbles(page).first())).toBe('1 / 2');

      // Regenerate again — should create a 3rd member.
      await assistantBubbles(page).first().locator('button[title="Regenerate response"]').click();
      await expect(page.locator('text=/Location:\\s*51\\./').first()).toBeVisible({ timeout: 60_000 });
      await awaitStreamingQuiesce(page);
      expect(await branchCounter(assistantBubbles(page).first())).toBe('3 / 3');
    } finally {
      await context.close();
    }
  });

  // checks: edit, navigate back to the original, edit again -> 3/3.
  test('exploratory: navigating back to a prior edit sibling then editing again grows the group counter', async ({
    page,
  }, testInfo) => {
    await page.goto(freshChannelUrl(testInfo.title));
    await sendPrompt(page, 'Reply with the word ONE and nothing else');

    // First edit -> 2/2.
    await editAndSubmit(page, userBubbles(page).first(), 'Reply with the word TWO and nothing else');
    await waitForAssistantSettled(page);
    expect(await branchCounter(userBubbles(page).last())).toBe('2 / 2');

    // Navigate back to the original prompt sibling.
    await userBubbles(page).last().locator('button[title="Previous branch"]').click();
    await expect.poll(async () => branchCounter(userBubbles(page).last())).toBe('1 / 2');

    // Edit again from the original -> a 3rd sibling.
    await editAndSubmit(page, userBubbles(page).last(), 'Reply with the word THREE and nothing else');
    await waitForAssistantSettled(page);
    expect(await branchCounter(userBubbles(page).last())).toBe('3 / 3');
  });

  // checks: cancel mid-stream; Send returns and no bubble stays on "streaming".
  test('exploratory: cancelling a streaming response cleans up and re-enables the Send button', async ({
    page,
  }, testInfo) => {
    await page.goto(freshChannelUrl(testInfo.title));
    const input = page.getByPlaceholder('Type a message...');
    await input.waitFor({ state: 'visible' });
    await input.fill('Reply with a very long story about a dragon');
    await input.press('Enter');

    // Wait until the assistant has actually produced some streamed output
    // before pressing Stop. Cancelling the very instant the Stop button
    // appears races the agent's abort listeners and can miss server-side
    // paths that only surface once tokens are mid-flight. The user's
    // manual reproduction is "press Stop as something starts coming in".
    const assistantBubble = page.locator('[data-testid="message-bubble"]').filter({ hasText: /./ }).nth(1);
    await expect(assistantBubble).toBeVisible({ timeout: 30_000 });
    await expect(assistantBubble).toHaveText(/.{40,}/, { timeout: 30_000 });

    const stopButton = page.getByRole('button', { name: /Stop/i });
    await expect(stopButton).toBeVisible();
    await stopButton.click();

    // After cancellation, Send must reappear and the run must reach a
    // terminal state (no "stuck streaming" badge).
    await expect(page.getByRole('button', { name: /Send/i })).toBeVisible({ timeout: 30_000 });
    const streamingBadges = page.locator('span:has(span:text-is("status")):has(span:text-is("streaming"))');
    await expect(streamingBadges).toHaveCount(0, { timeout: 30_000 });
  });

  // =========================================================================
  // Follow-up exploratory scenarios
  // =========================================================================

  // checks: cancel while in approval-requested state; the run cleans up.
  test('exploratory: a run suspended awaiting approval shows Send not Stop, and approving resumes it', async ({
    page,
  }, testInfo) => {
    // A run paused in the approval-requested state has no live stream to
    // abort, so there is nothing for Stop to act on: the input bar shows Send
    // and the user proceeds via Approve / Deny. (Stop is reserved for an
    // actively streaming run - see the streaming-cancel test.) This mirrors
    // the useChat demo, where Stop shows only while the request is in flight
    // (status 'submitted' | 'streaming'); a suspended run shows Send.
    await page.goto(freshChannelUrl(testInfo.title));
    const input = page.getByPlaceholder('Type a message...');
    await input.waitFor({ state: 'visible' });
    await input.fill("what's the weather forecast for London?");
    await input.press('Enter');

    // The approval card appears and the run suspends.
    await expect(page.getByRole('button', { name: /Approve/i }).first()).toBeVisible({ timeout: 60_000 });

    // Once suspended, the bar shows Send (not Stop). Wait for Send to settle
    // (the run may briefly still be 'active' as the tool call streams in),
    // then assert no Stop is offered for the suspended run.
    await expect(page.getByRole('button', { name: /Send/i })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: /Stop/i })).toHaveCount(0);

    // Approving still resumes the run to completion (no stuck streaming).
    await page
      .getByRole('button', { name: /Approve/i })
      .first()
      .click();
    await waitForAssistantSettled(page);
    const streamingBadges = page.locator('span:has(span:text-is("status")):has(span:text-is("streaming"))');
    await expect(streamingBadges).toHaveCount(0, { timeout: 30_000 });
  });

  // checks: P1 (2 regens), P2 (edit), P3 (regen) interleaved; each prompt keeps its own branch state.
  test('exploratory: mixed multi-prompt: P1 with 2 regens, P2 edit, P3 with regen — every prompt keeps its own branch state', async ({
    page,
  }, testInfo) => {
    // Stress-test that branch state on one prompt survives interleaved
    // operations on neighbouring prompts. Each user / assistant has its
    // own group; touching one must not bump another's counter.
    await page.goto(freshChannelUrl(testInfo.title));

    await sendPrompt(page, 'Reply with the word AAA and nothing else');
    // P1 regen #1 → 2/2 on P1's assistant.
    await assistantBubbles(page).nth(0).locator('button[title="Regenerate response"]').click();
    await waitForAssistantSettled(page);
    await expect.poll(async () => branchCounter(assistantBubbles(page).nth(0))).toBe('2 / 2');
    // P1 regen #2 → 3/3.
    await assistantBubbles(page).nth(0).locator('button[title="Regenerate response"]').click();
    await waitForAssistantSettled(page);
    await expect.poll(async () => branchCounter(assistantBubbles(page).nth(0))).toBe('3 / 3');

    await sendPrompt(page, 'Reply with the word BBB and nothing else');
    // Poll: action bars (and thus the assistantBubbles filter) re-render a tick
    // after waitForAssistantSettled resolves, so a one-shot count can read 1.
    await expect.poll(async () => assistantBubbles(page).count()).toBe(2);
    await expect.poll(async () => branchCounter(assistantBubbles(page).nth(1))).toBeNull();

    // Edit P2 → user bubble at index 1 shows 2/2.
    await editAndSubmit(page, userBubbles(page).nth(1), 'Reply with the word BBB2 and nothing else');
    await waitForAssistantSettled(page);
    await expect.poll(async () => branchCounter(userBubbles(page).nth(1))).toBe('2 / 2');

    await sendPrompt(page, 'Reply with the word CCC and nothing else');
    // P3 regen → 2/2 on P3's assistant.
    await assistantBubbles(page).nth(2).locator('button[title="Regenerate response"]').click();
    await waitForAssistantSettled(page);
    await expect.poll(async () => branchCounter(assistantBubbles(page).nth(2))).toBe('2 / 2');

    // Each prompt keeps its own independent branch counter — touching one
    // (regen / edit) must not bump another's. Poll each: the bubble whose
    // operation just settled re-renders its neighbours' action bars on a
    // following commit, so a one-shot read can momentarily miss a counter.
    await expect.poll(async () => branchCounter(assistantBubbles(page).nth(0))).toBe('3 / 3'); // P1 regen group
    await expect.poll(async () => branchCounter(userBubbles(page).nth(1))).toBe('2 / 2'); // P2 edit group
    await expect.poll(async () => branchCounter(assistantBubbles(page).nth(2))).toBe('2 / 2'); // P3 regen group

    // Navigate P1's assistant back to a prior regen sibling. P2 and P3 were
    // sent as follow-ups while P1's LATEST regen (3/3) was selected, so their
    // input nodes are parented at that specific reply. Selecting an earlier P1
    // reply takes the 3/3 reply off the visible chain, so the follow-up turns
    // chained beneath it (P2 and P3) are correctly hidden — this is the
    // regenerate-substitution model (a follow-up belongs to the reply it
    // answered), verified at the SDK level in view.test.ts. Navigating P1
    // forward again restores them.
    await assistantBubbles(page).nth(0).locator('button[title="Previous branch"]').click();
    await expect.poll(async () => branchCounter(assistantBubbles(page).nth(0))).toBe('2 / 3');
    // Only P1's prompt + its selected reply remain visible (P2/P3 hidden).
    await expect.poll(async () => userBubbles(page).count()).toBe(1);
    await expect.poll(async () => assistantBubbles(page).count()).toBe(1);

    // Navigate P1 forward to the latest regen again — P2 and P3 reappear with
    // their own branch counters intact, proving they were hidden (branch
    // selection), not lost.
    await assistantBubbles(page).nth(0).locator('button[title="Next branch"]').click();
    await expect.poll(async () => branchCounter(assistantBubbles(page).nth(0))).toBe('3 / 3');
    await expect.poll(async () => userBubbles(page).count()).toBe(3);
    await expect.poll(async () => branchCounter(userBubbles(page).nth(1))).toBe('2 / 2');
    await expect.poll(async () => branchCounter(assistantBubbles(page).nth(2))).toBe('2 / 2');
  });

  // checks: after a refresh, limit=1 shows the newest reply and "Load older"
  // pages back through the full conversation one message at a time.
  test('exploratory: pagination — Load older messages button is functional after a refresh', async ({
    page,
  }, testInfo) => {
    // Build a two-turn conversation: [u:PAGE1, a:PAGE1, u:PAGE2, a:PAGE2].
    // Open directly with limit=1 so the refresh below re-reads the same URL.
    await page.goto(freshChannelUrl(testInfo.title) + '&limit=1');
    await sendPrompt(page, 'Reply with the word PAGE1 and nothing else');
    await sendPrompt(page, 'Reply with the word PAGE2 and nothing else');

    // Refresh. `useView({ limit: 1 })` reveals exactly one older codecMessage
    // (loadOlder paginates by codecMessage, not Run), so the newest visible
    // message is the PAGE2 assistant reply — no user bubble is on the visible
    // chain until "Load older" reveals earlier codecMessages one at a time.
    await page.goto(page.url());
    await expect.poll(async () => assistantBubbles(page).count(), { timeout: 30_000 }).toBe(1);
    await expect.poll(async () => userBubbles(page).count()).toBe(0);
    await expect.poll(async () => bubbleText(assistantBubbles(page).first())).toMatch(/PAGE2/);

    // Older history remains, so the control is offered. The same button reads
    // "Loading..." mid-fetch, so track that state to settle loads cleanly.
    const loadOlder = page.getByRole('button', { name: /Load older messages/i });
    const loadingButton = page.getByRole('button', { name: /Loading/i });
    await expect(loadOlder).toBeVisible();

    // Page back through history one click at a time until the whole conversation
    // is visible again. Each click reveals exactly one older codecMessage.
    for (let i = 0; i < 8; i++) {
      await expect(loadingButton).toHaveCount(0); // let any in-flight load settle
      if ((await userBubbles(page).count()) >= 2) break;
      if ((await loadOlder.count()) === 0) break;
      const before = await allBubbles(page).count();
      await loadOlder.click();
      await expect.poll(async () => allBubbles(page).count()).toBe(before + 1);
    }

    // The full two-turn conversation is back in view — both prompts and both
    // replies, with PAGE1 (the oldest turn) reached via "Load older".
    await expect.poll(async () => userBubbles(page).count()).toBe(2);
    await expect.poll(async () => assistantBubbles(page).count()).toBe(2);
    await expect.poll(async () => bubbleContaining(page, 'PAGE1').count()).toBeGreaterThanOrEqual(1);
  });

  // checks: regenerating an earlier prompt's reply hides the later follow-up
  // turn (branch substitution); selecting the original reply restores it.
  test('exploratory: regenerating an earlier prompt with a later prompt present hides the later turn on the regen branch', async ({
    page,
  }, testInfo) => {
    // P1 then P2. P2 was sent as a follow-up while P1's reply was the latest
    // visible message, so P2's input node is parented at P1's reply. When P1's
    // reply is regenerated, that reply leaves the visible chain (the regen group
    // defaults to the new alternative), so the follow-up turn chained beneath it
    // (P2) is correctly hidden — a follow-up belongs to the reply it answered.
    // This is the documented regenerate-substitution model, verified at the SDK
    // level in view.test.ts ("hides a follow-up turn when its anchor assistant
    // is regenerated mid-conversation"). Selecting the original P1 reply back
    // brings the follow-up turn back.
    await page.goto(freshChannelUrl(testInfo.title));
    await sendPrompt(page, 'Reply with the word ALPHA and nothing else');
    await sendPrompt(page, 'Reply with the word BRAVO and nothing else');

    // Sanity: the chat already has 2 user + 2 assistant bubbles in order.
    await expect.poll(async () => userBubbles(page).count()).toBe(2);
    await expect.poll(async () => assistantBubbles(page).count()).toBe(2);

    // Regenerate the FIRST (earlier) assistant.
    await assistantBubbles(page).first().locator('button[title="Regenerate response"]').click();
    await waitForAssistantSettled(page);

    // The regen branch shows only P1's prompt + the new reply (2/2). P2's turn
    // is hidden because its anchor reply was substituted.
    await expect.poll(async () => userBubbles(page).count()).toBe(1);
    await expect.poll(async () => assistantBubbles(page).count()).toBe(1);
    await expect.poll(async () => branchCounter(assistantBubbles(page).first())).toBe('2 / 2');
    await expect.poll(async () => bubbleText(userBubbles(page).first())).toMatch(/ALPHA/);

    // Navigate the regen group back to the original P1 reply (1/2). P2's turn
    // reappears — it was hidden by branch selection, not lost.
    await assistantBubbles(page).first().locator('button[title="Previous branch"]').click();
    await expect.poll(async () => branchCounter(assistantBubbles(page).first())).toBe('1 / 2');
    await expect.poll(async () => userBubbles(page).count()).toBe(2);
    await expect.poll(async () => assistantBubbles(page).count()).toBe(2);
    const allTexts = await Promise.all((await allBubbles(page).all()).map(async (b) => bubbleText(b)));
    expect(allTexts[0]).toMatch(/ALPHA/);
    expect(allTexts[2]).toMatch(/BRAVO/);
    expect(allTexts[3]).toMatch(/BRAVO/);
  });

  // checks: two tabs on one channel; the observer sees the continuation run-end (status=finished).
  test('exploratory: multi-tab observer sees continuation run-end (tab B reaches status=finished)', async ({
    browser,
  }) => {
    // Regression for the observer-side run-end gate. The gate consults
    // the Tree's latest-continuation-invocation map ahead of the
    // serial-based winning-invocation map. Without that fallback, an
    // observer (no _ownRunIds entry, no router stream) drops the
    // continuation's run-end because treeWinner stays pinned to the
    // original prompt's invocation and the assistant bubbles stay
    // stuck on status=streaming.
    const channel = `ai:e2e-multi-tab-observer-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const ctxA = await browser.newContext({
      permissions: ['geolocation'],
      geolocation: { latitude: 51.5074, longitude: -0.1278 },
    });
    const ctxB = await browser.newContext();
    const tabA = await ctxA.newPage();
    const tabB = await ctxB.newPage();
    try {
      await tabA.goto(`/?channel=${channel}&clientId=tab-a`);
      await tabB.goto(`/?channel=${channel}&clientId=tab-b`);

      // Tab A drives the conversation.
      const inputA = tabA.getByPlaceholder('Type a message...');
      await inputA.fill("what's the weather like?");
      await inputA.press('Enter');

      // Both tabs eventually show the LocationResult card.
      await expect(tabA.locator('text=/Location:\\s*51\\./').first()).toBeVisible({ timeout: 60_000 });
      await expect(tabB.locator('text=/Location:\\s*51\\./').first()).toBeVisible({ timeout: 60_000 });
      await awaitStreamingQuiesce(tabA);
      await awaitStreamingQuiesce(tabB);

      // On tab B, every assistant bubble must reach status=finished.
      const observerStreaming = tabB.locator('span:has(span:text-is("status")):has(span:text-is("streaming"))');
      await expect(observerStreaming).toHaveCount(0, { timeout: 30_000 });
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });
});
