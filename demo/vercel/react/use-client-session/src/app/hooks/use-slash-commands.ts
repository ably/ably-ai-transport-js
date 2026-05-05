'use client';

/**
 * useSlashCommands — static command registry with autocomplete.
 *
 * Commands:
 *   /cancel          — cancel own runs (default)
 *   /cancel own      — cancel own runs
 *   /cancel all      — cancel all runs
 *   /cancel <id>     — cancel specific run
 *   /interrupt <p>   — cancel own, then send prompt
 *   /btw <p>         — send immediately (bypass queue)
 */

import { useMemo, useCallback } from 'react';
import type { ClientSession, ActiveRun, SendOptions } from '@ably/ai-transport';
import type { UIMessageChunk, UIMessage } from 'ai';
import { userMessage } from '../helpers';

export interface SlashCommand {
  name: string;
  description: string;
  hasArg: boolean;
}

const COMMANDS: SlashCommand[] = [
  { name: '/cancel', description: 'Cancel your active runs', hasArg: false },
  { name: '/cancel own', description: 'Cancel your active runs', hasArg: false },
  { name: '/cancel all', description: 'Cancel all active runs', hasArg: false },
  { name: '/interrupt', description: 'Cancel own runs, then send a new message', hasArg: true },
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

type SendFn = (messages: UIMessage[], options?: SendOptions) => Promise<ActiveRun<UIMessageChunk>>;

export function useSlashCommands(
  session: ClientSession<UIMessageChunk, UIMessage>,
  activeRuns: Map<string, Set<string>>,
  send: SendFn,
  input: string,
): SlashCommandHandle {
  const isActive = input.startsWith('/');

  const suggestions = useMemo(() => {
    if (!isActive) return [];
    const lower = input.toLowerCase();

    // Special case: "/cancel " with trailing space — show active run IDs
    if (lower === '/cancel ' || lower.startsWith('/cancel ')) {
      const suffix = input.slice('/cancel '.length).trim().toLowerCase();
      if (suffix !== 'own' && suffix !== 'all') {
        const runSuggestions: SlashCommand[] = [];
        for (const [cid, runIds] of activeRuns) {
          for (const tid of runIds) {
            if (!suffix || tid.toLowerCase().includes(suffix)) {
              runSuggestions.push({
                name: `/cancel ${tid}`,
                description: `Cancel run from ${cid}`,
                hasArg: false,
              });
            }
          }
        }
        const base = COMMANDS.filter(
          (c) =>
            (c.name === '/cancel own' || c.name === '/cancel all') && c.name.toLowerCase().startsWith(lower.trimEnd()),
        );
        return [...base, ...runSuggestions];
      }
    }

    const filtered = COMMANDS.filter((cmd) => cmd.name.toLowerCase().startsWith(lower));

    // When just "/" is typed and there are active runs, append per-run cancel options
    if (lower === '/' && activeRuns.size > 0) {
      const runSuggestions: SlashCommand[] = [];
      for (const [cid, runIds] of activeRuns) {
        for (const tid of runIds) {
          runSuggestions.push({
            name: `/cancel ${tid}`,
            description: `Cancel run from ${cid}`,
            hasArg: false,
          });
        }
      }
      return [...filtered, ...runSuggestions];
    }

    return filtered;
  }, [isActive, input, activeRuns]);

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

      // /cancel (no args) or /cancel own — cancel own runs
      if (lower === '/cancel' || lower === '/cancel own') {
        session.cancel({ own: true });
        return true;
      }

      if (lower === '/cancel all') {
        session.cancel({ all: true });
        return true;
      }

      if (lower.startsWith('/cancel ')) {
        const runId = trimmed.slice('/cancel '.length).trim();
        if (runId && runId !== 'own' && runId !== 'all') {
          session.cancel({ runId });
          return true;
        }
        return false;
      }

      if (lower.startsWith('/interrupt ')) {
        const prompt = trimmed.slice('/interrupt '.length).trim();
        if (prompt) {
          session.cancel({ own: true }).then(() => {
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
    [session, send],
  );

  return { suggestions, isActive, canExecute, execute };
}
