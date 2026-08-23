'use client';

import type { ReactNode } from 'react';
import { ThemeProvider as NextThemesProvider } from 'next-themes';

/**
 * Wraps the app in `next-themes` so the shared {@link ThemeToggle} can switch
 * between System / Dark / Light. It toggles the `dark` class on `<html>`, so
 * mount it in the root layout (highest in the tree, to set the class before
 * first paint) and give `<html>` `suppressHydrationWarning`. `system` follows
 * the OS preference and is the default.
 *
 * Codec-agnostic, so a demo on any codec can mount it without pulling in any
 * Vercel-typed hooks.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
    >
      {children}
    </NextThemesProvider>
  );
}
