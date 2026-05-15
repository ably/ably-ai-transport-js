'use client';

import { useCallback, useState } from 'react';

export interface UseNameHandle {
  /** The current name, or empty string if unset. */
  name: string;
  /** Set the name. Trimmed; empty input is rejected. */
  setName: (next: string) => void;
  /** Forget the current name so the modal shows again. Scoped to this tab. */
  clearName: () => void;
}

/**
 * In-memory name state for this browser tab. Deliberately not persisted —
 * makes it easy to demonstrate with multiple tabs without each one inheriting
 * the previous identity. Use the `?user=` query param to skip the modal.
 *
 * @param initialName - Optional name to seed state with (e.g. from `?user=`).
 */
export function useName(initialName?: string): UseNameHandle {
  const [name, setNameState] = useState(initialName?.trim() ?? '');

  const setName = useCallback((next: string) => {
    const trimmed = next.trim();
    if (!trimmed) return;
    setNameState(trimmed);
  }, []);

  const clearName = useCallback(() => {
    setNameState('');
  }, []);

  return { name, setName, clearName };
}
