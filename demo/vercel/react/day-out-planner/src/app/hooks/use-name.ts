'use client';

import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'day-out-planner:name';

export interface UseNameHandle {
  /** The current name, or empty string if unset (or pre-hydration). */
  name: string;
  /** Persist a new name. Trimmed; empty input is rejected. */
  setName: (next: string) => void;
  /** Forget the stored name so the modal shows again on next render. */
  clearName: () => void;
}

export function useName(): UseNameHandle {
  const [name, setNameState] = useState('');

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) setNameState(stored);
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

  return { name, setName, clearName };
}
