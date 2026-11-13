import type { ReactNode } from 'react';

import type { Block, ToolCall } from './lib';

const renderCitations = (block: Block): ReactNode => {
  if (block.type !== 'text' || !Array.isArray(block.citations) || block.citations.length === 0) return null;

  return (
    <ol className="citations">
      {block.citations.map((citation, i) => (
        <li key={i}>
          {citation.type === 'web_search_result_location' ? (
            <a
              href={citation.url}
              target="_blank"
              rel="noreferrer"
            >
              {citation.title ?? citation.url}
            </a>
          ) : null}{' '}
          “{citation.cited_text}”
        </li>
      ))}
    </ol>
  );
};

/** The props of one content block on the page. */
export interface BlockViewProps {
  /** The block to show. */
  block: Block;
  /** The tool calls waiting for the user; a `tool_use` block among them shows Approve and Deny. */
  pending: ToolCall[];
  /** Called when the user approves or denies a pending call. */
  onAnswer: (call: ToolCall, approved: boolean) => Promise<void>;
}

/**
 * One content block of a message: text with its citations, thinking, a tool
 * call with its answer buttons while it waits, a server tool's call and
 * result, or a tool result.
 * @param props - The block, the pending calls and the answer callback.
 * @returns The block's markup, or `null` for a block type the page does not show.
 */
export function BlockView({ block, pending, onAnswer }: BlockViewProps): ReactNode {
  switch (block.type) {
    case 'text': {
      return (
        <div>
          {block.text}
          {renderCitations(block)}
        </div>
      );
    }
    case 'thinking': {
      return (
        <details>
          <summary>Thinking</summary>
          {block.thinking}
        </details>
      );
    }
    case 'redacted_thinking': {
      return (
        <details>
          <summary>Thinking (redacted)</summary>
        </details>
      );
    }
    case 'tool_use': {
      const waiting = pending.some((call) => call.id === block.id);

      return (
        <div className="tool">
          {block.name}({JSON.stringify(block.input)})
          {waiting ? (
            <div className="actions">
              <button
                type="button"
                onClick={() => void onAnswer(block, true)}
              >
                Approve
              </button>
              <button
                type="button"
                onClick={() => void onAnswer(block, false)}
              >
                Deny
              </button>
            </div>
          ) : null}
        </div>
      );
    }
    case 'server_tool_use': {
      return (
        <div className="tool">
          {block.name}({JSON.stringify(block.input)})
        </div>
      );
    }
    case 'web_search_tool_result': {
      return (
        <div className="tool">
          {Array.isArray(block.content)
            ? block.content.map((result) => (
                <div key={result.url}>
                  <a
                    href={result.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {result.title}
                  </a>
                </div>
              ))
            : `search failed: ${block.content.error_code}`}
        </div>
      );
    }
    case 'tool_result': {
      return (
        <div className="tool">
          {block.is_error === true ? 'error: ' : 'result: '}
          {typeof block.content === 'string' ? block.content : JSON.stringify(block.content)}
        </div>
      );
    }
    default: {
      return null;
    }
  }
}
