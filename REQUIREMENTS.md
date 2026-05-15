# Requirements: Day out planner demo

A new demo app to live in this repo: a collaborative app for multiple users to plan a day out together with the assistance of an AI agent ("Bernard").

## UX components

- A chat window where users can exchange messages. Messages from the AI agent also appear here.
- A map that shows all the places on the itinerary
- A message input box for sending messages into the chat. Autocomplete to send to `@bernard`

## Requirements

- Sending to `@bernard` triggers an LLM call with all of the messages from the chat so far, so that it can act on what it's been told to do
- Messages not targeted at `@bernard` are just chat between users and don't trigger an LLM call

## Tech stack

- Ably AI Transport SDK
- The same Vercel / React setup as the other demo apps, same env file setup etc
- Frontend should use the `useClientSession` hooks (i.e. the richer ones, not `useChatTransport`) — if there's a resaon this doesn't work tell me
- Ably LiveObjects (from ably-js) to store the itinerary
    - agent writes to it via a server-side tool call
    - client recieves LiveObject updates and uses them to render the itinerary as a map and a list

## Example interactions

### Two-way conversation

1. Alice: hey bob let's do something on saturday, i was thinking maybe pizza near avenida paulista
2. Bob: yeah sure but i wanted to go see devil wears prada 2 as well, maybe let's do that then eat?
3. Alice: sure sounds good, we could go to cine belas artes?
4. Bob: yeah, i like it there
5. Alice: cool, @bernard make a plan for us
6. Bernard then:
   1. researches showtimes
   2. finds pizza places
   3. asks any clarifying questions
   4. decides on where to go and updates the itinerary
7. Charlie: oh hey folks let's also go to a museum nearby
8. Bob: maybe an art gallery?
9. Charlie: sure, @bernard help us out
10. Bernard then:
  1. finds an art gallery
  2. adds it to the itinerary

## Open questions

- What should render the map? Is there some free easy way to get one?
- How do we make Bernard know who sent each message in the chat? i.e. how do we stuff that info into the prompt
