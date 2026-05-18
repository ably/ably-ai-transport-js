'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useState, useCallback } from 'react';
import type { ToolApprovalDecision } from '@ably/ai-transport/vercel';

import { userMessage } from '../helpers';
import { useClientTools } from '../hooks/use-client-tools';
import { useMessageQueue } from '../hooks/use-message-queue';
import { Header } from './header';
import { ImagePresets } from './image-presets';
import { MessageList } from './message-list';
import { MessageQueue } from './message-queue';
import { InputBar } from './input-bar';
import { DebugPane } from './debug-pane';
import { ChatPane } from './chat-pane';
import { SpeechPresets } from './speech-presets';
import { SessionHooks } from '../providers';

const { useClientSession, useCreateView, useActiveRuns, useView, useAblyMessages } = SessionHooks;

type TabId = 'chat' | 'images' | 'speech';
const TAB_IDS: TabId[] = ['chat', 'images', 'speech'];

interface ChatProps {
  chatId: string;
  clientId?: string;
  historyLimit?: number;
}

export function Chat({ clientId, historyLimit }: ChatProps) {
  // Session is created by ClientSessionProvider in page.tsx
  const { session } = useClientSession();
  const [split, setSplit] = useState(false);

  // Active tab is held in the URL so it's shareable and survives reloads.
  // Each tab attaches to its own Ably channel (see page.tsx for the
  // base + suffix derivation), so the chat, image, and speech histories
  // are independent.
  const router = useRouter();
  const searchParams = useSearchParams();
  const rawTab = searchParams.get('tab');
  const tab: TabId = rawTab === 'images' ? 'images' : rawTab === 'speech' ? 'speech' : 'chat';
  const setTab = useCallback(
    (next: TabId) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set('tab', next);
      router.replace(`?${params.toString()}`);
    },
    [router, searchParams],
  );

  const limit = historyLimit ?? 30;
  const view = useView({ limit });
  const splitView = useCreateView({ limit, skip: !split });

  useClientTools(view, clientId);

  const activeRuns = useActiveRuns();
  const ablyMessages = useAblyMessages();
  const queue = useMessageQueue(session, view.send);

  const handleToolApproved = useCallback(
    (msgId: string, toolCallId: string, input: unknown) => {
      const inputObj = input as Record<string, string> | undefined;
      const label = inputObj?.location ?? toolCallId;
      const decision: ToolApprovalDecision = { toolCallId, approved: true, targetMsgId: msgId };
      view.send([userMessage(`Approved: ${label}`)], {
        body: { toolApprovals: [decision] },
      });
    },
    [view],
  );

  const handleToolDeny = useCallback(
    (msgId: string, toolCallId: string, input: unknown) => {
      const inputObj = input as Record<string, string> | undefined;
      const label = inputObj?.location ?? toolCallId;
      const decision: ToolApprovalDecision = { toolCallId, approved: false, targetMsgId: msgId };
      view.send([userMessage(`Denied: ${label}`)], {
        body: { toolApprovals: [decision] },
      });
    },
    [view],
  );

  return (
    <div className="flex h-dvh">
      <div className="flex flex-1 flex-col">
        <Header
          clientId={clientId}
          split={split}
          onToggleSplit={() => setSplit((s) => !s)}
        />
        {!split && (
          <Tabs
            active={tab}
            onChange={setTab}
          />
        )}
        {split ? (
          <div className="flex flex-1 min-h-0">
            <ChatPane
              label="View A"
              session={session}
              view={view}
              ablyMessages={ablyMessages}
              activeRuns={activeRuns}
              clientId={clientId}
            />
            <div className="w-px bg-zinc-800" />
            <ChatPane
              label="View B"
              session={session}
              view={splitView}
              ablyMessages={ablyMessages}
              activeRuns={activeRuns}
              clientId={clientId}
            />
          </div>
        ) : (
          <>
            <MessageList
              view={view}
              onRegenerate={(id) => view.regenerate(id)}
              onEdit={(id, text) => view.edit(id, [userMessage(text)])}
              onToolApprove={handleToolApproved}
              onToolDeny={handleToolDeny}
            />
            <MessageQueue queue={queue} />
            {tab === 'images' && <ImagePresets onSelectPrompt={(prompt) => view.send([userMessage(prompt)])} />}
            {tab === 'speech' && <SpeechPresets onSelectPrompt={(prompt) => view.send([userMessage(prompt)])} />}
            <InputBar
              session={session}
              send={view.send}
              activeRuns={activeRuns}
              clientId={clientId}
              queue={queue}
              placeholder={
                tab === 'images'
                  ? 'Describe a small image, or / for commands...'
                  : tab === 'speech'
                    ? 'Say something out loud, or / for commands...'
                    : undefined
              }
            />
          </>
        )}
      </div>
      {!split && (
        <DebugPane
          messages={view.nodes.map((n) => n.message)}
          ablyMessages={ablyMessages}
          activeRuns={activeRuns}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tabs - switch between chat and image generation. Each tab has its own
// Ably channel and history; switching tabs re-attaches with a different
// channel suffix.
// ---------------------------------------------------------------------------

function Tabs({ active, onChange }: { active: TabId; onChange: (tab: TabId) => void }) {
  return (
    <div className="flex flex-shrink-0 border-b border-zinc-800 px-4">
      {TAB_IDS.map((id) => (
        <button
          key={id}
          type="button"
          onClick={() => onChange(id)}
          className={`px-4 py-2 text-xs font-medium uppercase tracking-wide transition-colors border-b-2 -mb-px ${
            active === id ? 'border-emerald-500 text-zinc-100' : 'border-transparent text-zinc-500 hover:text-zinc-300'
          }`}
        >
          {id}
        </button>
      ))}
    </div>
  );
}
