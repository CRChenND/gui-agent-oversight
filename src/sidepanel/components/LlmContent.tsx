import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface LlmContentProps {
  content: string;
}

export const LlmContent: React.FC<LlmContentProps> = ({ content }) => {
  // Extract structured step metadata tags for prettier rendering in conversation.
  const stepMetadata: Array<{ thinkingSummary: string; impact: 'low' | 'medium' | 'high'; impactRationale: string }> = [];
  const metadataTripletRegex =
    /<thinking_summary>([\s\S]*?)<\/thinking_summary>\s*<impact>(low|medium|high)<\/impact>\s*<impact_rationale>([\s\S]*?)<\/impact_rationale>/gi;
  let metadataMatch;
  while ((metadataMatch = metadataTripletRegex.exec(content)) !== null) {
    stepMetadata.push({
      thinkingSummary: metadataMatch[1].trim(),
      impact: metadataMatch[2].trim().toLowerCase() as 'low' | 'medium' | 'high',
      impactRationale: metadataMatch[3].trim(),
    });
  }

  const contentWithoutMetadata = content
    .replace(metadataTripletRegex, '')
    .replace(/<thinking_summary>[\s\S]*?<\/thinking_summary>/gi, '')
    .replace(/<impact>([\s\S]*?)<\/impact>/gi, '')
    .replace(/<impact_rationale>[\s\S]*?<\/impact_rationale>/gi, '')
    .trim();

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

  // If no tool calls were found, just return the whole content
  if (parts.length === 0) {
    parts.push({
      type: 'text',
      content: content
    });
  }
  
  return (
    <>
      {stepMetadata.map((item, index) => {
        const impactClass =
          item.impact === 'high'
            ? 'badge badge-error'
            : item.impact === 'medium'
              ? 'badge badge-warning'
              : 'badge badge-success';
        return (
          <div key={`step-meta-${index}`} className="mb-2 rounded border border-base-300 bg-base-200 p-3 text-sm">
            <div className="mb-1 flex items-center justify-between">
              <span className="font-semibold text-base-content/80">Step Metadata</span>
              <span className={impactClass}>impact: {item.impact}</span>
            </div>
            <div className="mb-1">
              <span className="font-semibold">Thinking:</span> {item.thinkingSummary}
            </div>
            <div>
              <span className="font-semibold">Impact rationale:</span> {item.impactRationale}
            </div>
          </div>
        );
      })}
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
