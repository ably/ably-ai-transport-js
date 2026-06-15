Multi-human chats with AI

AI agents are helpful. Other people are helpful. How can we combine 

focus:
- common space for humans and agents
- multi-client (shared history etc)
- but not on the disconnect etc angle
- questions not addressed:
	- "you already have a dedicated solution for people to talk to each other; why isn't this integrated with that?"

*well it's not just benefit from it's they are needed e.g. in a collaborative experience*
*we could go further into other things like CodeRabbit or Slack type experiences*
## Content

AI chats are often a rather solitary experience: just you and ChatGPT, sitting there together, solving a problem. But so many of the tasks that we perform day to day are ones that benefit from, or often even require, collaboration with other people such as colleagues, family members, or friends.

So, if AI agents are helpful, and other people are helpful, then how can we provide a space for multiple people to collaborate with each other _and_ with AI agents?

This is a question to which the flagship AI chat products don't yet have a good answer: the best you can do in ChatGPT or Claude is to share your chat with somebody else, for them to fork and continue the conversation independently.

That said, it's encouraging to see that the companies behind these products are starting to think about this problem. For example, Anthropic's recently-launched [Claude Design](https://www.anthropic.com/news/claude-design-anthropic-labs) offers one approach: whilst a design still has a single owner who drives the chat with Claude, the tool provides a separate "Comments" section in which you can invite team members to discuss the design. Perhaps your colleague thinks that this button should be bigger and more yellow; you disagree, thinking it should be rounder and orangey. You have some back-and-forth and eventually decide to make it rounder but keep the colour the same. Once you've decided this, you can press a "Resolve with Claude" button on the comment thread which submits its contents to Claude, who then updates the design in response.

In this article, we'll explore a different model: a single chat in which agents and multiple people are all equal, first-class collaborators. We'll take a look at a demo that allows you and your friends to plan a day out together with the help of an AI assistant who you can involve in your conversation precisely at the moments when you want his help. Then we'll explain how [durable sessions](https://durablesessions.ai/) are a primitive that provide a shared space for agents and humans to exchange messages and for humans to invoke agents when needed, and how [Ably AI Transport](https://ably.com/ai-transport) provides a simple, extensible implementation of this primitive.

## Demo: planning a day out with friends

### Making initial plans

Alice and Steve are friends who are chatting with each other through a messaging app, planning a day out. Alice suggests that they go for pizza; Steve thinks that this sounds great and maybe they could also see some live music afterwards. Alice likes the sound of this, and suggests an area where they could meet and also says they could perhaps have a walk in a park. Steve likes the idea.

So far, this is just a normal chat between two people; no AI here. But now, Steve tags Bernard, our helpful AI assistant, to do the hard work of actually finding the places to go and planning the day out.

Bernard leaps into action, choosing places to go and updating a shared itinerary. Alice and Steve both see Bernard's responses streaming in realtime.

### Some more back-and-forth

Once Bernard has done his work, the conversation goes back to being a normal chat; he won't get involved until Alice or Steve tag him again.

Alice and Steve then chat some more: Steve doesn't want to go the jazz place that Bernard suggested, so Alice suggests they see some rock instead. Alice also wants to get ice cream after lunch. They agree on their plans and once again summon Bernard, who has full visibility of the new messages that Alice and Steve exchanged. Bernard gets to work again, researching places to go based on these new preferences and updating the itinerary.

### New participants

Later on, their friend Trevor joins the chat. When he opens the chat, he sees all of the conversation history (that is, messages from Alice, Steve, and Bernard) and also the shared itinerary. He tags Bernard to ask him what's been planned so far, and Bernard fills him on the plans.

Trevor can now also get involved in collaborating on the plans, just like Alice and Steve were doing before.

### Video

Take a look at this video, which shows it all in action:

*video to be embedded here*

## Durable sessions: a shared medium for everyone

Most client-side AI frameworks only concern themselves with how a single user exchanges messages with AI agents. When the user sends a message from the chat UI, this unconditionally performs an HTTP request that submits the message history to the agent for processing. All of the session state is stored locally in the client-side app. There is no concept of interacting with other users.

A _durable session_ provides an addressable medium that is shared between agents and humans. It stores all of the conversation state for a given chat, and syncs this state between all participants (human and AI) in the chat. Submitting a message to a durable session does not automatically trigger AI inference; rather, the session provides a separate mechanism for your app to trigger this inference when appropriate for the UX that you are building. Once invoked, the agent can use all of the messages that have been exchanged so far to decide its next move.

## Ably AI Transport SDK: Durable sessions in practice

At Ably, we believe that durable sessions will allow developers to build the next generation of agentic applications. We've built the [Ably AI Transport SDK](https://github.com/ably/ably-ai-transport-js), which provides an implementation of durable sessions on top of [Ably channels](https://ably.com/docs/channels). It comes with a drop-in integration with the [Vercel AI SDK](https://ai-sdk.dev/), meaning that if you're using already using Vercel then you don't need to make any changes to your server-side inference or agentic loop code.

The demo that I showed above was built using the AI Transport SDK. When you use Ably AI Transport, you also get access to all of the features that come built in with Ably channels. For example, in the demo, I used [Ably LiveObjects](https://ably.com/liveobjects) to drive the shared itinerary: the agent writes itinerary updates to a shared LiveMap, and clients receive updates to the itinerary in realtime, using these updates to update the itinerary UI (the map and the list).