import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { badgeClassName } from './badgeStyles';

interface LlmContentProps {
  content: string;
  stepStartIndex?: number;
  conversationStyle?: 'default' | 'chat';
}

export const LlmContent: React.FC<LlmContentProps> = ({
  content,
  stepStartIndex = 1,
  conversationStyle = 'default',
}) => {
  // Extract structured step metadata tags for prettier rendering in conversation.
  const stepMetadata: Array<{ thinkingSummary: string }> = [];
  const metadataThinkingRegex = /<thinking_summary>([\s\S]*?)<\/thinking_summary>/gi;
  let metadataMatch;
  while ((metadataMatch = metadataThinkingRegex.exec(content)) !== null) {
    stepMetadata.push({
      thinkingSummary: metadataMatch[1].trim(),
    });
  }

  const contentWithoutMetadata = content
    .replace(metadataThinkingRegex, '')
    .replace(/<thinking_summary>[\s\S]*?<\/thinking_summary>/gi, '')
    .replace(/<impact>([\s\S]*?)<\/impact>/gi, '')
    .replace(/Next Step I Plan To Do:\s*[\s\S]*?(?=\n\s*<tool>|<tool>|$)/gi, '')
    .replace(/Alternative:\s*[\s\S]*?(?=\n\s*<tool>|<tool>|$)/gi, '')
    .replace(/Why I choose A over B:\s*[\s\S]*?(?=\n\s*<tool>|<tool>|$)/gi, '')
    .trim();

  const actionChips = Array.from(
    new Set(
      Array.from(
        contentWithoutMetadata.matchAll(
          /<tool>(.*?)<\/tool>\s*<input>[\s\S]*?<\/input>(?:\s*<requires_approval>.*?<\/requires_approval>)?/gi
        )
      )
        .map((m) => (m[1] || '').trim())
        .filter(Boolean)
        .map((toolName) => (toolName.startsWith('browser_') ? toolName.slice('browser_'.length) : toolName))
    )
  );

  // Split content into regular text and tool calls
  const parts: Array<{ type: 'text' | 'tool', content: string }> = [];
  
  // Process the content to identify tool calls
  // Create a combined regex that handles both direct tool calls and those wrapped in code blocks (xml or bash)
  const combinedToolCallRegex = /(```(?:xml|bash)\s*)?<tool>(.*?)<\/tool>\s*<input>([\s\S]*?)<\/input>(?:\s*<requires_approval>(.*?)<\/requires_approval>)?(\s*```)?/g;
  let lastIndex = 0;
  
  // Create a copy of the content to work with
  const contentCopy = contentWithoutMetadata.toString();
  
  // Reset regex lastIndex
  combinedToolCallRegex.lastIndex = 0;
  
  // Process all tool calls (both direct and code block) in a single pass
  let match;
  while ((match = combinedToolCallRegex.exec(contentCopy)) !== null) {
    // Add text before the tool call
    if (match.index > lastIndex) {
      parts.push({
        type: 'text',
        content: contentCopy.substring(lastIndex, match.index)
      });
    }
    
    // Add the tool call
    parts.push({
      type: 'tool',
      content: match[0]
    });
    
    lastIndex = match.index + match[0].length;
  }
  
  // Add any remaining text after the last tool call
  if (lastIndex < contentCopy.length) {
    parts.push({
      type: 'text',
      content: contentCopy.substring(lastIndex)
    });
  }

  // If no tool calls were found, keep only cleaned content (no raw metadata tags).
  if (parts.length === 0) {
    if (contentWithoutMetadata) {
      parts.push({
        type: 'text',
        content: contentWithoutMetadata,
      });
    }
  }
  
  const isChatStyle = conversationStyle === 'chat';
  const plainThinkingBlocks = stepMetadata
    .map((item) => item.thinkingSummary.trim())
    .filter(Boolean);
  const textParts = parts.filter((part) => part.type === 'text' && part.content.trim().length > 0);
  const hasRenderableText = textParts.length > 0 || plainThinkingBlocks.length > 0;

  if (isChatStyle && !hasRenderableText) {
    return null;
  }

  return (
    <>
      {!isChatStyle && actionChips.length > 0 ? (
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          {actionChips.map((chip) => (
            <span key={`chip-${chip}`} className={badgeClassName('neutral')}>
              {chip}
            </span>
          ))}
        </div>
      ) : null}
      {!isChatStyle && stepMetadata.map((item, index) => {
        return (
          <div key={`step-meta-${index}`} className="mb-2 rounded border border-base-300 bg-base-200 p-3 text-sm">
            <div className="mb-1 flex items-center justify-between">
              <span className="font-semibold text-base-content/80">Step {stepStartIndex + index}</span>
            </div>
            <div>
              <span className="font-semibold">Thinking:</span> {item.thinkingSummary}
            </div>
          </div>
        );
      })}
      {isChatStyle
        ? plainThinkingBlocks.map((thinking, index) => (
            <ReactMarkdown
              key={`thinking-${index}`}
              remarkPlugins={[remarkGfm]}
              components={{
                p: ({node, ...props}) => <p className="mb-2" {...props} />,
              }}
            >
              {thinking}
            </ReactMarkdown>
          ))
        : null}
      {parts.map((part, index) => {
        if (part.type === 'text') {
          // Render regular text with markdown
          return (
            <ReactMarkdown 
              key={index}
              remarkPlugins={[remarkGfm]}
              components={{
                // Apply Tailwind classes to markdown elements
                p: ({node, ...props}) => <p className="mb-2" {...props} />,
                h1: ({node, ...props}) => <h1 className="text-xl font-bold mb-2" {...props} />,
                h2: ({node, ...props}) => <h2 className="text-lg font-bold mb-2" {...props} />,
                h3: ({node, ...props}) => <h3 className="text-md font-bold mb-2" {...props} />,
                ul: ({node, ...props}) => <ul className="list-disc pl-5 mb-2" {...props} />,
                ol: ({node, ...props}) => <ol className="list-decimal pl-5 mb-2" {...props} />,
                li: ({node, ...props}) => <li className="mb-1" {...props} />,
                a: ({node, ...props}) => <a className="text-primary underline" {...props} />,
                code: ({node, className, children, ...props}) => {
                  const match = /language-(\w+)/.exec(className || '');
                  const isInline = !match && !className;
                  return isInline 
                    ? <code className="bg-base-300 px-1 rounded text-sm" {...props}>{children}</code>
                    : <pre className="bg-base-300 p-2 rounded text-sm overflow-auto my-2"><code {...props}>{children}</code></pre>;
                },
                blockquote: ({node, ...props}) => <blockquote className="border-l-4 border-base-300 pl-4 italic my-2" {...props} />,
                table: ({node, ...props}) => <table className="border-collapse table-auto w-full my-2" {...props} />,
                th: ({node, ...props}) => <th className="border border-base-300 px-4 py-2 text-left" {...props} />,
                td: ({node, ...props}) => <td className="border border-base-300 px-4 py-2" {...props} />,
              }}
            >
              {part.content}
            </ReactMarkdown>
          );
        } else {
          // Render tool calls with special styling
          // We don't need to check for specific formats anymore since we're using a combined regex
          // Just return null for all tool calls to prevent empty bubbles
          return null;
        }
      })}
    </>
  );
};
