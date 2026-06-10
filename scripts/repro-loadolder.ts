#!/usr/bin/env tsx

/**
 * Reproduce the loadOlder(2) failure on a channel that already has at least
 * 6 sequential turns published in realistic ordering (user ai-input ->
 * ai-run-start -> assistant ai-output -> ai-run-end per turn).
 *
 * Usage:
 *   ABLY_API_KEY=xxx pnpm tsx scripts/repro-loadolder.ts ait:my-channel
 *
 * Optional env vars:
 *   ABLY_ENV       - "sandbox" | "production" (default: production)
 *   LIMIT          - loadOlder(N), default 2
 *   CALLS          - number of sequential loadOlder calls, default 4
 *   WATCHDOG_MS    - watchdog timeout, default 30000
 *   LOG_LEVEL      - "trace" | "debug" | "info" | "warn" | "silent" (default: warn)
 */

import * as Ably from 'ably';
import type * as AI from 'ai';

import { createClientSession } from '../src/core/transport/client-session.js';
import { LogLevel, makeLogger } from '../src/logger.js';
import { getTransportHeaders } from '../src/utils.js';
import type { VercelInput, VercelOutput, VercelProjection } from '../src/vercel/codec/index.js';
import { UIMessageCodec } from '../src/vercel/codec/index.js';

const apiKey = process.env.ABLY_API_KEY;
if (!apiKey) {
  console.error('ERROR: ABLY_API_KEY env var is required');
  process.exit(1);
}

const channelName = process.argv[2];
if (!channelName) {
  console.error('ERROR: pass the channel name as the first argument');
  process.exit(1);
}

const limit = Number(process.env.LIMIT ?? '2');
const calls = Number(process.env.CALLS ?? '4');
const watchdogMs = Number(process.env.WATCHDOG_MS ?? '30000');
const logLevelArg = (process.env.LOG_LEVEL ?? 'warn').toLowerCase();
const logLevels: Record<string, LogLevel> = {
  trace: LogLevel.Trace,
  debug: LogLevel.Debug,
  info: LogLevel.Info,
  warn: LogLevel.Warn,
  silent: LogLevel.Silent,
};
const logLevel: LogLevel = logLevels[logLevelArg] ?? LogLevel.Warn;

const env = process.env.ABLY_ENV ?? 'production';
const realtimeOpts: Ably.ClientOptions = {
  key: apiKey,
  clientId: `repro-${Math.random().toString(36).slice(2, 10)}`,
  ...(env !== 'production' && { environment: env }),
};

const client = new Ably.Realtime(realtimeOpts);

const summary = {
  startedAt: 0,
  finishedAt: 0,
  durationMs: 0,
  rawHistoryMessageCount: 0,
  rawByName: {} as Record<string, number>,
  rawByRole: {} as Record<string, number>,
  rawByAction: {} as Record<string, number>,
  visibleRunCount: 0,
  visibleRunIds: [] as string[],
  visibleNodeCount: 0,
  treeAblyMessageEvents: 0,
  treeUpdateEvents: 0,
  treeRunEvents: 0,
  treeOutputEvents: 0,
  hasOlder: false,
  reproduced: false,
  notes: [] as string[],
};

const main = async (): Promise<void> => {
  console.log(`Connecting to channel "${channelName}" (env=${env})...`);

  // First: read raw channel history directly so we can compare what's on the
  // channel vs. what the session reveals.
  const rawChannel = client.channels.get(channelName);
  await rawChannel.attach();

  const allRaw: Ably.InboundMessage[] = [];
  let page: Ably.PaginatedResult<Ably.InboundMessage> | null = await rawChannel.history({ limit: 200 });
  let pageCount = 0;
  while (page) {
    pageCount++;
    allRaw.push(...page.items);
    if (!page.hasNext()) break;
    page = await page.next();
  }

  summary.rawHistoryMessageCount = allRaw.length;
  for (const msg of allRaw) {
    const name = msg.name ?? '<no-name>';
    summary.rawByName[name] = (summary.rawByName[name] ?? 0) + 1;
    const headers = getTransportHeaders(msg);
    const role = headers['role'] ?? '<no-role>';
    summary.rawByRole[role] = (summary.rawByRole[role] ?? 0) + 1;
    const action = msg.action ?? '<no-action>';
    summary.rawByAction[action] = (summary.rawByAction[action] ?? 0) + 1;
  }

  console.log(`Raw history: ${String(allRaw.length)} messages across ${String(pageCount)} Ably page(s).`);
  console.log('  by name:', summary.rawByName);
  console.log('  by role header:', summary.rawByRole);
  console.log('  by action:', summary.rawByAction);

  // Print a compact chronological dump of the raw wire log so the reader can
  // confirm realistic ordering (user input before run-start for each turn).
  const chronological = [...allRaw].reverse();
  console.log('\nWire log (oldest -> newest):');
  for (const msg of chronological) {
    const headers = getTransportHeaders(msg);
    const compact = {
      name: msg.name,
      action: msg.action,
      serial: msg.serial?.slice(-12),
      role: headers['role'],
      runId: headers['run-id']?.slice(-8),
      cmid: headers['codec-message-id'],
      parent: headers['parent'],
      forkOf: headers['fork-of'],
      status: headers['status'],
      stream: headers['stream'],
      discrete: 'discrete' in headers ? 'true' : undefined,
    };
    // Drop undefined keys for legibility.
    const filtered: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(compact)) if (v !== undefined) filtered[k] = v;
    console.log('  ', filtered);
  }

  await rawChannel.detach();

  // Now open a fresh ClientSession and call loadOlder(limit).
  const logger = makeLogger({ logLevel });
  const session = createClientSession<VercelInput, VercelOutput, VercelProjection, AI.UIMessage>({
    client,
    channelName,
    codec: UIMessageCodec,
    clientId: client.auth.clientId ?? undefined,
    logger,
  });

  // Observe tree events that fire during loadOlder.
  session.tree.on('ably-message', () => {
    summary.treeAblyMessageEvents++;
  });
  session.tree.on('update', () => {
    summary.treeUpdateEvents++;
  });
  session.tree.on('run', () => {
    summary.treeRunEvents++;
  });
  session.tree.on('output', () => {
    summary.treeOutputEvents++;
  });

  console.log('\nConnecting session...');
  await session.connect();
  console.log(`Session connected. Staging ${String(calls)} sequential view.loadOlder(${String(limit)}) calls...`);

  const callRecords: {
    call: number;
    durationMs: number;
    visibleRunCount: number;
    visibleRunIdsTail: string[];
    hasOlder: boolean;
    treeAblyMessageEvents: number;
    treeUpdateEvents: number;
  }[] = [];

  summary.startedAt = Date.now();
  for (let i = 1; i <= calls; i++) {
    const callStart = Date.now();
    let watchdogFired = false;
    const watchdog = setTimeout(() => {
      watchdogFired = true;
      console.warn(`WATCHDOG: loadOlder #${String(i)} still running after ${String(watchdogMs)}ms`);
    }, watchdogMs);

    const treeAblyBefore = summary.treeAblyMessageEvents;
    const treeUpdateBefore = summary.treeUpdateEvents;

    try {
      await session.view.loadOlder(limit);
    } catch (error) {
      summary.notes.push(`loadOlder #${String(i)} threw: ${error instanceof Error ? error.message : String(error)}`);
    }
    clearTimeout(watchdog);
    if (watchdogFired) summary.notes.push(`call #${String(i)}: watchdog fired before resolution`);

    const durationMs = Date.now() - callStart;
    const runs = session.view.runs();
    const record = {
      call: i,
      durationMs,
      visibleRunCount: runs.length,
      visibleRunIdsTail: runs.map((r) => r.runId.slice(-8)),
      hasOlder: session.view.hasOlder(),
      treeAblyMessageEvents: summary.treeAblyMessageEvents - treeAblyBefore,
      treeUpdateEvents: summary.treeUpdateEvents - treeUpdateBefore,
    };
    callRecords.push(record);
    console.log(
      `  call #${String(i)}: ${String(durationMs)}ms, runs=${String(record.visibleRunCount)} ` +
        `[${record.visibleRunIdsTail.join(', ')}] hasOlder=${String(record.hasOlder)} ` +
        `newWires=${String(record.treeAblyMessageEvents)} newUpdates=${String(record.treeUpdateEvents)}`,
    );
  }
  summary.finishedAt = Date.now();
  summary.durationMs = summary.finishedAt - summary.startedAt;

  const finalRuns = session.view.runs();
  summary.visibleRunCount = finalRuns.length;
  summary.visibleRunIds = finalRuns.map((r) => r.runId);
  summary.hasOlder = session.view.hasOlder();

  // Also peek at the unfiltered tree to see what was folded.
  const allTreeNodes = session.tree.visibleNodes();
  summary.visibleNodeCount = allTreeNodes.length;

  console.log('\n--- Tree state (after loadOlder) ---');
  console.log('Tree visible nodes:', allTreeNodes.length);
  for (const node of allTreeNodes) {
    if (node.kind === 'run') {
      console.log(
        `  run runId=${node.runId.slice(-8)} status=${node.status} ` +
          `startSerial=${node.startSerial?.slice(-12) ?? '<none>'} ` +
          `parentCmid=${node.parentCodecMessageId ?? '<root>'}`,
      );
    } else {
      console.log(
        `  input cmid=${node.codecMessageId} serial=${node.serial?.slice(-12) ?? '<none>'} ` +
          `parentCmid=${node.parentCodecMessageId ?? '<root>'} forkOf=${node.forkOf ?? '<none>'}`,
      );
    }
  }

  console.log('\n--- view.runs() (final) ---');
  console.log(finalRuns);

  console.log('\n--- Per-call records ---');
  console.log(JSON.stringify(callRecords, null, 2));

  console.log('\n--- Summary ---');
  console.log(JSON.stringify(summary, null, 2));

  // Verdict — check incremental segmentation across calls.
  const onChannelRuns = summary.rawByName['ai-run-start'] ?? 0;
  const expectedFinal = onChannelRuns;
  const slowCalls = callRecords.filter((r) => r.durationMs > 5000);
  const stuckCalls = callRecords.filter((r) => r.visibleRunCount === 0 && r.call === 1);

  if (stuckCalls.length > 0) {
    summary.reproduced = true;
    console.log(`\nRESULT: REPRODUCED — first loadOlder(${String(limit)}) returned 0 runs.`);
  } else if (summary.visibleRunCount < expectedFinal) {
    console.log(
      `\nRESULT: PARTIAL — after ${String(calls)} calls, ${String(summary.visibleRunCount)} of ${String(expectedFinal)} runs visible.`,
    );
  } else if (summary.visibleRunCount === expectedFinal) {
    console.log(
      `\nRESULT: PASS — all ${String(expectedFinal)} on-channel runs revealed across ${String(calls)} calls.`,
    );
  } else {
    console.log(
      `\nRESULT: UNEXPECTED — saw ${String(summary.visibleRunCount)} runs but channel has ${String(expectedFinal)} ai-run-start wires.`,
    );
  }
  if (slowCalls.length > 0) {
    console.log(
      `Slow: ${String(slowCalls.length)} call(s) took >5s:`,
      slowCalls.map((c) => `#${String(c.call)}=${String(c.durationMs)}ms`).join(', '),
    );
  }

  session.close();
  await client.close();
};

main().catch((error: unknown) => {
  console.error('Script failed:', error);
  process.exit(1);
});
