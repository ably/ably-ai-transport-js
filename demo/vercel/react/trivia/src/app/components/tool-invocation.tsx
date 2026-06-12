'use client';

/**
 * Inline rendering for the quizmaster's tool calls. The object writes the
 * tools perform are deliberately visible in the conversation — they're half
 * the point of the demo.
 */

import type { DynamicToolUIPart } from 'ai';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function ToolChip({ icon, children }: { icon: string; children: React.ReactNode }) {
  return (
    <div className="my-1 flex items-center gap-2 rounded-md border border-zinc-700/40 bg-zinc-800/60 px-2.5 py-1.5 text-xs text-zinc-400">
      <span>{icon}</span>
      <span>{children}</span>
    </div>
  );
}

function ToolPending({ name }: { name: string }) {
  return (
    <div className="my-1 flex items-center gap-2 rounded-md border border-zinc-700/40 bg-zinc-800/60 px-2.5 py-1.5 text-xs">
      <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-amber-500/60" />
      <span className="text-zinc-400">
        Calling <span className="font-mono text-zinc-300">{name}</span>
      </span>
    </div>
  );
}

function ToolError({ name, errorText }: { name: string; errorText: string }) {
  return (
    <div className="my-1 rounded-md border border-red-900/30 bg-red-950/30 px-2.5 py-1.5 text-xs">
      <span className="text-red-400">
        <span className="font-mono">{name}</span> failed: {errorText}
      </span>
    </div>
  );
}

/** Award card — "+10 → Alice", rendered from the tool's output. */
function AwardCard({ output }: { output: unknown }) {
  if (!isRecord(output) || typeof output.awarded !== 'number' || typeof output.playerName !== 'string') {
    return <ToolChip icon="&#11088;">Points awarded</ToolChip>;
  }
  return (
    <div className="my-1 flex items-center gap-2 rounded-md border border-emerald-800/40 bg-emerald-950/40 px-2.5 py-1.5 text-xs">
      <span>&#11088;</span>
      <span className="font-mono font-semibold text-emerald-300">+{output.awarded}</span>
      <span className="text-zinc-300">{output.playerName}</span>
      {typeof output.reason === 'string' && output.reason.length > 0 && (
        <span className="truncate text-zinc-500">&mdash; {output.reason}</span>
      )}
    </div>
  );
}

interface ToolInvocationProps {
  part: DynamicToolUIPart;
}

export function ToolInvocation({ part }: ToolInvocationProps) {
  switch (part.state) {
    case 'input-streaming':
    case 'input-available':
      return <ToolPending name={part.toolName} />;

    case 'output-available': {
      // A tool that rejected the call (phase guard, unknown player) returns
      // an `{ error }` result so the model can self-correct — show it muted.
      if (isRecord(part.output) && typeof part.output.error === 'string') {
        return (
          <ToolChip icon="&#9888;&#65039;">
            <span className="font-mono">{part.toolName}</span>: {part.output.error}
          </ToolChip>
        );
      }
      switch (part.toolName) {
        case 'startQuiz':
          return <ToolChip icon="&#127881;">Quiz started</ToolChip>;
        case 'askQuestion':
          return <ToolChip icon="&#10067;">Question published to the board</ToolChip>;
        case 'awardPoints':
          return <AwardCard output={part.output} />;
        case 'endQuiz':
          return <ToolChip icon="&#127942;">Quiz finished</ToolChip>;
        default:
          return (
            <ToolChip icon="&#128295;">
              <span className="font-mono">{part.toolName}</span>: {JSON.stringify(part.output)}
            </ToolChip>
          );
      }
    }

    case 'output-error':
      return (
        <ToolError
          name={part.toolName}
          errorText={part.errorText}
        />
      );

    default:
      return null;
  }
}
