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
    const metadataTripletRegex = /<thinking_summary>[\s\S]*?<\/thinking_summary>/gi;
    const matches = content.match(metadataTripletRegex);
    return matches ? matches.length : 0;
  };

  // Always show all messages
  const filteredMessages = messages;

  if (filteredMessages.length === 0 && Object.keys(streamingSegments).length === 0) {
    return null;
  }

  return (
    <div className="morph-message-stack space-y-3">
      {/* Render completed messages in their original order */}
      {(() => {
        let stepCursor = 1;
        const total = filteredMessages.length;
        return filteredMessages.map((msg, index) => {
          const stepStartIndex = stepCursor;
          if (msg.type === 'llm') {
            stepCursor += countStepMetadata(msg.content);
          }

          const isSystem = msg.type === 'system';
          const hasNext = index < total - 1 || (isStreaming && Object.keys(streamingSegments).length > 0);

          return (
            <div key={`msg-${index}`}>
              {isSystem ? (
                <div className="morph-system-note bg-base-200 text-xs text-base-content/70">
                  {msg.content}
                </div>
              ) : (
                <div className="flex gap-2">
                  <div className="relative flex w-4 justify-center">
                    <span className="morph-timeline-dot block" />
                    {hasNext ? <span className="absolute top-4 h-[calc(100%-0.75rem)] w-px bg-base-300" /> : null}
                  </div>
                  <div className="min-w-0 flex-1">
                    {msg.type === 'screenshot' && msg.imageData ? (
                      <div className="morph-message-card bg-base-100 p-2">
                        <ScreenshotMessage imageData={msg.imageData} mediaType={msg.mediaType} />
                      </div>
                    ) : (
                      <div className="morph-message-card bg-base-100">
                        <LlmContent content={msg.content} stepStartIndex={stepStartIndex} />
                      </div>
                    )}
                  </div>
                </div>
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
            <div key={`segment-${id}`} className="flex gap-2">
              <div className="relative flex w-4 justify-center">
                <span className="morph-timeline-dot block bg-primary/60" />
              </div>
              <div className="morph-message-card min-w-0 flex-1 animate-pulse bg-base-100">
                <LlmContent content={content} stepStartIndex={stepStartIndex} />
              </div>
            </div>
          );
        });
      })()}
    </div>
  );
};
