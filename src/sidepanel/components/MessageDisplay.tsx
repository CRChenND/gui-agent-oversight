import React from 'react';
import { Message } from '../types';
import { LlmContent } from './LlmContent';
import { ScreenshotMessage } from './ScreenshotMessage';

interface MessageDisplayProps {
  messages: Message[];
  streamingSegments: Record<number, string>;
  isStreaming: boolean;
}

export const MessageDisplay: React.FC<MessageDisplayProps> = ({
  messages,
  streamingSegments,
  isStreaming
}) => {
  const countStepMetadata = (content: string): number => {
    if (!content) return 0;
    const metadataTripletRegex =
      /<thinking_summary>[\s\S]*?<\/thinking_summary>\s*<impact>(low|medium|high)<\/impact>\s*<impact_rationale>[\s\S]*?<\/impact_rationale>/gi;
    const matches = content.match(metadataTripletRegex);
    return matches ? matches.length : 0;
  };

  // Always show all messages
  const filteredMessages = messages;

  if (filteredMessages.length === 0 && Object.keys(streamingSegments).length === 0) {
    return null;
  }

  return (
    <div>
      {/* Render completed messages in their original order */}
      {(() => {
        let stepCursor = 1;
        return filteredMessages.map((msg, index) => {
          const stepStartIndex = stepCursor;
          if (msg.type === 'llm') {
            stepCursor += countStepMetadata(msg.content);
          }

          return (
            <div key={`msg-${index}`} className="mb-2">
              {msg.type === 'system' ? (
                <div className="bg-base-200 px-3 py-1 rounded text-gray-500 text-sm">
                  {msg.content}
                </div>
              ) : msg.type === 'screenshot' && msg.imageData ? (
                <ScreenshotMessage imageData={msg.imageData} mediaType={msg.mediaType} />
              ) : (
                <LlmContent content={msg.content} stepStartIndex={stepStartIndex} />
              )}
            </div>
          );
        });
      })()}
      
      {/* Render currently streaming segments at the end */}
      {isStreaming && (() => {
        const completedStepCount = filteredMessages.reduce((acc, msg) => {
          if (msg.type !== 'llm') return acc;
          return acc + countStepMetadata(msg.content);
        }, 0);
        let stepCursor = completedStepCount + 1;

        return Object.entries(streamingSegments).map(([id, content]) => {
          const stepStartIndex = stepCursor;
          stepCursor += countStepMetadata(content);
          return (
            <div key={`segment-${id}`} className="mb-2 animate-pulse">
              <LlmContent content={content} stepStartIndex={stepStartIndex} />
            </div>
          );
        });
      })()}
    </div>
  );
};
