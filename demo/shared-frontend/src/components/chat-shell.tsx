'use client';

import { type ReactNode, type RefObject } from 'react';
import { ArrowUpIcon, ExternalLinkIcon, SquareIcon } from 'lucide-react';
import { Button } from './ui/button';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from './ui/input-group';
import { TooltipProvider } from './ui/tooltip';
import { AvatarStack } from './avatar-stack';
import { SuggestionChips } from './suggestion-chips';
import { ThemeToggle } from './theme-toggle';
import { clientColor } from '../lib/client-color';
import type { Scenario } from '../lib/progress-steps';

/** A labelled external link shown in the header (e.g. SDK repo, docs). */
export interface HeaderLink {
  /** Visible link text. */
  label: string;
  /** Destination URL (opened in a new tab). */
  href: string;
}

const DEFAULT_LINKS: readonly HeaderLink[] = [
  { label: 'SDK repo', href: 'https://github.com/ably/ably-ai-transport-js' },
  { label: 'Ably docs', href: 'https://ably.com/docs/ai-transport' },
];

interface ChatShellProps {
  /** Header heading — each demo names itself (e.g. "Ably AI — ClientSession"). */
  title: string;
  /** Header links. Defaults to the SDK repo + Ably docs. */
  links?: readonly HeaderLink[];
  /** Channel name, shown to the presence avatars. */
  channelName: string;
  /** This client's id, tinted in the header. */
  clientId?: string;
  /** The transcript (a message-list variant), supplied by the demo's container. */
  transcript: ReactNode;
  /** Optional slot between the transcript and the composer (e.g. a widget). */
  extraSlot?: ReactNode;
  /** The debug pane, supplied by the demo's container (its logs are family-specific). */
  debugPane: ReactNode;
  /** Unfinished scenarios to offer as suggestion chips. */
  suggestions: Scenario[];
  /** Called with a chip's prompt when clicked (prefills the composer). */
  onSelectPrompt: (prompt: string) => void;
  /** Composer value (controlled). */
  input: string;
  /** Composer change handler. */
  onInputChange: (value: string) => void;
  /** Optional ref to the composer textarea (chips focus it). */
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  /** Composer placeholder. Defaults to "Type a message...". */
  inputPlaceholder?: string;
  /** Send the composed text. */
  onSend: (text: string) => void;
  /** Stop the in-flight run. */
  onStop: () => void;
  /** Whether a run is streaming (shows Stop instead of Send). */
  isRunning: boolean;
}

/**
 * The presentational chat frame shared by every demo: a configurable header, the
 * transcript slot, an optional widget slot, the suggestion chips, the composer,
 * and the debug pane. Each demo's container supplies the transcript + debug pane
 * (whose data is family-specific) and wires the composer/suggestion callbacks.
 */
export function ChatShell({
  title,
  links = DEFAULT_LINKS,
  channelName,
  clientId,
  transcript,
  extraSlot,
  debugPane,
  suggestions,
  onSelectPrompt,
  input,
  onInputChange,
  inputRef,
  inputPlaceholder,
  onSend,
  onStop,
  isRunning,
}: ChatShellProps) {
  return (
    // TooltipProvider is hosted here so every demo's tooltips (e.g. the branch
    // navigator) work without each app wiring one into its layout.
    <TooltipProvider>
      <div className="flex h-dvh overflow-hidden">
        <div className="flex min-w-0 flex-1 flex-col">
          <Header
            title={title}
            links={links}
            channelName={channelName}
            clientId={clientId}
          />
          {transcript}
          {extraSlot}
          <div className="border-t border-border">
            <SuggestionChips
              scenarios={suggestions}
              onSelectPrompt={onSelectPrompt}
            />
            <InputBar
              value={input}
              onChange={onInputChange}
              inputRef={inputRef}
              placeholder={inputPlaceholder}
              onSend={onSend}
              onStop={onStop}
              isRunning={isRunning}
            />
          </div>
        </div>
        {debugPane}
      </div>
    </TooltipProvider>
  );
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function Header({
  title,
  links,
  channelName,
  clientId,
}: {
  title: string;
  links: readonly HeaderLink[];
  channelName: string;
  clientId?: string;
}) {
  return (
    <header className="flex h-16 flex-shrink-0 items-center gap-3 border-b border-border px-4">
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          {/* Liveness indicator — no semantic "online" token exists, so a fixed
              status colour is intentional here. */}
          <div className="size-2 rounded-full bg-emerald-500" />
          <h1 className="text-sm font-medium text-foreground">{title}</h1>
        </div>
        <div className="flex items-center gap-2 pl-4">
          <ThemeToggle />
          {links.map((link) => (
            <Button
              key={link.href}
              asChild
              variant="outline"
              size="xs"
              className="rounded-full"
            >
              <a
                href={link.href}
                target="_blank"
                rel="noreferrer"
              >
                {link.label}
                <ExternalLinkIcon data-icon="inline-end" />
              </a>
            </Button>
          ))}
        </div>
      </div>
      <div className="ml-auto flex items-center gap-3">
        <AvatarStack
          channelName={channelName}
          selfClientId={clientId}
        />
        <Button
          type="button"
          variant="outline"
          size="xs"
          onClick={() => {
            const url = new URL(window.location.href);
            url.searchParams.delete('clientId');
            window.open(url.toString(), '_blank');
          }}
          title="Open this channel in a new tab as a fresh client"
        >
          open in new tab
        </Button>
        {clientId && <span className={`font-mono text-xs ${clientColor(clientId).text}`}>{clientId}</span>}
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Input bar — a single Stop button while streaming, Send otherwise
// ---------------------------------------------------------------------------

function InputBar({
  value,
  onChange,
  inputRef,
  placeholder,
  onSend,
  onStop,
  isRunning,
}: {
  value: string;
  onChange: (value: string) => void;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  placeholder?: string;
  onSend: (text: string) => void;
  onStop: () => void;
  isRunning: boolean;
}) {
  const submit = () => {
    const text = value.trim();
    if (!text) return;
    onChange('');
    onSend(text);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    submit();
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="px-4 py-3"
    >
      <InputGroup>
        <InputGroupTextarea
          ref={inputRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder ?? 'Type a message...'}
          autoFocus
          rows={1}
          className="min-h-0"
          // Enter sends; Shift+Enter inserts a newline (standard composer UX).
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <InputGroupAddon align="inline-end">
          {isRunning ? (
            <InputGroupButton
              type="button"
              variant="destructive"
              size="icon-sm"
              className="rounded-full"
              aria-label="Stop"
              onClick={onStop}
            >
              <SquareIcon className="fill-current" />
            </InputGroupButton>
          ) : (
            <InputGroupButton
              type="submit"
              variant="default"
              size="icon-sm"
              className="rounded-full"
              aria-label="Send"
              disabled={!value.trim()}
            >
              <ArrowUpIcon />
            </InputGroupButton>
          )}
        </InputGroupAddon>
      </InputGroup>
    </form>
  );
}
