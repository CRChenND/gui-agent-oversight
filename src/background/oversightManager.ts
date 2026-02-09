import type { Page } from 'playwright-crx';
import { getOversightSessionManager } from '../oversight/session/sessionManager';
import { getOversightTelemetryLogger } from '../oversight/telemetry/logger';
import type { OversightTelemetryEvent } from '../oversight/telemetry/types';
import type { AgentThinkingSummary, OversightEvent } from '../oversight/types';
import { clearAttentionOverlay, inferAttentionTarget, renderAttentionOverlay } from './attentionTracker';
import { sendUIMessage, logWithTimestamp } from './utils';

function emitOversightEvent(event: OversightEvent, tabId: number, windowId?: number): void {
  sendUIMessage('oversightEvent', { event }, tabId, windowId);
}

async function resolveSessionId(): Promise<string> {
  const sessionManager = getOversightSessionManager();
  const activeSessionId = await sessionManager.getActiveSessionId();
  if (activeSessionId) {
    return activeSessionId;
  }
  return sessionManager.startSession();
}

async function logTelemetry(
  event: Omit<OversightTelemetryEvent, 'sessionId' | 'timestamp'> & { timestamp?: number }
): Promise<void> {
  const logger = getOversightTelemetryLogger();
  const sessionId = await resolveSessionId();

  logger.log({
    sessionId,
    timestamp: event.timestamp ?? Date.now(),
    source: event.source,
    eventType: event.eventType,
    payload: event.payload,
  });
}

export async function handleToolStarted(args: {
  tabId: number;
  windowId?: number;
  page?: Page;
  stepId: string;
  toolName: string;
  toolInput: string;
  enableAgentFocus: boolean;
}): Promise<void> {
  const { tabId, windowId, page, stepId, toolName, toolInput, enableAgentFocus } = args;
  const attentionTarget = inferAttentionTarget(toolName, toolInput);

  emitOversightEvent(
    {
      kind: 'tool_started',
      timestamp: Date.now(),
      stepId,
      toolName,
      toolInput,
      focusType: attentionTarget.type,
      focusLabel: attentionTarget.label,
    },
    tabId,
    windowId
  );

  void logTelemetry({
    source: 'agent',
    eventType: 'agent_action',
    payload: {
      phase: 'tool_started',
      stepId,
      toolName,
      toolInput,
      focusType: attentionTarget.type,
      focusLabel: attentionTarget.label,
      tabId,
      windowId,
    },
  });

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

export async function handleToolCompleted(args: {
  tabId: number;
  windowId?: number;
  stepId: string;
  toolName: string;
  toolInput: string;
  result: string;
}): Promise<void> {
  const { tabId, windowId, stepId, toolName, toolInput, result } = args;
  void logTelemetry({
    source: 'agent',
    eventType: 'agent_action',
    payload: {
      phase: 'tool_completed',
      stepId,
      toolName,
      toolInput,
      result,
      tabId,
      windowId,
    },
  });
}

export async function handleToolFailed(args: {
  tabId: number;
  windowId?: number;
  stepId: string;
  toolName: string;
  toolInput: string;
  error: string;
}): Promise<void> {
  const { tabId, windowId, stepId, toolName, toolInput, error } = args;
  void logTelemetry({
    source: 'agent',
    eventType: 'agent_action',
    payload: {
      phase: 'tool_failed',
      stepId,
      toolName,
      toolInput,
      error,
      tabId,
      windowId,
    },
  });
}

export async function handleRiskSignal(args: {
  tabId: number;
  windowId?: number;
  stepId: string;
  toolName: string;
  signal: Record<string, unknown>;
}): Promise<void> {
  const { tabId, windowId, stepId, toolName, signal } = args;
  void logTelemetry({
    source: 'system',
    eventType: 'oversight_signal',
    payload: {
      phase: 'risk_signal_emitted',
      stepId,
      toolName,
      signal,
      tabId,
      windowId,
    },
  });
}

export async function handleApprovalRequested(args: {
  tabId: number;
  windowId?: number;
  stepId: string;
  requestId: string;
  toolName: string;
  toolInput: string;
  reason: string;
}): Promise<void> {
  const { tabId, windowId, stepId, requestId, toolName, toolInput, reason } = args;
  void logTelemetry({
    source: 'system',
    eventType: 'oversight_signal',
    payload: {
      phase: 'approval_requested',
      stepId,
      requestId,
      toolName,
      toolInput,
      reason,
      tabId,
      windowId,
    },
  });
}

export async function handleAgentThinking(args: {
  tabId: number;
  windowId?: number;
  stepId: string;
  toolName?: string;
  thinking: AgentThinkingSummary;
}): Promise<void> {
  const { tabId, windowId, stepId, toolName, thinking } = args;
  const timestamp = Date.now();

  emitOversightEvent(
    {
      kind: 'agent_thinking',
      timestamp,
      stepId,
      toolName,
      thinking,
    },
    tabId,
    windowId
  );

  void logTelemetry({
    source: 'agent',
    eventType: 'agent_thinking',
    timestamp,
    payload: {
      phase: 'agent_thinking',
      stepId,
      toolName,
      thinkingSummary: thinking,
      tabId,
      windowId,
    },
  });
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

  await logTelemetry({
    source: 'system',
    eventType: 'state_transition',
    payload: {
      phase: 'run_completed',
      focusLabel,
      tabId,
      windowId,
    },
  });

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

  await getOversightSessionManager().endSession();
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

  await logTelemetry({
    source: 'system',
    eventType: 'state_transition',
    payload: {
      phase: 'run_cancelled',
      focusLabel,
      tabId,
      windowId,
    },
  });

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

  await getOversightSessionManager().endSession();
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

  await logTelemetry({
    source: 'system',
    eventType: 'state_transition',
    payload: {
      phase: 'run_failed',
      focusLabel,
      error,
      tabId,
      windowId,
    },
  });

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

  await getOversightSessionManager().endSession();
}
