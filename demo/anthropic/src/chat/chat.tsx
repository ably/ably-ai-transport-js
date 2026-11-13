'use client';

import { type SubmitEvent, useState } from 'react';

import { BlockView } from './blocks';
import { useConversation, type UseConversationOptions } from './use-conversation';
import { useToolApproval } from './use-tool-approval';

export function Chat({ channelName, stored, onDiscontinuity }: UseConversationOptions) {
  const { entries, deliveries, attached, streaming, busy, submit, approve } = useConversation({
    channelName,
    stored,
    onDiscontinuity,
  });

  // Only the last entry can hold tool calls still waiting for an answer. The
  // Messages API needs every `tool_use` answered by a `tool_result` in the
  // next message, so a call in any earlier entry has already been answered,
  // and once the agent publishes the results, their message is the last entry.
  const { pending, answer } = useToolApproval({ last: entries.at(-1), held: busy || streaming, approve });

  const [tab, setTab] = useState<'chat' | 'wire'>('chat');
  const [input, setInput] = useState('');

  const send = async (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();

    const text = input.trim();
    if (text === '' || busy || streaming) return;

    setInput('');
    await submit(text);
  };

  return (
    <main>
      <header>
        <span>{channelName}</span>
        <nav className="tabs">
          <button
            type="button"
            className={tab === 'chat' ? 'active' : ''}
            onClick={() => setTab('chat')}
          >
            Conversation
          </button>
          <button
            type="button"
            className={tab === 'wire' ? 'active' : ''}
            onClick={() => setTab('wire')}
          >
            Ably messages ({deliveries.length})
          </button>
        </nav>
        <span>{streaming ? 'streaming…' : attached ? 'live' : 'connecting…'}</span>
      </header>
      {tab === 'chat' ? (
        <>
          <div className="messages">
            {entries.map((entry) => (
              <div
                key={entry.id}
                className={`message ${entry.role}`}
              >
                {typeof entry.content === 'string'
                  ? entry.content
                  : entry.content.map((block, i) => (
                      <BlockView
                        key={i}
                        block={block}
                        pending={pending}
                        onAnswer={answer}
                      />
                    ))}
              </div>
            ))}
          </div>
          <form onSubmit={send}>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={
                busy || streaming ? 'Waiting for the reply…' : 'Ask about the weather, or anything to search for'
              }
              disabled={busy || streaming || pending.length > 0}
              autoFocus
            />
            <button
              type="submit"
              disabled={!attached || busy || streaming || pending.length > 0 || input.trim() === ''}
            >
              Send
            </button>
          </form>
        </>
      ) : (
        <div className="deliveries">
          {deliveries.map((delivery, i) => (
            <pre key={`${delivery.message.serial ?? ''}:${delivery.message.version?.serial ?? String(i)}`}>
              {JSON.stringify(delivery, null, 2)}
            </pre>
          ))}
        </div>
      )}
    </main>
  );
}
