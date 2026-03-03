import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ConfigManager } from '../background/configManager';
import type { AuthorityState, ExecutionPhase, ExecutionState, OversightRegime } from '../oversight/runtime/types';
import {
  AGENT_FOCUS_MECHANISM_ID,
  INTERVENTION_GATE_MECHANISM_ID,
  MONITORING_MECHANISM_ID,
  TASK_GRAPH_MECHANISM_ID,
  createDefaultOversightParameterSettings,
  createDefaultOversightMechanismSettings,
  getOversightParameterStorageQueryDefaults,
  getOversightStorageQueryDefaults,
  mapStorageToOversightParameterSettings,
  mapStorageToOversightSettings,
} from '../oversight/registry';
import { AgentAttentionBar } from './components/AgentAttentionBar';
import { ApprovalRequest } from './components/ApprovalRequest';
import { MessageDisplay } from './components/MessageDisplay';
import { OutputHeader } from './components/OutputHeader';
import { PromptForm } from './components/PromptForm';
import { ProviderSelector } from './components/ProviderSelector';
import { TaskExecutionGraph } from './components/TaskExecutionGraph';
import { useChromeMessaging } from './hooks/useChromeMessaging';
import { useMessageManagement } from './hooks/useMessageManagement';
import { useOversightMechanisms } from './hooks/useOversightMechanisms';
import { useTabManagement } from './hooks/useTabManagement';

export function SidePanel() {
  const [activePanel, setActivePanel] = useState<'conversation' | 'oversight'>('conversation');
  const [mechanismSettings, setMechanismSettings] = useState(createDefaultOversightMechanismSettings);
  const [mechanismParameterSettings, setMechanismParameterSettings] = useState(createDefaultOversightParameterSettings);

  // State for tab status
  const [tabStatus, setTabStatus] = useState<'attached' | 'detached' | 'unknown' | 'running' | 'idle' | 'error'>('unknown');

  // State for approval requests
  const [approvalRequests, setApprovalRequests] = useState<Array<{
    requestId: string;
    stepId?: string;
    toolName: string;
    toolInput: string;
    reason: string;
  }>>([]);
  const [haltReason, setHaltReason] = useState<string | null>(null);
  const [runtimeStatus, setRuntimeStatus] = useState<{
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
  }>({
    authorityState: 'agent_autonomous',
    executionPhase: 'planning',
    executionState: 'running',
    regime: 'baseline',
    amplification: {
      state: 'normal',
      entryCount: 0,
    },
  });
  const [planReviewRequest, setPlanReviewRequest] = useState<{
    planSummary: string;
    plan?: string[];
    stepId?: string;
    toolName?: string;
    toolInput?: string;
  } | null>(null);
  const [approvedPlan, setApprovedPlan] = useState<{
    summary: string;
    steps: string[];
  } | null>(null);
  const [inspectPlanProgress, setInspectPlanProgress] = useState<{
    completedCount: number;
    currentStepNumber: number;
    isFullyCompleted: boolean;
    steps: Array<{ status: 'completed' | 'current' | 'pending'; reason: string }>;
  } | null>(null);
  const [inspectPlanLoading, setInspectPlanLoading] = useState(false);
  const [inspectPlanError, setInspectPlanError] = useState<string | null>(null);
  const [showInspectPlanModal, setShowInspectPlanModal] = useState(false);
  const [isEditingPlan, setIsEditingPlan] = useState(false);
  const [editedPlanSteps, setEditedPlanSteps] = useState<string[]>([]);
  const [showApprovalOverlay, setShowApprovalOverlay] = useState(true);
  const [softPauseNow, setSoftPauseNow] = useState(Date.now());
  const lastApprovalPromptTsRef = useRef(0);
  const approvalPromptWindowRef = useRef<number[]>([]);

  // State to track if any LLM providers are configured
  const [hasConfiguredProviders, setHasConfiguredProviders] = useState<boolean>(false);
  // Check if any providers are configured when component mounts
  useEffect(() => {
    const checkProviders = async () => {
      const configManager = ConfigManager.getInstance();
      const providers = await configManager.getConfiguredProviders();
      setHasConfiguredProviders(providers.length > 0);
    };
    const loadFeatureFlags = async () => {
      const result = await chrome.storage.sync.get({
        ...getOversightStorageQueryDefaults(),
        ...getOversightParameterStorageQueryDefaults(),
      });
      setMechanismSettings(mapStorageToOversightSettings(result as Record<string, unknown>));
      setMechanismParameterSettings(mapStorageToOversightParameterSettings(result as Record<string, unknown>));
    };
    checkProviders();
    loadFeatureFlags();

    // Listen for provider configuration changes
    const handleMessage = (message: any) => {
      if (message.action === 'providerConfigChanged') {
        checkProviders();
        loadFeatureFlags();
      }
    };

    chrome.runtime.onMessage.addListener(handleMessage);

    return () => {
      chrome.runtime.onMessage.removeListener(handleMessage);
    };
  }, []);

  // Use custom hooks to manage state and functionality
  const {
    tabId,
    windowId,
    setTabTitle
  } = useTabManagement();

  const {
    messages,
    streamingSegments,
    isStreaming,
    isProcessing,
    setIsProcessing,
    outputRef,
    addMessage,
    addSystemMessage,
    updateStreamingChunk,
    finalizeStreamingSegment,
    startNewSegment,
    completeStreaming,
    clearMessages,
    currentSegmentId
  } = useMessageManagement();

  const stripToolCallMarkup = (text: string): string => {
    if (!text) return '';
    const stripped = text
      .replace(/(```(?:xml|bash)\s*)?<tool>[\s\S]*?<\/requires_approval>(\s*```)?/g, '')
      .trim();
    return stripped;
  };

  const getLatestThinking = (): string => {
    const currentStreaming = stripToolCallMarkup(streamingSegments[currentSegmentId] || '');
    if (currentStreaming) {
      return currentStreaming.slice(-400);
    }

    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].type !== 'llm') continue;
      const cleaned = stripToolCallMarkup(messages[i].content || '');
      if (cleaned) return cleaned.slice(-400);
    }

    return '';
  };

  const {
    taskNodes,
    agentFocus,
    handleOversightEvent,
    logHumanTelemetry,
    resetRunState,
    clearOversightState,
  } = useOversightMechanisms({
    mechanismSettings,
    mechanismParameterSettings,
    getLatestThinking,
  });

  const enableAgentFocus = mechanismSettings[AGENT_FOCUS_MECHANISM_ID];
  const enableTaskGraph = mechanismSettings[TASK_GRAPH_MECHANISM_ID];
  const monitoringParams = mechanismParameterSettings[MONITORING_MECHANISM_ID] || {};
  const interventionParams = mechanismParameterSettings[INTERVENTION_GATE_MECHANISM_ID] || {};
  const taskGraphParams = mechanismParameterSettings[TASK_GRAPH_MECHANISM_ID] || {};
  const runtimePolicy = runtimeStatus.runtimePolicy;
  const storedMonitoringContentScope =
    monitoringParams.monitoringContentScope === 'minimal' ||
    monitoringParams.monitoringContentScope === 'standard' ||
    monitoringParams.monitoringContentScope === 'full'
      ? monitoringParams.monitoringContentScope
      : 'full';
  const storedExplanationAvailability =
    monitoringParams.explanationAvailability === 'none' ||
    monitoringParams.explanationAvailability === 'summary' ||
    monitoringParams.explanationAvailability === 'full'
      ? monitoringParams.explanationAvailability
      : 'summary';
  const monitoringContentScope =
    runtimePolicy?.monitoringContentScope ?? storedMonitoringContentScope;
  const explanationAvailability =
    runtimePolicy?.explanationAvailability ?? storedExplanationAvailability;
  const explanationFormat =
    monitoringParams.explanationFormat === 'text' ||
    monitoringParams.explanationFormat === 'snippet' ||
    monitoringParams.explanationFormat === 'diff'
      ? monitoringParams.explanationFormat
      : 'text';
  const notificationModality =
    monitoringParams.notificationModality === 'badge' ||
    monitoringParams.notificationModality === 'modal' ||
    monitoringParams.notificationModality === 'mixed'
      ? monitoringParams.notificationModality
      : 'mixed';
  const feedbackLatencyMs = Math.max(0, Number(monitoringParams.feedbackLatencyMs || 0));
  const persistenceMs = Math.max(0, Number(runtimePolicy?.persistenceMs ?? monitoringParams.persistenceMs ?? 0));
  const contentGranularity =
    taskGraphParams.contentGranularity === 'task' ||
    taskGraphParams.contentGranularity === 'step' ||
    taskGraphParams.contentGranularity === 'substep'
      ? taskGraphParams.contentGranularity
      : 'step';
  const informationDensity =
    taskGraphParams.informationDensity === 'compact' ||
    taskGraphParams.informationDensity === 'balanced' ||
    taskGraphParams.informationDensity === 'detailed'
      ? taskGraphParams.informationDensity
      : 'balanced';
  const colorEncoding =
    taskGraphParams.colorEncoding === 'semantic' ||
    taskGraphParams.colorEncoding === 'monochrome' ||
    taskGraphParams.colorEncoding === 'high_contrast'
      ? taskGraphParams.colorEncoding
      : 'semantic';
  const interruptCooldownMs = Math.max(0, Number(interventionParams.interruptCooldownMs || 0));
  const interruptTopK = Math.max(1, Number(interventionParams.interruptTopK || 999));
  const approvedPlanSteps = approvedPlan?.steps || [];

  const handleDownloadTaskGraph = useCallback(() => {
    if (taskNodes.length === 0) return;

    const exportData = {
      exportedAt: Date.now(),
      stepCount: taskNodes.length,
      steps: taskNodes.map((node, index) => ({
        index: index + 1,
        stepId: node.stepId,
        toolName: node.toolName,
        focusLabel: node.focusLabel,
        thinking: node.thinking || '',
        status: node.status,
        timestamp: node.timestamp,
      })),
    };

    const json = JSON.stringify(exportData, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `task-graph-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }, [taskNodes]);

  // Heartbeat interval for checking agent status
  useEffect(() => {
    if (!isProcessing) return;

    const interval = setInterval(() => {
      // Request agent status
      chrome.runtime.sendMessage({
        action: 'checkAgentStatus',
        tabId,
        windowId
      });
    }, 2000); // Check every 2 seconds

    return () => clearInterval(interval);
  }, [isProcessing, tabId, windowId]);

  // Handlers for approval requests
  const handleApprove = (requestId: string) => {
    const request = approvalRequests.find((req) => req.requestId === requestId);
    const stepId = request?.stepId || requestId;
    void logHumanTelemetry('human_intervention', {
      action: 'approval_accepted',
      requestId,
      stepId,
      toolName: request?.toolName,
      toolInput: request?.toolInput,
      reason: request?.reason,
    });
    void logHumanTelemetry('human_intervention', {
      action: 'override_performed',
      requestId,
      stepId,
      toolName: request?.toolName,
      toolInput: request?.toolInput,
    });
    void logHumanTelemetry('oversight_signal', {
      kind: 'intervention_decision',
      stepId,
      decision: 'approve',
    });
    handleOversightEvent({
      kind: 'intervention_decision',
      stepId,
      decision: 'approve',
    });

    // Send approval to the background script
    approveRequest(requestId);
    // Remove the request from the list
    setApprovalRequests(prev => prev.filter(req => req.requestId !== requestId));
    // Add a system message to indicate approval
    addSystemMessage(`✅ Approved action: ${requestId}`);
    setHaltReason(null);
  };

  const handleReject = (requestId: string) => {
    const request = approvalRequests.find((req) => req.requestId === requestId);
    const stepId = request?.stepId || requestId;
    void logHumanTelemetry('human_intervention', {
      action: 'approval_rejected',
      requestId,
      stepId,
      toolName: request?.toolName,
      toolInput: request?.toolInput,
      reason: request?.reason,
    });
    void logHumanTelemetry('oversight_signal', {
      kind: 'intervention_decision',
      stepId,
      decision: 'deny',
    });
    void logHumanTelemetry('state_transition', {
      kind: 'step_outcome',
      stepId,
      executed: false,
      blockedByUser: true,
    });
    handleOversightEvent({
      kind: 'intervention_decision',
      stepId,
      decision: 'deny',
    });

    // Send rejection to the background script
    rejectRequest(requestId);
    // Remove the request from the list
    setApprovalRequests(prev => prev.filter(req => req.requestId !== requestId));
    // Add a system message to indicate rejection
    addSystemMessage(`❌ Rejected action: ${requestId}`);
  };

  const sendApprovalDecision = useCallback((requestId: string, approved: boolean) => {
    chrome.runtime.sendMessage({
      action: 'approvalResponse',
      requestId,
      approved,
      tabId: tabId || undefined,
      windowId: windowId || undefined,
    });
  }, [tabId, windowId]);

  const handleDismissWarning = (requestId: string) => {
    const request = approvalRequests.find((req) => req.requestId === requestId);
    const stepId = request?.stepId || requestId;
    void logHumanTelemetry('human_monitoring', {
      action: 'warning_dismissed',
      requestId,
      stepId,
      toolName: request?.toolName,
      toolInput: request?.toolInput,
      reason: request?.reason,
    });
    void logHumanTelemetry('oversight_signal', {
      kind: 'intervention_decision',
      stepId,
      decision: 'deny',
    });
    void logHumanTelemetry('state_transition', {
      kind: 'step_outcome',
      stepId,
      executed: false,
      blockedByUser: true,
    });
    handleOversightEvent({
      kind: 'intervention_decision',
      stepId,
      decision: 'deny',
    });

    // Dismissing a pending approval also rejects it to avoid blocking execution.
    sendApprovalDecision(requestId, false);
    setApprovalRequests(prev => prev.filter(req => req.requestId !== requestId));
    addSystemMessage(`⚠️ Dismissed warning: ${requestId} (auto-rejected)`);
  };

  // Set up Chrome messaging with callbacks
  const {
    executePrompt,
    cancelExecution,
    clearHistory,
    approveRequest,
    rejectRequest,
    pauseExecution,
    resumeExecution,
    submitSoftPauseDecision,
    exitAmplifiedMode,
    submitPlanReviewDecision,
    runtimeInteractionSignal,
    assessPlanProgress,
  } = useChromeMessaging({
    tabId,
    windowId,
    onUpdateOutput: (content) => {
      if (content?.type === 'system' &&
          typeof content.content === 'string' &&
          content.content.startsWith('🕹️ tool:')) {
        return;
      }
      if (typeof content?.content === 'string' && content.content.includes('Execution stopped by post-action review policy')) {
        setHaltReason('Stopped by post-action review policy');
      }
      addMessage({ ...content, isComplete: true });
    },
    onUpdateStreamingChunk: (content) => {
      updateStreamingChunk(content.content);
    },
    onFinalizeStreamingSegment: (id, content) => {
      finalizeStreamingSegment(id, content);
    },
    onStartNewSegment: (id) => {
      startNewSegment(id);
    },
    onStreamingComplete: () => {
      completeStreaming();
    },
    onUpdateLlmOutput: (content) => {
      addMessage({ type: 'llm', content, isComplete: true });
    },
    onRateLimit: () => {
      addSystemMessage("⚠️ Rate limit reached. Retrying automatically...");
      // Ensure the UI stays in processing mode
      setIsProcessing(true);
      // Update the tab status to running
      setTabStatus('running');
    },
    onFallbackStarted: (message) => {
      addSystemMessage(message);
      // Ensure the UI stays in processing mode
      setIsProcessing(true);
      // Update the tab status to running
      setTabStatus('running');
    },
    onUpdateScreenshot: (content) => {
      addMessage({ ...content, isComplete: true });
    },
    onProcessingComplete: () => {
      setIsProcessing(false);
      completeStreaming();
      // Also update the tab status to idle to ensure the UI indicator changes
      setTabStatus('idle');
    },
    onRequestApproval: (request) => {
      const now = Date.now();
      approvalPromptWindowRef.current = approvalPromptWindowRef.current.filter((ts) => now - ts < 60000);

      if (approvalPromptWindowRef.current.length >= interruptTopK) {
        sendApprovalDecision(request.requestId, true);
        addSystemMessage(`ℹ️ Auto-approved ${request.requestId} due to interruptTopK.`);
        return;
      }

      if (interruptCooldownMs > 0 && now - lastApprovalPromptTsRef.current < interruptCooldownMs) {
        sendApprovalDecision(request.requestId, true);
        addSystemMessage(`ℹ️ Auto-approved ${request.requestId} due to interrupt cooldown.`);
        return;
      }

      window.setTimeout(() => {
        setApprovalRequests(prev => [...prev, request]);
        const timestamp = Date.now();
        lastApprovalPromptTsRef.current = timestamp;
        approvalPromptWindowRef.current.push(timestamp);

        if (notificationModality !== 'badge') {
          setShowApprovalOverlay(true);
        }

        if (persistenceMs > 0) {
          window.setTimeout(() => {
            setApprovalRequests((prev) => {
              const exists = prev.some((item) => item.requestId === request.requestId);
              if (!exists) return prev;
              sendApprovalDecision(request.requestId, false);
              addSystemMessage(`⌛ Auto-rejected expired approval: ${request.requestId}`);
              return prev.filter((item) => item.requestId !== request.requestId);
            });
          }, persistenceMs);
        }
      }, feedbackLatencyMs);
    },
    setTabTitle,
    // New event handlers for tab events
    onTabStatusChanged: (status, _tabId) => {
      // Update the tab status state
      setTabStatus(status);
    },
    onTargetChanged: (_tabId, _url) => {
      // We don't need to do anything here as TabStatusBar handles this
    },
    onActiveTabChanged: (oldTabId, newTabId, title, url) => {
      // Update the tab title when the agent switches tabs
      console.log(`SidePanel: Active tab changed from ${oldTabId} to ${newTabId}`);
      setTabTitle(title);

      // Add a system message to indicate the tab change
      addSystemMessage(`Switched to tab: ${title} (${url})`);
    },
    onPageDialog: (_tabId, dialogInfo) => {
      // Add a system message about the dialog
      addSystemMessage(`📢 Dialog: ${dialogInfo.type} - ${dialogInfo.message}`);
    },
    onPageError: (_tabId, error) => {
      // Add a system message about the error
      addSystemMessage(`❌ Page Error: ${error}`);
    },
    onAgentStatusUpdate: (status, lastHeartbeat) => {
      // Log agent status updates for debugging
      console.log(`Agent status update: ${status}, lastHeartbeat: ${lastHeartbeat}, diff: ${Date.now() - lastHeartbeat}ms`);

      // Update the tab status based on agent status
      if (status === 'running' || status === 'idle' || status === 'error') {
        setTabStatus(status);
      }

      // If agent is running, ensure UI is in processing mode
      if (status === 'running') {
        setIsProcessing(true);
      }

      // If agent is idle, ensure UI is not in processing mode
      if (status === 'idle') {
        setIsProcessing(false);
      }

      if (status === 'error') {
        handleOversightEvent({
          kind: 'run_failed',
          timestamp: Date.now(),
          focusLabel: 'Execution failed',
          error: 'Agent status error',
        });
      }
    },
    onOversightEvent: (event) => {
      if (event.kind === 'intent_refresh_triggered') {
        addSystemMessage('Still aiming to current goal? (auto-confirming Yes...)');
      }
      if (event.kind === 'intent_refresh_confirmed') {
        addSystemMessage('Intent refresh confirmed: Yes.');
      }
      handleOversightEvent(event);
    },
    onRuntimeStateUpdate: (status) => {
      setRuntimeStatus(status);
      if (
        status.executionState === 'paused_by_user' ||
        status.executionState === 'paused_by_system' ||
        status.executionState === 'paused_by_system_soft'
      ) {
        setIsProcessing(true);
      }
      if (status.executionState === 'cancelled' || status.executionState === 'completed') {
        setIsProcessing(false);
      }
    },
    onPlanReviewRequired: (payload) => {
      setPlanReviewRequest(payload);
      setEditedPlanSteps((payload.plan || []).filter((step) => step.trim().length > 0));
      setIsEditingPlan(false);
      setActivePanel('oversight');
      addSystemMessage('🧭 Plan review required before execution.');
    },
  });

  useEffect(() => {
    if (runtimeStatus.regime === 'deliberative_escalated') {
      setActivePanel('oversight');
    }
  }, [runtimeStatus.regime]);

  useEffect(() => {
    if (!runtimeStatus.softPause?.active) return;
    const timer = window.setInterval(() => {
      setSoftPauseNow(Date.now());
    }, 200);
    return () => window.clearInterval(timer);
  }, [runtimeStatus.softPause?.active]);

  useEffect(() => {
    if (!showInspectPlanModal) {
      setInspectPlanLoading(false);
    }
  }, [showInspectPlanModal]);

  useEffect(() => {
    if (!showInspectPlanModal || !approvedPlan || approvedPlan.steps.length === 0) return;
    let cancelled = false;
    setInspectPlanLoading(true);
    setInspectPlanError(null);

    void assessPlanProgress({
      planSteps: approvedPlan.steps,
      agentSteps: taskNodes.map((node, index) => ({
        index: index + 1,
        status: node.status,
        toolName: node.toolName,
        focusLabel: node.focusLabel,
        thinking: node.thinking,
      })),
    })
      .then((assessment) => {
        if (cancelled) return;
        setInspectPlanProgress(assessment);
      })
      .catch((error) => {
        if (cancelled) return;
        setInspectPlanError(error instanceof Error ? error.message : String(error));
        setInspectPlanProgress({
          completedCount: 0,
          currentStepNumber: 0,
          isFullyCompleted: false,
          steps: approvedPlan.steps.map(() => ({
            status: 'pending',
            reason: 'LLM progress assessment unavailable.',
          })),
        });
      })
      .finally(() => {
        if (!cancelled) setInspectPlanLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [showInspectPlanModal, approvedPlan, taskNodes]);

  const handlePlanReviewApprove = () => {
    const steps = (planReviewRequest?.plan || []).map((step) => step.trim()).filter(Boolean);
    if (steps.length > 0) {
      setApprovedPlan({
        summary: planReviewRequest?.planSummary || 'Approved plan.',
        steps,
      });
      setInspectPlanProgress(null);
      setInspectPlanError(null);
    }
    submitPlanReviewDecision('approve');
    setPlanReviewRequest(null);
    setIsEditingPlan(false);
    setEditedPlanSteps([]);
    addSystemMessage('✅ Plan approved. Execution continues.');
  };

  const handlePlanReviewEdit = () => {
    if (editedPlanSteps.length === 0) {
      setEditedPlanSteps(['']);
    }
    setIsEditingPlan(true);
  };

  const handlePlanStepChange = (index: number, value: string) => {
    setEditedPlanSteps((prev) => prev.map((step, idx) => (idx === index ? value : step)));
  };

  const handlePlanStepAdd = () => {
    setEditedPlanSteps((prev) => [...prev, '']);
  };

  const handlePlanStepRemove = (index: number) => {
    setEditedPlanSteps((prev) => prev.filter((_, idx) => idx !== index));
  };

  const handlePlanEditSubmit = () => {
    const normalized = editedPlanSteps.map((step) => step.trim()).filter(Boolean);
    if (normalized.length === 0) {
      addSystemMessage('⚠️ Please keep at least one plan step before submitting edits.');
      return;
    }
    const editedPlan = normalized.map((step, idx) => `${idx + 1}. ${step}`).join('\n');
    runtimeInteractionSignal('edit_intermediate_output');
    submitPlanReviewDecision('edit', editedPlan);
    setApprovedPlan({
      summary: planReviewRequest?.planSummary || 'Edited plan.',
      steps: normalized,
    });
    setInspectPlanProgress(null);
    setInspectPlanError(null);
    setPlanReviewRequest(null);
    setIsEditingPlan(false);
    setEditedPlanSteps([]);
    addSystemMessage(`✏️ Plan edited with ${normalized.length} steps.`);
  };

  const handlePlanReviewReject = () => {
    submitPlanReviewDecision('reject');
    setApprovedPlan(null);
    setShowInspectPlanModal(false);
    setInspectPlanProgress(null);
    setInspectPlanError(null);
    setPlanReviewRequest(null);
    setIsEditingPlan(false);
    setEditedPlanSteps([]);
    setIsProcessing(false);
    addSystemMessage('❌ Plan rejected. Execution terminated.');
  };

  // Handle form submission
  const handleSubmit = async (prompt: string) => {
    setIsProcessing(true);
    setHaltReason(null);
    setApprovedPlan(null);
    setShowInspectPlanModal(false);
    setInspectPlanProgress(null);
    setInspectPlanError(null);
    // Update the tab status to running
    setTabStatus('running');
    resetRunState();

    // Add a system message to indicate a new prompt
    addSystemMessage(`New prompt: "${prompt}"`);
    setActivePanel('conversation');

    try {
      await executePrompt(prompt);
    } catch (error) {
      console.error('Error:', error);
      addSystemMessage('Error: ' + (error instanceof Error ? error.message : String(error)));
      setIsProcessing(false);
      // Update the tab status to error
      setTabStatus('error');
      handleOversightEvent({
        kind: 'run_failed',
        timestamp: Date.now(),
        focusLabel: 'Execution failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  // Handle cancellation - also reject any pending approval requests
  const handleCancel = () => {
    // If there are any pending approval requests, reject them all
    if (approvalRequests.length > 0) {
      // Add a system message to indicate that approvals were rejected due to cancellation
      addSystemMessage(`❌ Cancelled execution - all pending approval requests were automatically rejected`);

      // Reject each pending approval request
      approvalRequests.forEach(req => {
        rejectRequest(req.requestId);
      });

      // Clear the approval requests
      setApprovalRequests([]);
    }

    // Cancel the execution
    cancelExecution();

    // Update the tab status to idle
    setTabStatus('idle');
    handleOversightEvent({
      kind: 'run_cancelled',
      timestamp: Date.now(),
      focusLabel: 'Execution cancelled',
    });
  };

  // Handle clearing history
  const handleClearHistory = () => {
    clearMessages();
    clearHistory();
    clearOversightState();
    setHaltReason(null);
    setApprovedPlan(null);
    setShowInspectPlanModal(false);
    setInspectPlanProgress(null);
    setInspectPlanError(null);
  };


  // Function to navigate to the options page
  const navigateToOptions = () => {
    chrome.runtime.openOptionsPage();
  };

  const pendingApprovalCount = approvalRequests.length;
  const shouldShowBadge = pendingApprovalCount > 0 && (notificationModality === 'badge' || notificationModality === 'mixed');
  const shouldShowOverlay = pendingApprovalCount > 0 && (notificationModality === 'modal' || notificationModality === 'mixed' || showApprovalOverlay);
  const canPause = runtimeStatus.executionState === 'running';
  const canResume =
    runtimeStatus.executionState === 'paused_by_user' ||
    runtimeStatus.executionState === 'paused_by_system' ||
    runtimeStatus.executionState === 'paused_by_system_soft';
  const amplificationReasonText =
    runtimeStatus.amplification?.enteredReason === 'inspect_plan'
      ? 'Inspect Plan'
      : runtimeStatus.amplification?.enteredReason === 'rapid_trace_inspection'
        ? 'Rapid Trace Inspection'
        : runtimeStatus.amplification?.enteredReason === 'pause_resume_rapid'
          ? 'Rapid Pause/Resume'
          : 'Unknown';
  const isAmplified = runtimeStatus.amplification?.state === 'amplified';
  const handleAmplifiedToggle = (checked: boolean) => {
    if (checked) {
      runtimeInteractionSignal('inspect_plan');
      return;
    }
    exitAmplifiedMode();
  };
  const inspectPlanView = inspectPlanProgress ?? {
    completedCount: 0,
    currentStepNumber: 0,
    isFullyCompleted: false,
    steps: approvedPlanSteps.map(() => ({ status: 'pending' as const, reason: 'Awaiting LLM assessment.' })),
  };

  return (
    <div className="morph-shell flex h-screen flex-col bg-base-200/60">
      {hasConfiguredProviders ? (
        <>
          <div className="morph-surface flex min-h-0 flex-1 flex-col overflow-hidden bg-base-100">
            <OutputHeader
              onClearHistory={handleClearHistory}
              onDownloadTaskGraph={handleDownloadTaskGraph}
              canDownloadTaskGraph={taskNodes.length > 0}
              isProcessing={isProcessing}
            />
            <div className="px-3 pt-2">
              <div className="flex items-center justify-between gap-2">
                <ProviderSelector isProcessing={isProcessing} />
                {shouldShowBadge ? (
                  <button
                    className="btn btn-warning btn-xs"
                    onClick={() => setShowApprovalOverlay((prev) => !prev)}
                    type="button"
                  >
                    Approvals ({pendingApprovalCount})
                  </button>
                ) : null}
              </div>

              <div className="morph-status-strip mt-2 bg-base-200/60 text-xs">
                <div className="flex flex-wrap items-center gap-1.5">
                  {approvedPlanSteps.length > 0 ? (
                    <button
                      className="btn btn-xs btn-outline"
                      onClick={() => {
                        runtimeInteractionSignal('inspect_plan');
                        setShowInspectPlanModal(true);
                      }}
                      type="button"
                    >
                      Inspect Plan
                    </button>
                  ) : null}
                  <label className="ml-auto flex items-center gap-2 rounded-md border border-base-300 px-2 py-1">
                    <span className="text-xs font-medium text-base-content/80">Amplified Mode</span>
                    <input
                      type="checkbox"
                      className="toggle toggle-warning toggle-xs"
                      checked={isAmplified}
                      onChange={(e) => handleAmplifiedToggle(e.target.checked)}
                    />
                    <span className="text-[11px] text-base-content/60">{isAmplified ? 'ON' : 'OFF'}</span>
                  </label>
                  {isAmplified ? (
                    <span className="text-[11px] text-base-content/70">Entered because: {amplificationReasonText}</span>
                  ) : null}
                </div>
              </div>
            </div>

            <div className="morph-tabbar mx-3 mt-2 mb-2 flex gap-2 bg-base-200">
              <button
                className={`btn btn-sm flex-1 rounded-lg ${activePanel === 'conversation' ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => setActivePanel('conversation')}
              >
                Conversation
              </button>
              <button
                className={`btn btn-sm flex-1 rounded-lg ${activePanel === 'oversight' ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => {
                  setActivePanel('oversight');
                  runtimeInteractionSignal('open_oversight_tab');
                }}
              >
                Oversight
              </button>
            </div>

            {haltReason ? (
              <div className="mx-3 mb-2 rounded-md border border-warning/40 bg-warning/15 px-3 py-2 text-xs text-warning-content">
                {haltReason}
              </div>
            ) : null}

            {runtimeStatus.softPause?.active ? (
              <div className="mx-3 mb-2 rounded-md border border-info/40 bg-info/10 px-3 py-2 text-xs">
                <div className="font-semibold text-base-content">Next action will execute...</div>
                <div className="mt-1 text-base-content/80">
                  Countdown active ({Math.max(0, Math.ceil((runtimeStatus.softPause.endsAt - softPauseNow) / 1000))}s)
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    className="btn btn-xs btn-primary"
                    onClick={() => submitSoftPauseDecision('continue_now')}
                    type="button"
                  >
                    Continue now
                  </button>
                  <button
                    className="btn btn-xs btn-outline"
                    onClick={() => submitSoftPauseDecision('pause')}
                    type="button"
                  >
                    Pause
                  </button>
                </div>
              </div>
            ) : null}

            {activePanel === 'conversation' && (
              <div
                ref={outputRef}
                className="morph-scroll min-h-0 flex-1 overflow-auto"
              >
                <MessageDisplay
                  messages={messages}
                  streamingSegments={streamingSegments}
                  isStreaming={isStreaming}
                />
              </div>
            )}

            {activePanel === 'oversight' && (
              <div className="morph-scroll min-h-0 flex-1 overflow-auto">
                {enableAgentFocus && agentFocus.state === 'active' && (
                  <AgentAttentionBar
                    state={agentFocus.state}
                    toolName={agentFocus.toolName}
                    focusLabel={agentFocus.focusLabel}
                    updatedAt={agentFocus.updatedAt}
                  />
                )}
                {enableTaskGraph && (
                  <TaskExecutionGraph
                    nodes={taskNodes}
                    contentGranularity={contentGranularity}
                    informationDensity={informationDensity}
                    colorEncoding={colorEncoding}
                    monitoringContentScope={monitoringContentScope}
                    explanationAvailability={explanationAvailability}
                    explanationFormat={explanationFormat}
                    onTraceNodeExpanded={() => runtimeInteractionSignal('expand_trace_node')}
                    onRepeatedTraceExpansion={() => runtimeInteractionSignal('repeated_trace_expansion')}
                    onRepeatedScrollBackward={() => runtimeInteractionSignal('repeated_scroll_backward')}
                    onRiskLabelHover={(durationMs) => runtimeInteractionSignal('hover_risk_label', durationMs)}
                  />
                )}
                {!enableAgentFocus && !enableTaskGraph && (
                  <div className="px-1 py-2 text-sm text-base-content/70">
                    Oversight panel is empty for current mechanism settings.
                  </div>
                )}
              </div>
            )}
          </div>

          {shouldShowOverlay ? (
            <div className="pointer-events-none fixed inset-x-4 bottom-24 z-30">
              <div className="pointer-events-auto max-h-72 overflow-y-auto">
                {approvalRequests.map(req => (
                  <ApprovalRequest
                    key={req.requestId}
                    requestId={req.requestId}
                    toolName={req.toolName}
                    toolInput={req.toolInput}
                    reason={req.reason}
                    onApprove={handleApprove}
                    onReject={handleReject}
                    onDismiss={handleDismissWarning}
                    onEdit={undefined}
                    onRetry={undefined}
                    onRollback={undefined}
                    compact={informationDensity === 'compact'}
                  />
                ))}
              </div>
            </div>
          ) : null}

          {planReviewRequest ? (
            <div className="pointer-events-none fixed inset-x-4 bottom-44 z-40">
              <div className="pointer-events-auto flex max-h-[62vh] flex-col rounded-lg border border-warning/40 bg-base-100 p-4 shadow-xl">
                <div className="mb-2 text-sm font-semibold">Plan Review</div>
                <div className="mb-2 text-xs text-base-content/80 whitespace-pre-wrap">{planReviewRequest.planSummary}</div>
                {planReviewRequest.plan && planReviewRequest.plan.length > 0 ? (
                  <div className="mb-3 flex-1 space-y-2 overflow-y-auto pr-1">
                    {(isEditingPlan ? editedPlanSteps : planReviewRequest.plan).map((line, idx) => (
                      <div key={`plan-line-${idx}`} className="grid grid-cols-[64px_1fr] items-start gap-2">
                        <div className="pt-2 text-xs font-semibold text-base-content/80">Step {idx + 1}</div>
                        {isEditingPlan ? (
                          <div className="space-y-1">
                            <textarea
                              className="textarea textarea-bordered w-full resize-y text-xs max-h-36"
                              value={line}
                              onChange={(e) => handlePlanStepChange(idx, e.target.value)}
                              rows={2}
                            />
                            <div className="flex justify-end">
                              <button
                                className="btn btn-ghost btn-xs text-error"
                                onClick={() => handlePlanStepRemove(idx)}
                                type="button"
                                disabled={editedPlanSteps.length <= 1}
                              >
                                Remove
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="rounded-md bg-base-200 px-3 py-2 text-xs text-base-content/90 whitespace-pre-wrap">
                            {line}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                ) : null}
                <div className="shrink-0 border-t border-base-300 pt-3 flex flex-wrap gap-2">
                  {!isEditingPlan ? (
                    <button
                      className="btn btn-xs btn-success min-w-[110px] flex-1"
                      onClick={handlePlanReviewApprove}
                      type="button"
                    >
                      Approve Plan
                    </button>
                  ) : null}
                  {!isEditingPlan ? (
                    <button className="btn btn-xs btn-error min-w-[110px] flex-1" onClick={handlePlanReviewReject} type="button">
                      Reject Plan
                    </button>
                  ) : null}
                  {!isEditingPlan ? (
                    <button
                      className="btn btn-xs btn-warning min-w-[110px] flex-1"
                      onClick={handlePlanReviewEdit}
                      type="button"
                    >
                      Edit Plan
                    </button>
                  ) : null}
                  {isEditingPlan ? (
                    <button className="btn btn-xs btn-outline min-w-[110px] flex-1" onClick={handlePlanStepAdd} type="button">
                      Add Step
                    </button>
                  ) : null}
                  {isEditingPlan ? (
                    <button className="btn btn-xs btn-warning min-w-[110px] flex-1" onClick={handlePlanEditSubmit} type="button">
                      Save Edits
                    </button>
                  ) : null}
                  {isEditingPlan ? (
                    <button
                      className="btn btn-xs btn-ghost min-w-[110px] flex-1"
                      onClick={() => {
                        setIsEditingPlan(false);
                        setEditedPlanSteps((planReviewRequest.plan || []).filter((step) => step.trim().length > 0));
                      }}
                      type="button"
                    >
                      Cancel Edit
                    </button>
                  ) : null}
                </div>
              </div>
            </div>
          ) : null}

          {showInspectPlanModal && approvedPlan ? (
            <div className="pointer-events-none fixed inset-x-4 bottom-44 z-40">
              <div className="pointer-events-auto flex max-h-[62vh] flex-col rounded-lg border border-primary/40 bg-base-100 p-4 shadow-xl">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <div className="text-sm font-semibold">Inspect Plan</div>
                  <button
                    className="btn btn-xs btn-ghost"
                    onClick={() => setShowInspectPlanModal(false)}
                    type="button"
                  >
                    Close
                  </button>
                </div>
                <div className="mb-2 text-xs text-base-content/80 whitespace-pre-wrap">{approvedPlan.summary}</div>
                {inspectPlanLoading ? (
                  <div className="mb-2 text-xs text-base-content/70">Assessing progress with model...</div>
                ) : null}
                {inspectPlanError ? (
                  <div className="mb-2 text-xs text-warning">LLM assessment error: {inspectPlanError}</div>
                ) : null}
                <div className="mb-3 rounded-md border border-base-300 bg-base-200 px-3 py-2 text-xs text-base-content/80">
                  <div>Completed: {inspectPlanView.completedCount}/{approvedPlan.steps.length}</div>
                  <div>
                    Current:{' '}
                    {inspectPlanView.isFullyCompleted
                      ? 'Done'
                      : inspectPlanView.currentStepNumber > 0
                        ? `Step ${inspectPlanView.currentStepNumber}`
                        : 'Unclear'}
                  </div>
                </div>
                <div className="mb-3 flex-1 space-y-2 overflow-y-auto pr-1">
                  {approvedPlan.steps.map((line, idx) => {
                    const progress = inspectPlanView.steps[idx];
                    const statusLabel = progress?.status || 'pending';
                    const statusClass = statusLabel === 'completed'
                      ? 'badge badge-success badge-xs'
                      : statusLabel === 'current'
                        ? 'badge badge-info badge-xs'
                        : 'badge badge-ghost badge-xs';
                    return (
                      <div key={`inspect-plan-${idx}`} className="grid grid-cols-[64px_1fr] items-start gap-2">
                        <div className="pt-1 text-xs font-semibold text-base-content/80">Step {idx + 1}</div>
                        <div className="rounded-md bg-base-200 px-3 py-2 text-xs text-base-content/90">
                          <div className="mb-1">
                            <span className={statusClass}>{statusLabel}</span>
                          </div>
                          <div className="whitespace-pre-wrap">{line}</div>
                          {progress?.reason ? (
                            <div className="mt-1 text-[11px] text-base-content/70 whitespace-pre-wrap">
                              reason: {progress.reason}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          ) : null}

          <div className="pb-1">
            <PromptForm
              onSubmit={handleSubmit}
              onCancel={handleCancel}
              onPause={pauseExecution}
              onResume={resumeExecution}
              isProcessing={isProcessing}
              canPause={canPause}
              canResume={canResume}
              tabStatus={tabStatus}
            />
          </div>
        </>
      ) : (
        <div className="flex flex-col flex-grow items-center justify-center">
          <div className="text-center mb-6">
            <h2 className="text-xl font-semibold mb-2">No LLM provider configured</h2>
            <p className="text-gray-600 mb-4">
              You need to configure an LLM provider before you can use BrowserBee.
            </p>
            <button
              onClick={navigateToOptions}
              className="btn btn-primary"
            >
              Configure Providers
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
