/**
 * The agent's checklist tool — the only writer of the shared task-list state,
 * closing over the channel's LiveObjects root.
 *
 * `plan` (re)defines the steps as a numbered list, all pending; `start` and
 * `complete` flip named steps to active / done. A status flip writes only the
 * referenced step keys, so a single channel message carries just the field
 * that changed — the granular update that keeps every client's checklist in
 * sync without resending the whole list. Everything in one call applies in one
 * `root.batch(...)`, so clients never render a partial update.
 *
 * A status flip rewrites the whole step value (the map stores each step as one
 * value), so it reads the step's current text from the snapshot; a `plan` in
 * the same call is applied first, letting its steps be flipped immediately.
 *
 * The clock is injected so the write timestamp is deterministic in tests.
 */

import type { Tool } from 'ai';
import { z } from 'zod';
import { checklistFrom, type ChecklistItem, type ChecklistRootPath } from '../../lib/checklist';

type UpdateArgs = { plan?: string[]; start?: number[]; complete?: number[] };

export function makeChecklistTool(root: ChecklistRootPath, now: () => number): Record<string, Tool> {
  return {
    updateChecklist: {
      description:
        'Maintain the shared task checklist shown beside the chat while you work through a multi-step request. First call with `plan` to lay out the steps as a numbered list. Then, as you work, call with `start` to mark a step in progress and `complete` to mark it done — flip one step at a time so the user sees live progress. ChecklistItem numbers are 1-based and match the order in `plan`. Skip the checklist for simple one-step answers.',
      inputSchema: z.object({
        plan: z
          .array(z.string().min(1).max(120))
          .optional()
          .describe('The full ordered list of step descriptions; replaces any existing checklist, all pending'),
        start: z.array(z.number().int().positive()).optional().describe('ChecklistItem numbers to mark as in progress'),
        complete: z.array(z.number().int().positive()).optional().describe('ChecklistItem numbers to mark as done'),
      }),
      execute: async ({ plan, start, complete }: UpdateArgs) => {
        const at = now();
        // Snapshot each step's text by position so a status flip can rewrite the
        // whole step value while preserving its text.
        const text = new Map<number, string>();
        const existing: number[] = [];
        for (const row of checklistFrom(root.compactJson())) {
          text.set(row.index, row.text);
          existing.push(row.index);
        }

        const started: number[] = [];
        const completed: number[] = [];
        await root.batch((map) => {
          if (plan) {
            // Drop any steps beyond the new plan, then (re)write 1..N as pending.
            for (const index of existing) {
              if (index > plan.length) map.remove(String(index));
            }
            plan.forEach((stepText, i) => {
              const step: ChecklistItem = { text: stepText, status: 'pending', updatedAt: at };
              map.set(String(i + 1), step);
              text.set(i + 1, stepText);
            });
          }
          const flip = (numbers: number[] | undefined, status: ChecklistItem['status'], applied: number[]) => {
            for (const n of numbers ?? []) {
              const stepText = text.get(n);
              if (stepText === undefined) continue;
              const step: ChecklistItem = { text: stepText, status, updatedAt: at };
              map.set(String(n), step);
              applied.push(n);
            }
          };
          flip(start, 'active', started);
          flip(complete, 'done', completed);
        });

        return { planned: plan?.length ?? 0, started, completed };
      },
    },
  };
}
