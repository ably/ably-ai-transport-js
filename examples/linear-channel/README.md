# Linear channel (thin AIT POC)

Branch: `poc/thin-codec`  
Parent: `poc/thin-dropin`

This is F on A and E0.

No conversation tree. No `extras.ai`.

## 30-second demo

```bash
pnpm exec vitest run examples/linear-channel
```

Optional farm:

```bash
ABLY_KEY=... ABLY_HOST=127.0.0.1 ABLY_PORT=8081 pnpm exec tsx examples/linear-channel/dropin-server.ts
# POST { "text": "What is Rust?" } to /chat
# Rejected POST ({ "accepted": false }) publishes nothing
```

## What this proves

| File | POC | Proves |
|---|---|---|
| `dropin.ts` | A | Their POST. Accept then publish. Reject writes nothing. REST `id` dedups the user bubble. |
| `linear.ts` `applyAppend` | C (client) | `complete` / `stopped` freeze the default body in the helper. |
| `linear.ts` `latestByIdentity` | D (client only) | Retry identity ≠ REST `id`. Latest attempt only. Store isolation is realtime `poc/retry-identity`. |
| `linear.ts` `cutSpan` | E0 | Overlapping spans. Cut uses delete + stopped. Not channel truncate. |
| `codec.ts` | F | AG-UI / Vercel names → status + spans (+ stub identity). |

## What this does not prove

- Store freeze. See realtime `poc/streaming-status`.
- Zombie append stays on an old version. See realtime `poc/retry-identity`.
- A raw `ably-js` subscriber needs no fold.
- Scale, multi-region, attach-warm identity map.

## Behaviours

| Action | Call |
|---|---|
| Send | Their `POST /chat`. Server `publish`. |
| Stream | `append`. Close = `stream-status` complete/stopped. |
| Regenerate | New `publish`, same span / `turn-id`. |
| 1 / N | Group visible history by span. |
| Rewind | `POST /channels/{id}/truncate` `{ afterSerial }` |
| Stop / cancel | Request-plane stop. Cut span. Keep the partial bubble. |
| Fork | `POST /channels/{id}/clone` `{ destChannel, untilSerial? }` |

`untilSerial` is inclusive.

Stamps use `extras.headers` as a **shim** (`stream-status`, `retry-identity`, `spans`). Product shape is reserved fields.
