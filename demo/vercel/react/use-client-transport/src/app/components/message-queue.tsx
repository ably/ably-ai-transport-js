'use client';

import type { QueueHandle } from '../hooks/use-message-queue';

interface MessageQueueProps {
  queue: QueueHandle;
}

export function MessageQueue({ queue }: MessageQueueProps) {
  if (queue.items.length === 0) return null;

  return (
    <div className="border-t border-zinc-800 px-4 py-2 flex items-center gap-2 overflow-x-auto">
      <span className="text-[10px] uppercase tracking-wider text-zinc-600 shrink-0">Queue</span>
      {queue.items.map((item) => (
        <div
          key={item.id}
          className="flex items-center gap-1 rounded bg-zinc-900 border border-zinc-800 px-2 py-1 text-xs text-zinc-400 shrink-0 max-w-[200px]"
        >
          <span className="truncate">{item.text}</span>
          <button
            onClick={() => queue.remove(item.id)}
            className="text-zinc-600 hover:text-zinc-300 transition-colors ml-1"
          >
            x
          </button>
        </div>
      ))}
      {queue.items.length > 1 && (
        <button
          onClick={queue.clear}
          className="text-[10px] text-zinc-600 hover:text-zinc-300 transition-colors shrink-0"
        >
          clear all
        </button>
      )}
    </div>
  );
}
