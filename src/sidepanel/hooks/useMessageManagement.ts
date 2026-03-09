import { useState, useRef, useEffect } from 'react';
import { Message } from '../types';

export const useMessageManagement = () => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [streamingSegments, setStreamingSegments] = useState<Record<number, string>>({});
  const [currentSegmentId, setCurrentSegmentId] = useState<number>(0);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [autoScrollEnabled, setAutoScrollEnabled] = useState(true);
  const outputRef = useRef<HTMLDivElement>(null);

  const isNearBottom = (el: HTMLDivElement) => {
    const threshold = 24;
    return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
  };

  // Track user scrolling intent: scrolling up disables auto-scroll;
  // returning to bottom re-enables it.
  useEffect(() => {
    const container = outputRef.current;
    if (!container) return;

    const onScroll = () => {
      setAutoScrollEnabled(isNearBottom(container));
    };

    container.addEventListener('scroll', onScroll, { passive: true });
    onScroll();

    return () => container.removeEventListener('scroll', onScroll);
  }, []);

  // Auto-scroll when new content arrives only if auto-scroll is enabled.
  useEffect(() => {
    if (autoScrollEnabled && outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [messages, streamingSegments, autoScrollEnabled]);

  const addMessage = (message: Message) => {
    setMessages(prev => [...prev, { ...message, isComplete: true }]);
  };

  const addSystemMessage = (content: string) => {
    addMessage({ type: 'system', content });
  };

  const addUserMessage = (content: string) => {
    addMessage({ type: 'user', content });
  };

  const updateStreamingChunk = (content: string) => {
    setIsStreaming(true);
    setStreamingSegments(prev => ({
      ...prev,
      [currentSegmentId]: (prev[currentSegmentId] || '') + content
    }));
  };

  const finalizeStreamingSegment = (id: number, content: string) => {
    // Add the finalized segment as a complete message
    addMessage({ 
      type: 'llm', 
      content,
      segmentId: id
    });
    
    // Remove the segment from streaming segments
    setStreamingSegments(prev => {
      const newSegments = { ...prev };
      delete newSegments[id];
      return newSegments;
    });
  };

  const startNewSegment = (id: number) => {
    setCurrentSegmentId(id);
  };

  const completeStreaming = () => {
    setIsStreaming(false);
    setStreamingSegments({});
  };

  const clearMessages = () => {
    setMessages([]);
    setStreamingSegments({});
    setAutoScrollEnabled(true);
  };

  return {
    messages,
    streamingSegments,
    isStreaming,
    isProcessing,
    setIsProcessing,
    outputRef,
    addMessage,
    addUserMessage,
    addSystemMessage,
    updateStreamingChunk,
    finalizeStreamingSegment,
    startNewSegment,
    completeStreaming,
    clearMessages,
    currentSegmentId
  };
};
