'use client';

import { useState } from 'react';
import type { UIMessage } from 'ai';

interface MessageBubbleProps {
  message: UIMessage;
  /** Present only in AI Transport mode. */
  branchNav?: {
    hasSiblings: boolean;
    total: number;
    selectedIndex: number;
    onSelect: (index: number) => void;
  };
  /** Edit via useChat's sendMessage({ text, messageId }) — the Vercel path. */
  onEditViaUseChat?: (newText: string) => void;
  /** Edit via view.edit() — the native AI Transport path. */
  onEditViaTransport?: (newText: string) => void;
  /** Regenerate via useChat's regenerate() — the Vercel path. */
  onRegenerateViaUseChat?: () => void;
  /** Regenerate via view.regenerate() — the native AI Transport path. */
  onRegenerateViaTransport?: () => void;
}

const styles = {
  wrapper: (isUser: boolean): React.CSSProperties => ({
    display: 'flex',
    justifyContent: isUser ? 'flex-end' : 'flex-start',
    margin: '6px 0',
  }),
  bubble: (isUser: boolean): React.CSSProperties => ({
    maxWidth: '75%',
    padding: '8px 12px',
    borderRadius: 8,
    fontSize: 14,
    lineHeight: 1.5,
    whiteSpace: 'pre-wrap',
    background: isUser ? '#27272a' : '#18181b',
    border: `1px solid ${isUser ? '#3f3f46' : '#27272a'}`,
  }),
  meta: {
    fontSize: 10,
    color: '#71717a',
    marginBottom: 4,
    fontFamily: 'monospace',
  } as React.CSSProperties,
  actionBar: {
    marginTop: 4,
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    flexWrap: 'wrap',
  } as React.CSSProperties,
  smallBtn: {
    fontSize: 10,
    color: '#71717a',
    background: 'rgba(63,63,70,0.5)',
    border: 'none',
    borderRadius: 3,
    padding: '2px 6px',
    cursor: 'pointer',
  } as React.CSSProperties,
  branchNav: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    background: 'rgba(63,63,70,0.5)',
    borderRadius: 3,
    padding: '2px 6px',
    fontSize: 10,
    color: '#71717a',
  } as React.CSSProperties,
};

function BranchNavigator({
  total,
  selectedIndex,
  onSelect,
}: {
  total: number;
  selectedIndex: number;
  onSelect: (i: number) => void;
}) {
  return (
    <div style={styles.branchNav}>
      <button
        onClick={() => onSelect(selectedIndex - 1)}
        disabled={selectedIndex === 0}
        style={{ ...styles.smallBtn, opacity: selectedIndex === 0 ? 0.3 : 1 }}
      >
        &lt;
      </button>
      <span style={{ minWidth: 30, textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}>
        {selectedIndex + 1} / {total}
      </span>
      <button
        onClick={() => onSelect(selectedIndex + 1)}
        disabled={selectedIndex >= total - 1}
        style={{ ...styles.smallBtn, opacity: selectedIndex >= total - 1 ? 0.3 : 1 }}
      >
        &gt;
      </button>
    </div>
  );
}

function EditForm({
  initialText,
  actions,
  onCancel,
}: {
  initialText: string;
  actions: { label: string; onSubmit: (text: string) => void }[];
  onCancel: () => void;
}) {
  const [text, setText] = useState(initialText);
  const trimmed = text.trim();
  const disabled = !trimmed || trimmed === initialText;

  return (
    <div style={{ width: '100%' }}>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={Math.min(6, text.split('\n').length + 1)}
        autoFocus
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel();
        }}
        style={{
          width: '100%',
          padding: '6px 10px',
          borderRadius: 6,
          border: '1px solid #52525b',
          background: '#27272a',
          color: '#e4e4e7',
          fontSize: 13,
          resize: 'none',
          outline: 'none',
          boxSizing: 'border-box',
        }}
      />
      <div style={{ display: 'flex', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
        {actions.map((action) => (
          <button
            key={action.label}
            onClick={() => {
              action.onSubmit(trimmed);
              onCancel();
            }}
            disabled={disabled}
            style={{ ...styles.smallBtn, opacity: disabled ? 0.4 : 1 }}
          >
            {action.label}
          </button>
        ))}
        <button
          onClick={onCancel}
          style={styles.smallBtn}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

export function MessageBubble({
  message,
  branchNav,
  onEditViaUseChat,
  onEditViaTransport,
  onRegenerateViaUseChat,
  onRegenerateViaTransport,
}: MessageBubbleProps) {
  const isUser = message.role === 'user';
  const [isEditing, setIsEditing] = useState(false);

  const messageText = message.parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('');

  const hasEdit = onEditViaUseChat || onEditViaTransport;

  // Build edit form actions from whichever callbacks are provided
  const editActions: { label: string; onSubmit: (text: string) => void }[] = [];
  if (onEditViaUseChat)
    editActions.push({ label: 'Submit via useChat (sendMessage w/ messageId)', onSubmit: onEditViaUseChat });
  if (onEditViaTransport) editActions.push({ label: 'Submit via transport (view.edit)', onSubmit: onEditViaTransport });

  return (
    <div style={styles.wrapper(isUser)}>
      <div style={{ maxWidth: '75%' }}>
        {isEditing && hasEdit ? (
          <EditForm
            initialText={messageText}
            actions={editActions}
            onCancel={() => setIsEditing(false)}
          />
        ) : (
          <>
            <div style={styles.bubble(isUser)}>
              <div style={styles.meta}>
                {message.role} &mdash; {message.id}
              </div>
              {messageText}
            </div>
            <div style={styles.actionBar}>
              {branchNav?.hasSiblings && (
                <BranchNavigator
                  total={branchNav.total}
                  selectedIndex={branchNav.selectedIndex}
                  onSelect={branchNav.onSelect}
                />
              )}
              {hasEdit && (
                <button
                  onClick={() => setIsEditing(true)}
                  style={styles.smallBtn}
                >
                  edit
                </button>
              )}
              {onRegenerateViaUseChat && (
                <button
                  onClick={onRegenerateViaUseChat}
                  style={styles.smallBtn}
                >
                  regenerate (useChat)
                </button>
              )}
              {onRegenerateViaTransport && (
                <button
                  onClick={onRegenerateViaTransport}
                  style={styles.smallBtn}
                >
                  regenerate (view.regenerate)
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
