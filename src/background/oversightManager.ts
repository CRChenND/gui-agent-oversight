import type { Page } from 'playwright-crx';
import type { TaskStepContext } from './types';
import { getOversightSessionManager } from '../oversight/session/sessionManager';
import { getOversightTelemetryLogger } from '../oversight/telemetry/logger';
import type { OversightTelemetryEvent } from '../oversight/telemetry/types';
import type { AgentThinkingSummary, OversightEvent, StepContextEvent } from '../oversight/types';
import { buildContextualRiskExplanation, inferRiskAssessment } from '../oversight/riskAssessment';
import { getOversightRuntimeManager } from '../oversight/runtime/runtimeManager';
import { canAnchorAttentionTargetInViewport, clearAttentionOverlay, inferAttentionTarget, renderAttentionOverlay } from './attentionTracker';
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

function normalizeSentence(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  return /[.!?]$/.test(normalized) ? normalized : `${normalized}.`;
}

export function buildApprovalDecisionCopy(args: {
  actionTitle: string;
  toolName: string;
  toolInput: string;
  thinking?: string;
  stepDescription?: string;
}): string {
  const { actionTitle, toolName, toolInput, thinking, stepDescription } = args;
  const risk = inferRiskAssessment(toolName, toolInput, stepDescription || thinking);
  const riskSentence = buildContextualRiskExplanation({
    toolName,
    toolInput,
    impact: risk.impact,
    reversible: risk.reversible,
    category: risk.category,
    stepDescription:
      stepDescription?.trim() ||
      thinking?.trim() ||
      normalizeSentence(`The agent wants to ${actionTitle.toLowerCase()}`),
  });
  const choiceSentence = 'Approve to let it continue. Reject to pause the agent so you can take over.';
  return `${riskSentence} ${choiceSentence}`;
}

export function buildPlanStepApprovalCopy(planStepNumber: number, planStepText: string): string {
  const stepSentence = normalizeSentence(`Next up is step ${planStepNumber}: ${planStepText}`);
  return `${stepSentence} Approve to let the agent continue with this step. Reject to pause the agent so you can take over.`;
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
  selectedArchetypeId?: string;
}): Promise<void> {
  const {
    tabId,
    windowId,
    page,
    stepId,
    toolName,
    toolInput,
    planStepIndex,
    stepDescription,
    enableAgentFocus,
    thinking,
    enableThinkingOverlay,
    selectedArchetypeId,
  } = args;
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
      const thinkingText = enableThinkingOverlay ? thinking : undefined;
      let overlayTarget = {
        ...attentionTarget,
        thinking: thinkingText,
      };

      if (selectedArchetypeId === 'risk-gated') {
        const canAnchor = await canAnchorAttentionTargetInViewport(page, attentionTarget);
        if (!canAnchor) {
          overlayTarget = {
            type: 'none',
            label: attentionTarget.label,
            thinking: thinkingText,
          };
        }
      }

      await renderAttentionOverlay(page, overlayTarget);
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
            stepDescription: thinkingByStepId[stepId],
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
