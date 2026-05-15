'use client';

import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'day-out-planner:name';

export interface UseNameHandle {
  /** The current name, or empty string if unset. Only meaningful when `ready` is true. */
  name: string;
  /**
   * Whether the localStorage read has happened. False on the server and on the
   * first client render; true after the mount effect runs. Callers should gate
   * UI on this so the name modal doesn't briefly render during SSR/hydration
   * (which can hydration-mismatch against browser autofill).
   */
  ready: boolean;
  /** Persist a new name. Trimmed; empty input is rejected. */
  setName: (next: string) => void;
  /** Forget the stored name so the modal shows again on next render. */
  clearName: () => void;
}

export function useName(): UseNameHandle {
  const [name, setNameState] = useState('');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) setNameState(stored);
    setReady(true);
  }, []);

  const setName = useCallback((next: string) => {
    const trimmed = next.trim();
    if (!trimmed) return;
    localStorage.setItem(STORAGE_KEY, trimmed);
    setNameState(trimmed);
  }, []);

  const clearName = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    setNameState('');
  }, []);

  return { name, ready, setName, clearName };
}
