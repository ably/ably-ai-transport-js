'use client';

import { useRef, useEffect, useMemo } from 'react';
import type { UIMessage, UIMessageChunk } from 'ai';
import type { ViewHandle } from '@ably/ai-transport/react';
import type { TreeNode } from '@ably/ai-transport';
import { MessageBubble } from './message-bubble';
import { hasAgentProgress, getLatestProgress } from './agent-progress';
import { isKnownAgent, AGENT_STYLES } from './agent-colors';

interface MessageListProps {
  view: ViewHandle<UIMessageChunk, UIMessage>;
  onCancelTurn: (turnId: string) => void;
  onSendMessage: (text: string) => void;
}

/**
 * Infer agent ID from headers or progress data.
 */
function getAgentId(node: TreeNode<UIMessage>): string | null {
  const clientId = node.headers['x-ably-turn-client-id'];
  if (clientId && isKnownAgent(clientId)) return clientId;
  const progress = getLatestProgress(node.message);
  if (!progress) return null;
  for (const [id, style] of Object.entries(AGENT_STYLES)) {
    if (style.label === progress.agentLabel) return id;
  }
  return null;
}

/**
 * From history, each data-agent-progress Ably message becomes a separate tree
 * node. Collapse consecutive progress-only nodes from the same agent into a
 * single node (keeping the last one, which has the most complete state).
 */
function collapseProgressNodes(nodes: TreeNode<UIMessage>[]): TreeNode<UIMessage>[] {
  const result: TreeNode<UIMessage>[] = [];

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const isProgress = node.message.role === 'assistant' && hasAgentProgress(node.message);

    if (!isProgress) {
      result.push(node);
      continue;
    }

    const agentId = getAgentId(node);

    // Look ahead: skip this node if the next node is also a progress node
    // from the same agent (keep only the last in a consecutive run).
    const next = nodes[i + 1];
    if (next && next.message.role === 'assistant' && hasAgentProgress(next.message)) {
      const nextAgentId = getAgentId(next);
      if (nextAgentId === agentId) {
        // Skip this one — the next node has a more complete progress snapshot
        continue;
      }
    }

    result.push(node);
  }

  return result;
}

export function MessageList({ view, onCancelTurn, onSendMessage }: MessageListProps) {
  const { nodes, hasOlder, loading, loadOlder } = view;
  const endRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const collapsed = useMemo(() => {
    const progress = collapseProgressNodes(nodes);
    // Filter out assistant messages with no visible content (e.g. only silent tool calls)
    return progress.filter((node) => {
      if (node.message.role !== 'assistant') return true;
      const hasText = node.message.parts.some((p) => p.type === 'text' && 'text' in p && (p as { text: string }).text.trim());
      const hasVisibleTool = node.message.parts.some((p) => p.type === 'dynamic-tool');
      const hasProgress = hasAgentProgress(node.message);
      const hasData = node.message.parts.some((p) => p.type.startsWith('data-'));
      return hasText || hasVisibleTool || hasProgress || hasData;
    });
  }, [nodes]);

  // Auto-scroll on any content change (new messages or streaming updates)
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [nodes]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el || !hasOlder || loading) return;
    if (el.scrollTop < 60) {
      void loadOlder();
    }
  };

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="flex-1 overflow-y-auto px-4 py-4 space-y-4"
    >
      {hasOlder && (
        <div className="text-center">
          <button
            onClick={() => void loadOlder()}
            disabled={loading}
            className="text-xs text-zinc-500 hover:text-zinc-300 disabled:opacity-40 transition-colors"
          >
            {loading ? 'Loading...' : 'Load older messages'}
          </button>
        </div>
      )}
      {loading && <div className="text-center text-xs text-zinc-600 animate-pulse">Loading history...</div>}
      {collapsed.length === 0 && !loading && (
        <div className="text-center mt-20 space-y-2">
          <p className="text-sm text-zinc-400">Welcome to Acme Electronics Support</p>
          <p className="text-xs text-zinc-600">Ask about an order, search products, or request a return.</p>
        </div>
      )}
      {collapsed.map((node) => (
        <MessageBubble
          key={node.message.id || node.msgId}
          message={node.message}
          headers={node.headers}
          onCancelTurn={onCancelTurn}
          onSendMessage={onSendMessage}
        />
      ))}
      <div ref={endRef} />
    </div>
  );
}
