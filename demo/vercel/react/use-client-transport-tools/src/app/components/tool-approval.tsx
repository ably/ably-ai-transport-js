'use client';

interface ToolApprovalCardProps {
  toolName: string;
  toolCallId: string;
  input: unknown;
  output?: unknown;
  state: string;
  onApprove: () => void;
  onDeny: () => void;
}

export function ToolApprovalCard({
  toolName,
  toolCallId,
  input,
  output,
  state,
  onApprove,
  onDeny,
}: ToolApprovalCardProps) {
  // CAST: tool input is always a JSON object from the LLM's tool call
  const inputObj = input as Record<string, unknown> | undefined;
  const inputSummary = inputObj ? Object.values(inputObj).join(', ') : JSON.stringify(input);

  const isPending = state === 'approval-requested';
  const isApproved = state === 'output-available' || state === 'approval-responded';
  const isDenied = state === 'output-denied';
  const isError = state === 'output-error';

  const borderColor = isApproved
    ? 'border-emerald-800/50'
    : isDenied || isError
      ? 'border-red-800/50'
      : 'border-amber-800/50';

  const bgColor = isApproved ? 'bg-emerald-950/30' : isDenied || isError ? 'bg-red-950/30' : 'bg-amber-950/30';

  return (
    <div className={`my-2 rounded-lg border ${borderColor} ${bgColor} p-3`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-amber-400">Tool Approval</span>
            {isApproved && (
              <span className="rounded bg-emerald-950 px-1.5 py-0.5 text-[10px] font-medium text-emerald-400">
                Approved
              </span>
            )}
            {isDenied && (
              <span className="rounded bg-red-950 px-1.5 py-0.5 text-[10px] font-medium text-red-400">Denied</span>
            )}
            {isError && (
              <span className="rounded bg-red-950 px-1.5 py-0.5 text-[10px] font-medium text-red-400">Error</span>
            )}
          </div>
          <p className="mt-1 text-sm text-zinc-300">
            <span className="font-mono text-amber-300">{toolName}</span>
            {inputSummary && <span className="text-zinc-500"> &mdash; {inputSummary}</span>}
          </p>
          <p className="mt-0.5 text-[10px] font-mono text-zinc-600">{toolCallId.slice(0, 12)}...</p>

          {/* Show tool output when approved */}
          {isApproved && output && (
            <ToolOutputPreview
              toolName={toolName}
              output={output}
            />
          )}
        </div>

        {isPending && (
          <div className="flex shrink-0 gap-2">
            <button
              onClick={onApprove}
              className="rounded-md bg-emerald-900/60 px-3 py-1.5 text-xs font-medium text-emerald-300 transition-colors hover:bg-emerald-900/80"
            >
              Approve
            </button>
            <button
              onClick={onDeny}
              className="rounded-md bg-red-900/60 px-3 py-1.5 text-xs font-medium text-red-300 transition-colors hover:bg-red-900/80"
            >
              Deny
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function ToolOutputPreview({ toolName, output }: { toolName: string; output: unknown }) {
  if (toolName === 'getArticle' && typeof output === 'object' && output !== null) {
    // CAST: getArticle tool returns { title, extract } — validated by typeof guard
    const article = output as { title: string; extract: string };
    return (
      <div className="mt-2 rounded border border-emerald-900/30 bg-zinc-900/50 px-2 py-1.5">
        <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-zinc-500">{article.title}</p>
        <p className="text-xs text-zinc-400 line-clamp-3">{article.extract}</p>
      </div>
    );
  }

  return (
    <pre className="mt-2 max-h-16 overflow-auto rounded border border-emerald-900/30 bg-zinc-900/50 px-2 py-1.5 text-[10px] text-zinc-500">
      {JSON.stringify(output, null, 2)}
    </pre>
  );
}
