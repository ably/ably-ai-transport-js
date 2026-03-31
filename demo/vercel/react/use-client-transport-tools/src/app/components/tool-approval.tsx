'use client';

interface ToolApprovalCardProps {
  toolName: string;
  toolCallId: string;
  input: unknown;
  state: string;
  onApprove: () => void;
  onDeny: () => void;
}

export function ToolApprovalCard({
  toolName,
  toolCallId,
  input,
  state,
  onApprove,
  onDeny,
}: ToolApprovalCardProps) {
  // CAST: tool input is always a JSON object from the LLM's tool call
  const inputObj = input as Record<string, unknown> | undefined;
  const inputSummary = inputObj
    ? Object.values(inputObj).join(', ')
    : JSON.stringify(input);

  const isPending = state === 'approval-requested';
  const isApproved = state === 'output-available' || state === 'approval-responded';
  const isDenied = state === 'output-denied';

  return (
    <div className="my-2 rounded-lg border border-amber-800/50 bg-amber-950/30 p-3">
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
              <span className="rounded bg-red-950 px-1.5 py-0.5 text-[10px] font-medium text-red-400">
                Denied
              </span>
            )}
          </div>
          <p className="mt-1 text-sm text-zinc-300">
            <span className="font-mono text-amber-300">{toolName}</span>
            {inputSummary && (
              <span className="text-zinc-500"> &mdash; {inputSummary}</span>
            )}
          </p>
          <p className="mt-0.5 text-[10px] font-mono text-zinc-600">
            {toolCallId.slice(0, 12)}...
          </p>
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
