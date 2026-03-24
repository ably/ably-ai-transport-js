'use client';

import { useState, useCallback } from 'react';
import type { ClientTransport, ActiveTurn, SendOptions } from '@ably/ably-ai-transport-js';
import type { UIMessageChunk, UIMessage } from 'ai';
import { useSlashCommands, type SlashCommand } from '../hooks/use-slash-commands';
import { SlashAutocomplete } from './slash-autocomplete';
import type { QueueHandle } from '../hooks/use-message-queue';
import { userMessage } from '../helpers';

type SendFn = (messages: UIMessage[], options?: SendOptions) => Promise<ActiveTurn<UIMessageChunk>>;

interface InputBarProps {
  transport: ClientTransport<UIMessageChunk, UIMessage>;
  send: SendFn;
  activeTurns: Map<string, Set<string>>;
  clientId: string | undefined;
  queue: QueueHandle;
}

export function InputBar({ transport, send, activeTurns, clientId, queue }: InputBarProps) {
  const [input, setInput] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);

  const hasOwnTurns = clientId ? activeTurns.has(clientId) : false;

  const slash = useSlashCommands(transport, activeTurns, send, input);

  const handleSubmit = useCallback(() => {
    const text = input.trim();
    if (!text) return;

    // Slash commands always execute immediately — never queued
    if (text.startsWith('/')) {
      if (slash.execute(text)) {
        setInput('');
        return;
      }
      // Unrecognized slash command — ignore (don't send as message)
      return;
    }

    setInput('');

    // If own turns are active, queue the message
    if (hasOwnTurns) {
      queue.add(text);
    } else {
      send([userMessage(text)]);
    }
  }, [input, slash, hasOwnTurns, send, queue]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (slash.isActive && slash.suggestions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((prev) => Math.min(prev + 1, slash.suggestions.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((prev) => Math.max(prev - 1, 0));
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && slash.suggestions.length > 0 && selectedIndex >= 0)) {
        // Only autocomplete if the input is a partial match (not an exact command ready to execute)
        const selected = slash.suggestions[selectedIndex];
        if (selected && input.trim() !== selected.name) {
          e.preventDefault();
          const newInput = selected.hasArg ? selected.name + ' ' : selected.name;
          setInput(newInput);
          setSelectedIndex(0);
          return;
        }
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!submitDisabled) handleSubmit();
    }
  };

  const handleSelectSuggestion = (cmd: SlashCommand) => {
    const newInput = cmd.hasArg ? cmd.name + ' ' : cmd.name;
    setInput(newInput);
    setSelectedIndex(0);
  };

  // Determine button label and disabled state
  const isSlash = input.trimStart().startsWith('/');
  const buttonLabel = isSlash ? 'Run' : hasOwnTurns ? 'Queue' : 'Send';
  const submitDisabled = !input.trim() || (isSlash && !slash.canExecute);

  return (
    <div className="border-t border-zinc-800 px-4 py-3">
      <div className="relative flex gap-2">
        {slash.isActive && (
          <SlashAutocomplete
            suggestions={slash.suggestions}
            selectedIndex={selectedIndex}
            onSelect={handleSelectSuggestion}
          />
        )}
        <input
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            setSelectedIndex(0);
          }}
          onKeyDown={handleKeyDown}
          placeholder={hasOwnTurns ? 'Type to queue, or /cancel...' : 'Type a message, or / for commands...'}
          className="flex-1 rounded-md bg-zinc-900 border border-zinc-700 px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 outline-none focus:border-zinc-500"
          autoFocus
        />
        {hasOwnTurns && !input.startsWith('/') && (
          <button
            type="button"
            onClick={() => transport.cancel({ own: true })}
            className="rounded-md bg-red-900/60 px-4 py-2 text-sm font-medium text-red-300 hover:bg-red-900/80 transition-colors"
          >
            Stop
          </button>
        )}
        <button
          type="button"
          onClick={handleSubmit}
          disabled={submitDisabled}
          className="rounded-md bg-zinc-700 px-4 py-2 text-sm font-medium text-zinc-200 hover:bg-zinc-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {buttonLabel}
        </button>
      </div>
    </div>
  );
}
