import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';

// Drive next-themes from the test: `useTheme` returns the current choice and a
// spy `setTheme`, so we can assert which segment is active and that clicking a
// segment requests that theme.
const setTheme = vi.fn();
let currentTheme = 'system';

vi.mock('next-themes', () => ({
  useTheme: () => ({ theme: currentTheme, setTheme }),
}));

// Imported after vi.mock so it picks up the mocked hook.
import { ThemeToggle } from '../index';

afterEach(() => {
  cleanup();
  currentTheme = 'system';
  setTheme.mockClear();
});

describe('ThemeToggle', () => {
  it('renders a System, Dark and Light segment', () => {
    render(<ThemeToggle />);
    expect(screen.getAllByRole('radio')).toHaveLength(3);
    expect(screen.getByRole('radio', { name: 'System theme' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Dark theme' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Light theme' })).toBeTruthy();
  });

  it('marks the current theme as the checked segment', () => {
    currentTheme = 'dark';
    render(<ThemeToggle />);
    expect(screen.getByRole('radio', { name: 'Dark theme' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: 'System theme' }).getAttribute('aria-checked')).toBe('false');
    expect(screen.getByRole('radio', { name: 'Light theme' }).getAttribute('aria-checked')).toBe('false');
  });

  it('requests the chosen theme on click', () => {
    render(<ThemeToggle />);
    fireEvent.click(screen.getByRole('radio', { name: 'Light theme' }));
    expect(setTheme).toHaveBeenCalledWith('light');
  });
});
