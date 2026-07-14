interface DemoStep {
  title: string;
  action: React.ReactNode;
  demonstrates: string;
}

const STEPS: DemoStep[] = [
  {
    title: 'Streamed text response',
    action: (
      <>
        Ask anything, e.g.{' '}
        <span className="font-medium text-zinc-100">&ldquo;explain how Ably channels work&rdquo;</span>.
      </>
    ),
    demonstrates:
      'The agent runs the OpenAI Responses API and streams the reply back over Ably via the Responses codec, token by token.',
  },
  {
    title: 'Server-side tool call',
    action: (
      <>
        Ask for the weather, e.g.{' '}
        <span className="font-medium text-zinc-100">&ldquo;what&rsquo;s the weather in London?&rdquo;</span>.
      </>
    ),
    demonstrates:
      'The model calls the getWeather tool, the agent runs it server-side and streams the result back as a weather card, then the model replies — all within one run, no suspend.',
  },
  {
    title: 'Multi-client sync',
    action: (
      <>
        Click <span className="font-medium text-zinc-100">open in new tab</span> in the header, then send a message from
        either tab.
      </>
    ),
    demonstrates: 'Both tabs share the same Ably channel. Messages, streams, and run state stay in sync.',
  },
  {
    title: 'Edit (branch)',
    action: (
      <>
        Hover a user message, click <span className="font-medium text-zinc-100">edit</span>, change the text.
      </>
    ),
    demonstrates:
      'Re-sends as a forked branch rooted at the edited message. Use the arrows to switch between branches.',
  },
  {
    title: 'Regenerate (branch)',
    action: (
      <>
        Hover an assistant reply, click <span className="font-medium text-zinc-100">regenerate</span>.
      </>
    ),
    demonstrates: 'Forks a new branch from that point. Previous branch is kept — the tree remembers both.',
  },
  {
    title: 'Cancel mid-stream',
    action: (
      <>
        Send a long prompt, then click <span className="font-medium text-zinc-100">Stop</span> while the assistant is
        writing.
      </>
    ),
    demonstrates: 'Cancel is published over Ably; the agent aborts the model stream and the client closes cleanly.',
  },
  {
    title: 'History on refresh',
    action: <>Reload the page — the conversation rebuilds from the channel.</>,
    demonstrates:
      'Nothing is held in app state: the session replays channel history and reconstructs the full conversation tree.',
  },
  {
    title: 'Observability',
    action: (
      <>
        Open the <span className="font-medium text-zinc-100">Debug pane</span> on the right.
      </>
    ),
    demonstrates:
      'Three tabs: raw Ably messages on the wire, resolved conversation turns, and transport lifecycle events.',
  },
];

export function IntroCard() {
  return (
    <div className="mx-auto max-w-2xl space-y-6 py-8">
      <header className="space-y-2">
        <h2 className="text-lg font-semibold text-zinc-100">OpenAI Responses over Ably</h2>
        <p className="text-sm text-zinc-300">
          A chat wired directly to the Ably AI Transport ClientSession API, with the OpenAI Responses codec. The session
          subscribes to a single Ably channel and exposes a branching conversation tree, a paginated view, and write
          operations (send, regenerate, edit, cancel). Sessions stay in sync across a user's devices and across multiple
          participants, with a bidirectional channel between user and agent for cancellation and steering. Each item
          below exercises a specific feature - try them in order to see what it does.
        </p>
      </header>

      <ol className="space-y-4">
        {STEPS.map((step, i) => (
          <li
            key={step.title}
            className="flex gap-3"
          >
            <span className="mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border border-zinc-700 text-xs font-medium text-zinc-300">
              {i + 1}
            </span>
            <div className="flex-1 space-y-1">
              <div className="text-sm font-medium text-zinc-100">{step.title}</div>
              <div className="text-sm text-zinc-300">{step.action}</div>
              <div className="text-xs text-zinc-400">{step.demonstrates}</div>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
