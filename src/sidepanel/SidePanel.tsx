import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ConfigManager } from '../background/configManager';
import type { AuthorityState, ExecutionPhase, ExecutionState } from '../oversight/runtime/types';
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
    updatedAt?: number;
  }>({
    authorityState: 'agent_autonomous',
    executionPhase: 'planning',
    executionState: 'running',
  });
  const [planReviewRequest, setPlanReviewRequest] = useState<{
    planSummary: string;
    plan?: string[];
    stepId?: string;
    toolName?: string;
    toolInput?: string;
  } | null>(null);
  const [showApprovalOverlay, setShowApprovalOverlay] = useState(true);
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
  const monitoringContentScope =
    monitoringParams.monitoringContentScope === 'minimal' ||
    monitoringParams.monitoringContentScope === 'standard' ||
    monitoringParams.monitoringContentScope === 'full'
      ? monitoringParams.monitoringContentScope
      : 'full';
  const explanationAvailability =
    monitoringParams.explanationAvailability === 'none' ||
    monitoringParams.explanationAvailability === 'summary' ||
    monitoringParams.explanationAvailability === 'full'
      ? monitoringParams.explanationAvailability
      : 'summary';
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
  const persistenceMs = Math.max(0, Number(monitoringParams.persistenceMs || 0));
  const showPostHocPanel = Boolean(monitoringParams.showPostHocPanel);
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
  const userActionOptions = interventionParams.userActionOptions === 'extended' ? 'extended' : 'basic';
  const approvedCount = taskNodes.filter((node) => node.intervention?.decision === 'approve').length;
  const deniedCount = taskNodes.filter((node) => node.intervention?.decision === 'deny').length;
  const highImpactCount = taskNodes.filter((node) => node.intervention?.impact === 'high').length;

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

  const handleEdit = (requestId: string) => {
    const request = approvalRequests.find((req) => req.requestId === requestId);
    const stepId = request?.stepId || requestId;
    const note = window.prompt('Edit instruction note (records intervention and rejects current step):', '') || '';
    void logHumanTelemetry('human_intervention', {
      action: 'edit_submitted',
      requestId,
      stepId,
      note,
    });
    handleOversightEvent({
      kind: 'intervention_decision',
      stepId,
      decision: 'edit',
    });
    sendApprovalDecision(requestId, false);
    setApprovalRequests(prev => prev.filter(req => req.requestId !== requestId));
    addSystemMessage(`✏️ Edit requested for ${requestId}${note ? `: ${note}` : ''}`);
  };

  const handleRetry = (requestId: string) => {
    const request = approvalRequests.find((req) => req.requestId === requestId);
    const stepId = request?.stepId || requestId;
    void logHumanTelemetry('human_intervention', {
      action: 'retry_requested',
      requestId,
      stepId,
    });
    sendApprovalDecision(requestId, false);
    setApprovalRequests(prev => prev.filter(req => req.requestId !== requestId));
    addSystemMessage(`🔁 Retry requested for ${requestId}. Re-run after adjusting context.`);
  };

  const handleRollback = (requestId: string) => {
    const request = approvalRequests.find((req) => req.requestId === requestId);
    const stepId = request?.stepId || requestId;
    void logHumanTelemetry('human_intervention', {
      action: 'rollback_requested',
      requestId,
      stepId,
    });
    handleOversightEvent({
      kind: 'intervention_decision',
      stepId,
      decision: 'rollback',
    });
    sendApprovalDecision(requestId, false);
    setApprovalRequests(prev => prev.filter(req => req.requestId !== requestId));
    addSystemMessage(`↩️ Rollback requested for ${requestId}. Manual rollback may be required.`);
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
    takeoverAuthority,
    releaseControl,
    submitPlanReviewDecision,
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
      handleOversightEvent(event);
    },
    onRuntimeStateUpdate: (status) => {
      setRuntimeStatus(status);
      if (status.executionState === 'paused_by_user' || status.executionState === 'paused_by_system') {
        setIsProcessing(true);
      }
      if (status.executionState === 'cancelled' || status.executionState === 'completed') {
        setIsProcessing(false);
      }
    },
    onPlanReviewRequired: (payload) => {
      setPlanReviewRequest(payload);
      setActivePanel('oversight');
      addSystemMessage('🧭 Plan review required before execution.');
    },
  });

  const handlePlanReviewApprove = () => {
    submitPlanReviewDecision('approve');
    setPlanReviewRequest(null);
    addSystemMessage('✅ Plan approved. Execution continues.');
  };

  const handlePlanReviewEdit = () => {
    const editedPlan = window.prompt('Edit plan guidance:', planReviewRequest?.planSummary || '') || '';
    submitPlanReviewDecision('edit', editedPlan);
    setPlanReviewRequest(null);
    addSystemMessage(`✏️ Plan edited${editedPlan ? ': ' + editedPlan : ''}`);
  };

  const handlePlanReviewReject = () => {
    submitPlanReviewDecision('reject');
    setPlanReviewRequest(null);
    setIsProcessing(false);
    addSystemMessage('❌ Plan rejected. Execution terminated.');
  };

  // Handle form submission
  const handleSubmit = async (prompt: string) => {
    setIsProcessing(true);
    setHaltReason(null);
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
  };


  // Function to navigate to the options page
  const navigateToOptions = () => {
    chrome.runtime.openOptionsPage();
  };

  const pendingApprovalCount = approvalRequests.length;
  const shouldShowBadge = pendingApprovalCount > 0 && (notificationModality === 'badge' || notificationModality === 'mixed');
  const shouldShowOverlay = pendingApprovalCount > 0 && (notificationModality === 'modal' || notificationModality === 'mixed' || showApprovalOverlay);

  return (
    <div className="flex flex-col h-screen p-4 bg-base-200">
      {/* <header className="mb-4">
        <div className="flex justify-end items-center">
          <TabStatusBar
            tabId={tabId}
            tabTitle={tabTitle}
            tabStatus={tabStatus}
          />
        </div>
      </header> */}

      {hasConfiguredProviders ? (
        <>
          <div className="flex flex-col flex-grow gap-4 overflow-hidden md:flex-row shadow-sm">
            <div className="card bg-base-100 shadow-md flex-1 flex flex-col overflow-hidden">
              <OutputHeader
                onClearHistory={handleClearHistory}
                onDownloadTaskGraph={handleDownloadTaskGraph}
                canDownloadTaskGraph={taskNodes.length > 0}
                isProcessing={isProcessing}
              />
              <div className="mx-3 mt-2 rounded-md border border-base-300 bg-base-200 px-3 py-2 text-xs">
                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <span className="font-semibold">Authority:</span> {runtimeStatus.authorityState}
                  </div>
                  <div>
                    <span className="font-semibold">Phase:</span> {runtimeStatus.executionPhase}
                  </div>
                  <div>
                    <span className="font-semibold">Execution:</span> {runtimeStatus.executionState}
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button className="btn btn-xs btn-outline" onClick={pauseExecution} type="button">
                    Pause
                  </button>
                  <button className="btn btn-xs btn-outline" onClick={resumeExecution} type="button">
                    Resume
                  </button>
                  <button className="btn btn-xs btn-outline" onClick={takeoverAuthority} type="button">
                    Takeover
                  </button>
                  <button className="btn btn-xs btn-outline" onClick={releaseControl} type="button">
                    Release control
                  </button>
                </div>
              </div>
              <div className="mx-3 mt-3 mb-2 flex gap-2 rounded-md bg-base-200 p-1">
                <button
                  className={`btn btn-sm flex-1 ${activePanel === 'conversation' ? 'btn-primary' : 'btn-ghost'}`}
                  onClick={() => setActivePanel('conversation')}
                >
                  Conversation
                </button>
                <button
                  className={`btn btn-sm flex-1 ${activePanel === 'oversight' ? 'btn-primary' : 'btn-ghost'}`}
                  onClick={() => setActivePanel('oversight')}
                >
                  Oversight
                </button>
              </div>

              {haltReason ? (
                <div className="mx-3 mb-2 rounded-md border border-warning/40 bg-warning/15 px-3 py-2 text-xs text-warning-content">
                  {haltReason}
                </div>
              ) : null}

              {activePanel === 'conversation' && (
                <div
                  ref={outputRef}
                  className="card-body p-3 overflow-auto bg-base-100 flex-1"
                >
                  <MessageDisplay
                    messages={messages}
                    streamingSegments={streamingSegments}
                    isStreaming={isStreaming}
                  />
                </div>
              )}

              {activePanel === 'oversight' && (
                <div className="flex-1 overflow-auto p-3 bg-base-100">
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
                    />
                  )}
                  {!enableAgentFocus && !enableTaskGraph && (
                    <div className="px-1 py-2 text-sm text-base-content/70">
                      Oversight panel is empty for current mechanism settings.
                    </div>
                  )}
                  {showPostHocPanel ? (
                    <div className="mt-3 rounded border border-base-300 bg-base-200 p-3 text-xs">
                      <div className="mb-1 font-semibold">Post-hoc Summary</div>
                      <div>steps: {taskNodes.length}</div>
                      <div>high impact steps: {highImpactCount}</div>
                      <div>approved: {approvedCount}</div>
                      <div>denied: {deniedCount}</div>
                    </div>
                  ) : null}
                </div>
              )}

            </div>
          </div>

          {shouldShowBadge ? (
            <button
              className="fixed right-4 bottom-24 z-30 btn btn-warning btn-sm"
              onClick={() => setShowApprovalOverlay((prev) => !prev)}
            >
              Approvals ({pendingApprovalCount})
            </button>
          ) : null}

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
                    onEdit={userActionOptions === 'extended' ? handleEdit : undefined}
                    onRetry={userActionOptions === 'extended' ? handleRetry : undefined}
                    onRollback={userActionOptions === 'extended' ? handleRollback : undefined}
                    compact={informationDensity === 'compact'}
                  />
                ))}
              </div>
            </div>
          ) : null}

          {planReviewRequest ? (
            <div className="pointer-events-none fixed inset-x-4 bottom-44 z-40">
              <div className="pointer-events-auto rounded-lg border border-warning/40 bg-base-100 p-4 shadow-xl">
                <div className="mb-2 text-sm font-semibold">Plan Review</div>
                <div className="mb-2 text-xs text-base-content/80 whitespace-pre-wrap">{planReviewRequest.planSummary}</div>
                {planReviewRequest.plan && planReviewRequest.plan.length > 0 ? (
                  <ol className="mb-3 list-decimal pl-5 text-xs">
                    {planReviewRequest.plan.map((line, idx) => (
                      <li key={`plan-line-${idx}`}>{line}</li>
                    ))}
                  </ol>
                ) : null}
                <div className="flex gap-2">
                  <button className="btn btn-xs btn-success" onClick={handlePlanReviewApprove} type="button">
                    Approve Plan
                  </button>
                  <button className="btn btn-xs btn-warning" onClick={handlePlanReviewEdit} type="button">
                    Edit Plan
                  </button>
                  <button className="btn btn-xs btn-error" onClick={handlePlanReviewReject} type="button">
                    Reject Plan
                  </button>
                </div>
              </div>
            </div>
          ) : null}

          <PromptForm
            onSubmit={handleSubmit}
            onCancel={handleCancel}
            isProcessing={isProcessing}
            tabStatus={tabStatus}
          />
          <ProviderSelector isProcessing={isProcessing} />
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
