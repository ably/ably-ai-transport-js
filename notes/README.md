# Reviewer materials — OpenAI Responses codec PR

> ⚠️ **OUT OF DATE.** These materials were written for an earlier shape of the
> OpenAI codec and have not been refreshed for its current wire model — notably
> the `drop`-based wire curation, the slimmed `output_item.done`, the
> payload-less terminal lifecycle events, and the `deltaFields` →
> `decodeDeltaFields` rename. Treat the explainers as background only; do not
> rely on their specifics until they are brought back in line with the code.

**Temporary.** This directory exists only to support review of the OpenAI codec
PR (AIT-1115) and is dropped before merge. Open the HTML files in a browser.

Read in this order:

1. **`openai-streaming-events-cheatsheet.html`** — a pure reference on OpenAI's
   Responses API: the `Response` / item / content-part structure, the coordinate
   system (`item_id`, `output_index`, `content_index`, `summary_index`,
   `call_id`), and what every stream event means. No SDK content — it is the
   background needed to read anything else in the PR.
2. **`streaming-target-model.html`** — how the SDK treats those events: the
   slot model ("text growing into a slot"), the five stream families, the three
   codec-API capabilities they needed (`streamId` extractor, `deltaFields` +
   `decodeDelta`, `startWhen`), and what this PR adds to provide them.

The durable background lives elsewhere: the Responses-API research and target
decision in
[AITRFC-022](https://ably.atlassian.net/wiki/spaces/AI/pages/5218598915)
(unreviewed Claude-generated draft), the work breakdown in the AIT-897 epic's
tickets, and the design narrative in the PR description and commit messages.
