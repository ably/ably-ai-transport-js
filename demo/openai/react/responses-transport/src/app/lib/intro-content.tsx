import type { Scenario } from '@ably-ai-demos/frontend/lib/progress-steps';

export const INTRO_TITLE = 'OpenAI Responses over Ably';

export const INTRO_DESCRIPTION =
  'A chat wired directly to the Ably AI Transport client transport, with the OpenAI Responses codec. The transport ' +
  'publishes inputs and decodes events off a single Ably channel; the app merges those events into a linear thread ' +
  "using OpenAI's own stream accumulator. The thread stays in sync across a user's devices and across multiple " +
  'participants, with a bidirectional channel between user and agent for cancellation. Each item below exercises a ' +
  'specific feature - try them in order to see what it does.';

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
    id: 'client-weather',
    tag: 'Client tool',
    title: 'Client-side tool call',
    prompt: 'where am I?',
    blurb:
      'The model calls getLocation, which has no server executor: the run suspends, the browser resolves geolocation and publishes the result, and a continuation resumes the same run so the model can reply.',
  },
  {
    id: 'approval-forecast',
    tag: 'Approval tool',
    title: 'Approval-gated tool call',
    prompt: `what's the weather forecast for Paris?`,
    action: (
      <>
        Ask for a forecast, e.g.{' '}
        <span className="font-medium text-foreground">&ldquo;what&rsquo;s the weather forecast for Paris?&rdquo;</span>,
        then Approve or Deny.
      </>
    ),
    blurb:
      'The model calls getWeatherForecast; the run suspends and shows an approval card. Approve and the agent runs the tool on resume; Deny and it skips it — either way the same run resumes.',
  },
  {
    id: 'multi-tab',
    tag: 'Multi-client sync',
    title: 'Multi-client sync',
    gesture: 'open in new tab (header), then send from either',
    blurb: 'Both tabs share the same Ably channel. Messages, streams, and run state stay in sync.',
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
      'Nothing is held in app state: the client pages channel history and re-merges the thread — even mid-stream, where hydrated history and the live continuation merge to one message.',
  },
  {
    tag: 'Observability',
    title: 'Observability',
    action: (
      <>
        Open the <span className="font-medium text-foreground">Debug pane</span> on the right.
      </>
    ),
    blurb: 'Three tabs: raw Ably messages on the wire, the merged conversation thread, and run lifecycle events.',
  },
];
