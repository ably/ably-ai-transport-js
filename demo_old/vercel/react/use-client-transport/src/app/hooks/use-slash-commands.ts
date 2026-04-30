'use client';

/**
 * useSlashCommands — static command registry with autocomplete.
 *
 * Commands:
 *   /cancel          — cancel own turns (default)
 *   /cancel own      — cancel own turns
 *   /cancel all      — cancel all turns
 *   /cancel <id>     — cancel specific turn
 *   /interrupt <p>   — cancel own, then send prompt
 *   /btw <p>         — send immediately (bypass queue)
 */

import { useMemo, useCallback } from 'react';
import type { ClientTransport, ActiveTurn, SendOptions } from '@ably/ai-transport';
import type { UIMessageChunk, UIMessage } from 'ai';
import { userMessage } from '../helpers';

export interface SlashCommand {
  name: string;
  description: string;
  hasArg: boolean;
}

const COMMANDS: SlashCommand[] = [
  { name: '/cancel', description: 'Cancel your active turns', hasArg: false },
  { name: '/cancel own', description: 'Cancel your active turns', hasArg: false },
  { name: '/cancel all', description: 'Cancel all active turns', hasArg: false },
  { name: '/interrupt', description: 'Cancel own turns, then send a new message', hasArg: true },
  { name: '/btw', description: 'Send immediately (bypass queue)', hasArg: true },
];

export interface SlashCommandHandle {
  /** Filtered suggestions based on current input. */
  suggestions: SlashCommand[];
  /** Whether slash mode is active (input starts with /). */
  isActive: boolean;
  /** Whether the current input is a complete, executable command. */
  canExecute: boolean;
  /** Execute the command. Returns true if input was a recognized command. */
  execute: (input: string) => boolean;
}

type SendFn = (messages: UIMessage[], options?: SendOptions) => Promise<ActiveTurn<UIMessageChunk>>;

export function useSlashCommands(
  transport: ClientTransport<UIMessageChunk, UIMessage>,
  activeTurns: Map<string, Set<string>>,
  send: SendFn,
  input: string,
): SlashCommandHandle {
  const isActive = input.startsWith('/');

  const suggestions = useMemo(() => {
    if (!isActive) return [];
    const lower = input.toLowerCase();

    // Special case: "/cancel " with trailing space — show active turn IDs
    if (lower === '/cancel ' || lower.startsWith('/cancel ')) {
      const suffix = input.slice('/cancel '.length).trim().toLowerCase();
      if (suffix !== 'own' && suffix !== 'all') {
        const turnSuggestions: SlashCommand[] = [];
        for (const [cid, turnIds] of activeTurns) {
          for (const tid of turnIds) {
            if (!suffix || tid.toLowerCase().includes(suffix)) {
              turnSuggestions.push({
                name: `/cancel ${tid}`,
                description: `Cancel turn from ${cid}`,
                hasArg: false,
              });
            }
          }
        }
        const base = COMMANDS.filter(
          (c) =>
            (c.name === '/cancel own' || c.name === '/cancel all') && c.name.toLowerCase().startsWith(lower.trimEnd()),
        );
        return [...base, ...turnSuggestions];
      }
    }

    const filtered = COMMANDS.filter((cmd) => cmd.name.toLowerCase().startsWith(lower));

    // When just "/" is typed and there are active turns, append per-turn cancel options
    if (lower === '/' && activeTurns.size > 0) {
      const turnSuggestions: SlashCommand[] = [];
      for (const [cid, turnIds] of activeTurns) {
        for (const tid of turnIds) {
          turnSuggestions.push({
            name: `/cancel ${tid}`,
            description: `Cancel turn from ${cid}`,
            hasArg: false,
          });
        }
      }
      return [...filtered, ...turnSuggestions];
    }

    return filtered;
  }, [isActive, input, activeTurns]);

  const canExecute = useMemo(() => {
    if (!isActive) return false;
    const lower = input.trim().toLowerCase();

    if (lower === '/cancel' || lower === '/cancel own' || lower === '/cancel all') return true;
    if (lower.startsWith('/cancel ')) {
      const arg = input.trim().slice('/cancel '.length).trim();
      return arg.length > 0 && arg !== 'own' && arg !== 'all';
    }
    if (lower.startsWith('/interrupt ')) return input.trim().slice('/interrupt '.length).trim().length > 0;
    if (lower.startsWith('/btw ')) return input.trim().slice('/btw '.length).trim().length > 0;
    return false;
  }, [isActive, input]);

  const execute = useCallback(
    (raw: string): boolean => {
      const trimmed = raw.trim();
      if (!trimmed.startsWith('/')) return false;

      const lower = trimmed.toLowerCase();

      // /cancel (no args) or /cancel own — cancel own turns
      if (lower === '/cancel' || lower === '/cancel own') {
        transport.cancel({ own: true });
        return true;
      }

      if (lower === '/cancel all') {
        transport.cancel({ all: true });
        return true;
      }

      if (lower.startsWith('/cancel ')) {
        const turnId = trimmed.slice('/cancel '.length).trim();
        if (turnId && turnId !== 'own' && turnId !== 'all') {
          transport.cancel({ turnId });
          return true;
        }
        return false;
      }

      if (lower.startsWith('/interrupt ')) {
        const prompt = trimmed.slice('/interrupt '.length).trim();
        if (prompt) {
          transport.cancel({ own: true }).then(() => {
            send([userMessage(prompt)]);
          });
          return true;
        }
        return false;
      }

      if (lower.startsWith('/btw ')) {
        const prompt = trimmed.slice('/btw '.length).trim();
        if (prompt) {
          send([userMessage(prompt)]);
          return true;
        }
        return false;
      }

      return false;
    },
    [transport, send],
  );

  return { suggestions, isActive, canExecute, execute };
}
