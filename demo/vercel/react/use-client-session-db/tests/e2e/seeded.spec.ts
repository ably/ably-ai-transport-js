import { expect, test, type Locator, type Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Database hydration — DB seed ⧺ live channel reconciliation (core seam walk)
// ---------------------------------------------------------------------------
//
// The agent persists each completed turn to the in-memory store and the demo
// fetches it as a seed on load. `useMessagesWithSeed` then walks the live
// channel back to the seam (the newest seed message) and composes seed ⧺ live
// with no duplicate. This proves the core "compose a database with the channel"
// recipe over real Ably history across a page reload.

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

test.describe('use-client-session database hydration - DB seed reconciliation', () => {
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

    // Reload: the seeded chat re-seeds from the store (/api/messages) and
    // useMessagesWithSeed walks the live channel back to the seam and
    // composes seed ⧺ live.
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
});
