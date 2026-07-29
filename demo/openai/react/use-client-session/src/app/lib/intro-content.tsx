import type { Scenario } from '@ably-ai-demos/frontend/lib/progress-steps';

export const INTRO_TITLE = 'OpenAI Responses over Ably';

export const INTRO_DESCRIPTION =
  'A chat wired directly to the Ably AI Transport ClientSession API, with the OpenAI Responses codec. The session ' +
  'subscribes to a single Ably channel and exposes a branching conversation tree, a paginated view, and write ' +
  "operations (send, regenerate, edit, cancel). Sessions stay in sync across a user's devices and across multiple " +
  'participants, with a bidirectional channel between user and agent for cancellation and steering. Each item below ' +
  'exercises a specific feature - try them in order to see what it does.';

/**
 * This demo's scenarios, feeding both the intro-card walkthrough and the
 * suggestion chips. Entries with an `id` are tracked by `useDemoProgress` and
 * offered as chips until demonstrated; the rest are intro-only.
 */
export const DEMO_SCENARIOS: readonly Scenario[] = [
  {
    tag: 'Streaming',
    title: 'Streamed text response',
    action: (
      <>
        Ask anything, e.g.{' '}
        <span className="font-medium text-foreground">&ldquo;explain how Ably channels work&rdquo;</span>.
      </>
    ),
    blurb:
      'The agent runs the OpenAI Responses API and streams the reply back over Ably via the Responses codec, token by token.',
  },
  {
    id: 'server-weather',
    tag: 'Server tool',
    title: 'Server-side tool call',
    prompt: `what's the weather in Tokyo?`,
    blurb:
      'The model calls the getWeather tool, the agent runs it server-side and streams the result back as a weather card, then the model replies — all within one run, no suspend.',
  },
  {
    id: 'multi-tab',
    tag: 'Multi-client sync',
    title: 'Multi-client sync',
    gesture: 'open in new tab (header), then send from either',
    blurb: 'Both tabs share the same Ably channel. Messages, streams, and run state stay in sync.',
  },
  {
    id: 'edit',
    tag: 'Branching',
    title: 'Edit (branch)',
    gesture: 'hover a user message, click edit',
    blurb: 'Re-sends as a forked branch rooted at the edited message. Use the arrows to switch between branches.',
  },
  {
    id: 'regenerate',
    tag: 'Branching',
    title: 'Regenerate (branch)',
    gesture: 'hover an assistant reply, click regenerate',
    blurb: 'Forks a new branch from that point. Previous branch is kept — the tree remembers both.',
  },
  {
    id: 'cancel',
    tag: 'Cancel mid-stream',
    title: 'Cancel mid-stream',
    gesture: 'send a long prompt, click Stop while it streams',
    blurb: 'Cancel is published over Ably; the agent aborts the model stream and the client closes cleanly.',
  },
  {
    tag: 'History',
    title: 'History on refresh',
    action: <>Reload the page — the conversation rebuilds from the channel.</>,
    blurb:
      'Nothing is held in app state: the session replays channel history and reconstructs the full conversation tree.',
  },
  {
    tag: 'Observability',
    title: 'Observability',
    action: (
      <>
        Open the <span className="font-medium text-foreground">Debug pane</span> on the right.
      </>
    ),
    blurb: 'Three tabs: raw Ably messages on the wire, resolved conversation turns, and transport lifecycle events.',
  },
];
