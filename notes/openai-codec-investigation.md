# Investigation for OpenAI codec

The task we're working on is https://ably.atlassian.net/browse/AIT-742. Some context and requirements there but further things below.

The aim is to write a codec that supports one of the OpenAI APIs. The task is still a bit ill-defined so we need to do some investigation first.

Note that this will be the second codec that we've written; the first one is the Vercel codec. In theory we have a declarative API that makes it easy to write new codecs, but given that we've only used it to write the Vercel codec so far it may turn out to be too Vercel-specific.

## Which backend API are we going to target?

We've identified two potential OpenAI APIs that we could use on the backend:

- OpenAI Responses API (streamed over SSE): https://developers.openai.com/api/docs/guides/streaming-responses
- OpenAI Agents SDK: https://developers.openai.com/api/docs/guides/agents

I am mildly familiar with the Responses API (that is, I know it emits a stream of events) but I have not looked at the Agents SDK.

The reason that we're targeting OpenAI as our next codec is because we believe that a lot of other providers (e.g. OpenRouter) provide "OpenAI compatible" APIs. We are assuming that this means they provide event streams that are compatible with the Responses API. You should research whether this understanding is correct. We must make sure that our codec is able to consume events in this common format.

If the common format turns out to be that of the streamed Responses API, then we need to understand whether the Agents SDK produces an events stream whose possible events are a superset of the Responses API events. If it does, then it is desirable to support the Agents SDK too. If it does not, then we will focus on the Responses API.

## What demo would we be able to build, and what features would we be able to support?

The aim for demonstrating this codec is to be able to have a demo which is a copy of the existing use-client-session demo, but whose server route calls an OpenAI SDK and consumes its stream of events, and whose frontend is able to consume the resulting tree to drive a chat UI.

But this raises questions: what functionality does the underlying domain model support? The Vercel domain model is rich and is designed for an agentic loop on the backend and a large set of client-side functionality for interacting with this agentic loop (tool call approvals, client-side tool calls). It might be that neither of the OpenAI SDKs mentioned above provide such a rich domain model (the Agents SDK probably does more so than the Responses API).

Of course, since Vercel's SDK implements its domain model on top of the underlying provider APIs, it is possible to build an equivalent set of functionality on top of those APIs. But it's still unclear whether doing this would be something that our own SDK would try and achieve, or whether we'd find a way of doing it in the demo app, or whether we'd de-scope such feature support initially.

I'd like to hear your thoughts on this — and, again, it will depend on which of the two OpenAI SDKs we choose to use. It may be that if we go with the Responses API then we start by building a simple agentic loop in the backend that can just do server-side tool calls (e.g. "what's the weather in London" in that example) in order to get a first shippable iteration.

## What will the codec's generic type arguments be?

A `Codec` is parameterised by four generic types (`Input`, `Output`, `Projection`, `Message`). I'd like to hear your suggestions for each of these and how they relate to the types vended by the underlying OpenAI SDKs.

I'm particularly interested in what `Message` would be since this is what the UI renders, and `Input` since this is what the UI sends.

## Notes

Note that the SDK is pre-v1 so we do not need to worry about breaking existing public APIs if necessary, nor yet too much (e.g. when choosing codec's generic args) about making sure that our choices can be extended in a backwards-compatible fashion in the future.

## Task

Investigate the points above and give me recommendations for how we approach building this codec. For decisions that I've already identified as pending, give me your opinion. Tell me where there are further decisions to make that I may not yet be aware of. Also give me an idea of the level of complexity of this task. If you believe that there are things that could be de-scoped to reduce the complexity of the initial codec, tell me the phases in which you would build this codec, with a clear idea of what shippable functionality would exist at the end of each phase.

Make sure that you are confident about your understanding of the abilities of the OpenAI APIs that I mentioned; if you need to locally check out any OpenAI SDK repositories to confirm details then you should do so.

Only use official OpenAI resources; that is, their website or SDK source code repositories, and make sure that your answers are given in relation to the latest versions of the OpenAI SDKs.

Also make sure that you have read all in-repo code and documentation that describes the codec and the Vercel codec, and that you have looked at the code for the use-client-session demo.

Cite your sources.
