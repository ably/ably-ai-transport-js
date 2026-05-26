interface DemoStep {
  title: string;
  action: React.ReactNode;
  demonstrates: string;
}

const STEPS: DemoStep[] = [
  {
    title: 'Server-side tool call',
    action: (
      <>
        Ask: <span className="font-medium text-zinc-100">&ldquo;what&rsquo;s the weather in Tokyo?&rdquo;</span>
      </>
    ),
    demonstrates: 'The assistant calls getWeather, which runs on the server and streams the result back over Ably.',
  },
  {
    title: 'Client-side tool call',
    action: (
      <>
        Ask: <span className="font-medium text-zinc-100">&ldquo;what&rsquo;s the weather like?&rdquo;</span>
      </>
    ),
    demonstrates:
      'The assistant calls getLocation in your browser (you will see a permission prompt), then feeds the coords into getWeather.',
  },
  {
    title: 'Approval-required tool call',
    action: (
      <>
        Ask:{' '}
        <span className="font-medium text-zinc-100">&ldquo;what&rsquo;s the weather forecast for London?&rdquo;</span>,
        then click <span className="font-medium text-zinc-100">Approve</span> on the card.
      </>
    ),
    demonstrates:
      'getWeatherForecast is gated behind addToolApprovalResponse. The assistant pauses with an Approve / Deny card; the tool only runs after you approve, and the result lands on the original message.',
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
        Hover a user message, click <span className="font-medium text-zinc-100">Edit</span>, change the text.
      </>
    ),
    demonstrates: 'Re-sends as a forked branch rooted at the edited message.',
  },
  {
    title: 'Regenerate (branch)',
    action: (
      <>
        Hover an assistant reply, click <span className="font-medium text-zinc-100">Regenerate</span>.
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
    demonstrates: 'Cancel is published over Ably; the server cancels the stream and the client closes cleanly.',
  },
  {
    title: 'Observability',
    action: (
      <>
        Open the <span className="font-medium text-zinc-100">Debug pane</span> on the right.
      </>
    ),
    demonstrates:
      'Three tabs: raw Ably messages on the wire, resolved UIMessage state, and transport lifecycle events.',
  },
];

export function IntroCard() {
  return (
    <div className="mx-auto max-w-2xl space-y-6 py-8">
      <header className="space-y-2">
        <h2 className="text-lg font-semibold text-zinc-100">useChat over Ably</h2>
        <p className="text-sm text-zinc-300">
          A Vercel AI SDK chat wired to an Ably transport. Supplying Ably as the customTransport for Vercel useChat
          gives the app resumable streams, sessions that stay in sync across a user's devices and across multiple
          participants, plus a bidirectional channel between user and agent for cancellation and steering. Each item
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
