'use client';

import { useEffect, useState } from 'react';
import { MonitorIcon, MoonIcon, SunIcon } from 'lucide-react';
import { useTheme } from 'next-themes';
import { cn } from '../lib/utils';

/** The three selectable modes, in the order the segmented control renders them. */
const OPTIONS = [
  { value: 'system', label: 'System theme', Icon: MonitorIcon },
  { value: 'dark', label: 'Dark theme', Icon: MoonIcon },
  { value: 'light', label: 'Light theme', Icon: SunIcon },
] as const;

/**
 * A three-way theme selector — System / Dark / Light — styled as a segmented
 * control after the toggle on the Ably docs site. It drives `next-themes`, so it
 * must render under a {@link ThemeProvider}. `system` follows the OS preference
 * and is the default.
 */
export function ThemeToggle() {
  const { theme, setTheme } = useTheme();

  // next-themes only knows the active choice on the client, so the first render
  // (server + hydration) must match: mark nothing active until mounted, else the
  // highlighted segment would differ between server and client.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className="inline-flex items-center gap-0.5 rounded-lg border border-border bg-background p-0.5"
    >
      {OPTIONS.map(({ value, label, Icon }) => {
        const active = mounted && theme === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={label}
            title={label}
            onClick={() => setTheme(value)}
            className={cn(
              'inline-flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors',
              'hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
              active && 'bg-muted text-foreground',
            )}
          >
            <Icon className="size-3.5" />
          </button>
        );
      })}
    </div>
  );
}
