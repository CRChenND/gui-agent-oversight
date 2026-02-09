import React, { useCallback, useMemo, useState, useEffect } from 'react';
import { ConfigManager } from '../background/configManager';
import {
  AGENT_FOCUS_MECHANISM_ID,
  TASK_GRAPH_MECHANISM_ID,
  createDefaultOversightParameterSettings,
  createDefaultOversightMechanismSettings,
  getOversightParameterStorageQueryDefaults,
  getOversightStorageQueryDefaults,
  mapStorageToOversightParameterSettings,
  mapStorageToOversightSettings,
} from '../oversight/registry';
import { ApprovalRequest } from './components/ApprovalRequest';
import { AgentAttentionBar } from './components/AgentAttentionBar';
import { MessageDisplay } from './components/MessageDisplay';
import { OutputHeader } from './components/OutputHeader';
import { PromptForm } from './components/PromptForm';
import { ProviderSelector } from './components/ProviderSelector';
import { TaskExecutionGraph } from './components/TaskExecutionGraph';
import { useChromeMessaging } from './hooks/useChromeMessaging';
import { useMessageManagement } from './hooks/useMessageManagement';
import { useOversightMechanisms } from './hooks/useOversightMechanisms';
import { useTabManagement } from './hooks/useTabManagement';
import { ReplayTimeline } from './replay/ReplayTimeline';
import { ReplayController, type ReplaySessionSummary } from '../replay/replayController';

export function SidePanel() {
  const [mechanismSettings, setMechanismSettings] = useState(createDefaultOversightMechanismSettings);
  const [mechanismParameterSettings, setMechanismParameterSettings] = useState(createDefaultOversightParameterSettings);

  // State for tab status
  const [tabStatus, setTabStatus] = useState<'attached' | 'detached' | 'unknown' | 'running' | 'idle' | 'error'>('unknown');

  // State for approval requests
  const [approvalRequests, setApprovalRequests] = useState<Array<{
    requestId: string;
    toolName: string;
    toolInput: string;
    reason: string;
  }>>([]);

  // State to track if any LLM providers are configured
  const [hasConfiguredProviders, setHasConfiguredProviders] = useState<boolean>(false);
  const [replaySessions, setReplaySessions] = useState<ReplaySessionSummary[]>([]);
  const [selectedReplaySessionId, setSelectedReplaySessionId] = useState<string>('');
  const [isReplayMode, setIsReplayMode] = useState(false);
  const [replayCursor, setReplayCursor] = useState(-1);
  const [replayEventCount, setReplayEventCount] = useState(0);
  const replayController = useMemo(() => new ReplayController(), []);

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
    const loadReplaySessions = async () => {
      const sessions = await replayController.listSessions();
      setReplaySessions(sessions);
      if (sessions.length > 0 && !selectedReplaySessionId) {
        setSelectedReplaySessionId(sessions[0].sessionId);
      }
    };

    checkProviders();
    loadFeatureFlags();
    loadReplaySessions();

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
  }, [replayController, selectedReplaySessionId]);

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
    isTaskGraphExpanded,
    setTaskGraphExpanded,
    agentFocus,
    handleOversightEvent,
    replayOversightEvents,
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

  const applyReplayState = useCallback(() => {
    const visibleEvents = replayController.getVisibleEvents();
    replayOversightEvents(visibleEvents);
    setReplayCursor(replayController.getCursor());
    setReplayEventCount(replayController.getReplayEvents().length);
  }, [replayController, replayOversightEvents]);

  const handleLoadReplaySession = useCallback(async () => {
    if (!selectedReplaySessionId) return;
    await replayController.loadSession(selectedReplaySessionId);
    setIsReplayMode(true);
    applyReplayState();
  }, [selectedReplaySessionId, replayController, applyReplayState]);

  const handleExitReplay = useCallback(() => {
    setIsReplayMode(false);
    setReplayCursor(-1);
    setReplayEventCount(0);
    replayOversightEvents([]);
  }, [replayOversightEvents]);

  const handleReplayStepForward = useCallback(() => {
    replayController.stepForward();
    applyReplayState();
  }, [replayController, applyReplayState]);

  const handleReplayStepBackward = useCallback(() => {
    replayController.stepBackward();
    applyReplayState();
  }, [replayController, applyReplayState]);

  const handleReplayJumpToPosition = useCallback(
    (position: number) => {
      const events = replayController.getReplayEvents();
      if (position <= 0 || events.length === 0) {
        replayController.jumpTo(-Infinity);
      } else {
        const bounded = Math.min(position, events.length);
        replayController.jumpTo(events[bounded - 1].timestamp);
      }
      applyReplayState();
    },
    [replayController, applyReplayState]
  );

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
    void logHumanTelemetry('human_intervention', {
      action: 'approval_accepted',
      requestId,
      toolName: request?.toolName,
      toolInput: request?.toolInput,
      reason: request?.reason,
    });
    void logHumanTelemetry('human_intervention', {
      action: 'override_performed',
      requestId,
      toolName: request?.toolName,
      toolInput: request?.toolInput,
    });

    // Send approval to the background script
    approveRequest(requestId);
    // Remove the request from the list
    setApprovalRequests(prev => prev.filter(req => req.requestId !== requestId));
    // Add a system message to indicate approval
    addSystemMessage(`✅ Approved action: ${requestId}`);
  };

  const handleReject = (requestId: string) => {
    const request = approvalRequests.find((req) => req.requestId === requestId);
    void logHumanTelemetry('human_intervention', {
      action: 'approval_rejected',
      requestId,
      toolName: request?.toolName,
      toolInput: request?.toolInput,
      reason: request?.reason,
    });

    // Send rejection to the background script
    rejectRequest(requestId);
    // Remove the request from the list
    setApprovalRequests(prev => prev.filter(req => req.requestId !== requestId));
    // Add a system message to indicate rejection
    addSystemMessage(`❌ Rejected action: ${requestId}`);
  };

  const handleDismissWarning = (requestId: string) => {
    const request = approvalRequests.find((req) => req.requestId === requestId);
    void logHumanTelemetry('human_monitoring', {
      action: 'warning_dismissed',
      requestId,
      toolName: request?.toolName,
      toolInput: request?.toolInput,
      reason: request?.reason,
    });

    // Dismissing a pending approval also rejects it to avoid blocking execution.
    rejectRequest(requestId);
    setApprovalRequests(prev => prev.filter(req => req.requestId !== requestId));
    addSystemMessage(`⚠️ Dismissed warning: ${requestId} (auto-rejected)`);
  };

  // Set up Chrome messaging with callbacks
  const {
    executePrompt,
    cancelExecution,
    clearHistory,
    approveRequest,
    rejectRequest
  } = useChromeMessaging({
    tabId,
    windowId,
    onUpdateOutput: (content) => {
      if (content?.type === 'system' &&
          typeof content.content === 'string' &&
          content.content.startsWith('🕹️ tool:')) {
        return;
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
      // Add the request to the list
      setApprovalRequests(prev => [...prev, request]);
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
      if (isReplayMode) return;
      handleOversightEvent(event);
    }
  });

  // Handle form submission
  const handleSubmit = async (prompt: string) => {
    setIsProcessing(true);
    // Update the tab status to running
    setTabStatus('running');
    resetRunState();

    // Add a system message to indicate a new prompt
    addSystemMessage(`New prompt: "${prompt}"`);

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
  };


  // Function to navigate to the options page
  const navigateToOptions = () => {
    chrome.runtime.openOptionsPage();
  };

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
                isProcessing={isProcessing}
              />
              {enableAgentFocus && (
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
                  expanded={isTaskGraphExpanded}
                  onToggle={() => setTaskGraphExpanded(!isTaskGraphExpanded)}
                />
              )}
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
            </div>
          </div>
          <ReplayTimeline
            sessions={replaySessions}
            selectedSessionId={selectedReplaySessionId}
            isReplayMode={isReplayMode}
            eventCount={replayEventCount}
            cursor={replayCursor}
            onSelectSession={setSelectedReplaySessionId}
            onLoadSession={handleLoadReplaySession}
            onExitReplay={handleExitReplay}
            onStepBackward={handleReplayStepBackward}
            onStepForward={handleReplayStepForward}
            onJumpToPosition={handleReplayJumpToPosition}
          />
          {/* Display approval requests */}
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
            />
          ))}

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
