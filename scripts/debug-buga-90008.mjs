/**
 * Minimal repro for 90008 "Unable to get channel history: attach point not
 * found" on untilAttach history queries.
 *
 * The bug (realtime: lib/channel/messagecache.go LiveHistory): an untilAttach
 * query fails with 90008 — instead of returning an empty page — when:
 *   (a) the channel has NO messages at or before the attach point, and
 *   (b) the channel serial has advanced past the attach point, and
 *   (c) the query is served by a frontdoor whose message cache has no
 *       subscription for the channel (so its only entry is an epoch sentinel
 *       at the CURRENT serial, which is after the attach point; a
 *       zero-message populate fetch inserts nothing, so the attach point is
 *       never found).
 *
 * Each iteration: fresh channel -> attach (empty) -> publish one message
 * (advances the serial) -> untilAttach history. Crucially there is NO history
 * query before the publish — that would seed the frontdoor cache with an
 * entry at the attach point and mask the bug.
 *
 * Two queries per iteration:
 *   - SDK:      channel.history({ untilAttach: true }) from the realtime
 *               client (may be masked when the request lands on the same
 *               frontdoor that holds the websocket subscription)
 *   - raw REST: GET /channels/{id}/messages?fromSerial=<attachSerial>
 *               (what untilAttach sends on the wire), via plain fetch
 *
 * Usage:
 *   ABLY_API_KEY=<key> ABLY_ENDPOINT=nonprod:sandbox node scripts/debug-buga-90008.mjs
 *   ITERATIONS=20 ABLY_API_KEY=<key> ... node scripts/debug-buga-90008.mjs
 */
import Ably from 'ably';

const key = process.env.ABLY_API_KEY;
if (!key) {
  console.error('ABLY_API_KEY is required');
  process.exit(1);
}
const endpoint = process.env.ABLY_ENDPOINT;
const iterations = Number(process.env.ITERATIONS) || 10;
const restHost = endpoint === 'nonprod:sandbox' ? 'sandbox-rest.ably.io' : 'rest.ably.io';
const basicAuth = `Basic ${Buffer.from(key).toString('base64')}`;

const t0 = Date.now();
const log = (msg) => console.log(`[+${String(Date.now() - t0).padStart(6, ' ')}ms] ${msg}`);

const rawRestHistory = async (channelName, fromSerial) => {
  const url = `https://${restHost}/channels/${encodeURIComponent(channelName)}/messages?fromSerial=${encodeURIComponent(fromSerial)}&limit=100&direction=backwards`;
  const res = await fetch(url, { headers: { Authorization: basicAuth } });
  return { status: res.status, body: await res.text() };
};

const realtime = new Ably.Realtime({ key, ...(endpoint ? { endpoint } : {}) });
await realtime.connection.once('connected');
log(`connected (connectionId=${realtime.connection.id})`);

let sdkFailed = 0;
let restFailed = 0;
for (let i = 0; i < iterations; i++) {
  const name = `ai:debug-buga-${Date.now().toString(36)}-${i}`;
  const ch = realtime.channels.get(name);

  await ch.attach(); // attach point on the empty channel
  const attachSerial = ch.properties.attachSerial;
  await ch.publish({ name: 'msg', data: { iteration: i } }); // serial advances past the attach point

  try {
    const page = await ch.history({ limit: 100, untilAttach: true });
    log(`iter ${i}: sdk untilAttach ok (${page.items.length} item(s))`);
  } catch (err) {
    sdkFailed++;
    log(`iter ${i}: sdk untilAttach FAILED code=${err.code} ${err.message} (attachSerial=${attachSerial})`);
  }

  const rest = await rawRestHistory(name, attachSerial);
  if (rest.status === 200) {
    log(`iter ${i}: raw REST fromSerial ok (${JSON.parse(rest.body).length} item(s))`);
  } else {
    restFailed++;
    log(`iter ${i}: raw REST fromSerial FAILED status=${rest.status} body=${rest.body.trim()}`);
  }

  await ch.detach();
  realtime.channels.release(name);
}

log(`done: sdk ${sdkFailed}/${iterations} failed, raw REST ${restFailed}/${iterations} failed`);
realtime.close();
