'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { PlainChat } from './plain-chat';
import { AblyChat } from './ably-chat';
import { AblyProviders } from './providers';

type Mode = 'plain' | 'ably';

function ChatPage() {
  const searchParams = useSearchParams();
  const channelName = searchParams.get('channel') ?? process.env.NEXT_PUBLIC_ABLY_CHANNEL ?? 'ai:edit-demo';
  const [mode, setMode] = useState<Mode>('plain');

  return (
    <div
      style={{
        maxWidth: 750,
        margin: '0 auto',
        padding: '1rem',
        height: '100dvh',
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Mode toggle */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '0.5rem 0',
          borderBottom: '1px solid #333',
          marginBottom: '1rem',
        }}
      >
        <h1 style={{ fontSize: 14, fontWeight: 600, margin: 0, color: '#a1a1aa' }}>Edit / Regenerate Demo</h1>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
          {(['plain', 'ably'] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              style={{
                padding: '4px 12px',
                fontSize: 12,
                fontWeight: 500,
                borderRadius: 4,
                border: '1px solid #444',
                background: mode === m ? '#3f3f46' : 'transparent',
                color: mode === m ? '#e4e4e7' : '#71717a',
                cursor: 'pointer',
              }}
            >
              {m === 'plain' ? 'Plain Vercel' : 'AI Transport'}
            </button>
          ))}
        </div>
      </div>

      {/* Chat area */}
      {mode === 'plain' ? (
        <PlainChat />
      ) : (
        <AblyProviders>
          <AblyChat chatId={channelName} />
        </AblyProviders>
      )}
    </div>
  );
}

export default function Home() {
  return (
    <Suspense>
      <ChatPage />
    </Suspense>
  );
}
