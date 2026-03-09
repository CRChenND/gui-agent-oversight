import type { Page } from 'playwright-crx';
import type { TaskStepContext } from './types';
import { getOversightSessionManager } from '../oversight/session/sessionManager';
import { getOversightTelemetryLogger } from '../oversight/telemetry/logger';
import type { OversightTelemetryEvent } from '../oversight/telemetry/types';
import type { AgentThinkingSummary, OversightEvent, StepContextEvent } from '../oversight/types';
import { inferRiskAssessment } from '../oversight/riskAssessment';
import { getOversightRuntimeManager } from '../oversight/runtime/runtimeManager';
import { clearAttentionOverlay, inferAttentionTarget, renderAttentionOverlay } from './attentionTracker';
import { sendUIMessage, logWithTimestamp } from './utils';

function emitOversightEvent(event: OversightEvent, tabId: number, windowId?: number): void {
  sendUIMessage('oversightEvent', { event }, tabId, windowId);
}

let runtimeDispatcherRegistered = false;
function ensureRuntimeDispatcherRegistered(): void {
  if (runtimeDispatcherRegistered) return;
  getOversightRuntimeManager().setDispatcher({
    emitOversightEvent: (event, tabId, windowId) => {
      sendUIMessage('oversightEvent', { event }, tabId, windowId);
    },
    emitRuntimeState: (status, tabId, windowId) => {
      sendUIMessage('runtimeStateUpdate', status, tabId, windowId);
    },
  });
  runtimeDispatcherRegistered = true;
}
ensureRuntimeDispatcherRegistered();

let activeStepContextByStepId: Record<string, TaskStepContext> = {};
const thinkingByStepId: Record<string, string> = {};

export function setActiveTaskStepContexts(steps: TaskStepContext[] = []): void {
  activeStepContextByStepId = steps.reduce((acc, step) => {
    acc[step.stepId] = step;
    return acc;
  }, {} as Record<string, TaskStepContext>);
}

export function clearActiveTaskStepContexts(): void {
  activeStepContextByStepId = {};
  Object.keys(thinkingByStepId).forEach((stepId) => {
    delete thinkingByStepId[stepId];
  });
}

function describeApprovalAction(toolName: string, toolInput: string): string {
  const trimmedInput = toolInput.trim();
  const quotedTarget = trimmedInput.match(/["']([^"']+)["']/)?.[1]?.trim();

  if (toolName.includes('snapshot') || toolName.includes('query') || toolName.includes('read')) {
    return 'Review this part of the page';
  }
  if (toolName.includes('click')) {
    return quotedTarget ? `Interact with "${quotedTarget}"` : 'Click the highlighted item';
  }
  if (toolName.includes('type') || toolName.includes('fill')) {
    return 'Enter information here';
  }
  if (toolName.includes('navigate')) {
    return 'Open the next page';
  }
  return 'Run this next step';
}

function extractPlainTarget(toolInput: string): string {
  const trimmed = toolInput.trim();
  const quoted = trimmed.match(/["']([^"']+)["']/)?.[1]?.trim();
  if (quoted) return quoted;
  const selector = trimmed.split(',')[0]?.trim();
  return selector || trimmed || 'this part of the page';
}

function describeApprovalProsAndCons(args: {
  toolName: string;
  toolInput: string;
  actionTitle: string;
  thinking?: string;
}): { pro: string; con: string } {
  const { toolName, toolInput, actionTitle, thinking } = args;
  const target = extractPlainTarget(toolInput);
  const tool = toolName.toLowerCase();

  if (tool.includes('type') || tool.includes('fill')) {
    return {
      pro: `Approving lets the agent keep filling the form so the task can move forward without more interruption.`,
      con: `The downside is that it may place information into ${target}, so a wrong field or wrong value could be annoying to undo.`,
    };
  }
  if (tool.includes('click')) {
    return {
      pro: `Approving lets the agent move the workflow forward by interacting with ${target}.`,
      con: `The downside is that a click can change the page immediately, and in some cases it may trigger the wrong next step.`,
    };
  }
  if (tool.includes('navigate')) {
    return {
      pro: `Approving lets the agent reach the next page it needs in order to continue the task.`,
      con: `The downside is that the page may change context, which can make it harder to compare with what you are seeing now.`,
    };
  }
  if (tool.includes('read') || tool.includes('snapshot') || tool.includes('query')) {
    return {
      pro: `Approving lets the agent inspect ${target} and gather the information it needs before acting.`,
      con: `The downside is low, but you may still want to pause if this is not the part of the page you expected it to inspect.`,
    };
  }

  return {
    pro: `Approving lets the agent continue with ${actionTitle.toLowerCase()} so it can keep working toward your request.`,
    con: thinking
      ? `The downside is that it may continue based on its current understanding, and you may want to stop it if that reasoning does not look right.`
      : `The downside is that the next change will happen immediately, so you may want to reject if this does not look like the step you intended.`,
  };
}

export function buildApprovalDecisionCopy(args: {
  actionTitle: string;
  toolName: string;
  toolInput: string;
  thinking?: string;
}): string {
  const { actionTitle, toolName, toolInput, thinking } = args;
  const { pro, con } = describeApprovalProsAndCons({ toolName, toolInput, actionTitle, thinking });
  return `If you approve, ${pro} If you reject, the agent will stop here for now. ${con}`;
}

function resolveStepContext(stepId: string, toolName: string, toolInput: string): StepContextEvent {
  const configured = activeStepContextByStepId[stepId];
  const inferred = inferRiskAssessment(toolName, toolInput);
  return {
    kind: 'step_context',
    stepId,
    impact: configured?.impact || inferred.impact,
    reversible: configured?.reversible ?? inferred.reversible,
    gold_risky: configured?.gold_risky ?? inferred.gold_risky,
    category: configured?.category || inferred.category,
  };
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
  planStepIndex?: number;
  stepDescription?: string;
  enableAgentFocus: boolean;
  thinking?: string;
  enableThinkingOverlay?: boolean;
}): Promise<void> {
  const { tabId, windowId, page, stepId, toolName, toolInput, planStepIndex, stepDescription, enableAgentFocus, thinking, enableThinkingOverlay } = args;
  const attentionTarget = inferAttentionTarget(toolName, toolInput);
  thinkingByStepId[stepId] = thinking || '';
  const stepContext = resolveStepContext(stepId, toolName, toolInput);
  const stepContextTimestamp = Date.now();

  emitOversightEvent(
    {
      ...stepContext,
    },
    tabId,
    windowId
  );

  void logTelemetry({
    source: 'system',
    eventType: 'oversight_signal',
    timestamp: stepContextTimestamp,
    payload: {
      ...stepContext,
    },
  });

  emitOversightEvent(
    {
      kind: 'tool_started',
      timestamp: Date.now(),
      stepId,
      toolName,
      toolInput,
      planStepIndex,
      stepDescription,
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
      await renderAttentionOverlay(page, {
        ...attentionTarget,
        thinking: enableThinkingOverlay ? thinking : undefined,
      });
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
    source: 'system',
    eventType: 'state_transition',
    payload: {
      kind: 'step_outcome',
      stepId,
      executed: true,
      blockedByUser: false,
      tabId,
      windowId,
    },
  });

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
    source: 'system',
    eventType: 'state_transition',
    payload: {
      kind: 'step_outcome',
      stepId,
      executed: false,
      blockedByUser: false,
      tabId,
      windowId,
    },
  });

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
  const signalImpact = signal.impact;
  const signalReversible = signal.reversible;
  const signalGoldRisky = signal.gold_risky;
  const signalCategory = signal.category;

  if (signalImpact === 'low' || signalImpact === 'medium' || signalImpact === 'high') {
    emitOversightEvent(
      {
        kind: 'step_context',
        stepId,
        impact: signalImpact,
        reversible: typeof signalReversible === 'boolean' ? signalReversible : true,
        gold_risky: Boolean(signalGoldRisky),
        category: typeof signalCategory === 'string' ? signalCategory : undefined,
      },
      tabId,
      windowId
    );
  }

  emitOversightEvent(
    {
      kind: 'risk_signal',
      timestamp: Date.now(),
      stepId,
      toolName,
      signal,
    },
    tabId,
    windowId
  );

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
  page?: Page;
  stepId: string;
  requestId: string;
  toolName: string;
  toolInput: string;
  reason: string;
  enableAgentFocus?: boolean;
}): Promise<void> {
  const { tabId, windowId, page, stepId, requestId, toolName, toolInput, reason, enableAgentFocus } = args;
  void logTelemetry({
    source: 'system',
    eventType: 'oversight_signal',
    payload: {
      kind: 'intervention_prompted',
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

  if (enableAgentFocus && page) {
    try {
      const target = inferAttentionTarget(toolName, toolInput);
      const actionTitle = describeApprovalAction(toolName, toolInput);
      await renderAttentionOverlay(page, {
        ...target,
        thinking: thinkingByStepId[stepId],
        approval: {
          requestId,
          tabId,
          windowId,
          title: actionTitle,
          message: buildApprovalDecisionCopy({
            actionTitle,
            toolName,
            toolInput,
            thinking: thinkingByStepId[stepId],
          }),
          approveLabel: 'Approve',
          approveSeriesLabel: 'Approve Similar',
          rejectLabel: 'Reject',
        },
      });
    } catch (error) {
      logWithTimestamp(
        `Failed to render approval overlay: ${error instanceof Error ? error.message : String(error)}`,
        'warn'
      );
    }
  }
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
  clearActiveTaskStepContexts();
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
  clearActiveTaskStepContexts();
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
  clearActiveTaskStepContexts();
}
