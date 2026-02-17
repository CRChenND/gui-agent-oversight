import type { OversightEvent } from '../oversight/types';

// Define message types
export type MessageType = 'system' | 'llm' | 'screenshot';

export interface Message {
  type: MessageType;
  content: string;
  isComplete?: boolean;
  segmentId?: number;
  isStreaming?: boolean;
  imageData?: string;
  mediaType?: string;
}

// Chrome message types
export interface ChromeMessage {
  action: string;
  content?: any;
  tabId?: number;
  windowId?: number;
  // Approval request properties
  requestId?: string;
  stepId?: string;
  toolName?: string;
  toolInput?: string;
  reason?: string;
  
  status?: 'attached' | 'detached' | 'running' | 'idle' | 'error';
  lastHeartbeat?: number;
  timestamp?: number;
  targetInfo?: any;
  url?: string;
  title?: string;
  dialogInfo?: any;
  consoleInfo?: any;
  error?: string;
  attentionState?: 'active' | 'idle';
  focusType?: 'selector' | 'coordinates' | 'url' | 'text' | 'none';
  focusLabel?: string;
  event?: OversightEvent;
  
  // Tab replacement properties
  oldTabId?: number;
  newTabId?: number;
}
