'use client';

import { AGENT_STYLES } from './agent-colors';

interface HeaderProps {
  clientId: string | undefined;
  activeTurns: Map<string, Set<string>>;
  humanAgentPresent?: boolean;
}

export function Header({ clientId, activeTurns, humanAgentPresent }: HeaderProps) {
  // Collect active agents (excluding the user's own turns and unlabeled turns)
  const activeAgentIds: string[] = [];
  for (const [cid, turns] of activeTurns) {
    if (cid === clientId || turns.size === 0) continue;
    if (!(cid in AGENT_STYLES)) continue;
    activeAgentIds.push(cid);
  }

  return (
    <header className="flex items-center gap-3 border-b border-zinc-800 px-4 py-3">
      <div className="h-2 w-2 rounded-full bg-emerald-500" />
      <h1 className="text-sm font-medium text-zinc-300">Acme Electronics Support</h1>
      {activeAgentIds.length > 0 && (
        <div className="flex items-center gap-1.5 ml-2">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
          {activeAgentIds.map((agentId) => {
            const style = AGENT_STYLES[agentId];
            const label = style?.label ?? agentId;
            const pillClass = style?.pill ?? 'bg-zinc-900 text-zinc-400 border-zinc-700';
            return (
              <span
                key={agentId}
                className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${pillClass}`}
              >
                {label}
              </span>
            );
          })}
          <span className="text-[11px] text-zinc-500">working...</span>
        </div>
      )}
      {humanAgentPresent && (
        <div className="flex items-center gap-1.5 ml-2">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500" />
          <span className="text-[11px] text-emerald-400 font-medium">Human agent connected</span>
        </div>
      )}
      {clientId && <span className="ml-auto text-xs text-zinc-600 font-mono">{clientId}</span>}
    </header>
  );
}
