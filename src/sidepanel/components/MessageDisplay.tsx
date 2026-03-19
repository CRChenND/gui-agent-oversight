import React from 'react';
import { Message } from '../types';
import { LlmContent } from './LlmContent';
import { ScreenshotMessage } from './ScreenshotMessage';

interface MessageDisplayProps {
  messages: Message[];
  streamingSegments: Record<number, string>;
  isStreaming: boolean;
  conversationStyle?: 'default' | 'chat';
}

export const MessageDisplay: React.FC<MessageDisplayProps> = ({
  messages,
  streamingSegments,
  isStreaming,
  conversationStyle = 'default',
}) => {
  const isChatStyle = conversationStyle === 'chat';
  const countStepMetadata = (content: string): number => {
    if (!content) return 0;
    const metadataTripletRegex = /<thinking(?:_summary|\s+summary)>[\s\S]*?<\/thinking(?:_summary|\s+summary)>/gi;
    const matches = content.match(metadataTripletRegex);
    return matches ? matches.length : 0;
  };

  const hasVisibleConversationContent = (content: string): boolean => {
    if (!isChatStyle) {
      return content.trim().length > 0;
    }
    const thinkingBlocks = content.match(/<thinking(?:_summary|\s+summary)>([\s\S]*?)<\/thinking(?:_summary|\s+summary)>/gi);
    const stripped = content
      .replace(/<thinking(?:_summary|\s+summary)>[\s\S]*?<\/thinking(?:_summary|\s+summary)>/gi, '')
      .replace(/<impact>[\s\S]*?<\/impact>/gi, '')
      .replace(/(```(?:xml|bash)\s*)?<tool>[\s\S]*?<\/requires_approval>(\s*```)?/gi, '')
      .replace(/(```(?:xml|bash)\s*)?<tool>[\s\S]*?<\/input>(\s*```)?/gi, '')
      .trim();
    return Boolean(stripped || (thinkingBlocks && thinkingBlocks.length > 0));
  };

  // Always show all messages
  const filteredMessages = messages;

  if (filteredMessages.length === 0 && Object.keys(streamingSegments).length === 0) {
    return null;
  }

  return (
    <div className={isChatStyle ? "space-y-3 px-3 py-3" : "morph-message-stack space-y-3"}>
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
          const isUser = msg.type === 'user';
          const hasNext = index < total - 1 || (isStreaming && Object.keys(streamingSegments).length > 0);
          const shouldRenderLlmBody = msg.type !== 'llm' || hasVisibleConversationContent(msg.content);

          return (
            <div key={`msg-${index}`}>
              {isSystem ? (
                <div className={isChatStyle ? "rounded-2xl bg-base-200/80 px-3 py-2 text-xs text-base-content/65" : "morph-system-note bg-base-200 text-xs text-base-content/70"}>
                  {msg.content}
                </div>
              ) : isUser ? (
                <div className="flex justify-end">
                  <div className={isChatStyle ? "max-w-[88%] rounded-[1.35rem] rounded-br-md bg-primary px-4 py-3 text-sm text-primary-content shadow-sm" : "max-w-[88%] rounded-2xl rounded-br-md bg-primary px-4 py-3 text-sm text-primary-content shadow-sm"}>
                    {msg.content}
                  </div>
                </div>
              ) : shouldRenderLlmBody ? (
                isChatStyle ? (
                  <div className="flex justify-start">
                    <div className="max-w-[88%] rounded-[1.35rem] rounded-bl-md border border-base-300/70 bg-base-100 px-4 py-3 shadow-sm">
                      {msg.type === 'screenshot' && msg.imageData ? (
                        <ScreenshotMessage imageData={msg.imageData} mediaType={msg.mediaType} />
                      ) : (
                        <LlmContent
                          content={msg.content}
                          stepStartIndex={stepStartIndex}
                          conversationStyle={conversationStyle}
                        />
                      )}
                    </div>
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
                          <LlmContent
                            content={msg.content}
                            stepStartIndex={stepStartIndex}
                            conversationStyle={conversationStyle}
                          />
                        </div>
                      )}
                    </div>
                  </div>
                )
              ) : null}
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
          if (!hasVisibleConversationContent(content)) {
            return null;
          }
          const stepStartIndex = stepCursor;
          stepCursor += countStepMetadata(content);
          return (
            isChatStyle ? (
              <div key={`segment-${id}`} className="flex justify-start">
                <div className="max-w-[88%] rounded-[1.35rem] rounded-bl-md border border-primary/20 bg-base-100 px-4 py-3 shadow-sm">
                  <LlmContent
                    content={content}
                    stepStartIndex={stepStartIndex}
                    conversationStyle={conversationStyle}
                  />
                </div>
              </div>
            ) : (
              <div key={`segment-${id}`} className="flex gap-2">
                <div className="relative flex w-4 justify-center">
                  <span className="morph-timeline-dot block bg-primary/60" />
                </div>
                <div className="morph-message-card min-w-0 flex-1 animate-pulse bg-base-100">
                  <LlmContent
                    content={content}
                    stepStartIndex={stepStartIndex}
                    conversationStyle={conversationStyle}
                  />
                </div>
              </div>
            )
          );
        });
      })()}
    </div>
  );
};
