# Requirements for updating this demo

The `day-out-planner` demo in this directory was created a long time ago, with the intention of demonstrating the fact that AI Transport's durable sessions provide a place for both human-to-human and human-to-agent collaboration.

I wrote a draft blog post based on this demo, which can be found inside `../blog`.

I recieved some [feedback](https://ably-real-time.slack.com/archives/C09SY1AQGK0/p1780314948256159?thread_ts=1780080630.685609&cid=C09SY1AQGK0) on this blog post, and I wish to act on it to get the blog post into a place where it's ready to share.

As I mentioned there, the current implementation of the demo is quite a hack, since in the SDK's API at the time:

- there was not a proper way to tell the SDK to send a message without invoking the agent
- the LiveObjects usage was a hack and required us to use a separate channel due to issues surrounding how to specify channel modes

Since then, the SDK's API has evolved considerably. In particular:

- on `main` there is now a first-class concept of an `Invocation`, which is what triggers the agent to perform work 
- in not-yet-merged https://github.com/ably/ably-ai-transport-js/pull/182 the LiveObjects API is now exposed via this SDK and the channel modes problem appears to be resolved

## Task

Your task is to figure out how to get this demo into a place that allows us to address the blog post feedback.

For gathering context, I'd suggest at a minimum:

- read the full Slack thread (use ably-os)
- read the draft blog post
- look at all the work that's been done on this branch so far (there are some documents in `initial` and also the demo's `README` which explain some of the decisions)
- look at the API changes from the LiveObjects work that's been done in #182

Things to investigate:

- whether the `Invocation` concept would now allow us to address Fiona's question of "As well as multi-participant, I think you should explain in more detail how a durable session lets the developer choose when the agent does work - how would someone do this without a durable session? Maybe illustrate with a code snippet if it's neat." in a way that we'd be happy to share
- whether pulling in the contents of #182 will allow us to fix the LiveObjects hack and make things indeed be all on the same channel

(If we're going to pull in later SDK changes into this branch, I'd prefer to merge those SDK changes in instead of rebasing, to preserve the original history for now.)

My main aim is to be able to progress the blog post so that I can actually get something published. If you think there is feedback that we can't address without making changes to the SDK, let me know.

## Unknowns

- Also though there is a first-class concept of an `Invocation`, I don't know whether there is a way from the React layer to say "send a message without performing an invocation"
- We have not yet decided the official correct way to, at the wire level, represent user messages that aren't intended to trigger an invocation. My thoughts are, for now, that the best thing to do would be to just send them in the same `ai-input` format as messages that _do_ trigger an invocation, so that they still end up in the message tree and thus in the agent's LLM call context.
