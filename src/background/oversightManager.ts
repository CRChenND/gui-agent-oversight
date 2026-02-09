import type { Page } from 'playwright-crx';
import { clearAttentionOverlay, inferAttentionTarget, renderAttentionOverlay } from './attentionTracker';
import { sendUIMessage, logWithTimestamp } from './utils';
import type { OversightEvent } from '../oversight/types';

function emitOversightEvent(event: OversightEvent, tabId: number, windowId?: number): void {
  sendUIMessage('oversightEvent', { event }, tabId, windowId);
}

export async function handleToolStarted(args: {
  tabId: number;
  windowId?: number;
  page?: Page;
  toolName: string;
  toolInput: string;
  enableAgentFocus: boolean;
}): Promise<void> {
  const { tabId, windowId, page, toolName, toolInput, enableAgentFocus } = args;
  const attentionTarget = inferAttentionTarget(toolName, toolInput);

  emitOversightEvent(
    {
      kind: 'tool_started',
      timestamp: Date.now(),
      toolName,
      toolInput,
      focusType: attentionTarget.type,
      focusLabel: attentionTarget.label,
    },
    tabId,
    windowId
  );

  if (enableAgentFocus && page) {
    try {
      await renderAttentionOverlay(page, attentionTarget);
    } catch (error) {
      logWithTimestamp(
        `Failed to render attention overlay: ${error instanceof Error ? error.message : String(error)}`,
        'warn'
      );
    }
  }
}

export async function handleRunCompleted(args: {
  tabId: number;
  windowId?: number;
  page?: Page;
  focusLabel?: string;
}): Promise<void> {
  const { tabId, windowId, page, focusLabel = 'Task completed' } = args;

  emitOversightEvent(
    {
      kind: 'run_completed',
      timestamp: Date.now(),
      focusLabel,
    },
    tabId,
    windowId
  );

  if (page) {
    try {
      await clearAttentionOverlay(page);
    } catch (error) {
      logWithTimestamp(
        `Failed to clear attention overlay: ${error instanceof Error ? error.message : String(error)}`,
        'warn'
      );
    }
  }
}

export async function handleRunCancelled(args: {
  tabId: number;
  windowId?: number;
  page?: Page;
  focusLabel?: string;
}): Promise<void> {
  const { tabId, windowId, page, focusLabel = 'Execution cancelled' } = args;

  emitOversightEvent(
    {
      kind: 'run_cancelled',
      timestamp: Date.now(),
      focusLabel,
    },
    tabId,
    windowId
  );

  if (page) {
    try {
      await clearAttentionOverlay(page);
    } catch (error) {
      logWithTimestamp(
        `Failed to clear attention overlay on cancel: ${error instanceof Error ? error.message : String(error)}`,
        'warn'
      );
    }
  }
}

export async function handleRunFailed(args: {
  tabId: number;
  windowId?: number;
  page?: Page;
  focusLabel?: string;
  error?: string;
}): Promise<void> {
  const { tabId, windowId, page, focusLabel = 'Execution failed', error } = args;

  emitOversightEvent(
    {
      kind: 'run_failed',
      timestamp: Date.now(),
      focusLabel,
      error,
    },
    tabId,
    windowId
  );

  if (page) {
    try {
      await clearAttentionOverlay(page);
    } catch (clearError) {
      logWithTimestamp(
        `Failed to clear attention overlay on error: ${clearError instanceof Error ? clearError.message : String(clearError)}`,
        'warn'
      );
    }
  }
}
