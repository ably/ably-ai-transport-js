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
      'The assistant calls getLocation in your browser (you will see a permission prompt). The run suspends while you resolve it client-side, then resumes and streams the weather — the whole suspend/resume turn persists to the database as one unit.',
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
      'getWeatherForecast pauses at approval-requested. Approve publishes a tool-approval-response on the channel; the agent resumes and the result lands on the original message. After a reload, the approved tool-call message is rehydrated from the database still showing as approved.',
  },
  {
    title: 'Database hydration',
    action: (
      <>
        Send a few turns, then <span className="font-medium text-zinc-100">reload the page</span>.
      </>
    ),
    demonstrates:
      'The agent persists each completed run to the store. On reload the demo seeds from the database and reconciles it with the live channel at the seam, so the conversation comes back exactly once — no duplicates, no gaps.',
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
        <h2 className="text-lg font-semibold text-zinc-100">ClientSession over Ably — database hydration</h2>
        <p className="text-sm text-zinc-300">
          A linear chat wired to the Ably AI Transport ClientSession API, with a database behind it. The agent persists
          every completed run to a store; on load the demo seeds from that store and reconciles it with the live channel
          at the seam (via <span className="font-mono text-xs">useMessagesWithSeed</span>). Client-executed and
          approval-gated tools suspend and resume the run, and the whole suspend/resume turn persists as one lossless
          unit. Each item below exercises a specific feature - try them in order to see what it does.
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
