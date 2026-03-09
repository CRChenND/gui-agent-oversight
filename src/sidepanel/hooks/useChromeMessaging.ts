import { useEffect } from 'react';
import type { OversightEvent } from '../../oversight/types';
import type { AuthorityState, ExecutionPhase, ExecutionState, OversightRegime } from '../../oversight/runtime/types';
import { ChromeMessage } from '../types';

interface UseChromeMessagingProps {
  tabId: number | null;
  windowId?: number | null;
  onUpdateOutput: (content: any) => void;
  onUpdateStreamingChunk: (content: any) => void;
  onFinalizeStreamingSegment: (id: number, content: string) => void;
  onStartNewSegment: (id: number) => void;
  onStreamingComplete: () => void;
  onUpdateLlmOutput: (content: string) => void;
  onRateLimit: () => void;
  onFallbackStarted: (message: string) => void;
  onUpdateScreenshot: (content: any) => void;
  onProcessingComplete: () => void;
  onRequestApproval?: (request: {
    requestId: string;
    stepId?: string;
    toolName: string;
    toolInput: string;
    reason: string;
    approvalVariant?: 'default' | 'action-confirmation' | 'supervisory' | 'supervisory-plan-step';
    planStepIndex?: number;
  }) => void;
  onApprovalResolved?: (payload: { requestId: string; approved: boolean }) => void;
  setTabTitle: (title: string) => void;
  onTabStatusChanged?: (status: 'attached' | 'detached' | 'running' | 'idle' | 'error', tabId: number) => void;
  onTargetCreated?: (tabId: number, targetInfo: any) => void;
  onTargetDestroyed?: (tabId: number, url: string) => void;
  onTargetChanged?: (tabId: number, url: string) => void;
  onActiveTabChanged?: (oldTabId: number, newTabId: number, title: string, url: string) => void;
  onPageDialog?: (tabId: number, dialogInfo: any) => void;
  onPageConsole?: (tabId: number, consoleInfo: any) => void;
  onPageError?: (tabId: number, error: string) => void;
  onAgentStatusUpdate?: (status: string, lastHeartbeat: number) => void;
  onAttentionUpdate?: (content: any) => void;
  onOversightEvent?: (event: OversightEvent) => void;
  onRuntimeStateUpdate?: (status: {
    authorityState: AuthorityState;
    executionPhase: ExecutionPhase;
    executionState: ExecutionState;
    regime: OversightRegime;
    amplification?: {
      state: 'normal' | 'amplified';
      enteredAt?: number;
      enteredReason?: 'pause_resume_rapid' | 'inspect_plan' | 'rapid_trace_inspection';
      entryCount: number;
    };
    softPause?: {
      active: boolean;
      startedAt: number;
      endsAt: number;
      timeoutMs: number;
      stepId?: string;
      toolName?: string;
    };
    deliberation?: {
      score: number;
      lastSignalTimestamp: number;
      sustainedDurationMs: number;
      isDeliberative: boolean;
    };
    runtimePolicy?: {
      monitoringContentScope: 'minimal' | 'standard' | 'full';
      explanationAvailability: 'none' | 'summary' | 'full';
      userActionOptions: 'basic' | 'extended';
      persistenceMs: number;
      tightenHighImpactAuthority: boolean;
    };
    updatedAt?: number;
  }) => void;
  onPlanReviewRequired?: (payload: {
    planSummary: string;
    plan?: string[];
    stepId?: string;
    toolName?: string;
    toolInput?: string;
  }) => void;
}

export const useChromeMessaging = ({
  tabId,
  windowId,
  onUpdateOutput,
  onUpdateStreamingChunk,
  onFinalizeStreamingSegment,
  onStartNewSegment,
  onStreamingComplete,
  onUpdateLlmOutput,
  onRateLimit,
  onFallbackStarted,
  onUpdateScreenshot,
  onProcessingComplete,
  onRequestApproval,
  onApprovalResolved,
  setTabTitle,
  onTabStatusChanged,
  onTargetCreated,
  onTargetDestroyed,
  onTargetChanged,
  onActiveTabChanged,
  onPageDialog,
  onPageConsole,
  onPageError,
  onAgentStatusUpdate,
  onAttentionUpdate,
  onOversightEvent,
  onRuntimeStateUpdate,
  onPlanReviewRequired
}: UseChromeMessagingProps) => {

  // Listen for updates from the background script
  useEffect(() => {
    const messageListener = (message: ChromeMessage, sender: chrome.runtime.MessageSender, sendResponse: (response?: any) => void) => {
      // Only process messages intended for this tab and window
      // If the message has a tabId, check if it matches this tab's ID
      // If the message has a windowId, check if it matches this window's ID
      // If the message doesn't have a tabId or windowId, process it (for backward compatibility)
      if ((message.tabId && message.tabId !== tabId) ||
          (message.windowId && windowId && message.windowId !== windowId)) {
        return false; // Skip messages for other tabs or windows
      }

      if (message.action === 'updateOutput') {
        // For complete messages (system messages or non-streaming LLM output)
        onUpdateOutput(message.content);

        // Check if this is a system message about tab connection
        if (message.content?.type === 'system' &&
            typeof message.content.content === 'string' &&
            message.content.content.startsWith('Connected to tab:')) {
          // Extract the tab title from the message
          const titleMatch = message.content.content.match(/Connected to tab: (.+)/);
          if (titleMatch && titleMatch[1]) {
            setTabTitle(titleMatch[1]);
          }
        }
      } else if (message.action === 'updateStreamingChunk') {
        // For streaming chunks
        onUpdateStreamingChunk(message.content);
      } else if (message.action === 'finalizeStreamingSegment') {
        // Finalize a streaming segment
        const { id, content } = message.content;
        onFinalizeStreamingSegment(id, content);
      } else if (message.action === 'startNewSegment') {
        // Start a new streaming segment
        const { id } = message.content;
        onStartNewSegment(id);
      } else if (message.action === 'streamingComplete') {
        // When streaming is complete
        onStreamingComplete();
      } else if (message.action === 'updateLlmOutput') {
        // Handle legacy format for backward compatibility
        onUpdateLlmOutput(message.content);
      } else if (message.action === 'rateLimit') {
        // Handle rate limit notification
        onRateLimit();
      } else if (message.action === 'fallbackStarted') {
        // Handle fallback notification
        onFallbackStarted(message.content?.message || "Switching to fallback mode. Processing continues...");
      } else if (message.action === 'updateScreenshot') {
        // Handle screenshot messages
        onUpdateScreenshot(message.content);
      } else if (message.action === 'processingComplete') {
        onProcessingComplete();
      } else if (message.action === 'oversightEvent' && onOversightEvent && message.content?.event) {
        onOversightEvent(message.content.event);
      } else if (message.action === 'runtimeStateUpdate' && onRuntimeStateUpdate && message.content) {
        const payload = message.content;
        if (
          (payload.authorityState === 'agent_autonomous' ||
            payload.authorityState === 'shared_supervision' ||
            payload.authorityState === 'human_control') &&
          (payload.executionPhase === 'planning' ||
            payload.executionPhase === 'plan_review' ||
            payload.executionPhase === 'execution' ||
            payload.executionPhase === 'posthoc_review' ||
            payload.executionPhase === 'terminated') &&
          (payload.executionState === 'running' ||
            payload.executionState === 'paused_by_user' ||
            payload.executionState === 'paused_by_system' ||
            payload.executionState === 'paused_by_system_soft' ||
            payload.executionState === 'cancelled' ||
            payload.executionState === 'completed') &&
          (payload.regime === 'baseline' || payload.regime === 'deliberative_escalated')
        ) {
          onRuntimeStateUpdate({
            authorityState: payload.authorityState,
            executionPhase: payload.executionPhase,
            executionState: payload.executionState,
            regime: payload.regime,
            amplification:
              payload.amplification && typeof payload.amplification === 'object'
                ? {
                    state: payload.amplification.state === 'amplified' ? 'amplified' : 'normal',
                    enteredAt:
                      typeof payload.amplification.enteredAt === 'number' ? payload.amplification.enteredAt : undefined,
                    enteredReason:
                      payload.amplification.enteredReason === 'pause_resume_rapid' ||
                      payload.amplification.enteredReason === 'inspect_plan' ||
                      payload.amplification.enteredReason === 'rapid_trace_inspection'
                        ? payload.amplification.enteredReason
                        : undefined,
                    entryCount: Math.max(0, Number(payload.amplification.entryCount || 0)),
                  }
                : undefined,
            softPause:
              payload.softPause && typeof payload.softPause === 'object'
                ? {
                    active: Boolean(payload.softPause.active),
                    startedAt: Number(payload.softPause.startedAt || Date.now()),
                    endsAt: Number(payload.softPause.endsAt || Date.now()),
                    timeoutMs: Math.max(0, Number(payload.softPause.timeoutMs || 0)),
                    stepId: typeof payload.softPause.stepId === 'string' ? payload.softPause.stepId : undefined,
                    toolName: typeof payload.softPause.toolName === 'string' ? payload.softPause.toolName : undefined,
                  }
                : undefined,
            deliberation:
              payload.deliberation && typeof payload.deliberation === 'object'
                ? {
                    score: Number(payload.deliberation.score || 0),
                    lastSignalTimestamp: Number(payload.deliberation.lastSignalTimestamp || 0),
                    sustainedDurationMs: Number(payload.deliberation.sustainedDurationMs || 0),
                    isDeliberative: Boolean(payload.deliberation.isDeliberative),
                  }
                : undefined,
            runtimePolicy:
              payload.runtimePolicy && typeof payload.runtimePolicy === 'object'
                ? {
                    monitoringContentScope:
                      payload.runtimePolicy.monitoringContentScope === 'minimal' ||
                      payload.runtimePolicy.monitoringContentScope === 'standard' ||
                      payload.runtimePolicy.monitoringContentScope === 'full'
                        ? payload.runtimePolicy.monitoringContentScope
                        : 'standard',
                    explanationAvailability:
                      payload.runtimePolicy.explanationAvailability === 'none' ||
                      payload.runtimePolicy.explanationAvailability === 'summary' ||
                      payload.runtimePolicy.explanationAvailability === 'full'
                        ? payload.runtimePolicy.explanationAvailability
                        : 'summary',
                    userActionOptions: payload.runtimePolicy.userActionOptions === 'extended' ? 'extended' : 'basic',
                    persistenceMs: Math.max(0, Number(payload.runtimePolicy.persistenceMs || 0)),
                    tightenHighImpactAuthority: Boolean(payload.runtimePolicy.tightenHighImpactAuthority),
                  }
                : undefined,
            updatedAt: typeof payload.updatedAt === 'number' ? payload.updatedAt : Date.now(),
          });
        }
      } else if (message.action === 'planReviewRequired' && onPlanReviewRequired && message.content) {
        const payload = message.content;
        onPlanReviewRequired({
          planSummary: typeof payload.planSummary === 'string' ? payload.planSummary : 'Plan generated.',
          plan: Array.isArray(payload.plan) ? payload.plan.filter((v: unknown) => typeof v === 'string') : undefined,
          stepId: typeof payload.stepId === 'string' ? payload.stepId : undefined,
          toolName: typeof payload.toolName === 'string' ? payload.toolName : undefined,
          toolInput: typeof payload.toolInput === 'string' ? payload.toolInput : undefined,
        });
      } else if (message.action === 'attentionUpdate' && onAttentionUpdate) {
        onAttentionUpdate(message.content);
      } else if (message.action === 'attentionUpdate' && onOversightEvent && message.content) {
        const content = message.content;
        if (content.state === 'active' && typeof content.toolName === 'string') {
          onOversightEvent({
            kind: 'tool_started',
            timestamp: typeof content.timestamp === 'number' ? content.timestamp : Date.now(),
            stepId:
              typeof content.stepId === 'string'
                ? content.stepId
                : `legacy_step_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            toolName: content.toolName,
            toolInput: typeof content.toolInput === 'string' ? content.toolInput : '',
            planStepIndex: typeof content.planStepIndex === 'number' ? content.planStepIndex : undefined,
            stepDescription: typeof content.stepDescription === 'string' ? content.stepDescription : undefined,
            focusType: content.focusType || 'none',
            focusLabel: typeof content.focusLabel === 'string' ? content.focusLabel : 'Focus updated'
          });
        } else {
          onOversightEvent({
            kind: 'run_completed',
            timestamp: typeof content.timestamp === 'number' ? content.timestamp : Date.now(),
            focusLabel: typeof content.focusLabel === 'string' ? content.focusLabel : 'Task completed'
          });
        }
      } else if (message.action === 'requestApproval') {
        // Handle approval requests
        // Check if the fields exist rather than if they're truthy
        // This allows empty strings for toolInput which is valid in some cases
        if ('requestId' in message &&
            'toolName' in message &&
            'toolInput' in message &&
            typeof message.requestId === 'string' &&
            typeof message.toolName === 'string' &&
            typeof message.toolInput === 'string') {

          if (onRequestApproval) {
            onRequestApproval({
              requestId: message.requestId,
              stepId: typeof message.stepId === 'string' ? message.stepId : undefined,
              toolName: message.toolName,
              toolInput: message.toolInput,
              reason: message.reason || 'This action requires approval.',
              planStepIndex: typeof message.planStepIndex === 'number' ? message.planStepIndex : undefined,
              approvalVariant:
                message.approvalVariant === 'action-confirmation' ||
                message.approvalVariant === 'supervisory' ||
                message.approvalVariant === 'supervisory-plan-step'
                  ? message.approvalVariant
                  : 'default',
            });
          } else {
            console.error('onRequestApproval handler is not defined, cannot process approval request');
          }

          // Send a response to keep the message channel open
          sendResponse({ success: true });
          return true; // Keep the message channel open for async response
        } else {
          console.warn('Received incomplete requestApproval message');
          sendResponse({ success: false, error: 'Incomplete approval request' });
        }
      } else if (
        message.action === 'approvalResolved' &&
        onApprovalResolved &&
        typeof message.content?.requestId === 'string' &&
        typeof message.content?.approved === 'boolean'
      ) {
        onApprovalResolved({
          requestId: message.content.requestId,
          approved: message.content.approved,
        });
      }
      else if (message.action === 'tabStatusChanged' && onTabStatusChanged && message.status && message.tabId) {
        onTabStatusChanged(message.status, message.tabId);
      } else if (message.action === 'targetCreated' && onTargetCreated && message.tabId && message.targetInfo) {
        onTargetCreated(message.tabId, message.targetInfo);
      } else if (message.action === 'targetDestroyed' && onTargetDestroyed && message.tabId && message.url) {
        onTargetDestroyed(message.tabId, message.url);
      } else if (message.action === 'targetChanged' && onTargetChanged && message.tabId && message.url) {
        onTargetChanged(message.tabId, message.url);
      } else if (message.action === 'activeTabChanged' && message.oldTabId && message.newTabId) {
        // Special handling for active tab changed message
        // This message is sent when the agent switches tabs
        console.log(`Active tab changed from ${message.oldTabId} to ${message.newTabId}`);

        // Update the UI's tabId state by sending a special message to SidePanel
        chrome.runtime.sendMessage({
          action: 'updateActiveTab',
          oldTabId: message.oldTabId,
          newTabId: message.newTabId,
          title: message.title || 'Unknown Tab',
          url: message.url || 'about:blank'
        });

        // If there's a callback for this event, call it
        if (onActiveTabChanged) {
          onActiveTabChanged(
            message.oldTabId,
            message.newTabId,
            message.title || 'Unknown Tab',
            message.url || 'about:blank'
          );
        }

        // Update the tab title in the UI
        if (setTabTitle && message.title) {
          setTabTitle(message.title);
        }
      } else if (message.action === 'tabTitleChanged' && setTabTitle && message.title) {
        setTabTitle(message.title);
      } else if (message.action === 'pageDialog' && onPageDialog && message.tabId && message.dialogInfo) {
        onPageDialog(message.tabId, message.dialogInfo);
      } else if (message.action === 'pageConsole' && onPageConsole && message.tabId && message.consoleInfo) {
        onPageConsole(message.tabId, message.consoleInfo);
      } else if (message.action === 'pageError' && onPageError && message.tabId && message.error) {
        onPageError(message.tabId, message.error);
      } else if (message.action === 'agentStatusUpdate' && message.status && message.lastHeartbeat) {
        // Handle agent status update
        if (onAgentStatusUpdate) {
          onAgentStatusUpdate(message.status, message.lastHeartbeat);
        } else {
          // If no explicit handler, use onRateLimit to keep UI in processing mode if agent is running
          if (message.status === 'running' && onRateLimit) {
            onRateLimit();
          }
        }
      }

      // Send a response for any message that doesn't explicitly return true
      sendResponse({ success: true });
      return false; // Don't keep the message channel open by default
    };

    chrome.runtime.onMessage.addListener(messageListener);
    return () => chrome.runtime.onMessage.removeListener(messageListener);
  }, [
    tabId,
    windowId,
    onUpdateOutput,
    onUpdateStreamingChunk,
    onFinalizeStreamingSegment,
    onStartNewSegment,
    onStreamingComplete,
    onUpdateLlmOutput,
    onRateLimit,
    onFallbackStarted,
    onUpdateScreenshot,
    onProcessingComplete,
    onRequestApproval,
    onApprovalResolved,
    setTabTitle,
    onTabStatusChanged,
    onTargetCreated,
    onTargetDestroyed,
    onTargetChanged,
    onActiveTabChanged,
    onPageDialog,
    onPageConsole,
    onPageError,
    onAgentStatusUpdate,
    onAttentionUpdate,
    onOversightEvent,
    onRuntimeStateUpdate,
    onPlanReviewRequired
  ]);

  const executePrompt = (prompt: string) => {
    return new Promise<void>((resolve, reject) => {
      try {
        // Send message to background script with tab ID
        chrome.runtime.sendMessage({
          action: 'executePrompt',
          prompt,
          tabId,
          windowId
        }, () => {
          const lastError = chrome.runtime.lastError;
          if (lastError) {
            console.error(lastError);
            reject(lastError);
            return;
          }
          resolve();
        });
      } catch (error) {
        console.error('Error:', error);
        reject(error);
      }
    });
  };

  const cancelExecution = () => {
    chrome.runtime.sendMessage({
      action: 'cancelExecution',
      tabId,
      windowId
    }, () => {
      if (chrome.runtime.lastError) {
        console.error(chrome.runtime.lastError);
      }
    });
  };

  const clearHistory = () => {
    chrome.runtime.sendMessage({
      action: 'clearHistory',
      tabId,
      windowId
    });
  };

  const approveRequest = (requestId: string, approvalMode: 'once' | 'series' | 'site' = 'once') => {
    chrome.runtime.sendMessage({
      action: 'approvalResponse',
      requestId,
      approved: true,
      approvalMode,
      tabId,
      windowId
    }, (_response) => {
      if (chrome.runtime.lastError) {
        console.error('Error sending approval response:', chrome.runtime.lastError);
      }
    });
  };

  const rejectRequest = (requestId: string) => {
    chrome.runtime.sendMessage({
      action: 'approvalResponse',
      requestId,
      approved: false,
      tabId,
      windowId
    }, (_response) => {
      if (chrome.runtime.lastError) {
        console.error('Error sending rejection response:', chrome.runtime.lastError);
      }
    });
  };

  const pauseExecution = () => {
    chrome.runtime.sendMessage({ action: 'pauseExecution', tabId, windowId });
  };

  const resumeExecution = () => {
    chrome.runtime.sendMessage({ action: 'resumeExecution', tabId, windowId });
  };

  const takeoverAuthority = () => {
    chrome.runtime.sendMessage({ action: 'takeoverAuthority', tabId, windowId });
  };

  const releaseControl = () => {
    chrome.runtime.sendMessage({ action: 'releaseControl', tabId, windowId });
  };

  const resolveEscalation = () => {
    chrome.runtime.sendMessage({ action: 'resolveEscalation', tabId, windowId });
  };

  const submitPlanReviewDecision = (decision: 'approve' | 'edit' | 'reject', editedPlan?: string) => {
    chrome.runtime.sendMessage({
      action: 'planReviewDecision',
      tabId,
      windowId,
      decision,
      editedPlan,
    });
  };

  const updateApprovedPlan = async (editedPlan: string) => {
    return chrome.runtime.sendMessage({
      action: 'updateApprovedPlan',
      tabId,
      windowId,
      editedPlan,
    });
  };

  const runtimeInteractionSignal = (
    signal:
      | 'pause_by_user'
      | 'resume_by_user'
      | 'inspect_plan'
      | 'takeover'
      | 'expand_trace_node'
      | 'hover_risk_label'
      | 'open_oversight_tab'
      | 'edit_intermediate_output'
      | 'repeated_scroll_backward'
      | 'repeated_trace_expansion',
    durationMs?: number
  ) => {
    chrome.runtime.sendMessage({
      action: 'runtimeInteractionSignal',
      tabId,
      windowId,
      signal,
      durationMs,
    });
  };

  const submitSoftPauseDecision = (decision: 'continue_now' | 'pause') => {
    chrome.runtime.sendMessage({
      action: 'softPauseDecision',
      tabId,
      windowId,
      decision,
    });
  };

  const exitAmplifiedMode = () => {
    chrome.runtime.sendMessage({
      action: 'exitAmplifiedMode',
      tabId,
      windowId,
    });
  };

  const assessPlanProgress = async (payload: {
    planSteps: string[];
    agentSteps: Array<{
      index: number;
      status: 'active' | 'completed' | 'cancelled' | 'error';
      toolName: string;
      focusLabel: string;
      thinking?: string;
    }>;
  }): Promise<{
    completedCount: number;
    currentStepNumber: number;
    isFullyCompleted: boolean;
    steps: Array<{ status: 'completed' | 'current' | 'pending'; reason: string }>;
  }> => {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        {
          action: 'assessPlanProgress',
          tabId,
          windowId,
          planSteps: payload.planSteps,
          agentSteps: payload.agentSteps,
        },
        (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (!response?.success || !response.assessment) {
            reject(new Error(response?.error || 'Failed to assess plan progress'));
            return;
          }
          resolve(response.assessment);
        }
      );
    });
  };

  return {
    executePrompt,
    cancelExecution,
    clearHistory,
    approveRequest,
    rejectRequest,
    pauseExecution,
    resumeExecution,
    takeoverAuthority,
    releaseControl,
    resolveEscalation,
    submitSoftPauseDecision,
    exitAmplifiedMode,
    submitPlanReviewDecision,
    updateApprovedPlan,
    runtimeInteractionSignal,
    assessPlanProgress,
  };
};
