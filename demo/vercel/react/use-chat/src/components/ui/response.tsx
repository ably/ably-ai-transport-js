'use client';

import { type ComponentProps, memo } from 'react';
import { Streamdown } from 'streamdown';

import { cn } from '@/lib/utils';

type ResponseProps = ComponentProps<typeof Streamdown>;

/**
 * Streaming-markdown renderer for assistant output, built on Streamdown
 * (GitHub-flavoured markdown + safe HTML hardening). Memoised on `children`
 * so re-renders during a token stream only repaint when the text changes.
 */
export const Response = memo(
  ({ className, ...props }: ResponseProps) => (
    // w-full (not size-full): the markdown fills the bubble width but takes its
    // natural height — h-full would balloon a short reply to fill the row.
    <Streamdown
      className={cn('w-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0', className)}
      {...props}
    />
  ),
  (prevProps, nextProps) => prevProps.children === nextProps.children,
);

Response.displayName = 'Response';
