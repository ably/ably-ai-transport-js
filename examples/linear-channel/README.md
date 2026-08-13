# Linear channel (no conversation tree)

This example is the AIT-side proof of the core primitives on `feature/channel-clone-truncate` in `ably/realtime`.

The stream does not carry `parent`, `fork-of`, `msg-regenerate`, or `supersedes`.

## Behaviours

| Action | Call |
|---|---|
| Send | `publish` |
| Regenerate | `publish` with the same `turn-id` |
| 1 / N versions | Group `visible(history)` by `turn-id` |
| Rewind to here | `POST /channels/{id}/truncate` `{ afterSerial }` |
| Edit | cancel + truncate + publish |
| Fork all | `POST /channels/{id}/clone` `{ destChannel }` |
| Fork from here | `POST /channels/{id}/clone` `{ destChannel, untilSerial }` |

`untilSerial` is inclusive. Dest gets that serial and every earlier serial. Dest does not get later rows. There is no dest truncate.

## Files

- `linear.ts` — the whole app-side API
- `linear.test.ts` — unit tests for 1/N and visible history
- `show.ts` — walkthrough; optional farm run

```bash
pnpm exec vitest run examples/linear-channel/linear.test.ts
ABLY_KEY=... ABLY_HOST=127.0.0.1 ABLY_PORT=8081 pnpm exec tsx examples/linear-channel/show.ts
```

Keep runs, cancel, and codecs in the main SDK. Drop the tree headers and the branch walk.
